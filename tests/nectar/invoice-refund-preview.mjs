import assert from 'node:assert/strict'
import { nativeCollectionEdge } from './native-collection.mjs'
import { applyPolicy } from './policy-helper.mjs'
let edge
export const harnessOptions = () => { edge = nativeCollectionEdge(); return { stripeFetch: edge.fetch, stripeSecret: 'synthetic-nectar-1' } }

export async function invoiceRefundPreviewFlow(h, owner) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  await h.advanceClock('2026-10-22T18:00:00Z')
  await api('business.configure', { ...await api('business'), timezone: 'UTC' })
  await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: 'CA', tax_mode: 'flat_rate', tax_rate: '10', tax_note: 'Synthetic reviewed service tax' })
  await api('tax.review', { revision: (await api('business')).revision })
  await applyPolicy(h, owner, 'credit.policy', { two_person_above: '1000' })
  const customer = (await api('customer.create', { external_id: 'synthetic-nectar-preview-1', name: 'Synthetic refund preview customer', billing_email: 'synthetic-nectar-preview-1@example.test' })).id
  const charge = (await api('charge.add', { customer, amount: '2000', description: 'Synthetic taxable card-paid service', taxable: true, effective_date: '2026-10-20' })).charge
  const { id } = await api('invoice.manual', { customer, charges: [charge], service_date: '2026-10-20' })
  const preview = (amount, destination, status) => api('invoice.refund.preview', { invoice: id, amount, destination }, status)
  await api('invoice.approve', { invoice: id, acknowledge: true })
  await api('invoice.finalise', { invoice: id, issue_date: '2026-10-22' })
  assert.equal((await preview('1100', 'original', 409)).error, 'paid_invoice_required')
  await api('collection.customer.bind', { customer, account_ref: 'synthetic-nectar-native-account-1', stripe_customer_ref: 'synthetic-nectar-native-customer-1', confirm: true })
  assert.equal((await api('invoice.void', { invoice: id, basis: (await api(`invoices/${id}`)).source_fingerprint, reason: 'Synthetic taxed void refusal', confirm: true }, 409)).error, 'invoice_void_scope_not_supported')
  const collection = await api('collection.prepare', { invoice: id })
  await api('collection.confirm', collection.instructions.confirm)
  const original = await api(`invoices/${id}`), audit = await api('audit'), writes = edge.calls.filter(call => call.method === 'POST').length, mails = h.mails.length
  assert.deepEqual([original.subtotal_cents, original.tax_cents, original.total_cents, original.balanceCents], [200000, 20000, 220000, 0])
  const cash = await preview('1100', 'original'), balance = await preview('1100', 'balance')
  assert.deepEqual(cash.reversing, { subtotalCents: 100000, taxCents: 10000, totalCents: 110000 })
  assert.deepEqual(balance.reversing, cash.reversing)
  assert.deepEqual(cash.effects, { owedBeforeCents: 0, owedAfterCents: 0, cashCents: -110000, customerBalanceCents: 0, revenueCents: -100000 })
  assert.deepEqual(balance.effects, { owedBeforeCents: 0, owedAfterCents: 0, cashCents: 0, customerBalanceCents: 110000, revenueCents: -100000 })
  assert.equal(cash.needsSecondApprover, true); assert.equal(balance.needsSecondApprover, true)
  assert.notEqual(cash.basis, balance.basis)
  assert.deepEqual(cash.original, { totalCents: 220000, subtotalCents: 200000, taxCents: 20000, payment: original.allocations[0].payment_id, capture: edge.charges.values().next().value.value.id })
  const low = await preview('900', 'original')
  assert.equal(low.needsSecondApprover, false)
  assert.deepEqual(low.reversing, { subtotalCents: 81818, taxCents: 8182, totalCents: 90000 })
  for (const value of [cash, balance, low]) { assert.equal(value.executionAvailable, false); assert.equal(value.providerOutcome, 'not-attempted') }
  for (const [amount, destination, status, error] of [['2200.01','original',409,'exceeds_refundable_amount'],['0','balance',409,'exceeds_refundable_amount'],['1','another',400,'invalid_refund_destination']]) assert.equal((await preview(amount, destination, status)).error, error)
  const agent = { bearer: (await api('credential.issue', { name: 'Synthetic refund proposer', scopes: ['prepare'] })).key }
  const beforeAgent = await api('audit')
  assert.deepEqual(await h.api('invoice.refund.preview', agent, { invoice: id, amount: '1100', destination: 'original' }), cash)
  await h.api('invoice.refund.preview', undefined, { invoice: id, amount: '1', destination: 'original' }, 401)
  assert.deepEqual(await api('audit'), beforeAgent)
  assert.equal(edge.calls.filter(call => call.method === 'POST').length, writes)
  // The credential issue sends no mail; quoting never reserves a message.
  assert.equal(h.mails.length, mails)
  assert.deepEqual(await api(`invoices/${id}`), original)
  assert.deepEqual((await api(`customers/${customer}/balance`)).totalCents, 0)
  assert.equal(audit.some(row => row.action.startsWith('invoice.refund')), false)
  await applyPolicy(h, owner, 'credit.policy', { two_person_above: '1200' })
  const changed = await preview('1100', 'original')
  assert.equal(changed.needsSecondApprover, false); assert.notEqual(changed.basis, cash.basis)
  console.log('INV-005 read-only refund preview: exact independent tax and pretax effects, original-method and balance destinations, thresholds, source basis, refused inputs and no provider, ledger or mail writes passed')
}
