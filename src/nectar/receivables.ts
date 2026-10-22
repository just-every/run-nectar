import { sharedCreditNotes } from './shared-credit-custody'
import { carriedUsageCredits } from './usage-correction-records'
import { revenueCreditStatements } from './revenue-records'
import { clockInstant } from './clock'
import { documentNumberAllocation } from './invoice-numbering'
import { withMetadata } from './metadata'
import { metadataFilter,metadataPredicate } from './metadata-query'
import { alertStatements } from './notifications'
import { deliverAlerts } from './notification-mail'
// Flow 11: issued invoices are never edited. A credit note reduces what is
// owed; a payment is evidence of money received outside Nectar, allocated to
// invoices. For every invoice: total = credited + paid + balance, and no
// credit or allocation can take a balance below zero (checked in the batch).
import type { Bindings } from '../auth.server'
import { actorLabel, can, requireAny, requireCapability, requireMember, requireRead, type Actor } from './actor'
import { requireBusiness } from './business'
import { all, commit, guard, insist, newId, now, one, stmt, type Row } from './core'
import { authorizeCredit, prepareCreditRequest } from './credit-policy'
import { cents, plainMoney } from './decimal'
import { addDays, daysBetween, requireDate, today } from './dates'
import { Input } from './input'

export const BALANCE_SQL = `(i.total_cents - COALESCE((SELECT SUM(COALESCE(applied_cents,amount_cents)) FROM nc_credit_notes WHERE invoice_id = i.id), 0) - COALESCE((SELECT SUM(amount_cents) FROM nc_allocations WHERE invoice_id = i.id), 0) - COALESCE((SELECT SUM(amount_cents) FROM nc_usage_credit_applications WHERE invoice_id=i.id),0))`
export const CARRIED_APPLICATION_SQL = `COALESCE((SELECT SUM(amount_cents) FROM nc_usage_credit_applications WHERE invoice_id=i.id),0)`
const balanceOf = (id: string) => [`(SELECT ${BALANCE_SQL} FROM nc_invoices i WHERE i.id = ?)`, id] as const
const UNALLOCATED_SQL = `(p.amount_cents - COALESCE((SELECT SUM(amount_cents) FROM nc_allocations WHERE payment_id = p.id), 0))`

export async function issuedInvoice(env: Bindings, id: string) {
  const invoice = await one(env, `SELECT i.*, ${BALANCE_SQL} AS balance_cents FROM nc_invoices i WHERE i.id = ?`, id)
  insist(invoice, 'invoice_not_found', 404)
  insist(invoice.status === 'issued', 'invoice_not_issued', 409)
  return invoice
}

export async function creditNoteStatements(env: Bindings, actor: Actor, input: Input, proposalId?: string) {
  requireAny(actor, ['approve', 'credits.limited'])
  insist(actor.kind === 'member', 'person_required', 403)
  if (!can(actor, 'approve')) requireRead(actor, 'invoices')
  const business = await requireBusiness(env)
  const invoice = await issuedInvoice(env, input.text('invoice', { max: 100 }))
  const amount = cents(input.text('amount', { max: 20 }))
  insist(amount > 0, 'invalid_amount')
  insist(amount <= invoice.balance_cents, 'exceeds_balance', 409)
  const reason = input.text('reason', { max: 500 })
  const authorization = await authorizeCredit(env, actor, input, invoice, amount, reason, proposalId)
  const customer = await one(env, 'SELECT * FROM nc_customers WHERE id=?', invoice.customer_id)
  insist(customer && !customer.erased_at, 'customer_not_found', 404)
  const allocation = await documentNumberAllocation(env, business, customer, 'credit-note')
  const number = allocation.number
  const id = newId(), issuedAt=clockInstant(env)
  const [balanceSql, balanceParam] = balanceOf(invoice.id)
  return { statements: [
    ...authorization.guards,
    ...allocation.statements,
    guard(env, 'exceeds_balance', `${balanceSql} >= ?`, balanceParam, amount),
    stmt(env, 'INSERT INTO nc_credit_notes (id, number, invoice_id, customer_id, amount_cents, reason, proposal_id, issued_by, issued_at,billing_entity_id,billing_route_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,?,?)', id, number, invoice.id, invoice.customer_id, amount, reason, proposalId ?? null, actorLabel(actor), issuedAt,allocation.entityId,allocation.routeJson),
    ...await revenueCreditStatements(env,{id,invoice:invoice.id,customer:invoice.customer_id,amountCents:amount,issuedAt}),
    ...(authorization.request ? [stmt(env, "UPDATE nc_credit_requests SET status='issued',approved_by=?,approved_at=?,credit_id=? WHERE id=?", actorLabel(actor), now(), id, authorization.request.id)] : []),
  ], audits: [{ actor: actorLabel(actor), action: 'credit.issue', subject: id, detail: { number, invoice: invoice.number, amount, reason, request: authorization.request?.id ?? null, preparedBy: authorization.request?.prepared_name ?? actorLabel(actor) } }], result: { id: invoice.id, credit: id, number } }
}

