import assert from 'node:assert/strict'
import { applyPolicy } from './policy-helper.mjs'

// USE-004 public-door historical evidence; financial execution remains open.
export async function usageReplayFlow(h, owner) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  await api('business.configure', { ...(await api('business')), timezone: 'UTC' })
  await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: 'CA', tax_mode: 'flat_rate', tax_rate: '10', tax_note: 'USE-004 saved historical tax' })
  await api('tax.review', { revision: (await api('business')).revision })
  const customer = (await api('customer.create', { external_id: 'USE004', name: 'Cedar Compute', billing_email: 'billing@cedar.example' })).id
  const source = await api('meter.create', { code: 'use004-snapshots', name: 'Recorded capacity', unit_label: 'units' })
  const events = [
    { event_id: 'use004-predecessor', quantity: '2', occurred_at: '2019-12-31T00:00:00Z' },
    { event_id: 'use004-original', quantity: '20', occurred_at: '2020-01-16T00:00:00Z' },
  ].map(e => ({ ...e, customer: 'USE004', meter: source.code, properties: { resource: 'one', user: 'one' } }))
  await api('usage.submit', { events })
  const prices = [], kinds = new Map()
  for (const aggregation of ['maximum', 'unique', 'latest', 'time_weighted']) {
    const request = await api('meter.prepare', { code: `use004-${aggregation}`, name: aggregation, unit_label: 'units', source_meter: source.id, definition: { aggregation, ...(aggregation === 'unique' ? { unique_property: 'user' } : {}), ...(aggregation === 'time_weighted' ? { entity_property: 'resource', time_unit: 'month' } : {}) } })
    for (const period of ['2019-11', '2019-12', '2020-01']) await api('meter.preview', { request: request.request, customer, period })
    const metric = await api('meter.activate', { request: request.request })
    const product = (await api('product.create', { code: `use004-${aggregation}`, name: `Recorded ${aggregation}` })).id
    const price = (await api('price.create', { product, kind: 'unit', meter: metric.id, unit_amount: '1', taxable: true })).id
    prices.push(price); kinds.set(price, aggregation)
  }
  const subscription = (await api('subscription.create', { customer, start_date: '2020-01-01', price: prices })).id
  const issued = []
  for (const period of ['2020-01', '2020-02']) {
    const run = await api('billrun.prepare', { period })
    const invoice = (await api(`runs/${run.id}`)).invoices.find(i => i.customer_id === customer)
    await api('invoice.approve', { invoice: invoice.id, acknowledge: true })
    await api('invoice.finalise', { invoice: invoice.id, issue_date: invoice.period_end })
    issued.push(await api(`invoices/${invoice.id}`))
  }
  const body = { subscription, from_period: '2020-01', through_period: '2020-02', void_event_ids: [], add_event_ids: [] }
  const snapshot = async () => ({ invoices: await Promise.all(issued.map(i => api(`invoices/${i.id}`))), batches: await api('usage/batches'), payments: await api('payments'), audit: await api('audit'), proposals: await api('proposals'), mails: h.mails.length })
  const original = await snapshot()
  const noChange = await api('usage.correction.preview', body)
  assert.deepEqual(noChange.delta, { subtotalCents: 0, taxCents: 0, totalCents: 0 }, 'USE-004 empty replay reproduces both issued invoices')
  assert.equal(noChange.status, 'unresolved', 'USE-004 a preview never claims disposition or resolution')
  assert.equal(noChange.scope, 'selected-issued-range-only', 'USE-004 downstream scope is explicit')
  assert.deepEqual(await snapshot(), original, 'USE-004 preview leaves all financial, usage, audit, proposal and message custody unchanged')

  // Later current policy cannot rewrite saved historical terms.
  await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: 'CA', tax_mode: 'flat_rate', tax_rate: '20', tax_note: 'USE-004 current tax differs' })
  await api('tax.review', { revision: (await api('business')).revision })
  const late = { ...events[1], event_id: 'use004-late-low', quantity: '5', occurred_at: '2020-01-20T00:00:00Z' }
  await api('usage.submit', { events: [late] })
  const beforeReplay = await snapshot()
  const replay = await api('usage.correction.preview', { ...body, add_event_ids: [late.event_id] })
  const lineDelta = (period, kind) => {
    const p = replay.periods[period], price = [...kinds].find(([, k]) => k === kind)[0]
    return p.after.lines.find(l => l.priceId === price).amountCents - p.before.lines.find(l => l.priceId === price).amountCents
  }
  assert.equal(lineDelta(0, 'maximum'), 0, 'USE-004 a late value below the original maximum adds zero')
  assert.equal(lineDelta(0, 'unique'), 0, 'USE-004 a repeated unique value adds zero')
  assert.equal(lineDelta(0, 'latest'), -1500, 'USE-004 late latest rerates the original window, not a new aggregate')
  assert.equal(lineDelta(0, 'time_weighted'), -581, 'USE-004 January predecessor and full 31-day window give 350/31 -> 170/31 units')
  assert.equal(lineDelta(1, 'latest'), 0, 'USE-004 latest uses in-window events only; an empty later window stays zero')
  assert.equal(lineDelta(1, 'time_weighted'), -1500, 'USE-004 corrected predecessor carries through leap February')
  assert.deepEqual(replay.delta, { subtotalCents: -3581, taxCents: -358, totalCents: -3939 }, 'USE-004 signed total and saved 10% tax are independently calculated across both periods')
  assert.ok(replay.periods.every(p => p.after.lines.some(l => [...(l.evidence.eventIds || []), ...(l.evidence.contextEventIds || [])].includes(late.event_id))), 'USE-004 original-period and predecessor evidence cite the selected late event')
  assert.deepEqual((await api('usage.correction.preview', { ...body, add_event_ids: [late.event_id] })), replay, 'USE-004 unchanged sources give identical fingerprints and complete replay')
  assert.deepEqual(await snapshot(), beforeReplay, 'USE-004 replay does not consume late events or change issued inputs')
  const run = await api('billrun.prepare', { period: '2020-03' })
  const blocked = (await api(`runs/${run.id}`)).invoices.find(i => i.customer_id === customer)
  assert.ok((await api(`invoices/${blocked.id}`)).exceptions.some(e => e.code === 'metric_late_correction'), 'USE-004 unresolved correction keeps the issue block')
  await api('invoice.approve', { invoice: blocked.id, acknowledge: true }, 409)

  const voided = await api('usage.correction.preview', { ...body, void_event_ids: ['use004-original'] })
  assert.equal(voided.periods[0].after.lines.find(l => kinds.get(l.priceId) === 'maximum').amountCents, 0, 'USE-004 proposed void removes the original maximum only in replay')
  assert.equal(voided.periods[0].after.lines.find(l => kinds.get(l.priceId) === 'time_weighted').amountCents, 200, 'USE-004 void restores the full prior state across January')
  assert.deepEqual(await Promise.all(issued.map(i => api(`invoices/${i.id}`))), original.invoices, 'USE-004 proposed void preserves all original issued evidence')

  await api('access.give', { email: 'use004-accountant@example.test', name: 'Replay Accountant', role: 'accountant' })
  const accountant = await h.signIn('use004-accountant@example.test', { requested: true })
  const readerKey = await api('credential.issue', { name: 'Replay reader', scopes: ['prepare'] })
  const usageKey = await api('credential.issue', { name: 'Replay ingestion', scopes: ['usage'] })
  for (const who of [accountant, { bearer: readerKey.key }]) assert.deepEqual((await h.api('usage.correction.preview', who, body)).delta, noChange.delta, 'USE-004 current read roles reach only a read-only preview')
  await h.api('usage.correction.preview', { bearer: usageKey.key }, body, 403)
  await h.api('usage.correction.preview', undefined, body, 401)
  await api('usage.correction.preview', { ...body, void_event_ids: ['missing'] }, 404)
  await api('usage.correction.preview', { ...body, void_event_ids: ['use004-original', 'use004-original'] }, 400)
  await api('usage.correction.preview', { ...body, add_event_ids: ['use004-original'] }, 409)
  await api('usage.correction.preview', { ...body, from_period: '2020-03' }, 400)
  await api('usage.correction.preview', { ...body, through_period: '2020-03' }, 409)
  const foreign = (await api('customer.create', { external_id: 'USE004-FOREIGN', name: 'Separate customer', billing_email: 'foreign@example.test' })).id
  await api('usage.submit', { events: [{ ...late, event_id: 'use004-foreign', customer: 'USE004-FOREIGN' }] })
  await api('usage.correction.preview', { ...body, add_event_ids: ['use004-foreign'] }, 404)
  await api('usage.submit', { events: [{ ...late, event_id: 'use004-outside', occurred_at: '2020-03-20T00:00:00Z' }] })
  await api('usage.correction.preview', { ...body, add_event_ids: ['use004-outside'] }, 409)
  const form = new URLSearchParams({ subscription, from_period: '2020-01', through_period: '2020-02', void_ids: '', add_ids: late.event_id })
  const html = await (await h.raw('/app/usage/replay', { cookie: owner, form })).text()
  assert.match(html, /Unresolved correction preview/, 'USE-004 HTML form renders the same unresolved evidence')
  assert.ok(html.includes('-39.39'), 'USE-004 HTML form agrees with API signed total')
  assert.equal((await h.raw('/app/usage/replay', { cookie: owner, form, headers: { origin: 'https://foreign.example' } })).status, 403, 'USE-004 cross-site form cannot reach replay')
  assert.match(await h.page(`/app/invoices/${issued[0].id}`, owner), /Preview usage correction/, 'USE-004 invoice links to historical replay')
  await h.page(`/app/usage/replay?subscription=${subscription}&period=2020-01`, accountant)

  // The acceptance-sized replay is real, while financial dispositions stay open.
  const bulkSource = await api('meter.create', { code: 'use004-bulk', name: 'Bulk events', unit_label: 'events' })
  const bulkProduct = (await api('product.create', { code: 'use004-bulk', name: 'Bulk processing' })).id
  const bulkPrice = (await api('price.create', { product: bulkProduct, kind: 'unit', meter: bulkSource.id, unit_amount: '0.01', taxable: false })).id
  const bulkSub = (await api('subscription.create', { customer: foreign, start_date: '2020-07-01', price: [bulkPrice] })).id
  const bulk = Array.from({ length: 10000 }, (_, i) => ({ event_id: `use004-bulk-${i}`, customer: 'USE004-FOREIGN', meter: bulkSource.code, quantity: '1', occurred_at: '2020-07-10T00:00:00Z' }))
  for (let i = 0; i < bulk.length; i += 5000) assert.equal((await api('usage.submit', { events: bulk.slice(i, i + 5000) })).accepted, 5000)
  const bulkRun = await api('billrun.prepare', { period: '2020-07' })
  const bulkInvoice = (await api(`runs/${bulkRun.id}`)).invoices.find(i => i.customer_id === foreign)
  await api('invoice.approve', { invoice: bulkInvoice.id, acknowledge: true })
  await api('invoice.finalise', { invoice: bulkInvoice.id, issue_date: '2020-08-01' })
  const savedBulk = await api(`invoices/${bulkInvoice.id}`)
  const bulkReplay = await api('usage.correction.preview', { subscription: bulkSub, from_period: '2020-07', through_period: '2020-07', void_event_ids: bulk.map(e => e.event_id), add_event_ids: [] })
  assert.deepEqual(bulkReplay.delta, { subtotalCents: -10000, taxCents: 0, totalCents: -10000 }, 'USE-004 10,000 proposed historical voids replay to the independent exact delta')
  assert.equal(bulkReplay.periods[0].eventIds.length, 10000, 'USE-004 acceptance-sized replay cites every original event')
  assert.deepEqual(await api(`invoices/${bulkInvoice.id}`), savedBulk, 'USE-004 10,000-event replay leaves July immutable')
  console.log('USE-004 historical range, 10,000-event void preview, maximum/unique/latest/time-weighted deltas, predecessor, tax, authority and unresolved blocking passed')
  return { subscription, invoice: issued[0].id, lateEvent: late.event_id, paths: [`/app/invoices/${issued[0].id}`, `/app/usage/replay?subscription=${subscription}&period=2020-01`] }
}
