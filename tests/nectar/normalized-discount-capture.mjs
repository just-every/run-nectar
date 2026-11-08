import assert from 'node:assert/strict'
import { file } from './harness.mjs'
import { stripeHistoryCapture } from '../fixtures/stripe-history.mjs'

// Part of the normalized-metrics sanity journey, through upload, adoption,
// governed corrections and billing. No business records are written directly.
export async function discountedCaptureFlow(h, owner, onState) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  for (const mode of ['subscription-expanded', 'item-legacy', 'item-expanded', 'correction']) {
    const data = JSON.parse(JSON.stringify(stripeHistoryCapture()).replaceAll('synthetic-nectar-', `synthetic-nectar-${mode}-`))
    const sub = data.subscriptions.data[0]
    const coupon = { id: `synthetic-nectar-${mode}-coupon`, percent_off: 10, duration: 'forever' }
    const discount = { id: `synthetic-nectar-${mode}-discount`, start: sub.start_date, source: { type: 'coupon', coupon } }
    if (mode === 'subscription-expanded') sub.discounts = [discount]
    if (mode === 'item-legacy') sub.items.data[0].discounts = [{ ...discount, source: undefined, coupon }]
    if (mode === 'item-expanded') {
      sub.items.data[0].discounts = [discount]
      sub.items.data.push({ id: `synthetic-nectar-${mode}-second-item`, price: sub.items.data[0].price, quantity: 1 })
    }
    const source = structuredClone(sub)
    if (mode === 'correction') source.items.data[0].quantity = 2
    data.subscription_events.data = [{ id: `synthetic-nectar-${mode}-created`, object: 'event', type: 'customer.subscription.created', created: sub.start_date, data: { object: source } }]
    data.manifest.files.subscription_events.count = 1
    const files = Object.fromEntries(Object.entries(data).map(([name, value]) => [name, file(`${name}.json`, JSON.stringify(value), 'application/json')]))
    const preview = await api('import.preview', files)
    assert.deepEqual(preview.rejected, [])
    await api('import.apply', { ...files, fingerprint: preview.fingerprint })
    const customer = (await api('customers')).find(row => row.external_id === sub.customer).id
    const subscription = (await api(`customers/${customer}`)).subscriptions[0].id
    const expected = mode === 'item-expanded' ? 19000 : mode === 'correction' ? 20000 : 9000
    const report = (metric, month) => api(`reports/${metric}?period=${month}&customer=${customer}`)
    const check = async (month, cents) => {
      for (const metric of ['normalized-mrr', 'normalized-arr']) {
        const result = await report(metric, month), amount = cents * (metric === 'normalized-arr' ? 12 : 1)
        assert.equal(result.totalCents, amount, `${mode}: independent ${metric} after ${month}`)
        const detail = await api(result.entries[0].href.replace('/app/', ''))
        assert.equal(detail.totalCents, amount)
        if (mode === 'item-expanded') assert.deepEqual(detail.normalized.snapshot.components.map(row => row.mrrCents).sort((a,b)=>a-b), [9000,10000], 'Only the discounted item loses ten dollars, even with a shared price')
      }
    }
    await check('2026-06', expected)
    await api('subscription.adopt', { subscription, cutover_start: '2026-07-01', acknowledge_unreconciled: true })
    await check('2026-06', expected)
    let native = mode === 'correction' ? 10000 : expected
    await check('2026-07', native)
    if (mode === 'correction') {
      const propose = () => api('proposal.create', { kind: 'amendment', title: 'Reviewed recurring discount', payload: {
        subscription, kind: 'discount_percent', value: '10', effective_from: '2026-06-01', note: 'Reviewed recurring terms',
      }, evidence: { clauses: [{ quote: 'Reduce recurring fees by ten percent from 1 June 2026.', reference: 'Executed contract section 2' }] } })
      const proposal = await propose(), stale = await propose(), saved = await api(`proposals/${proposal.id}`)
      const effects = saved.impact.flatMap(row => row.normalizedMrr.periods)
      assert.deepEqual(effects.map(row => [row.before.mrrCents,row.after.mrrCents]), [[20000,20000],[10000,9000]], 'Frozen MRR uses source terms before cutover and corrected native terms afterwards')
      assert.deepEqual(effects.map(row => [row.before.arrCents,row.after.arrCents]), [[240000,240000],[120000,108000]])
      assert.equal(effects[0].source.provider, 'stripe')
      assert.ok(saved.payload.noticeDrafts[0].citations.some(row => row.fingerprint === effects[0].after.fingerprint))
      await onState({ label: 'captured-correction-prepared', path: `/app/proposals/${proposal.id}` })
      const key = (await api('credential.issue', { name: 'Discount proposer', scopes: ['prepare'] })).key
      await h.api('proposal.decide', { bearer: key }, { proposal: proposal.id, decision: 'approved' }, 403)
      await check('2026-07',10000)
      await api('proposal.decide', { proposal: proposal.id, decision: 'approved' })
      const approved = await api(`proposals/${proposal.id}`)
      assert.deepEqual(approved.impact, saved.impact)
      assert.deepEqual(approved.payload, saved.payload)
      assert.equal(approved.customerMessages[0].body, saved.payload.noticeDrafts[0].body)
      await api('proposal.decide', { proposal: stale.id, decision: 'approved' }, 409)
      assert.deepEqual((await api(`proposals/${stale.id}`)).customerMessages, [])
      await check('2026-06',20000)
      native = 9000
      await check('2026-07',native)
      await onState({ label: 'captured-correction-approved', path: `/app/proposals/${proposal.id}` })
    }
    const prepared = await api('billrun.prepare', { period: '2026-07' })
    const invoice = (await api(`runs/${prepared.id}`)).invoices.find(row => row.subscription_id === subscription)
    await api('invoice.approve', { invoice: invoice.id, acknowledge: true })
    await api('invoice.finalise', { invoice: invoice.id, issue_date: '2026-08-01' })
    const issued = await api(`invoices/${invoice.id}`)
    assert.equal(issued.subtotal_cents, native, 'Adopted billing preserves the same exact discount scope')
    const july = await report('normalized-mrr','2026-07')
    assert.deepEqual(july.series.map(row=>row.amountCents), [...Array(18).fill(expected),native], 'Source history and the adopted native series reconcile independently')
    await api('import.apply', { ...files, fingerprint: preview.fingerprint })
    await check('2026-07',native)
    for (const month of ['2026-06','2026-07']) {
      const value = await report('normalized-mrr',month)
      await onState({ label: `${mode}-${month}-report`, path: `/app/reports/normalized-mrr?period=${month}&customer=${customer}`, amount: value.totalCents })
      await onState({ label: `${mode}-${month}-source`, path: value.entries[0].href, amount: value.totalCents })
    }
  }
  await replacementDiscountFlow(h, owner)
  await meteredMembershipFlow(h, owner)
  console.log('Expanded and item discounts survive adoption, billing and replay; frozen source and native correction effects match approved reports')
}

