import { publishPrice } from './price-helper.mjs'
// CAT-002: real catalogue -> subscriptions -> usage -> bill run -> invoices.
// Hand-computed dollars below retain every fractional cent until the line
// rounds. Both seats and usage use the same commercial terms and expectations.
import assert from 'node:assert/strict'

const quantities = ['0', '1', '1000', '1001', '2500000']
const band = (tier, quantity, unitAmount, flatAmount, amountExact, extra = {}) => ({
  tier, fromExclusive: tier === 1 ? '0.00' : '1000.00', upTo: tier === 1 ? '1000.00' : null,
  quantity, unitAmount, flatAmount, amountExact, ...extra,
})
const terms = {
  graduated: {
    tiers: [{ up_to: '1000', unit_amount: '0.002', flat_amount: '0.006' }, { up_to: null, unit_amount: '0.0014', flat_amount: '0.006' }],
    cents: [0, 1, 201, 201, 350061], exact: ['0.00', '0.008', '2.006', '2.0134', '3500.612'],
    breakdown: [[], [band(1, '1.00', '0.002', '0.006', '0.008')], [band(1, '1000.00', '0.002', '0.006', '2.006')],
      [band(1, '1000.00', '0.002', '0.006', '2.006'), band(2, '1.00', '0.0014', '0.006', '0.0074')],
      [band(1, '1000.00', '0.002', '0.006', '2.006'), band(2, '2499000.00', '0.0014', '0.006', '3498.606')]],
  },
  volume: {
    tiers: [{ up_to: '1000', unit_amount: '0.002', flat_amount: '0.006' }, { up_to: null, unit_amount: '0.0014', flat_amount: '0.016' }],
    cents: [0, 1, 201, 142, 350002], exact: ['0.00', '0.008', '2.006', '1.4174', '3500.016'],
    breakdown: [[], [band(1, '1.00', '0.002', '0.006', '0.008')], [band(1, '1000.00', '0.002', '0.006', '2.006')],
      [band(2, '1001.00', '0.0014', '0.016', '1.4174')], [band(2, '2500000.00', '0.0014', '0.016', '3500.016')]],
  },
  package: {
    tiers: [{ up_to: null, unit_amount: '1.234567', flat_amount: '0.006' }], package_size: '1000',
    cents: [0, 124, 124, 248, 308642], exact: ['0.00', '1.240567', '1.240567', '2.475134', '3086.4235'],
    breakdown: [[], ...[
      ['1.00', '1', '1.240567'], ['1000.00', '1', '1.240567'], ['1001.00', '2', '2.475134'], ['2500000.00', '2500', '3086.4235'],
    ].map(([quantity, blocks, exact]) => [band(1, quantity, '1.234567', '0.006', exact, { upTo: null, blocks, packageSize: '1000.00' })])],
  },
  stair_step: {
    tiers: [{ up_to: '1000', flat_amount: '7.005' }, { up_to: null, flat_amount: '15.005' }],
    cents: [0, 701, 701, 1501, 1501], exact: ['0.00', '7.005', '7.005', '15.005', '15.005'],
    breakdown: [[], [band(1, '1.00', '0.00', '7.005', '7.005')], [band(1, '1000.00', '0.00', '7.005', '7.005')],
      [band(2, '1001.00', '0.00', '15.005', '15.005')], [band(2, '2500000.00', '0.00', '15.005', '15.005')]],
  },
}

