import { applyPolicy } from './policy-helper.mjs'
import assert from 'node:assert/strict'

export async function oneTimeBilling(h, owner) {
  const previous = await h.api('business', owner)
  await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: 'CA', tax_mode: 'flat_rate', tax_rate: '10', tax_note: 'Reviewed declared rate for services and recurring charges' })
  await h.api('tax.review', owner, { revision: (await h.api('business', owner)).revision })
  const customer = (await h.api('customer.create', owner, { external_id: 'CAT006-SUB', name: 'Juniper Engineering', billing_email: 'ap@juniper.example' })).id
  const standalone = (await h.api('customer.create', owner, { external_id: 'CAT006-SERVICE', name: 'Harbor Services', billing_email: 'ap@harbor.example' })).id
  const product = async (code, name, amount, kind = 'flat') => {
    const p = (await h.api('product.create', owner, { code, name })).id
    return (await h.api('price.create', owner, { product: p, kind, unit_amount: amount, taxable: true })).id
  }
  const base = await product('cat006-base', 'Engineering platform', '100')
  const fee = await product('cat006-implementation', 'Implementation', '2500')
  const seats = await product('cat006-seats', 'Seat pack', '20', 'seat')
  const consulting = await product('cat006-services', 'Services hour', '40')
  const subscription = (await h.api('subscription.create', owner, { customer, start_date: '2026-04-01', price: [base] })).id
  const charge = (await h.api('charge.add', owner, { customer, subscription, price: fee, effective_date: '2026-04-01' })).charge
  await h.api('price.retire', owner, { price: fee })
  await h.api('charge.add', owner, { customer, price: fee, effective_date: '2026-04-01' }, 409)
  await h.api('subscription.addon', owner, { subscription, price: seats, quantity: 10, effective_date: '2026-04-16' })
  await h.api('subscription.addon', owner, { subscription, price: seats, quantity: 10, effective_date: '2026-04-16' }, 409)
  await h.api('subscription.addon', owner, { subscription, price: seats, quantity: 10, effective_date: '2026-04-01' }, 409)
  const recurring = async month => {
    const run = await h.api('billrun.prepare', owner, { period: month })
    const invoice = (await h.api(`runs/${run.id}`, owner)).invoices.find(i => i.customer_id === customer)
    assert.ok(invoice)
    return await h.api(`invoices/${invoice.id}`, owner)
  }
  const issue = async invoice => {
    await h.api('invoice.approve', owner, { invoice: invoice.id, acknowledge: true })
    await h.api('invoice.finalise', owner, { invoice: invoice.id, issue_date: invoice.invoice_kind === 'manual' ? invoice.period_start : invoice.period_end })
    return await h.api(`invoices/${invoice.id}`, owner)
  }
  const april = await issue(await recurring('2026-04'))
  assert.deepEqual([april.subtotal_cents, april.tax_cents, april.total_cents], [270000, 27000, 297000])
  assert.equal(april.lines.filter(l => l.kind === 'one_time').length, 1)
  assert.equal(april.lines.find(l => l.kind === 'one_time').evidence.charge, charge)
  assert.equal(april.lines.find(l => l.price_id === seats).amount_cents, 10000)
  assert.equal(april.lines.find(l => l.price_id === seats).evidence.days, 15)
  const frozen = april.calculation
  await h.api('subscription.addon', owner, { subscription, price: consulting, effective_date: '2026-04-20' }, 409)
  const may = await issue(await recurring('2026-05'))
  assert.deepEqual([may.subtotal_cents, may.tax_cents, may.total_cents], [30000, 3000, 33000])
  assert.equal(may.lines.some(l => l.kind === 'one_time'), false)
  // Standalone work has no subscription, yet uses the normal approval, tax and ledger.
  const custom = (await h.api('charge.add', owner, { customer: standalone, amount: '750.00', description: 'Architecture workshop', taxable: true, effective_date: '2026-06-05' })).charge
  const manual = await h.api('invoice.manual', owner, { customer: standalone, charges: [custom], service_date: '2026-06-05' })
  const competitor = await h.api('invoice.manual', owner, { customer: standalone, charges: [custom], service_date: '2026-06-05' })
  let detail = await h.api(`invoices/${manual.id}`, owner)
  assert.equal(detail.subscription_id, null); assert.equal(detail.invoice_kind, 'manual')
  await h.api('invoice.finalise', owner, { invoice: detail.id, issue_date: '2026-06-05' }, 409)
  const services = await issue(detail)
  assert.deepEqual([services.subtotal_cents, services.tax_cents, services.total_cents], [75000, 7500, 82500])
  assert.equal(new Set([april.number, may.number, services.number]).size, 3)
  await h.api('invoice.approve', owner, { invoice: competitor.id, acknowledge: true }, 409)
  await h.api('invoice.manual', owner, { customer: standalone, charges: [custom], service_date: '2026-06-05' }, 409)
  await h.api('invoice.finalise', owner, { invoice: services.id, issue_date: '2026-06-05' }, 409)
  assert.equal((await h.api(`customers/${standalone}`, owner)).subscriptions.length, 0)
  // A subscription-linked charge may also be billed now instead of waiting for its next run.
  const immediate = (await h.api('charge.add', owner, { customer, subscription, price: consulting, quantity: '3', effective_date: '2026-06-10' })).charge
  const beforeImmediate = await recurring('2026-06')
  const now = await h.api('invoice.manual', owner, { customer, charges: [immediate], service_date: '2026-06-10' })
  const immediateInvoice = await issue(await h.api(`invoices/${now.id}`, owner))
  assert.equal(immediateInvoice.total_cents, 13200)
  await h.api('invoice.approve', owner, { invoice: beforeImmediate.id, acknowledge: true }, 409)
  const june = await issue(await recurring('2026-06'))
  assert.equal(june.lines.some(l => l.evidence.charge === immediate), false)
  assert.equal(june.total_cents, 33000)
  await h.api('credit.issue', owner, { invoice: services.id, amount: '50', reason: 'Workshop goodwill adjustment' })
  const payment = await h.api('payment.record', owner, { customer: standalone, amount: '25', received_on: '2026-06-10', method: 'bank_transfer', reference: 'CAT006-WIRE' })
  await h.api('payment.allocate', owner, { payment: payment.payment, invoice: services.id, amount: '25' })
  detail = await h.api(`invoices/${services.id}`, owner)
  assert.equal(detail.balanceCents, 75000)
  assert.deepEqual((await h.api(`invoices/${april.id}`, owner)).calculation, frozen)
  assert.equal((await h.api(`customers/${customer}`, owner)).charges.filter(c => c.invoice_id).length, 2)
  assert.match(await (await h.raw('/app/exports/invoices.csv', { cookie: owner })).text(), new RegExp(services.number))
  assert.match(await h.page(`/app/invoices/${services.id}`, owner), /Architecture workshop/)
  await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: previous.tax_jurisdiction, tax_mode: previous.tax_mode, tax_rate: previous.tax_rate, tax_note: previous.tax_note })
  if (previous.taxReady) await h.api('tax.review', owner, { revision: (await h.api('business', owner)).revision })
  console.log('CAT-006 queued and immediate one-time charges, prorated add-ons, standalone approval, tax, numbering and exactly-once billing passed')
  return { customer, standalone, subscription, invoice: services.id }
}