async function regressionCapture(h, owner, tag, configure) {
  await h.api('business.configure', owner, { ...(await h.api('business', owner)), timezone: 'UTC' })
  await h.advanceClock('2026-08-01T16:00:00Z')
  const data = JSON.parse(JSON.stringify(stripeHistoryCapture()).replaceAll('synthetic-nectar-', `synthetic-nectar-${tag}-`))
  configure(data)
  const sub = data.subscriptions.data[0]
  data.subscription_events.data = [{ id: `synthetic-nectar-${tag}-created`, object: 'event', type: 'customer.subscription.created', created: sub.start_date, data: { object: structuredClone(sub) } }]
  for (const [name, value] of Object.entries(data)) if (name !== 'manifest') data.manifest.files[name].count = value.data.length
  const files = Object.fromEntries(Object.entries(data).map(([name, value]) => [name, file(`${name}.json`, JSON.stringify(value), 'application/json')]))
  const api = (path, body) => h.api(path, owner, body)
  const preview = await api('import.preview', files)
  await api('import.apply', { ...files, fingerprint: preview.fingerprint })
  const customer = (await api('customers')).find(row => row.external_id === sub.customer).id
  const subscription = (await api(`customers/${customer}`)).subscriptions[0].id
  return { api, customer, subscription }
}

