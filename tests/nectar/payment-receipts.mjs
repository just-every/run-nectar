import assert from 'node:assert/strict'

// Call inside customerSearchFlow before its native/MFA section. Uses ordinary
// public cash/allocation doors; no new payment or provider implementation.
export async function assertPaymentReceipts(h, owner) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  const createCustomer = async n => (await api('customer.create', { external_id: `synthetic-nectar-${n}`,
    name: `synthetic-nectar-${n}`, billing_email: `synthetic-nectar-${n}@example.test` })).id
  const customer = await createCustomer(301), other = await createCustomer(302)
  const invoices = []
  for (const n of [303, 304]) {
    const charge = await api('charge.add', { customer, amount: '10', description: `synthetic-nectar-${n}`, effective_date: '2026-01-05', taxable: false })
    const draft = await api('invoice.manual', { customer, charges: [charge.charge], service_date: '2026-01-05' })
    await api('invoice.approve', { invoice: draft.id, acknowledge: true })
    await api('invoice.finalise', { invoice: draft.id, issue_date: '2026-01-05' })
    invoices.push(draft.id)
  }
  const payment = (await api('payment.record', { customer, amount: '25', method: 'bank_transfer', reference: 'synthetic-nectar-305', evidence: 'synthetic-nectar-306', received_on: '2026-01-07' })).payment
  const initial = await api(`payments/${payment}/receipt`)
  assert.equal(initial.amountCents, 2500)
  assert.deepEqual(initial.allocations, [])
  for (const invoice of invoices) await api('payment.allocate', { payment, invoice, amount: '10' })
  const second = (await api('payment.record', { customer: other, amount: '1', method: 'check', reference: 'synthetic-nectar-307', received_on: '2026-01-07' })).payment
  const receipt = await api(`payments/${payment}/receipt`), otherReceipt = await api(`payments/${second}/receipt`)
  assert.equal(receipt.number, initial.number, 'Allocating cash cannot renumber its receipt')
  assert.notEqual(receipt.number, otherReceipt.number)
  assert.ok(otherReceipt.sequence > receipt.sequence)
  assert.deepEqual((await api(`customers?search=${encodeURIComponent(receipt.number)}`)).map(row => row.id), [customer])
  const record = await api(`customers/${customer}`), ledger = record.ledger
  assert.deepEqual(record.billingRecord.receipts, [receipt])
  assert.equal(receipt.amountCents, ledger.payments.find(row => row.id === payment).amount_cents)
  assert.equal(receipt.currency, ledger.payments.find(row => row.id === payment).currency)
  assert.equal(receipt.allocatedCents, ledger.paidCents)
  assert.equal(receipt.unallocatedCents, ledger.unallocatedCents)
  assert.equal(receipt.allocations.reduce((sum, a) => sum + a.amountCents, 0), receipt.allocatedCents)
  assert.deepEqual(receipt.allocations.map(a => a.invoice).sort(), invoices.sort())
  for (const allocation of receipt.allocations) {
    const source = await api(`invoices/${allocation.invoice}`)
    assert.equal(allocation.invoiceNumber, source.number)
    assert.equal(allocation.currency, source.currency)
  }
  assert.deepEqual(receipt.provenance, [])
  assert.equal(receipt.custody, 'recorded_cash')
  for (const field of ['reference', 'evidence', 'recorded_by', 'provider_ref', 'proof_json', 'customer_name', 'billing_email']) assert.ok(!(field in receipt))
  assert.ok(!JSON.stringify(receipt).includes('synthetic-nectar-306'))
  for (const role of ['support', 'collections', 'accountant']) {
    const email = `synthetic-nectar-${{support:308,collections:309,accountant:310}[role]}@example.test`
    await api('access.give', { email, name: 'synthetic-nectar-311', role })
    const cookie = await h.signIn(email, { requested: true })
    assert.deepEqual(await h.api(`payments/${payment}/receipt`, cookie), receipt)
    assert.deepEqual((await h.api(`customers?search=${encodeURIComponent(receipt.number)}`, cookie)).map(row => row.id), [customer])
    assert.ok((await h.page(receipt.sourcePath, cookie)).includes(receipt.number))
  }
  const role = await api('role.define', { name: 'synthetic-nectar-312', capabilities: ['read.customers', 'read.payments'] })
  await api('access.give', { email: 'synthetic-nectar-312@example.test', name: 'synthetic-nectar-312', role: 'custom', custom_role: role.id })
  const restricted = await h.signIn('synthetic-nectar-312@example.test', { requested: true })
  await h.api(`payments/${payment}/receipt`, restricted, undefined, 403)
  assert.equal((await h.api(`customers/${customer}`, restricted)).billingRecord.receipts, null)
  assert.deepEqual(await h.api(`customers?search=${encodeURIComponent(receipt.number)}`, restricted), [])
  await h.api(`payments/${payment}/receipt`, undefined, undefined, 401)
  const audit = await api('audit')
  await api(`payments/${payment}/receipt`)
  await h.page(receipt.sourcePath, owner)
  assert.deepEqual(await api('audit'), audit, 'Receipt reads append no financial or audit records')
  return { customer, other, payment, receipt }
}
