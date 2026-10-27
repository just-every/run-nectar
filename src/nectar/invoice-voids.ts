import { refundActorGuard } from './prepaid-refund-records'
import type { Bindings } from '../auth.server'
import { actorLabel, requireMember, type Actor } from './actor'
import { BALANCE_SQL } from './balance-sql'
import { requireBusiness } from './business'
import { clockInstant } from './clock'
import { all, commit, fingerprint, guard, insist, newId, one, parseJson, stmt, type Row } from './core'
import { authorizeCredit, creditRequestStatements } from './credit-policy'
import { plainMoney } from './decimal'
import { Input } from './input'
import { invoiceContent } from './invoice-content'
import { documentNumberAllocation } from './invoice-numbering'
import { requireFreshFactor } from './mfa'
import { revenueCreditStatements } from './revenue-records'

async function source(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'approve')
  await requireFreshFactor(env, actor)
  const invoice = await one(env, `SELECT i.*,${BALANCE_SQL} AS balance_cents FROM nc_invoices i JOIN nc_customers c ON c.id=i.customer_id WHERE i.id=? AND c.erased_at IS NULL`, input.text('invoice', { max: 100 }))
  insist(invoice, 'invoice_not_found', 404)
  insist(invoice.status === 'issued', 'invoice_not_issued', 409)
  insist(invoice.source_fingerprint === input.text('basis', { max: 100 }), 'source_changed', 409)
  insist(!await one(env,"SELECT 1 FROM nc_customer_hierarchies WHERE customer_id=? AND billing_mode='consolidated'",invoice.customer_id),'consolidation_required',409)
  const lines = await all(env, 'SELECT * FROM nc_invoice_lines WHERE invoice_id=? ORDER BY seq', invoice.id)
  // Funding and credit-consumption lines retain their own correction duties.
  const kinds = ['one_time', 'flat', 'seat', 'usage', 'overage', 'discount', 'metric_usage']
  insist(invoice.currency === 'USD' && invoice.tax_cents === 0 && invoice.total_cents > 0 && lines.length > 0 && lines.every(line => kinds.includes(line.kind)), 'invoice_void_scope_not_supported', 409)
  insist(invoice.balance_cents === invoice.total_cents && !await one(env, 'SELECT 1 FROM nc_credit_notes WHERE invoice_id=?', invoice.id), 'invoice_not_wholly_unpaid', 409)
  return { invoice, lines }
}

export async function prepareInvoiceVoid(env: Bindings, actor: Actor, input: Input) {
  const { invoice } = await source(env, actor, input)
  const prepared = await creditRequestStatements(env, actor, Input.of({ amount: plainMoney(invoice.total_cents), reason: input.text('reason', { max: 500 }) }), invoice, 'invoice-void')
  await commit(env, [refundActorGuard(env, actor), ...prepared.statements], prepared.audits)
  return prepared.result
}

