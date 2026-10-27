import { totp } from './mfa.mjs'
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

export async function invoiceVoidFlow(h, owner, { onState = async () => {} } = {}) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  await h.advanceClock('2026-06-10T18:00:00Z')
  await api('business.configure', { ...await api('business'), timezone: 'UTC' })
  const customer = (await api('customer.create', { external_id: 'synthetic-nectar-void-1', name: 'Synthetic invoice correction customer', billing_email: 'synthetic-nectar-void-1@example.test' })).id
  const issue = async amount => {
    const charge = (await api('charge.add', { customer, amount, description: 'Synthetic service correction', taxable: false, effective_date: '2026-06-05' })).charge
    const draft = await api('invoice.manual', { customer, charges: [charge], service_date: '2026-06-05' })
    await api('invoice.approve', { invoice: draft.id, acknowledge: true })
    await api('invoice.finalise', { invoice: draft.id, issue_date: '2026-06-05' })
    return api(`invoices/${draft.id}`)
  }
  await applyPolicy(h, owner, 'credit.policy', { two_person_above: '1000' })
  await api('access.give', { email: 'synthetic-nectar-void-2@example.test', name: 'Synthetic second approver', role: 'finance' })
  const finance = await h.signIn('synthetic-nectar-void-2@example.test', { requested: true })
  const agent = { bearer: (await api('credential.issue', { name: 'Synthetic void agent', scopes: ['prepare'] })).key }
  const high = await issue('1500'), low = await issue('900'), paid = await issue('100'), partial = await issue('100')
  const body = invoice => ({ invoice: invoice.id, basis: invoice.source_fingerprint, reason: 'Replace the original service invoice', confirm: true })
  const unchanged = async invoice => assert.deepEqual(await api(`invoices/${invoice.id}`), invoice)
  await api('invoice.void', body(high), 409); await unchanged(high)
  for (const action of ['invoice.void.prepare', 'invoice.void']) await h.api(action, agent, body(high), 403)
  const request = await api('invoice.void.prepare', body(high))
  const preparation = (await api('audit')).find(row => row.action === 'invoice.void.prepare' && row.subject === request.request)
  assert.equal(preparation.actor, h.vars.OWNER_EMAIL)
  assert.equal(JSON.parse(preparation.detail).invoice, high.id)
  assert.equal(JSON.parse(preparation.detail).amount, 150000)
  await h.api('credit.approve', finance, { request: request.request }, 409)
  await api('invoice.void', { ...body(high), request: request.request }, 409)
  assert.equal((await api(`invoices/${high.id}`)).balanceCents, 150000)
  const replacement = await h.api('invoice.void', finance, { ...body(high), request: request.request })
  const voided = await api(`invoices/${high.id}`)
  assert.equal(voided.balanceCents, 0); assert.equal(voided.voidedBy.void_replacement_id, replacement.id)
  assert.deepEqual(voided.calculation, high.calculation); assert.deepEqual(voided.lines, high.lines)
  for (const key of ['status','number','subtotal_cents','tax_cents','total_cents','issue_date','issued_by','issued_at']) assert.equal(voided[key], high[key])
  assert.deepEqual(voided.credits.map(row => [row.amount_cents, row.applied_cents, row.tax_cents]), [[150000, 150000, 0]])
  const draft = await api(`invoices/${replacement.id}`)
  assert.equal(draft.status, 'draft'); assert.equal(draft.reissuedFrom.invoice, high.id)
  assert.equal(draft.total_cents, 150000); assert.equal(draft.tax_cents, 0)
  assert.deepEqual(draft.lines.map(row => [row.description, row.amount_cents, row.evidence]), high.lines.map(row => [row.description, row.amount_cents, row.evidence]))
  await api('invoice.finalise', { invoice: replacement.id }, 409)
  await api('invoice.approve', { invoice: replacement.id, acknowledge: true })
  await api('invoice.finalise', { invoice: replacement.id, issue_date: '2026-06-10' })
  const reissued = await api(`invoices/${replacement.id}`)
  assert.equal(reissued.balanceCents, 150000); assert.notEqual(reissued.number, high.number)
  await h.api('invoice.void', finance, { ...body(high), request: request.request }, 409)
  assert.deepEqual(await api(`invoices/${high.id}`), voided)
  const audit = (await api('audit')).find(row => row.action === 'invoice.void' && row.subject === high.id)
  const detail = JSON.parse(audit.detail)
  assert.equal(detail.preparedBy, h.vars.OWNER_EMAIL); assert.equal(detail.approvedBy, 'synthetic-nectar-void-2@example.test')
  assert.equal(detail.replacement, replacement.id); assert.equal(detail.credit, replacement.credit)
  await h.rejectAudit('invoice.void')
  await api('invoice.void', body(low), 500)
  await h.rejectAudit(null)
  await unchanged(low)
  const competing = await Promise.all([0,1].map(() => h.raw('/api/nectar/invoice.void', { cookie: owner, body: body(low) })))
  assert.deepEqual(competing.map(row => row.status).sort(), [200,409], 'Concurrent voids commit one credit and one replacement')
  const single = await competing.find(row => row.status === 200).json()
  assert.equal((await api(`invoices/${low.id}`)).balanceCents, 0)
  assert.equal((await api(`invoices/${single.id}`)).total_cents, 90000)
  const payment = await api('payment.record', { customer, amount: '100', received_on: '2026-06-10', method: 'bank_transfer', reference: 'synthetic-nectar-void-payment' })
  await api('payment.allocate', { payment: payment.payment, invoice: paid.id, amount: '100' })
  await api('invoice.void', body(paid), 409)
  await api('credit.issue', { invoice: partial.id, amount: '1', reason: 'Synthetic partial adjustment' })
  await api('invoice.void', body(partial), 409)
  const product = (await api('product.create', { code: 'synthetic-nectar-void-plan', name: 'Synthetic recurring service' })).id
  const price = (await api('price.create', { product, kind: 'flat', unit_amount: '300', taxable: false })).id
  const seatProduct = (await api('product.create', { code: 'synthetic-nectar-void-seats', name: 'Synthetic seats' })).id
  const seat = (await api('price.create', { product: seatProduct, kind: 'seat', unit_amount: '20', taxable: false })).id
  const meter = (await api('meter.create', { code: 'synthetic-nectar-void-meter', name: 'Synthetic source-preserved units', unit_label: 'units' })).id
  const usageProduct = (await api('product.create', { code: 'synthetic-nectar-void-usage', name: 'Synthetic usage' })).id
  const unit = (await api('price.create', { product: usageProduct, meter, kind: 'unit', unit_amount: '0.07', taxable: false })).id
  const subscription = (await api('subscription.create', { customer, start_date: '2026-05-01', price: [price,seat,unit], quantity: ['','7',''] })).id
  await api('usage.submit', { events: [{ event_id: 'synthetic-nectar-void-event', customer: 'synthetic-nectar-void-1', meter: 'synthetic-nectar-void-meter', quantity: '23', occurred_at: '2026-05-15T12:00:00Z' }] })
  const run = await api('billrun.prepare', { period: '2026-05' })
  const recurring = (await api(`runs/${run.id}`)).invoices.find(row => row.subscription_id === subscription)
  assert.ok(recurring)
  await api('invoice.approve', { invoice: recurring.id, acknowledge: true })
  await api('invoice.finalise', { invoice: recurring.id, issue_date: '2026-06-01' })
  const recurringOriginal = await api(`invoices/${recurring.id}`)
  assert.equal(recurringOriginal.total_cents, 44161)
  assert.deepEqual(recurringOriginal.lines.map(row => row.kind).sort(), ['flat','seat','usage'])
  assert.deepEqual(recurringOriginal.calculation.consumedEvents, ['synthetic-nectar-void-event'])
  const recurringReplacement = await api('invoice.void', body(recurringOriginal))
  await api('invoice.approve', { invoice: recurringReplacement.id, acknowledge: true })
  await api('invoice.finalise', { invoice: recurringReplacement.id, issue_date: '2026-06-10' })
  assert.equal((await api(`invoices/${recurring.id}`)).balanceCents, 0)
  const recurringReissued = await api(`invoices/${recurringReplacement.id}`)
  assert.equal(recurringReissued.balanceCents, 44161)
  assert.deepEqual(recurringReissued.lines.map(({id,invoice_id,...row}) => row), recurringOriginal.lines.map(({id,invoice_id,...row}) => row))
  assert.deepEqual(recurringReissued.calculation.consumedEvents, [])
  const revenueShape = source => source.schedules.map(row => ({ kind: row.kind, amountCents: row.amountCents, entries: row.entries.map(entry => [entry.period,entry.amountCents]) })).sort((a,b) => a.kind.localeCompare(b.kind))
  const expectedRevenue = [{ kind: 'flat', amountCents: 30000, entries: [['2026-05',30000]] }, { kind: 'seat', amountCents: 14000, entries: [['2026-05',14000]] }, { kind: 'usage', amountCents: 161, entries: [['2026-05',161]] }]
  assert.deepEqual(revenueShape(await api(`revenue/${recurring.id}`)), expectedRevenue)
  assert.deepEqual(revenueShape(await api(`revenue/${recurringReplacement.id}`)), expectedRevenue, 'Replacement revenue preserves the saved usage dates and exact service amounts')
  assert.deepEqual((await api(`invoices/${recurring.id}`)).calculation, recurringOriginal.calculation)
  const again = await api('billrun.prepare', { period: '2026-05' })
  assert.equal((await api(`runs/${again.id}`)).invoices.length, 0, 'A replacement never releases the original recurring period for billing again')
  const stale = await issue('1500'), staleRequest = await api('invoice.void.prepare', body(stale))
  await applyPolicy(h, owner, 'credit.policy', { two_person_above: '1001' })
  await h.api('invoice.void', finance, { ...body(stale), request: staleRequest.request }, 409)
  assert.equal((await api(`invoices/${stale.id}`)).balanceCents, 150000)
  await api('invoice.void', { ...body(stale), basis: 'synthetic-nectar-stale' }, 409)
  for (const [label, id] of [['voided-original', high.id], ['replacement-issued', replacement.id]]) {
    const page = await h.page(`/app/invoices/${id}`, owner)
    assert.ok(page.includes(label === 'voided-original' ? replacement.id : high.id))
    await onState({ label, id, owner })
  }
  await api('access.give', { email: 'synthetic-nectar-void-3@example.test', name: 'Synthetic former approver', role: 'finance' })
  const former = await h.signIn('synthetic-nectar-void-3@example.test', { requested: true })
  const formerRequest = await h.api('invoice.void.prepare', former, body(stale))
  const member = (await api('members')).find(row => row.email === 'synthetic-nectar-void-3@example.test')
  await api('access.end', { member: member.id })
  assert.equal((await api('invoice.void', { ...body(stale), request: formerRequest.request }, 409)).error, 'void_preparer_no_longer_authorized')
  assert.equal((await api(`invoices/${stale.id}`)).balanceCents, 150000)
  await api('mfa.policy', { scope: 'roles', roles: ['finance'] })
  const factor = await h.api('mfa.totp.start', finance, {})
  await h.api('mfa.totp.confirm', finance, { factor: factor.factor, code: totp(factor.secret, Date.parse('2026-06-10T18:00:00Z')) })
  await h.advanceClock('2026-06-10T18:16:00Z')
  for (const action of ['invoice.void.prepare', 'invoice.void']) assert.equal((await h.api(action, finance, body(stale), 403)).error, 'mfa_step_up_required')
  assert.equal((await api(`invoices/${stale.id}`)).balanceCents, 150000)
  await h.api('mfa.verify', finance, { code: totp(factor.secret, Date.parse('2026-06-10T18:16:00Z')) })
  const fresh = await h.api('invoice.void.prepare', finance, body(stale))
  await h.api('invoice.void', finance, { ...body(stale), request: fresh.request }, 409)
  const freshReplacement = await api('invoice.void', { ...body(stale), request: fresh.request })
  assert.equal((await api(`invoices/${freshReplacement.id}`)).total_cents, 150000)
  const erase = await api('erasure.request', { customer })
  const link = h.mails.at(-1).text.match(/https?:\/\/[^\s"<]+\/erase\/[a-f0-9]{64}/)[0]
  assert.equal((await h.raw(new URL(link).pathname, { form: new URLSearchParams({ confirm: 'yes' }) })).status, 200)
  await api('erasure.approve', { request: erase.id, confirm: true })
  await api('invoice.void', body(stale), 404)
  await api('invoice.approve', { invoice: single.id, acknowledge: true }, 409)
  assert.equal((await api(`invoices/${high.id}`)).voidedBy.void_replacement_id, replacement.id)
  console.log('INV-005 unpaid invoice void and ordinary governed reissue: exact originals, independent threshold approval, one-person low amount, stale, duplicate, paid and partial refusal passed')
  return { original: high.id, replacement: replacement.id }
}
