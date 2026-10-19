import assert from 'node:assert/strict'
import { applyPolicy } from './policy-helper.mjs'
import { metricNegative } from './metric-negative.mjs'
import { metricChanges } from './metric-changes.mjs'
import { metricPricing } from './metric-pricing.mjs'
import { metricsSql } from './metrics-sql.mjs'

const months = ['2020-01', '2020-02', '2020-03']
// Independent hand calculations, alpha then beta. Time-weighted values use
// actual month lengths: January 31, leap February 29, March 31 days.
const expected = {
  sum: [[[10,1],[5,1]], [[8,1],[7,1]], [[1,1],[2,1]]],
  count: [[[2,1],[1,1]], [[1,1],[1,1]], [[1,1],[1,1]]],
  maximum: [[[6,1],[5,1]], [[8,1],[7,1]], [[1,1],[2,1]]],
  unique: [[[2,1],[1,1]], [[1,1],[1,1]], [[1,1],[1,1]]],
  latest: [[[6,1],[5,1]], [[8,1],[7,1]], [[1,1],[2,1]]],
  time_weighted: [[[126,31],[85,31]], [[204,29],[105,29]], [[136,31],[137,31]]],
}
const checkPreview = (preview, values, label) => {
  assert.equal(preview.results.length, 2, `USE-002 ${label} returns both exact dimension groups`)
  for (const [index, model] of ['alpha', 'beta'].entries()) {
    const result = preview.results.find(row => row.dimensions.model === model)
    assert.ok(result, `USE-002 ${label} identifies ${model}`)
    assert.deepEqual(result.exact, { numerator: String(values[index][0]), denominator: String(values[index][1]) }, `USE-002 ${label} ${model} retains the hand-calculated rational`)
    assert.ok(Math.abs(Number(result.quantity) - values[index][0] / values[index][1]) <= 0.0000005, `USE-002 ${label} ${model} display agrees with exact quantity`)
  }
}
// Integer cents independently calculated from a rational and a six-place USD
// price, with one positive half-up rounding at the financial boundary.
const cents = ([n, d], rate) => Number((BigInt(n) * BigInt(rate) * 100n * 2n + BigInt(d) * 1000000n) / (2n * BigInt(d) * 1000000n))