export async function issueCreditNote(env: Bindings, actor: Actor, input: Input) {
  const credit = await creditNoteStatements(env, actor, input)
  await commit(env, credit.statements, credit.audits)
  return credit.result
}

export async function prepareCredit(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'approve')
  const invoice = await issuedInvoice(env, input.text('invoice', { max: 100 }))
  return await prepareCreditRequest(env, actor, input, invoice)
}

export async function approveCredit(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'approve')
  const request = await one(env, 'SELECT * FROM nc_credit_requests WHERE id=?', input.text('request', { max: 100 }))
  insist(request, 'credit_request_not_found', 404)
  return await issueCreditNote(env, actor, Input.of({ invoice: request.invoice_id, amount: plainMoney(request.amount_cents), reason: request.reason, request: request.id }))
}

interface PaymentFact {
  paymentId: string; customerId: string; amountCents: number; receivedOn: string
  method: string; reference: string; evidence: string
}
function paymentFactStatement(env: Bindings, actor: Actor, fact: PaymentFact) {
  return stmt(env, 'INSERT INTO nc_payments (id, customer_id, amount_cents, received_on, method, reference, evidence, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', fact.paymentId, fact.customerId, fact.amountCents, fact.receivedOn, fact.method, fact.reference, fact.evidence, actorLabel(actor), now())
}
function allocationFactStatements(env: Bindings, actor: Actor, paymentId: string, invoice: Row, amount: number, id: string) {
  const [balanceSql, balanceParam] = balanceOf(invoice.id)
  return [
    guard(env, 'exceeds_payment', `(SELECT ${UNALLOCATED_SQL} FROM nc_payments p WHERE p.id = ?) >= ?`, paymentId, amount),
    guard(env, 'exceeds_balance', `${balanceSql} >= ?`, balanceParam, amount),
    stmt(env, 'INSERT INTO nc_allocations (id, payment_id, invoice_id, amount_cents, allocated_by, allocated_at) VALUES (?, ?, ?, ?, ?, ?)', id, paymentId, invoice.id, amount, actorLabel(actor), now()),
  ]
}

/** The processor collector supplies captured financial facts, then commits these
 * ordinary payment/allocation statements together with its unique attempt and
 * source guards. This helper never calls a provider or commits on its own. */
export async function collectedPaymentStatements(env: Bindings, actor: Actor, fact: {
  customerId: string; invoiceId: string; amountCents: number; receivedOn: string
  reference: string; evidence: string; paymentId?: string; allocationId?: string
}) {
  requireCapability(actor, 'receivables')
  insist(Number.isSafeInteger(fact.amountCents) && fact.amountCents > 0, 'invalid_amount')
  const customer = await one(env, 'SELECT id FROM nc_customers WHERE id=? AND erased_at IS NULL', fact.customerId)
  insist(customer, 'customer_not_found', 404)
  const invoice = await issuedInvoice(env, fact.invoiceId)
  insist(invoice.customer_id === customer.id, 'different_customer', 409)
  insist(invoice.balance_cents === fact.amountCents, 'collection_balance_changed', 409)
  const received = requireDate(fact.receivedOn, 'received_on')
  insist(typeof fact.reference === 'string' && fact.reference.trim().length > 0 && fact.reference.length <= 120, 'invalid_reference')
  insist(typeof fact.evidence === 'string' && fact.evidence.length <= 1000, 'invalid_evidence')
  insist(!await one(env, 'SELECT 1 FROM nc_payments WHERE customer_id=? AND reference=?', customer.id, fact.reference), 'payment_reference_exists', 409)
  const paymentId = fact.paymentId ?? newId(), allocationId = fact.allocationId ?? newId()
  return { paymentId, allocationId, statements: [
    guard(env, 'customer_erased', 'EXISTS(SELECT 1 FROM nc_customers WHERE id=? AND erased_at IS NULL)', customer.id),
    guard(env, 'payment_reference_exists', 'NOT EXISTS(SELECT 1 FROM nc_payments WHERE customer_id=? AND reference=?)', customer.id, fact.reference),
    guard(env, 'collection_balance_changed', `(SELECT ${BALANCE_SQL} FROM nc_invoices i WHERE i.id=? AND i.status='issued' AND i.customer_id=?)=?`, invoice.id, customer.id, fact.amountCents),
    paymentFactStatement(env, actor, { paymentId, customerId: customer.id, amountCents: fact.amountCents, receivedOn: received, method: 'card_external', reference: fact.reference, evidence: fact.evidence }),
    ...allocationFactStatements(env, actor, paymentId, invoice, fact.amountCents, allocationId),
  ], audits: [
    { actor: actorLabel(actor), action: 'payment.record', subject: paymentId, detail: { customer: customer.id, amount: fact.amountCents, received, method: 'card_external', reference: fact.reference } },
    { actor: actorLabel(actor), action: 'payment.allocate', subject: allocationId, detail: { payment: fact.reference, invoice: invoice.number, amount: fact.amountCents } },
  ] }
}

