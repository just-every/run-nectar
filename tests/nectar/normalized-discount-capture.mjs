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
  console.log('Expanded and item discounts survive adoption, billing and replay; frozen source and native correction effects match approved reports')
}
