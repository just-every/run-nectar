import { readAchPaymentEvidence } from './ach-payment-evidence'
import { readCustomerPaymentMethods } from './customer-payment-methods'
import { customerSubscriptionHistory,customerWriteOffHistory } from './customer-record-history'
// CUS-001 composition of existing financial sources. Only closed projections
// cross this boundary: processor proof, approval narratives and audit detail do not.
import type { Bindings } from '../auth.server'
import { canRead, requireRead, type Actor } from './actor'
import { balanceView } from './balance'
import { requireBusiness } from './business'
import { clockInstant } from './clock'
import { all, insist, one, parseJson, stmt, type Row } from './core'
import { today } from './dates'
import { nativeCollectionRows } from './payments/state'
import { prepaidBalances } from './prepaid-balances'
import { readPrepaidRefunds } from './prepaid-refund-records'

/** Saved-card verification is historical; it does not establish a current default. */
export async function customerProcessorFacts(env: Bindings, customer?: string) {
  return (await nativeCollectionRows(env, customer)).map(row => {
    const basis = parseJson<Row | null>(row.basis_json, null)
    const proof = parseJson<Row | null>(row.proof_json, null)
    const card = basis?.card
    const verifiedCard = basis?.customerId === row.customer_id && basis?.invoiceId === row.invoice_id
      && basis?.paymentMethodRef === row.payment_method_ref && basis?.customerRef === row.stripe_customer_ref
      && card && typeof card.brand === 'string' && /^\d{4}$/.test(card.last4)
      && Number.isInteger(card.expMonth) && card.expMonth >= 1 && card.expMonth <= 12 && Number.isInteger(card.expYear)
      ? { brand: card.brand, last4: card.last4, expMonth: card.expMonth, expYear: card.expYear } : null
    const captured = proof?.proof === 'succeeded-payment-intent-and-captured-charge'
      && proof.paymentIntentRef === row.payment_intent_ref && proof.chargeRef === row.charge_ref
      && proof.amountCents === row.amount_cents && proof.accountRef === row.account_ref
      && proof.customerRef === row.stripe_customer_ref && proof.paymentMethodRef === row.payment_method_ref
    return { id: row.id, customer: row.customer_id, invoice: row.invoice_id, payment: row.payment_id,
      status: row.status, amountCents: row.amount_cents, currency: row.currency,
      paymentIntentRef: row.payment_intent_ref ?? null, chargeRef: row.charge_ref ?? null,
      captured: !!captured, card: verifiedCard, verifiedAt: row.prepared_at }
  })
}

const refundFields = ['id','status','grant','subscription','customer','invoice','purchaseNumber','purchaseLine','payment',
  'receiptReference','amountN','amountCents','kind','unitLabel','refundRef','credit','creditNumber','requestedBy',
  'requestedByKind','requestedAt','reasonCategory','preparedBy','approvedBy','approvalMode','preparedAt','approvedAt',
  'claimedAt','refundedOn','liabilityCents','recognitionCents','cashAmountCents','source','intake'] as const
const typedRefund = (row: Row) => Object.fromEntries(refundFields.filter(key => row[key] !== undefined).map(key => [key, row[key]]))