export async function recordPayment(env: Bindings, actor: Actor, input: Input) {
  requireCapability(actor, 'receivables')
  const customer = await one(env, 'SELECT id FROM nc_customers WHERE id = ?', input.text('customer', { max: 100 }))
  insist(customer, 'customer_not_found', 404)
  const amount = cents(input.text('amount', { max: 20 }))
  insist(amount > 0, 'invalid_amount')
  const received = requireDate(input.text('received_on', { max: 10 }), 'received_on')
  const method = input.text('method', { max: 20 })
  insist(['bank_transfer', 'check', 'card_external', 'other'].includes(method), 'invalid_method')
  const reference = input.text('reference', { max: 120 })
  const evidence = input.text('evidence', { max: 1000, optional: true })
  insist(!await one(env, 'SELECT 1 FROM nc_payments WHERE customer_id = ? AND reference = ?', customer.id, reference), 'payment_reference_exists', 409)
  const id = newId()
  const owed = await all(env, `SELECT ${BALANCE_SQL} AS balance_cents FROM nc_invoices i WHERE i.customer_id=? AND i.status='issued'`,customer.id)
  const mismatch = owed.some(i=>i.balance_cents>0) && !owed.some(i=>i.balance_cents===amount)
  const alerts = mismatch ? await alertStatements(env,'payment_mismatch',id,`/app/customers/${customer.id}#payment-${id}`) : []
  await commit(env, [...alerts,paymentFactStatement(env, actor, { paymentId: id, customerId: customer.id, amountCents: amount, receivedOn: received, method, reference, evidence })],
    { actor: actorLabel(actor), action: 'payment.record', subject: id, detail: { customer: customer.id, amount, received, method, reference } })
  if (mismatch) await deliverAlerts(env,'payment_mismatch',id,actorLabel(actor))
  return { id: customer.id, payment: id }
}

export async function allocate(env: Bindings, actor: Actor, input: Input) {
  requireCapability(actor, 'receivables')
  const payment = await one(env, `SELECT p.*, ${UNALLOCATED_SQL} AS unallocated FROM nc_payments p WHERE p.id = ?`, input.text('payment', { max: 100 }))
  insist(payment, 'payment_not_found', 404)
  const invoice = await issuedInvoice(env, input.text('invoice', { max: 100 }))
  insist(invoice.customer_id === payment.customer_id, 'different_customer', 409)
  const amount = cents(input.text('amount', { max: 20 }))
  insist(amount > 0, 'invalid_amount')
  insist(amount <= payment.unallocated, 'exceeds_payment', 409)
  insist(amount <= invoice.balance_cents, 'exceeds_balance', 409)
  const id = newId()
  await commit(env, allocationFactStatements(env, actor, payment.id, invoice, amount, id), { actor: actorLabel(actor), action: 'payment.allocate', subject: id, detail: { payment: payment.reference, invoice: invoice.number, amount } })
  return { id: invoice.id, allocation: id }
}

export async function payments(env: Bindings, actor: Actor, customerId?: string,url?:URL) {
  requireRead(actor, 'payments')
  return await paymentRows(env, customerId, url)
}

/** Callers authorize first: the payments door, or a customer record's own ledger (GOV-001). */
async function paymentRows(env: Bindings, customerId?: string,url?:URL) {
  const filter=metadataPredicate('payment','p.id',url?metadataFilter(url):null)
  return await withMetadata(env,'payment',await all(env, `SELECT p.*, c.name AS customer_name, ${UNALLOCATED_SQL} AS unallocated_cents FROM nc_payments p JOIN nc_customers c ON c.id = p.customer_id WHERE ${filter.sql} ${customerId ? 'AND p.customer_id = ?' : ''} ORDER BY p.received_on DESC, p.recorded_at DESC ${customerId ? '' : 'LIMIT 200'}`, ...filter.params,...(customerId ? [customerId] : [])))
}