export async function pricingModels(h, cookie) {
  const api = (path, body, status) => h.api(path, cookie, body, status)
  const createCustomer = async suffix => api('customer.create', { external_id: `CAT002-${suffix}`, name: `CAT002 ${suffix}`, billing_email: 'billing@example.test', tax_exempt: true, tax_exempt_ref: 'CAT002 certificate' })
  const product = await api('product.create', { code: 'cat002-simple', name: 'CAT002 simple seats' })
  const simplePrice = await api('price.create', { product: product.id, kind: 'seat', unit_amount: '1' })
  const legacyCustomer = await createCustomer('legacy')
  await api('subscription.create', { customer: legacyCustomer.id, start_date: '2026-05-01', price: [simplePrice.id], quantity: ['1'] })
  const invoicesFor = async run => (await api(`runs/${run}`)).invoices
  const firstRun = await api('billrun.prepare', { period: '2026-05' })
  const legacyBefore = await api(`invoices/${(await invoicesFor(firstRun.id)).find(row => row.customer_id === legacyCustomer.id).id}`)

  const prices = [], specs = new Map(), meters = []
  for (const [model, term] of Object.entries(terms)) for (const kind of ['seat', 'unit']) {
    const product = await api('product.create', { code: `cat002-${model}-${kind}`, name: `CAT002 ${model} ${kind}` })
    const meter = kind === 'unit' ? await api('meter.create', { code: `cat002-${model}`, name: `CAT002 ${model}`, unit_label: 'units' }) : null
    const body = { product: product.id, kind, pricing_model: model, tiers: term.tiers, ...(term.package_size ? { package_size: term.package_size } : {}), ...(meter ? { meter: meter.id } : {}) }
    const price = await api('price.create', body)
    prices.push({ ...price, model, kind, body }); specs.set(price.id, term)
    if (meter) meters.push({ meter: meter.id, code: `cat002-${model}` })
  }

  // A malformed band must be refused at creation, rather than leaking into a bill.
  const base = { product: product.id, kind: 'unit', meter: meters[0].meter, pricing_model: 'graduated' }
  const invalid = [
    { tiers: [] },
    { tiers: [{ up_to: '1000', unit_amount: '1' }] },
    { tiers: [{ up_to: null, unit_amount: '1' }, { up_to: null, unit_amount: '2' }] },
    { tiers: [{ up_to: '0', unit_amount: '1' }, { up_to: null, unit_amount: '1' }] },
    { tiers: [{ up_to: '1000', unit_amount: '1' }, { up_to: '999', unit_amount: '1' }, { up_to: null, unit_amount: '1' }] },
    { tiers: [{ up_to: 1000, unit_amount: '1' }, { up_to: null, unit_amount: '1' }] },
    { tiers: [{ up_to: null, unit_amount: '-1' }] },
    { tiers: [{ up_to: null, unit_amount: '0.0000001' }] },
    { tiers: [{ up_to: null, unit_amount: '1', flat_amount: '-1' }] },
    { tiers: [{ up_to: null, unit_amount: '1', typo: '1' }] },
    { pricing_model: 'stair_step', tiers: [{ up_to: null, unit_amount: '1', flat_amount: '2' }] },
    { pricing_model: 'package', package_size: '0', tiers: [{ up_to: null, unit_amount: '1' }] },
    { pricing_model: 'package', package_size: '1000', tiers: terms.graduated.tiers },
    { kind: 'flat', tiers: [{ up_to: null, unit_amount: '1' }] },
    { pricing_model: 'unknown', tiers: [{ up_to: null, unit_amount: '1' }] },
  ]
  for (const fields of invalid) await api('price.create', { ...base, ...fields }, 400)

  const customers = []
  for (const quantity of quantities) {
    const customer = await createCustomer(quantity)
    customers.push(customer)
    await api('subscription.create', { customer: customer.id, start_date: '2026-05-01', price: prices.map(price => price.id), quantity: prices.map(price => price.kind === 'seat' ? quantity : '') })
    const events = meters.flatMap(({ code }) => (quantity === '1001' ? ['1000.999999', '0.000001'] : [quantity]).map((amount, index) => ({
      event_id: `cat002-${code}-${quantity}-${index}`, customer: `CAT002-${quantity}`, meter: code, quantity: amount, occurred_at: '2026-05-15T12:00:00Z',
    })))
    const report = await api('usage.submit', { events })
    assert.equal(report.accepted, events.length); assert.equal(report.rejected, 0)
  }

  // Replacements and retirement never change the terms a subscriber already holds.
  for (const old of prices.filter(price => price.model === 'graduated')) {
    const replacement = await publishPrice(h, cookie, { ...old.body, tiers: [{ up_to: null, unit_amount: '99' }] })
    const catalogue = await api('catalog')
    const previous = catalogue.prices.find(price => price.id === old.id)
    const next = catalogue.prices.find(price => price.id === replacement.id)
    assert.deepEqual(previous.pricing.tiers.map(tier => ({ up_to: tier.upTo, unit_amount: tier.unitAmount, flat_amount: tier.flatAmount })),
      [{ up_to: '1000.00', unit_amount: '0.002', flat_amount: '0.006' }, { up_to: null, unit_amount: '0.0014', flat_amount: '0.006' }])
    assert.ok(next.version > previous.version)
    await api('price.retire', { price: old.id })
    await api('subscription.create', { customer: legacyCustomer.id, start_date: '2026-05-01', price: [old.id], quantity: ['1'] }, 404)
  }

  const prepared = await api('billrun.prepare', { period: '2026-05' })
  const invoices = await invoicesFor(prepared.id)
  const legacyAfter = await api(`invoices/${invoices.find(row => row.customer_id === legacyCustomer.id).id}`)
  assert.equal(legacyAfter.source_fingerprint, legacyBefore.source_fingerprint, 'adding new price models preserves existing simple inputs')
  const original = new Map()
  for (let index = 0; index < customers.length; index++) {
    const invoice = await api(`invoices/${invoices.find(row => row.customer_id === customers[index].id).id}`)
    original.set(customers[index].id, invoice)
    assert.notEqual(invoice.calc_version, legacyAfter.calc_version, 'new pricing models record a new rating rule')
    assert.equal(invoice.calc_version, invoice.calculation.inputs.version)
    assert.equal(invoice.calc_version, invoice.calculation.version)
    assert.equal(invoice.lines.length, prices.length)
    for (const line of invoice.lines) {
      const expected = specs.get(line.price_id)
      assert.ok(expected, 'every line retains the subscribed immutable price version')
      assert.equal(line.amount_cents, expected.cents[index])
      assert.equal(line.evidence.quantity, `${quantities[index]}.00`)
      assert.equal(line.evidence.amountExact, expected.exact[index])
      assert.deepEqual(line.evidence.tiers, expected.breakdown[index])
    }
    assert.equal(invoice.subtotal_cents, Object.values(terms).reduce((total, term) => total + term.cents[index] * 2, 0))
  }
  const again = await api('billrun.prepare', { period: '2026-05' })
  const redrafts = await invoicesFor(again.id)
  for (const customer of customers) {
    const invoice = await api(`invoices/${redrafts.find(row => row.customer_id === customer.id).id}`)
    const before = original.get(customer.id)
    assert.equal(invoice.source_fingerprint, before.source_fingerprint)
    assert.deepEqual(invoice.lines.map(line => [line.price_id, line.amount_cents, line.evidence]), before.lines.map(line => [line.price_id, line.amount_cents, line.evidence]))
    await api('invoice.approve', { invoice: invoice.id, acknowledge: true })
  }
  const issued = await api('invoice.finalise', { run: again.id })
  assert.equal(issued.issued.length, customers.length)
  for (const customer of customers) {
    const invoice = await api(`invoices/${redrafts.find(row => row.customer_id === customer.id).id}`)
    assert.equal(invoice.status, 'issued')
    assert.deepEqual(invoice.lines.map(line => [line.amount_cents, line.evidence.tiers]), original.get(customer.id).lines.map(line => [line.amount_cents, line.evidence.tiers]))
  }
}