export async function voidInvoice(env: Bindings, actor: Actor, input: Input) {
  const { invoice, lines } = await source(env, actor, input)
  insist(input.flag('confirm'), 'confirmation_required')
  const reason = input.text('reason', { max: 500 })
  const authorization = await authorizeCredit(env, actor, input, invoice, invoice.total_cents, reason, undefined, undefined, undefined, 'invoice-void')
  if (authorization.request) insist(await one(env,"SELECT 1 FROM nc_members m JOIN oa_operators o ON o.email=m.email WHERE m.id=? AND m.status='active' AND m.role IN ('owner','finance') AND o.status='active' AND (m.role<>'owner' OR o.role='owner')",authorization.request.prepared_by),'void_preparer_no_longer_authorized',409)
  const business = await requireBusiness(env), customer = await one(env, 'SELECT * FROM nc_customers WHERE id=? AND erased_at IS NULL', invoice.customer_id)
  insist(customer, 'customer_not_found', 404)
  const number = await documentNumberAllocation(env, business, customer, 'credit-note')
  insist(number.entityId === invoice.billing_entity_id && number.routeJson === invoice.billing_route_json, 'source_changed', 409)
  const id = newId(), credit = newId(), run = newId(), at = clockInstant(env)
  const original = parseJson<Row>(invoice.calculation_json, {})
  const inputs = { version: invoice.calc_version, currency: invoice.currency, customer: customer.id, date: invoice.period_start, charges: [], tax: original.inputs.tax, invoiceContent: await invoiceContent(env, business, customer.id), reissue: { invoice: invoice.id, credit, sourceFingerprint: invoice.source_fingerprint } }
  const basis = await fingerprint(inputs)
  const calculation = { version: invoice.calc_version, fingerprint: basis, tax: original.tax, consumedEvents: [], inputs }
  await commit(env, [
    refundActorGuard(env, actor), ...authorization.guards, ...number.statements,
    ...(authorization.request ? [guard(env, 'void_preparer_no_longer_authorized', "EXISTS(SELECT 1 FROM nc_members m JOIN oa_operators o ON o.email=m.email WHERE m.id=? AND m.status='active' AND m.role IN ('owner','finance') AND o.status='active' AND (m.role<>'owner' OR o.role='owner'))", authorization.request.prepared_by)] : []),
    guard(env, 'invoice_not_wholly_unpaid', `(SELECT ${BALANCE_SQL} FROM nc_invoices i WHERE i.id=? AND i.status='issued')=? AND NOT EXISTS(SELECT 1 FROM nc_credit_notes WHERE invoice_id=?)`, invoice.id, invoice.total_cents, invoice.id),
    stmt(env, "INSERT INTO nc_bill_runs(id,period,cutoff_at,calc_version,status,summary_json,created_by,created_at,kind) VALUES(?,?,?,?,'draft',?,?,?,'manual')", run, invoice.period_start.slice(0, 7), at, invoice.calc_version, JSON.stringify({ invoices: 1, totals: { subtotal: invoice.subtotal_cents, tax: 0, total: invoice.total_cents }, reissuedFrom: invoice.id }), actorLabel(actor), at),
    stmt(env, "INSERT INTO nc_invoices(id,bill_run_id,customer_id,subscription_id,invoice_kind,period_start,period_end,status,subtotal_cents,tax_cents,total_cents,currency,calc_version,source_fingerprint,calculation_json,comparison_json,exceptions_json,created_at) VALUES(?,?,?,NULL,'manual',?,?,'draft',?,0,?,?,?,?,?,'{}','[]',?)", id, run, invoice.customer_id, invoice.period_start, invoice.period_end, invoice.subtotal_cents, invoice.total_cents, invoice.currency, invoice.calc_version, basis, JSON.stringify(calculation), at),
    ...lines.map(line => stmt(env, 'INSERT INTO nc_invoice_lines(id,invoice_id,seq,kind,description,quantity,unit_amount,amount_cents,taxable,price_id,meter_id,period_start,period_end,evidence_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', newId(), id, line.seq, line.kind, line.description, line.quantity, line.unit_amount, line.amount_cents, line.taxable, line.price_id, line.meter_id, line.period_start, line.period_end, line.evidence_json)),
    stmt(env, 'INSERT INTO nc_credit_notes(id,number,invoice_id,customer_id,amount_cents,reason,issued_by,issued_at,applied_cents,subtotal_cents,tax_cents,billing_entity_id,billing_route_json,void_replacement_id) VALUES(?,?,?,?,?,?,?,?,?,?,0,?,?,?)', credit, number.number, invoice.id, invoice.customer_id, invoice.total_cents, reason, actorLabel(actor), at, invoice.total_cents, invoice.subtotal_cents, number.entityId, number.routeJson, id),
    ...await revenueCreditStatements(env, { id: credit, invoice: invoice.id, customer: invoice.customer_id, amountCents: invoice.total_cents, issuedAt: at }),
    ...(authorization.request ? [stmt(env, "UPDATE nc_credit_requests SET status='issued',approved_by=?,approved_at=?,credit_id=? WHERE id=?", actorLabel(actor), at, credit, authorization.request.id)] : []),
  ], { actor: actorLabel(actor), action: 'invoice.void', subject: invoice.id, detail: { replacement: id, credit, amountCents: invoice.total_cents, reason, request: authorization.request?.id ?? null, preparedBy: authorization.request?.prepared_name ?? actorLabel(actor), approvedBy: actorLabel(actor) } })
  return { id, original: invoice.id, credit, run }
}