// Folded into the existing normalized journey: one aggregate assertion covers
// the same scoped discount through reviewed replacements, reports and billing.
export async function replacementDiscountFlow(h, owner, onState = async () => {}) {
  const actual = [], expected = []
  for (const scope of ['product', 'item']) {
    const { api, customer, subscription } = await regressionCapture(h, owner, `replacement-${scope}`, data => {
      const sub = data.subscriptions.data[0], price = data.prices.data[0]
      price.metadata.nectar_kind = 'seat'
      sub.items.data[0].price = price
      const discount = { id: `synthetic-nectar-${scope}-discount`, start: sub.start_date, end: Date.parse('2026-10-01T00:00:00Z') / 1000,
        coupon: { id: `synthetic-nectar-${scope}-coupon`, percent_off: 10, duration: 'repeating', duration_in_months: 20,
          ...(scope === 'product' ? { applies_to: { products: [price.product] } } : {}) } }
      if (scope === 'product') sub.discounts = [discount]
      else {
        sub.items.data[0].discounts = [discount]
        sub.items.data.push({ id: 'synthetic-nectar-undiscounted-sibling', price, quantity: 1 })
      }
    })
    await api('subscription.adopt', { subscription, cutover_start: '2026-07-01', acknowledge_unreconciled: true })
    const previews = []
    let itemId = (await api(`subscriptions/${subscription}`)).amendments.find(row => row.item_id).item_id
    for (const [quantity, date] of [[2, '2026-07-01'], [3, '2026-08-01']]) {
      const change = await api('change.prepare', { subscription, item: itemId, quantity, effective_date: date })
      previews.push(change.preview.nextPeriod.cents)
      await api('change.decide', { change: change.change, decision: 'approved' })
      itemId = (await api(`subscriptions/${subscription}`)).items.find(row => row.change_id === change.change).id
    }
    const amounts = [], details = []
    for (const month of ['2026-06', '2026-07', '2026-08', '2026-10']) {
      const report = await api(`reports/normalized-mrr?period=${month}&customer=${customer}`)
      const detail = await api(report.entries[0].href.replace('/app/', ''))
      if (scope === 'product' && month === '2026-07') {
        await onState({label:'discounted-seat-report',path:`/app/reports/normalized-mrr?period=${month}&customer=${customer}`,amount:18000})
        await onState({label:'discounted-seat-source',path:report.entries[0].href,amount:18000})
      }
      amounts.push(report.totalCents)
      details.push([detail.totalCents, detail.normalized.snapshot.components.map(row => row.mrrCents).sort((a,b) => a-b)])
    }
    const run = await api('billrun.prepare', { period: '2026-07' })
    const invoice = (await api(`runs/${run.id}`)).invoices.find(row => row.subscription_id === subscription)
    await api('invoice.approve', { invoice: invoice.id, acknowledge: true })
    await api('invoice.finalise', { invoice: invoice.id, issue_date: '2026-08-01' })
    const billed = await api(`invoices/${invoice.id}`)
    actual.push({ scope, previews, amounts, details, billed: billed.subtotal_cents })
    const sibling = scope === 'item' ? 10000 : 0, values = [9000, 18000, 27000, 30000]
    expected.push({ scope, previews: [18000+sibling, 27000+sibling], amounts: values.map(n => n+sibling),
      details: values.map(n => [n+sibling, [...(sibling ? [sibling] : []), n].sort((a,b) => a-b)]), billed: 18000+sibling })
  }
  assert.deepEqual(actual, expected, 'Adopted scoped discounts follow repeated seat replacements, preserve sibling scope and expiry, and reconcile preview, source-traced MRR and issued money')
  return actual
}

export async function meteredMembershipFlow(h, owner, onState = async () => {}) {
  let sourcePrice
  const { api, customer, subscription } = await regressionCapture(h, owner, 'metered-membership', data => {
    const fixed = data.prices.data[0], meter = 'synthetic-nectar-membership-meter'
    sourcePrice = 'synthetic-nectar-membership-price'
    const metered = { ...fixed, id: sourcePrice, unit_amount: 3, recurring: { interval: 'month', interval_count: 1, usage_type: 'metered', meter } }
    data.meters.data.push({ id: meter, object: 'billing.meter', event_name: 'synthetic_nectar_membership', display_name: 'Research events', default_aggregation: { formula: 'sum' } })
    data.prices.data.push(metered)
    data.subscriptions.data[0].items.data.push({ id: 'synthetic-nectar-membership-item', price: metered, quantity: 1 })
  })
  const nativePrice = (await api(`subscriptions/${subscription}`)).items.find(row => row.kind === 'unit').price_id
  const actual = []
  for (const stage of ['captured', 'adopted']) {
    if (stage === 'adopted') await api('subscription.adopt', { subscription, cutover_start: '2026-07-01', acknowledge_unreconciled: true })
    for (const plan of [sourcePrice, nativePrice]) for (const metric of ['normalized-mrr', 'normalized-arr']) {
      const report = await api(`reports/${metric}?period=2026-07&customer=${customer}&plan=${plan}`)
      const details = await Promise.all(report.entries.map(row => api(row.href.replace('/app/', ''))))
      if (stage === 'adopted' && plan === sourcePrice && metric === 'normalized-mrr')
        await onState({label:'metered-plan-history',path:`/app/reports/${metric}?period=2026-07&customer=${customer}&plan=${plan}`,amount:10000})
      actual.push({ stage, plan, metric, series: report.series.map(row => row.amountCents),
        growth: report.saas.months.map(row => [row.newMrrCents, row.expansionMrrCents]),
        sources: details.map(row => [row.totalCents, row.components.map(component => component.amountCents)]) })
    }
  }
  const expected = actual.map(({ stage, plan, metric }) => {
    const amount = metric === 'normalized-mrr' ? 10000 : 120000
    return { stage, plan, metric, series: Array(19).fill(amount),
      growth: [[10000, 0], ...Array.from({length:18}, () => [0, 0])], sources: [[amount, [amount]]] }
  })
  assert.deepEqual(actual, expected, 'Metered-price filters retain the whole mixed subscription before and after adoption, with usage excluded from money and no false new growth at cutover')
  return actual
}