export async function metricsFlow(h, owner) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  const business = await api('business')
  await api('business.configure', { ...business, timezone: 'UTC' })
  await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: 'CA', tax_mode: 'no_tax', tax_note: 'USE-002 independent metric arithmetic' })
  await api('tax.review', { revision: (await api('business')).revision })
  await api('access.give', { email: 'use002-accountant@example.test', name: 'Metric Accountant', role: 'accountant' })
  const accountant = await h.signIn('use002-accountant@example.test', { requested: true })
  const prepareKey = await api('credential.issue', { name: 'USE002 preview', scopes: ['prepare'] })
  const usageKey = await api('credential.issue', { name: 'USE002 ingestion', scopes: ['usage'] })
  const agent = { bearer: prepareKey.key }, ingestion = { bearer: usageKey.key }
  const customer = (await api('customer.create', { external_id: 'USE002-STREAM', name: 'Metric Research', billing_email: 'ap@metrics.example' })).id
  const source = await api('meter.create', { code: 'use002-raw', name: 'USE002 immutable snapshots', unit_label: 'GB' })
  const snapshots = [
    ['dec-alpha','2019-12-31T00:00:00Z','alpha','2','a',true,'prior','1'],
    ['dec-beta','2019-12-31T00:00:00Z','beta','3','b',true,'prior','1'],
    ['jan-alpha-a','2020-01-16T00:00:00Z','alpha','4','a',true,'7','2'],
    ['jan-alpha-z','2020-01-16T00:00:00Z','alpha','6','a',true,7,'0.5'],
    ['jan-beta','2020-01-16T00:00:00Z','beta','5','b',true,'u1','2'],
    ['jan-beta-reset','2020-01-24T00:00:00Z','beta','9','b',false,'ignored','1'],
    ['feb-alpha','2020-02-15T00:00:00Z','alpha','8','a',true,'u1','2'],
    ['feb-beta','2020-02-15T00:00:00Z','beta','7','b',true,'u2','1'],
    ['mar-alpha','2020-03-16T00:00:00Z','alpha','1','a',true,'u3','0.5'],
    ['mar-beta','2020-03-16T00:00:00Z','beta','2','b',true,'u2','3'],
  ]
  const events = snapshots.map(([id, occurred_at, model, quantity, resource, active, user, weight]) => ({ event_id: `use002-${id}`, occurred_at, customer: 'USE002-STREAM', meter: source.code, quantity, properties: { model, resource, active, user, weight, seats: 7, optional: null } }))
  assert.equal((await h.api('usage.submit', ingestion, { events })).accepted, events.length, 'USE-002 scalar properties and decimal strings enter the real source stream')
  const reordered = { ...events[2], properties: Object.fromEntries(Object.entries(events[2].properties).reverse()) }
  assert.equal((await api('usage.submit', { events: [reordered] })).duplicates, 1, 'USE-002 property key order preserves replay identity')
  assert.equal((await api('usage.submit', { events: [{ ...events[2], properties: { ...events[2].properties, active: false } }] })).rejected, 1, 'USE-002 changed properties cannot reuse an event id')
  assert.equal((await api('usage.submit', { events: [{ ...events[2], event_id: 'use002-nested', properties: { nested: { hidden: true } } }] })).rejected, 1, 'USE-002 nested properties cannot enter metric inputs')
  const metrics = [], prices = [], priceSpecs = new Map()
  for (const aggregation of Object.keys(expected)) {
    const body = { code: `use002-${aggregation}`, name: `USE002 ${aggregation}`, unit_label: 'units', source_meter: source.id, definition: { aggregation, group_by: ['model'], filters: [{ property: 'active', operator: '=', value: true }], ...(aggregation === 'unique' ? { unique_property: 'user' } : {}), ...(aggregation === 'time_weighted' ? { entity_property: 'resource', time_unit: 'month' } : {}) } }
    const request = await api('meter.prepare', body)
    if (aggregation === 'sum') {
      for (const who of [accountant, agent]) {
        await h.api('meter.prepare', who, body, 403)
        await h.api('meter.activate', who, { request: request.request }, 403)
      }
      await h.api('meter.prepare', undefined, body, 401)
      await h.api('meter.activate', undefined, { request: request.request }, 401)
      await h.api('meter.preview', ingestion, { request: request.request, customer, period: months[0] }, 403)
      await h.api('meter.preview', undefined, { request: request.request, customer, period: months[0] }, 401)
      await api('meter.activate', { request: request.request }, 409)
    }
    const previews = []
    for (const [index, period] of months.entries()) {
      const preview = await h.api('meter.preview', index === 0 ? accountant : index === 1 ? agent : owner, { request: request.request, customer, period })
      checkPreview(preview, expected[aggregation][index], `${aggregation} ${period}`)
      previews.push(preview)
      if (aggregation === 'sum' && index === 1) await api('meter.activate', { request: request.request }, 409)
    }
    if (aggregation === 'time_weighted') {
      assert.deepEqual(previews[0].results.find(row => row.dimensions.model === 'alpha').contextEventIds, ['use002-dec-alpha'], 'USE-002 January time-weighting retains its preperiod snapshot')
      assert.ok(!previews[1].results.find(row => row.dimensions.model === 'beta').contextEventIds.length, 'USE-002 a filtered-out snapshot resets the prior beta state to zero')
      assert.deepEqual((await api('meter.preview', { request: request.request, customer, period: '2019-11' })).results, [], 'USE-002 empty grouped history has no invented snapshots or quantities')
    }
    const metric = await api('meter.activate', { request: request.request })
    metrics.push({ ...metric, aggregation, body, previews })
    for (const [index, model] of ['alpha', 'beta'].entries()) {
      const product = (await api('product.create', { code: `use002-${aggregation}-${model}`, name: `USE002 ${aggregation} ${model}` })).id
      const price = await api('price.create', { product, kind: 'unit', meter: metric.id, dimensions: { model }, unit_amount: index ? '0.654321' : '0.123456', taxable: false })
      prices.push(price.id); priceSpecs.set(price.id, { aggregation, model, index, rate: index ? 654321 : 123456, metric })
    }
  }
  const sqlMeters = await metricsSql(h, owner, { source, customer, months, expected, checkPreview })
  await api('subscription.create', { customer, start_date: '2020-01-01', price: [prices[0], prices[0]] }, 409)
  const subscription = (await api('subscription.create', { customer, start_date: '2020-01-01', price: prices })).id
  await api('subscription.create', { customer, start_date: '2020-01-01', price: [prices[0]] }, 409)
  const extraProduct = (await api('product.create', { code: 'use002-dimension-validation', name: 'Dimension validation' })).id
  for (const dimensions of [{}, { model: 'alpha', extra: 'unused' }]) await api('price.create', { product: extraProduct, kind: 'unit', meter: metrics[0].id, dimensions, unit_amount: '1' }, 400)
  const flat = (await api('price.create', { product: extraProduct, kind: 'flat', unit_amount: '1' })).id
  const rival = (await api('subscription.create', { customer, start_date: '2020-01-01', price: [flat] })).id
  await api('subscription.addon', { subscription: rival, price: prices[2], effective_date: '2020-01-16' }, 409)
  const ownDraft = async run => {
    const candidates = (await api(`runs/${run}`)).invoices.filter(row => row.customer_id === customer)
    const details = await Promise.all(candidates.map(row => api(`invoices/${row.id}`)))
    const draft = details.find(row => row.subscription_id === subscription)
    assert.ok(draft, 'USE-002 bill run identifies the shared-source subscription independently of other customer plans')
    return draft
  }
  const invoices = []
  for (const [index, month] of months.entries()) {
    const upcoming = await api(`subscriptions/${subscription}/upcoming?period=${month}`)
    const inspection = await api(`usage/inspect?period=${month}`)
    const inspected = inspection.subscriptions.find(row => row.subscription === subscription)
    assert.ok(inspected, `USE-002 ${month} inspection finds the source-owning subscription`)
    for (const spec of priceSpecs.values()) {
      const row = inspected.meters.find(row => row.meter === spec.metric.code && row.dimensions.model === spec.model)
      assert.ok(row, `USE-002 ${month} inspection exposes ${spec.aggregation}/${spec.model}`)
      assert.ok(Math.abs(Number(row.total) - expected[spec.aggregation][index][spec.index][0] / expected[spec.aggregation][index][spec.index][1]) <= 0.0000005, `USE-002 ${month} inspected derived quantity agrees with preview`)
    }
    const run = await api('billrun.prepare', { period: month })
    let draft = await ownDraft(run.id)
    assert.equal(draft.source_fingerprint,upcoming.calculation.fingerprint,`USE-002 ${month} inspection and preparation preserve the same exact source basis`)
    if(index===0){const repeated=await api('billrun.prepare',{period:month});const again=await ownDraft(repeated.id);assert.equal(again.source_fingerprint,draft.source_fingerprint,'USE-002 re-preparation with unchanged inputs preserves the fingerprint');assert.deepEqual(again.lines.map(l=>[l.price_id,l.quantity,l.amount_cents,l.evidence]),draft.lines.map(l=>[l.price_id,l.quantity,l.amount_cents,l.evidence]),'USE-002 re-preparation retains every grouped exact quantity and amount');draft=again}
    const id=draft.id
    const total = [...priceSpecs.values()].reduce((sum, spec) => sum + cents(expected[spec.aggregation][index][spec.index], spec.rate), 0)
    assert.equal(upcoming.calculation.totalCents, total, `USE-002 ${month} upcoming multiplies exact rational quantities before monetary rounding`)
    assert.equal(draft.total_cents, total, `USE-002 ${month} draft independently reconciles all metric/model prices`)
    await api('invoice.approve', { invoice: id, acknowledge: true })
    await api('invoice.finalise', { invoice: id, issue_date: draft.period_end })
    const invoice = await api(`invoices/${id}`)
    invoices.push(invoice)
    assert.equal(invoice.lines.length, prices.length, `USE-002 ${month} bills each metric and model once`)
    assert.equal(new Set(invoice.calculation.consumedEvents).size, invoice.calculation.consumedEvents.length, `USE-002 ${month} sharing one source never consumes an event twice`)
    for (const line of invoice.lines) {
      const spec = priceSpecs.get(line.price_id), value = expected[spec.aggregation][index][spec.index]
      assert.equal(line.kind, 'metric_usage', `USE-002 ${month} retains derived usage classification`)
      assert.equal(line.amount_cents, cents(value, spec.rate), `USE-002 ${month} ${spec.aggregation}/${spec.model} has independently rounded cents`)
      assert.deepEqual(line.evidence.exactQuantity, { numerator: String(value[0]), denominator: String(value[1]) }, `USE-002 ${month} issued evidence freezes exact rational quantity`)
      assert.deepEqual(line.evidence.dimensions, { model: spec.model }, `USE-002 ${month} issued evidence freezes the typed model dimension`)
      assert.equal(line.evidence.sourceMeter, source.id, `USE-002 ${month} derived evidence identifies its shared raw source`)
      const drill = await api(`invoices/${id}/lines/${line.id}`)
      assert.deepEqual(drill.line.evidence, line.evidence, `USE-002 ${month} report-line drill retains the issued aggregation evidence`)
      for (const event of drill.events) assert.deepEqual(event.properties, events.find(row => row.event_id === event.eventId).properties, `USE-002 ${event.eventId} report drill retains immutable raw properties`)
      assert.deepEqual(drill.events.map(row => row.eventId).sort(), [...line.evidence.eventIds, ...line.evidence.contextEventIds].sort(), `USE-002 ${month} report drill reaches selected raw and predecessor events`)
    }
    assert.equal((await api(`reports/mrr?period=${month}&customer=${customer}`)).totalCents, total, `USE-002 ${month} report totals reconcile to issued metric lines`)
  }
  const pricingFixture=await metricPricing(h,owner,{source,timeWeightedMeter:metrics.find(m=>m.aggregation==='time_weighted')})
  const changesFixture=await metricChanges(h,owner,{source,timeWeightedMeter:metrics.find(m=>m.aggregation==='time_weighted')})
  const negativeFixture=await metricNegative(h,owner,{source})
  const version = await api('meter.prepare', { ...metrics[0].body, definition: { ...metrics[0].body.definition, value_property: 'weight' } })
  const weighted = [[[5,2],[2,1]], [[2,1],[1,1]], [[1,2],[3,1]]]
  for (const [index, period] of months.entries()) checkPreview(await api('meter.preview', { request: version.request, customer, period }), weighted[index], `sum v2 ${period}`)
  const v2 = await api('meter.activate', { request: version.request })
  assert.notEqual(v2.id, metrics[0].id, 'USE-002 changing a definition creates a distinct immutable metric version')
  const catalogue = await api('catalog')
  assert.equal(catalogue.prices.find(row => row.id === prices[0]).meter_id, metrics[0].id, 'USE-002 publishing v2 preserves the old price metric binding')
  const stale = await api('meter.prepare', { ...metrics[1].body, code: 'use002-stale' })
  for (const period of months) await api('meter.preview', { request: stale.request, customer, period })
  await api('usage.submit', { events: [{ ...events[6], event_id: 'use002-late-correction', quantity: '100', properties: { ...events[6].properties, user: 'new-user' } }] })
  await api('meter.activate', { request: stale.request }, 409)
  const nextRun = await api('billrun.prepare', { period: '2020-04' })
  const correction = await ownDraft(nextRun.id)
  assert.ok(correction.exceptions.some(row => row.code === 'metric_late_correction'), 'USE-002 late nonadditive usage requires correction of the original issued window')
  await api('invoice.approve', { invoice: correction.id, acknowledge: true }, 409)
  for (const invoice of invoices) assert.deepEqual((await api(`invoices/${invoice.id}`)).calculation, invoice.calculation, 'USE-002 new versions and late corrections preserve every issued calculation')
  await api('subscription.cancel', { subscription, revision: (await api(`subscriptions/${subscription}`)).revision, mode: 'immediate', effective_date: '2020-05-01', reason: 'USE002 release raw source ownership' })
  await api('subscription.create', { customer, start_date: '2020-05-01', price: [prices[0]] })
  await api('subscription.reactivate', { subscription, revision: (await api(`subscriptions/${subscription}`)).revision, effective_date: '2020-05-02', reason: 'USE002 source already reused' }, 409)
  await api('credential.revoke', { key: prepareKey.id })
  await api('credential.revoke', { key: usageKey.id })
  console.log('USE-002 native/SQL metrics, exact grouped billing, predecessor/reset/tie semantics, immutable properties and versions, preview activation, source ownership and late correction passed')
  return { customer, subscription, source,pricingFixture,changesFixture,negativeFixture, metrics: metrics.map(({ id, code, aggregation }) => ({ id, code, aggregation })), sqlMeters, invoices: invoices.map(row => row.id), paths: [`/app/subscriptions/${subscription}`, `/app/invoices/${invoices[0].id}`, '/app/usage?period=2020-01'] }
}