// Subject ownership, rather than text inside detail, associates an event. Family
// gates apply before selecting subjects. No global latest-500 window loses history.
async function customerAuditEvents(env: Bindings, actor: Actor, customer: string) {
  const sources = ["SELECT id FROM nc_customers WHERE id=?", 'SELECT id FROM nc_contacts WHERE customer_id=?']
  if (canRead(actor, 'subscriptions')) sources.push('SELECT id FROM nc_subscriptions WHERE customer_id=?', 'SELECT id FROM nc_prepaid_requests WHERE customer_id=?', 'SELECT id FROM nc_prepaid_grants WHERE customer_id=?', 'SELECT id FROM nc_prepaid_ledger WHERE customer_id=?')
  if (canRead(actor, 'invoices')) sources.push('SELECT id FROM nc_invoices WHERE customer_id=?', 'SELECT id FROM nc_credit_notes WHERE customer_id=?', 'SELECT id FROM nc_write_offs WHERE customer_id=?', 'SELECT id FROM nc_write_off_recoveries WHERE customer_id=?', 'SELECT id FROM nc_charges WHERE customer_id=?')
  if (canRead(actor, 'payments')) sources.push('SELECT id FROM nc_payments WHERE customer_id=?', 'SELECT id FROM nc_balance_entries WHERE customer_id=?', 'SELECT id FROM nc_balance_requests WHERE customer_id=?')
  if (canRead(actor, 'payments') && canRead(actor, 'invoices')) sources.push('SELECT id FROM nc_ach_payment_evidence WHERE customer_id=?', 'SELECT id FROM nc_native_collections WHERE customer_id=?', 'SELECT id FROM nc_prepaid_refunds WHERE customer_id=?', 'SELECT id FROM nc_prepaid_refund_intakes WHERE customer_id=?', 'SELECT id FROM nc_allocations WHERE payment_id IN (SELECT id FROM nc_payments WHERE customer_id=?)')
  sources.push("SELECT id FROM nc_notes WHERE customer_id=? AND kind='customer'")
  if (canRead(actor, 'invoices')) sources.push("SELECT id FROM nc_notes WHERE customer_id=? AND kind='invoice'")
  if (canRead(actor, 'payments')) sources.push("SELECT id FROM nc_notes WHERE customer_id=? AND kind='payment'")
  const batches=await env.DB.batch<Row>(sources.map(source=>stmt(env,`SELECT seq,at,action,subject FROM nc_audit WHERE subject IN (${source}) ORDER BY seq DESC`,customer)))
  return [...new Map(batches.flatMap(batch=>batch.results).map(row=>[row.seq,row])).values()].sort((a,b)=>b.seq-a.seq)
}

export async function customerBillingRecord(env: Bindings, actor: Actor, customer: string) {
  requireRead(actor, 'customers')
  const row = await one(env, 'SELECT id,erased_at FROM nc_customers WHERE id=?', customer)
  insist(row, 'customer_not_found', 404)
  const empty = { processorPayments: null, paymentMethods: null, prepaid: null, refunds: null, creditBalance: null, subscriptionHistory:null,writeOffs:null,savedPaymentMethods:null,achPaymentEvidence:null,auditEvents: [] }
  // Do not parse retained processor/narrative bytes after erasure.
  if (row.erased_at || await one(env, 'SELECT 1 FROM nc_erased_records WHERE record_id=?', customer)) return empty
  const payments = canRead(actor, 'payments'), invoices = canRead(actor, 'invoices'), subscriptions = canRead(actor, 'subscriptions')
  const subs = subscriptions || payments && invoices ? await all(env, 'SELECT id FROM nc_subscriptions WHERE customer_id=? ORDER BY created_at,id', customer) : []
  const date = subscriptions ? today((await requireBusiness(env)).timezone, clockInstant(env)) : null
  const [processorPayments, prepaid, refunds, balance, auditEvents,subscriptionHistory,writeOffs,savedPaymentMethods,achPaymentEvidence] = await Promise.all([
    payments && invoices ? customerProcessorFacts(env, customer) : null,
    subscriptions ? Promise.all(subs.map(sub => prepaidBalances(env, actor, sub.id, date!))) : null,
    payments && invoices ? Promise.all(subs.map(sub => readPrepaidRefunds(env, actor, sub.id))) : null,
    payments ? balanceView(env, actor, customer) : null,
    customerAuditEvents(env, actor, customer),
    customerSubscriptionHistory(env,actor,customer),customerWriteOffHistory(env,actor,customer),
    payments&&invoices?readCustomerPaymentMethods(env,actor,customer):null,
    payments&&invoices?readAchPaymentEvidence(env,actor,customer):null,
  ])
  const creditBalance = balance ? { customer, cashCents: balance.cashCents, goodwillCents: balance.goodwillCents,
    carriedCents: balance.carriedCents, totalCents: balance.totalCents, entries: balance.entries,
    requests: balance.requests.map(({ id, kind, amountCents, status, approval, payment }: Row) => ({ id, kind, amountCents, status, approval, payment })) } : null
  return { processorPayments, paymentMethods: processorPayments?.filter(payment => payment.card).map(payment => ({
    collection: payment.id, invoice: payment.invoice, card: payment.card, verifiedAt: payment.verifiedAt })) ?? null,
    prepaid, refunds: refunds?.flat().filter(refund => refund.customer === customer).map(typedRefund) ?? null,
    creditBalance, auditEvents,subscriptionHistory,writeOffs,savedPaymentMethods,achPaymentEvidence }
}
