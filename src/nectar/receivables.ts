// Flow 11: issued invoices are never edited. A credit note reduces what is
// owed; a payment is evidence of money received outside Nectar, allocated to
// invoices. For every invoice: total = credited + paid + balance, and no
// credit or allocation can take a balance below zero (checked in the batch).
import type { Bindings } from '../auth.server'
import { actorLabel, requireCapability, requireMember, type Actor } from './actor'
import { requireBusiness } from './business'
import { all, commit, guard, insist, newId, now, one, stmt } from './core'
import { cents } from './decimal'
import { requireDate } from './dates'
import type { Input } from './input'

export const BALANCE_SQL = `(i.total_cents - COALESCE((SELECT SUM(amount_cents) FROM nc_credit_notes WHERE invoice_id = i.id), 0) - COALESCE((SELECT SUM(amount_cents) FROM nc_allocations WHERE invoice_id = i.id), 0))`
const balanceOf = (id: string) => [`(SELECT ${BALANCE_SQL} FROM nc_invoices i WHERE i.id = ?)`, id] as const
const UNALLOCATED_SQL = `(p.amount_cents - COALESCE((SELECT SUM(amount_cents) FROM nc_allocations WHERE payment_id = p.id), 0))`

async function issuedInvoice(env: Bindings, id: string) {
  const invoice = await one(env, `SELECT i.*, ${BALANCE_SQL} AS balance_cents FROM nc_invoices i WHERE i.id = ?`, id)
  insist(invoice, 'invoice_not_found', 404)
  insist(invoice.status === 'issued', 'invoice_not_issued', 409)
  return invoice
}

export async function issueCreditNote(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'approve')
  const business = await requireBusiness(env)
  const invoice = await issuedInvoice(env, input.text('invoice', { max: 100 }))
  const amount = cents(input.text('amount', { max: 20 }))
  insist(amount > 0, 'invalid_amount')
  insist(amount <= invoice.balance_cents, 'exceeds_balance', 409)
  const reason = input.text('reason', { max: 500 })
  const sequence = business.next_credit_number
  const number = `${business.invoice_prefix}-CN-${String(sequence).padStart(6, '0')}`
  const id = newId()
  const [balanceSql, balanceParam] = balanceOf(invoice.id)
  await commit(env, [
    guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_business WHERE singleton = 1 AND next_credit_number = ?)', sequence),
    guard(env, 'exceeds_balance', `${balanceSql} >= ?`, balanceParam, amount),
    stmt(env, 'UPDATE nc_business SET next_credit_number = next_credit_number + 1 WHERE singleton = 1'),
    stmt(env, 'INSERT INTO nc_credit_notes (id, number, invoice_id, customer_id, amount_cents, reason, proposal_id, issued_by, issued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', id, number, invoice.id, invoice.customer_id, amount, reason, input.text('proposal', { max: 100, optional: true }) || null, actorLabel(actor), now()),
  ], { actor: actorLabel(actor), action: 'credit.issue', subject: id, detail: { number, invoice: invoice.number, amount, reason } })
  return { id: invoice.id, credit: id, number }
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
  await commit(env, [stmt(env, 'INSERT INTO nc_payments (id, customer_id, amount_cents, received_on, method, reference, evidence, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', id, customer.id, amount, received, method, reference, evidence, actorLabel(actor), now())],
    { actor: actorLabel(actor), action: 'payment.record', subject: id, detail: { customer: customer.id, amount, received, method, reference } })
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
  const [balanceSql, balanceParam] = balanceOf(invoice.id)
  const id = newId()
  await commit(env, [
    guard(env, 'exceeds_payment', `(SELECT ${UNALLOCATED_SQL} FROM nc_payments p WHERE p.id = ?) >= ?`, payment.id, amount),
    guard(env, 'exceeds_balance', `${balanceSql} >= ?`, balanceParam, amount),
    stmt(env, 'INSERT INTO nc_allocations (id, payment_id, invoice_id, amount_cents, allocated_by, allocated_at) VALUES (?, ?, ?, ?, ?, ?)', id, payment.id, invoice.id, amount, actorLabel(actor), now()),
  ], { actor: actorLabel(actor), action: 'payment.allocate', subject: id, detail: { payment: payment.reference, invoice: invoice.number, amount } })
  return { id: invoice.id, allocation: id }
}

export async function payments(env: Bindings, actor: Actor, customerId?: string) {
  requireCapability(actor, 'read')
  return await all(env, `SELECT p.*, c.name AS customer_name, ${UNALLOCATED_SQL} AS unallocated_cents FROM nc_payments p JOIN nc_customers c ON c.id = p.customer_id ${customerId ? 'WHERE p.customer_id = ?' : ''} ORDER BY p.received_on DESC, p.recorded_at DESC LIMIT 200`, ...(customerId ? [customerId] : []))
}

/** Open (issued, unpaid) invoices with their balances. */
export async function openInvoices(env: Bindings, customerId?: string) {
  return await all(env, `SELECT i.id, i.number, i.customer_id, c.name AS customer_name, c.billing_email, i.issue_date, i.due_date, i.total_cents, ${BALANCE_SQL} AS balance_cents
    FROM nc_invoices i JOIN nc_customers c ON c.id = i.customer_id WHERE i.status = 'issued' ${customerId ? 'AND i.customer_id = ?' : ''} AND ${BALANCE_SQL} > 0 ORDER BY i.due_date, i.number`, ...(customerId ? [customerId] : []))
}

export async function customerLedger(env: Bindings, actor: Actor, customerId: string) {
  requireCapability(actor, 'read')
  const invoices = await all(env, `SELECT i.id, i.number, i.issue_date, i.due_date, i.total_cents, ${BALANCE_SQL} AS balance_cents,
    COALESCE((SELECT SUM(amount_cents) FROM nc_credit_notes WHERE invoice_id = i.id), 0) AS credited_cents,
    COALESCE((SELECT SUM(amount_cents) FROM nc_allocations WHERE invoice_id = i.id), 0) AS paid_cents
    FROM nc_invoices i WHERE i.customer_id = ? AND i.status = 'issued' ORDER BY i.issue_date, i.number`, customerId)
  const pays = await payments(env, actor, customerId)
  const credits = await all(env, 'SELECT * FROM nc_credit_notes WHERE customer_id = ? ORDER BY issued_at', customerId)
  return {
    invoices, payments: pays, credits,
    invoicedCents: invoices.reduce((sum, row) => sum + row.total_cents, 0),
    creditedCents: invoices.reduce((sum, row) => sum + row.credited_cents, 0),
    paidCents: invoices.reduce((sum, row) => sum + row.paid_cents, 0),
    balanceCents: invoices.reduce((sum, row) => sum + row.balance_cents, 0),
    unallocatedCents: pays.reduce((sum, row) => sum + row.unallocated_cents, 0),
  }
}
