import assert from 'node:assert/strict'
import { applyPolicy } from './policy-helper.mjs'
import { nativeCollectionEdge } from './native-collection.mjs'
import { totp } from './mfa.mjs'

let edge
export const harnessOptions = () => {
  edge = nativeCollectionEdge()
  return { stripeFetch: edge.fetch, stripeSecret: 'synthetic-nectar-1', localTime: '2026-10-22T10:00:00Z' }
}

// One real-money-record journey: every source is created through Worker HTTP,
// with only the processor boundary substituted, as in the collection journey.
export async function entitlementVisibilityFlow(h, owner, { onState = async () => {} } = {}) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  const email = label => [`synthetic-nectar-${label}`, 'example.test'].join(String.fromCharCode(64))
  let instant = Date.parse('2026-10-22T10:00:00Z')
  await api('business.configure', { ...await api('business'), timezone: 'UTC', payment_terms_days: 7 })
  const meter = await api('meter.create', { code: 'synthetic-nectar-visibility', name: 'Visibility requests', unit_label: 'requests' })
  const feature = 'synthetic-nectar-feature', shared = 'synthetic-nectar-shared'
  const products = [], prices = []
  for (let index = 0; index < 3; index++) {
    const product = (await api('product.create', { code: `synthetic-nectar-visibility-${index}`, name: `Visibility plan ${index}` })).id
    products.push(product)
    prices.push((await api('price.create', { product, kind: 'flat', unit_amount: index === 1 ? '20' : '100', taxable: false })).id)
    for (const name of index === 0 ? [feature, shared] : [index === 1 ? shared : feature]) {
      await api('feature.grant', { product, feature: name })
      await applyPolicy(h, owner, 'feature.policy', { product, feature: name, quota_policy: 'soft',
        numeric_limit: index === 0 ? '7.125001' : '0',
        ...(index === 0 ? { meter: meter.id, quota: '100', grace_days: 3 } : {}) })
    }
  }
  const records = []
  for (let index = 0; index < 2; index++) {
    const external = `synthetic-nectar-visibility-${index}`
    const customer = (await api('customer.create', { external_id: external, name: `Visibility customer ${index}`, billing_email: email(`customer-${index}`) })).id
    const subscription = (await api('subscription.create', { customer, start_date: '2026-09-01', anchor_day: 1, price: index ? [prices[2]] : prices.slice(0, 2) })).id
    await api('usage.submit', { events: [{ event_id: `${external}-usage`, customer: external, meter: meter.code, quantity: '12.5', occurred_at: '2026-10-21T12:00:00Z' }] })
    records.push({ customer, external, subscription, index })
  }
  const [grace, dunning] = records
  const readers = []
  const base = ['read.customers', 'read.catalog', 'read.subscriptions']
  for (const [name, capabilities] of [
    ['sales', null], ['neither', base], ['invoices', [...base, 'read.invoices']],
    ['payments', [...base, 'read.payments']], ['both', [...base, 'read.invoices', 'read.payments']],
  ]) {
    const role = capabilities ? await api('role.define', { name: `Visibility ${name}`, capabilities }) : null
    await api('access.give', { email: email(name), name: `Visibility ${name}`, role: role ? 'custom' : 'sales', ...(role ? { custom_role: role.id } : {}) })
    readers.push({ name, role, who: await h.signIn(email(name), { requested: true }), financial: name === 'both' })
  }
  // Snapshots are observed through public sources rather than seeded SQL.
  const sources = async () => ({
    invoices: await Promise.all(records.filter(r => r.invoice).map(r => api(`invoices/${r.invoice.id}`))),
    subscriptions: await Promise.all(records.map(r => api(`subscriptions/${r.subscription}?include_state=true`))),
    payments: await api('payments'), dunning: await api('dunning'), audit: await api('audit'),
  })
  const read = async (record, reader) => {
    const one = await h.api(`entitlements/${record.customer}?feature=${feature}`, reader.who)
    const all = await h.api(`entitlements/${record.external}`, reader.who)
    const nested = (await h.api(`customers/${record.customer}`, reader.who)).entitlements
    assert.deepEqual(all.find(row => row.feature === feature), one, 'Feature-specific and all-feature doors agree')
    assert.deepEqual(nested, all, 'Customer-nested entitlements use the identical capability projection')
    return all
  }
  const auditVisibility = (answers, record, reader, allowed, balance, restricted) => {
    const answer = answers.find(row => row.feature === feature), path = answer.paths[0]
    assert.equal(answer.allowed, allowed, `${reader.name}: independently expected access`)
    assert.equal(path.subscription, record.subscription)
    assert.equal(path.granted, allowed)
    assert.ok(path.steps.some(step => step.includes(prices[record.index ? 2 : 0])), 'The permitted immutable price explanation remains')
    assert.equal(path.numericLimit, allowed ? record.index ? '0.00' : '7.125001' : null)
    if (!record.index) {
      assert.equal(path.quota.used, '12.5')
      assert.equal(path.quota.remaining, '87.5')
      assert.equal(path.quota.limit, '100.00')
      assert.ok(path.steps.some(step => step.startsWith('Usage ')), 'Quota explanation remains readable')
      const alternative = answers.find(row => row.feature === shared)
      assert.equal(alternative.paths[0].decisions.length, 2, 'Multiple product decisions are actually inspected')
      assert.equal(alternative.allowed, true, 'A permitted alternative product still grants the shared feature')
      assert.equal(alternative.paths[0].decisions.find(row => row.product === products[1]).numericLimit, '0.00', 'The alternative zero limit remains an exact decision fact')
    }
    if (reader.financial) {
      assert.equal(path.state.payment.status, balance && instant >= Date.parse(record.invoice.due_date + 'T00:00:00Z') ? 'past_due' : 'current')
      assert.equal(path.payment.restricted, restricted)
      const expected = restricted ? [{ id: record.invoice.id, number: record.invoice.number, dueDate: record.invoice.due_date, balanceCents: balance }] : []
      assert.deepEqual(path.payment.invoices, expected, 'Authorized readers retain exact independently reconciled invoice evidence')
      assert.deepEqual(path.decisions[0].payment.invoices, expected)
      if (restricted) assert.ok(path.steps.some(step => step.includes(record.invoice.number)))
      if (reader.name !== 'owner') assert.deepEqual(Object.keys(path.state.payment), ['status'], 'Financial readers retain their existing non-owner state projection')
    } else {
      // Walk every nested branch, including duplicated explanations and the
      // multi-product case; do not rely on an empty top-level payment object.
      const inspect = value => {
        if (Array.isArray(value)) return value.forEach(inspect)
        if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
          assert.ok(!['payment', 'invoices', 'failures', 'balanceCents', 'dueDate', 'graceDays'].includes(key), `${reader.name}: financial evidence key ${key} is absent throughout entitlements`)
          inspect(child)
        }
      }
      inspect(answers)
      if (record.invoice) {
        const serialized = JSON.stringify(answers)
        for (const fact of [record.invoice.id, record.invoice.number, record.invoice.due_date]) assert.ok(!serialized.includes(fact), `${reader.name}: forbidden invoice facts never enter nested JSON or explanation strings`)
      }
      if (restricted) assert.ok(path.steps.some(step => step.includes('restricted')), 'Restriction remains explainable without financial evidence')
    }
  }
  const observe = async (label, expectations) => {
    const before = await sources(), writes = edge.calls.length
    for (const record of records) {
      const [allowed, balance, restricted] = expectations[record.index]
      if (record.invoice) {
        const invoice = await api(`invoices/${record.invoice.id}`)
        assert.equal(invoice.total_cents, record.index ? 10000 : 12000)
        assert.equal(invoice.paidCents, record.paid ?? 0)
        assert.equal(invoice.balanceCents, balance, 'Original invoice cents minus independently recorded allocations equals debt')
      }
      for (const reader of [...readers, { name: 'owner', who: owner, financial: true }]) auditVisibility(await read(record, reader), record, reader, allowed, balance, restricted)
    }
    assert.deepEqual(await sources(), before, 'Entitlement reads mutate no financial or lifecycle source or audit')
    assert.equal(edge.calls.length, writes, 'Entitlement reads make no provider request')
    await onState({ label, records, readers, feature, shared })
    console.log(`PROBE ENT-001 ${label}: feature-specific, all-feature and customer-nested HTTP -> correct access and capability projection; sources unchanged`)
  }
  // No invoice is a genuine current control, rather than an empty restriction list.
  await observe('current', [[true, 0, false], [true, 0, false]])
  const run = await api('billrun.prepare', { period: '2026-09' })
  for (const record of records) {
    const invoice = (await api(`runs/${run.id}`)).invoices.find(row => row.subscription_id === record.subscription)
    await api('invoice.approve', { invoice: invoice.id, acknowledge: true })
    await api('invoice.finalise', { invoice: invoice.id, issue_date: '2026-10-22' })
    record.invoice = await api(`invoices/${invoice.id}`)
    assert.equal(record.invoice.due_date, '2026-10-29')
  }
  await observe('issued-not-due', [[true, 12000, false], [true, 10000, false]])
  const factor = await api('mfa.totp.start', {})
  await api('mfa.totp.confirm', { factor: factor.factor, code: totp(factor.secret, instant) })
  await api('collection.customer.bind', { customer: dunning.customer, account_ref: 'synthetic-nectar-native-account-1', stripe_customer_ref: 'synthetic-nectar-native-customer-1', confirm: true })
  const request = await api('collection.prepare', { invoice: dunning.invoice.id })
  edge.refuseNext('insufficient_funds')
  await api('collection.confirm', { ...request.instructions.confirm, confirm: true })
  const policy = await api('dunning.policy.create', { name: 'Visibility restriction', scope: 'default', scope_ref: '', offsets: '0', end_day: 10, end_action: 'restrict', confirm: true })
  const series = await api('dunning.enroll', { invoice: dunning.invoice.id, policy: policy.id, confirm: true })
  const move = async date => { instant = Date.parse(date); await h.advanceClock(date); await api('mfa.verify', { code: totp(factor.secret, instant) }) }
  await move('2026-10-30T10:00:00Z')
  await observe('overdue-within-grace', [[true, 12000, false], [true, 10000, false]])
  await move('2026-11-01T10:00:00Z')
  await api('dunning.end', { series: series.id, action: 'restrict', confirm: true })
  // October usage no longer applies in November; keep expected quota explicit.
  await api('usage.submit', { events: [{ event_id: 'synthetic-nectar-visibility-november', customer: grace.external, meter: meter.code, quantity: '12.5', occurred_at: '2026-11-01T09:00:00Z' }] })
  await observe('grace-and-owner-restricted', [[false, 12000, true], [false, 10000, true]])
  const evolving = readers.find(row => row.name === 'neither')
  for (const [revision, capabilities, financial] of [
    [1, [...base, 'read.invoices', 'read.payments'], true], [2, [...base, 'read.payments'], false],
    [3, [...base, 'read.invoices'], false], [4, base, false],
  ]) {
    await api('role.update', { role: evolving.role.id, revision, capabilities })
    auditVisibility(await read(grace, { ...evolving, financial }), grace, { ...evolving, financial }, false, 12000, true)
  }
  // Recorded funds alone cannot restore access; only the separately allocated cents do.
  for (const record of records) {
    const amount = record.index ? '100' : '120'
    const payment = await api('payment.record', { customer: record.customer, amount, received_on: '2026-11-01', method: 'bank_transfer', reference: `synthetic-nectar-visibility-payment-${record.index}` })
    await observe(`unallocated-${record.index}`, [record.index ? [true, 0, false] : [false, 12000, true], [false, 10000, true]])
    await api('payment.allocate', { payment: payment.payment, invoice: record.invoice.id, amount })
    record.paid = record.index ? 10000 : 12000
    if (!record.index) {
      const partiallyRestored = await read(grace, readers[0])
      auditVisibility(partiallyRestored, grace, readers[0], true, 0, false)
    }
  }
  await observe('allocation-restored', [[true, 0, false], [true, 0, false]])
  const credential = await api('credential.issue', { name: 'Visibility application reader', scopes: ['prepare'] })
  const application = { bearer: credential.key }
  const path = `entitlements/${grace.customer}?feature=${feature}`
  assert.equal((await h.api(path, application)).allowed, true)
  await api('credential.revoke', { key: credential.id })
  const before = await sources()
  for (const door of [path, `entitlements/${grace.customer}`, `customers/${grace.customer}`]) await h.api(door, application, undefined, 401)
  assert.deepEqual(await sources(), before, 'Revoked application reads expose no data and mutate no source')
  console.log('PROBE ENT-001 revoked-credential: all three HTTP doors -> 401; sources unchanged')

  // Erasure withdraws operational access even though invoices and allocations
  // remain in the required financial retention store.
  const peerBefore = await read(dunning, readers[0])
  const erasure = await api('erasure.request', { customer: grace.customer })
  const message = h.mails.findLast(mail => [mail.to].flat().includes(email('customer-0')))
  const confirmation = `${message.text ?? ''} ${message.html ?? ''}`.match(/https?:\/\/[^\s"<]+\/erase\/[a-f0-9]{64}/)[0]
  assert.equal((await h.raw(new URL(confirmation).pathname, { form: new URLSearchParams({ confirm: 'yes' }) })).status, 200)
  await api('erasure.approve', { request: erasure.id, confirm: true })
  const retained = async () => ({
    invoices: await Promise.all(records.map(record => api(`invoices/${record.invoice.id}`))),
    payments: await api('payments'), dunning: await api('dunning'), audit: await api('audit'),
  })
  const retainedBefore = await retained(), providerCalls = edge.calls.length
  assert.equal(retainedBefore.invoices[0].paidCents, 12000)
  assert.equal(retainedBefore.invoices[0].balanceCents, 0)
  for (const reader of [...readers, { name: 'owner', who: owner }]) {
    const refusal = await h.api(`entitlements/${grace.customer}?feature=${feature}`, reader.who, undefined, 410)
    assert.equal(refusal.error, 'customer_erased', 'An erased operational entitlement is withdrawn for every role')
    assert.deepEqual(await h.api(`entitlements/${grace.customer}`, reader.who), [], 'Retained financial records confer no current feature grants')
    const customer = await h.api(`customers/${grace.customer}`, reader.who)
    assert.deepEqual(customer.entitlements, [], 'The nested door agrees with the withdrawn entitlement list')
    assert.deepEqual(await h.api(`entitlements/${customer.external_id}`, reader.who), [], 'The erased external alias cannot reopen retained grants')
    await h.api(`entitlements/${grace.external}?feature=${feature}`, reader.who, undefined, 404)
  }
  assert.deepEqual(await retained(), retainedBefore, 'Erased entitlement reads preserve retained money and audit evidence')
  await onState({ label: 'erased', records, readers, feature, shared })
  const replay = await api('usage.submit', { events: [{ event_id: `${grace.external}-usage`, customer: grace.external, meter: meter.code, quantity: '12.5', occurred_at: '2026-10-21T12:00:00Z' }] })
  assert.equal(replay.accepted, 0)
  assert.equal(replay.rejected, 1, 'A replayed pre-erasure capture cannot recreate the old customer identity')
  await api('payment.record', { customer: grace.customer, amount: '120', received_on: '2026-11-01', method: 'bank_transfer', reference: 'synthetic-nectar-visibility-payment-0' }, 409)
  await api(`entitlements/${grace.customer}?feature=${feature}`, undefined, 410)
  assert.deepEqual(await api(`entitlements/${grace.customer}`), [])
  assert.deepEqual((await retained()).invoices, retainedBefore.invoices, 'Replayed captures cannot change retained invoice balances')
  assert.deepEqual((await retained()).payments, retainedBefore.payments, 'Replayed captures record no new received funds')
  assert.deepEqual(await read(dunning, readers[0]), peerBefore, 'Erasure leaves the unrelated customer access decision unchanged')
  assert.equal(edge.calls.length, providerCalls, 'Erasure and replay qualification issues no provider request')
  console.log('PROBE ENT-001 erased-and-replayed: feature HTTP -> 410, all-feature and nested HTTP -> empty; old capture rejected, retained money and peer unchanged')
}
