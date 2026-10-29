import assert from 'node:assert/strict'

export function achPaymentEvidenceEdge(baseFetch) {
  const calls = [], customer = 'synthetic-nectar-native-customer-1', method = 'synthetic-nectar-native-bank-1'
  let captured = null, fault = null
  const refs = { paymentIntentRef: 'synthetic-nectar-ach-intent-1', chargeRef: 'synthetic-nectar-ach-charge-1', settlementRef: 'synthetic-nectar-ach-settlement-1' }
  const bank = { bank_name: 'Synthetic Nectar Bank', last4: '6789', account_type: 'checking', routing_number: '110000000' }
  const fetch = async request => {
    const path = new URL(request.url).pathname.replace('/v1', '')
    const owned = path === `/payment_methods/${method}` || [refs.paymentIntentRef, refs.chargeRef, refs.settlementRef].some(ref => path.endsWith(`/${ref}`))
    if (!owned) return baseFetch(request)
    calls.push({ path, method: request.method })
    assert.equal(request.method, 'GET', 'ACH recognition sends no provider write')
    assert.equal(request.headers.get('authorization'), 'Bearer synthetic-nectar-1')
    assert.ok(captured, 'External capture must be seeded explicitly at the network edge')
    const common = { customer, livemode: false }, at = Date.parse(captured.date) / 1000
    let value
    if (path === `/payment_intents/${refs.paymentIntentRef}`) value = { object: 'payment_intent', id: refs.paymentIntentRef, ...common, status: 'succeeded',
      amount: captured.amountCents, amount_received: captured.amountCents, amount_capturable: 0, currency: captured.currency.toLowerCase(), payment_method: method,
      latest_charge: refs.chargeRef, metadata: { nectar_native_invoice: captured.invoice } }
    else if (path === `/charges/${refs.chargeRef}`) value = { object: 'charge', id: refs.chargeRef, ...common, status: 'succeeded', paid: true, captured: true,
      payment_intent: refs.paymentIntentRef, payment_method: method, balance_transaction: refs.settlementRef, amount: captured.amountCents, amount_captured: captured.amountCents,
      currency: captured.currency.toLowerCase(), amount_refunded: 0, refunded: false, disputed: false, created: at,
      payment_method_details: { type: 'us_bank_account', us_bank_account: bank } }
    else if (path === `/payment_methods/${method}`) value = { object: 'payment_method', id: method, ...common, type: 'us_bank_account', us_bank_account: bank,
      billing_details: { name: 'Synthetic private billing name' } }
    else value = { object: 'balance_transaction', id: refs.settlementRef, status: 'available', type: 'charge', source: refs.chargeRef,
      amount: captured.amountCents, currency: captured.currency.toLowerCase(), available_on: at }
    if (fault === 'invoice' && value.metadata) value.metadata.nectar_native_invoice = 'synthetic-nectar-invoice-99'
    if (fault === 'customer' && value.customer) value.customer = 'synthetic-nectar-native-customer-99'
    if (fault === 'pending' && value.object === 'balance_transaction') value.status = 'pending'
    if (fault === 'livemode' && value.object === 'payment_method') value.livemode = true
    if (fault === 'refunded' && value.object === 'charge') value.amount_refunded = 1
    return Response.json(value)
  }
  return { fetch, calls, ...refs, configureCaptured(value) { captured = structuredClone(value); return refs }, setFault(value) { fault = value } }
}

/** Requires an issued, unpaid native invoice and an existing held binding. */
export async function assertAchPaymentEvidence(h, owner, { customer, invoice, edge, finance, other,record }) {
  const invoiceId = typeof invoice === 'string' ? invoice : invoice.id
  const before = await h.api(`invoices/${invoiceId}`, owner)
  const original = before.invoice ?? before
  const amountCents = original.balance_cents ?? original.balanceCents ?? original.total_cents ?? original.totalCents
  const currency = original.currency
  assert.ok(Number.isSafeInteger(amountCents) && amountCents > 0)
  edge.configureCaptured({ invoice: invoiceId, amountCents, currency, date: '2026-10-22T00:00:00Z' })
  const input = { invoice: invoiceId, account_ref: 'synthetic-nectar-native-account-1', payment_intent_ref: edge.paymentIntentRef, confirm: true }
  for (const fault of ['invoice', 'customer', 'pending', 'livemode', 'refunded']) {
    edge.setFault(fault)
    await h.api('payment.ach_evidence.record', owner, input, 409)
  }
  edge.setFault(null)
  if (finance) await h.api('payment.ach_evidence.record', finance, input, 403)
  const result = record ? await record({customer,invoice:invoiceId,input}) : await h.api('payment.ach_evidence.record', owner, input)
  assert.equal(result.customer, customer); assert.equal(result.invoice, invoiceId)
  assert.equal(result.amountCents, amountCents); assert.equal(result.currency, currency.toLowerCase())
  assert.equal(result.debitAuthority, false); assert.equal(result.last4, '6789')
  const customerRecord = await h.api(`customers/${customer}`, owner)
  assert.ok(customerRecord.billingRecord.achPaymentEvidence.some(row => row.id === result.id))
  const payment = customerRecord.ledger.payments.find(row => row.id === result.payment)
  assert.ok(payment, 'Verified evidence uses the ordinary customer cash ledger')
  assert.equal(payment.amount_cents, amountCents); assert.equal(payment.currency.toLowerCase(), currency.toLowerCase())
  assert.equal(payment.reference, `stripe:${input.account_ref}:${input.payment_intent_ref}`)
  assert.equal(payment.method, 'bank_transfer')
  const after = await h.api(`invoices/${invoiceId}`, owner), issued = after.invoice ?? after
  for (const key of ['id', 'number', 'total_cents', 'currency', 'source_fingerprint', 'calculation_json', 'billing_route_json']) assert.deepEqual(issued[key], original[key], `Issued invoice ${key} remains immutable`)
  await h.api('payment.ach_evidence.record', owner, input, 409)
  if (other) assert.deepEqual((await h.api(`customers/${other}`, owner)).billingRecord.achPaymentEvidence, [])
  assert.ok(edge.calls.length > 0 && edge.calls.every(call => call.method === 'GET'))
  assert.ok(!JSON.stringify(result).includes('routing_number') && !JSON.stringify(result).includes('billing_details'))
  return result
}