/** Open (issued, unpaid) invoices with their balances. */
export async function openInvoices(env: Bindings, customerId?: string) {
  return await all(env, `SELECT i.id, i.number, i.customer_id, c.name AS customer_name, c.billing_email, i.issue_date, i.due_date, i.total_cents, ${BALANCE_SQL} AS balance_cents
    FROM nc_invoices i JOIN nc_customers c ON c.id = i.customer_id WHERE i.status = 'issued' ${customerId ? 'AND i.customer_id = ?' : ''} AND ${BALANCE_SQL} > 0 ORDER BY i.due_date, i.number`, ...(customerId ? [customerId] : []))
}

export async function customerLedger(env: Bindings, actor: Actor, customerId: string) {
  requireRead(actor, 'customers')
  const invoices = await all(env, `SELECT i.id, i.number, i.issue_date, i.due_date, i.total_cents, ${BALANCE_SQL} AS balance_cents,
    COALESCE((SELECT SUM(COALESCE(applied_cents,amount_cents)) FROM nc_credit_notes WHERE invoice_id = i.id), 0) + ${CARRIED_APPLICATION_SQL} AS credited_cents,
    COALESCE((SELECT SUM(amount_cents) FROM nc_allocations WHERE invoice_id = i.id), 0) AS paid_cents
    FROM nc_invoices i WHERE i.customer_id = ? AND i.status = 'issued' ORDER BY i.issue_date, i.number`, customerId)
  // The customer record includes its own payments, so customer readers see them here.
  const pays = await paymentRows(env, customerId)
  const credits = await sharedCreditNotes(env,'n.customer_id=?',customerId)
  return {
    carriedUsageCredits:await carriedUsageCredits(env,customerId),
    invoices:await withMetadata(env,'invoice',invoices), payments: pays, credits:await withMetadata(env,'credit-note',credits),
    invoicedCents: invoices.reduce((sum, row) => sum + row.total_cents, 0),
    creditedCents: invoices.reduce((sum, row) => sum + row.credited_cents, 0),
    paidCents: invoices.reduce((sum, row) => sum + row.paid_cents, 0),
    balanceCents: invoices.reduce((sum, row) => sum + row.balance_cents, 0),
    unallocatedCents: pays.reduce((sum, row) => sum + row.unallocated_cents, 0),
  }
}

/** The receivables desk: every issued invoice still owed, those settled in the last 30 days with how they
 * were paid, the latest invoicing month's counts and what arrived this month. */
export async function receivablesDesk(env: Bindings, actor: Actor) {
  requireRead(actor, 'invoices')
  requireRead(actor, 'payments')
  const business = await requireBusiness(env)
  const day = today(business.timezone), month = day.slice(0, 7)
  const rows = await all(env, `SELECT i.id, i.number, i.customer_id, c.name AS customer_name, c.address, i.issue_date, i.due_date, i.total_cents, ${BALANCE_SQL} AS balance_cents,
    COALESCE((SELECT SUM(amount_cents) FROM nc_allocations WHERE invoice_id = i.id), 0) AS paid_cents,
    (SELECT MAX(p.received_on) FROM nc_allocations a JOIN nc_payments p ON p.id = a.payment_id WHERE a.invoice_id = i.id) AS paid_on,
    (SELECT p.method FROM nc_allocations a JOIN nc_payments p ON p.id = a.payment_id WHERE a.invoice_id = i.id ORDER BY p.received_on DESC LIMIT 1) AS method
    FROM nc_invoices i JOIN nc_customers c ON c.id = i.customer_id WHERE i.status = 'issued'`)
  const open = rows.filter(row => row.balance_cents > 0).map((row): Row => ({ ...row, daysOverdue: Math.max(0, daysBetween(row.due_date, day)) }))
  const settled = rows.filter(row => row.balance_cents <= 0 && (row.paid_on ?? row.issue_date) >= addDays(day, -30)).sort((a, b) => String(b.paid_on ?? '').localeCompare(String(a.paid_on ?? ''))).slice(0, 10)
  const issueMonth = rows.reduce((latest: string, row) => row.issue_date > latest ? row.issue_date : latest, '').slice(0, 7)
  const ofMonth = rows.filter(row => issueMonth && row.issue_date.startsWith(issueMonth))
  const collected = await one<{ cents: number }>(env, 'SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM nc_payments WHERE received_on >= ? AND received_on <= ?', `${month}-01`, day)
  return {
    day, month, open, settled, issueMonth,
    issued: ofMonth.length, paid: ofMonth.filter(row => row.balance_cents <= 0).length,
    owedCents: open.reduce((sum, row) => sum + row.balance_cents, 0),
    overdueCents: open.filter(row => row.daysOverdue > 0).reduce((sum, row) => sum + row.balance_cents, 0),
    collectedCents: collected?.cents ?? 0,
  }
}
