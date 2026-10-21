// Invoice corrections are proposals: preparing them never changes an issued bill.
import type { Bindings } from '../auth.server'
import { actorLabel, requireMember, type Actor } from './actor'
import { requireBusiness, type Business } from './business'
import { all, canonical, commit, fingerprint, guard, insist, now, one, parseJson, stmt, type Row } from './core'
import { creditPolicy, creditRequestStatements } from './credit-policy'
import { cents, plainMoney } from './decimal'
import { Input } from './input'
import { invoiceTotals } from './invoice-tax'
import type { Line } from './rating'
import { BALANCE_SQL, creditNoteStatements, issuedInvoice } from './receivables'
import { clockInstant } from './clock'
import { addMonths, localDate, zonedStart } from './dates'
import { customerText } from './locale'
import { recognitionForSavedInvoice, REVENUE_POLICY_VERSION, type RevenueSchedule } from './revenue-allocation'
import { revenuePreview, revenuePeriodDeltas } from './draft-correction-plan'

interface Citation { line_id: string; source: string; quote: string }
interface CreditSource {
  invoice: Row; lines: Row[]; policy: Row; creditHistory: Row[]
  generation: number; issueMonth: string; timezone: string
}

function creditRevenueSchedule(invoiceId: string, creditId: string, amount: number, issueMonth: string): RevenueSchedule {
  insist(Number.isSafeInteger(amount) && /^\d{4}-(0[1-9]|1[0-2])$/.test(issueMonth), 'invoice_credit_revenue_source_required', 409)
  return { lineId: `credit:${creditId}`, kind: 'credit_note', amountCents: -amount,
    serviceStart: `${issueMonth}-01`, serviceEnd: addMonths(`${issueMonth}-01`, 1), policy: 'credit-contra-issue-month',
    entries: [{ period: issueMonth, amountCents: -amount, basis: { method: 'credit-contra-issue-month', invoiceId, creditId, issueMonth } }],
    basis: { version: REVENUE_POLICY_VERSION, invoiceId, creditId, issueMonth, attribution: 'invoice-level; original lines and tax unchanged' } }
}

function text(value: unknown, field: string, max: number) {
  insist(typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max, `invalid_${field}`)
  return value.trim()
}

/** Each quote must be present in the saved line, its evidence or its saved calculation.
 * Source references are local and invoice scoped; arbitrary URLs cannot become evidence. */
function citationsFor(payload: Row, invoice: Row, lines: Row[]): Citation[] {
  insist(Array.isArray(payload.citations) && payload.citations.length > 0 && payload.citations.length <= 50, 'invoice_credit_citations_required')
  return payload.citations.map((entry: Row) => {
    insist(entry && typeof entry === 'object' && !Array.isArray(entry), 'invalid_invoice_credit_citation')
    const lineId = text(entry.line_id, 'line_id', 100)
    const line = lines.find(row => row.id === lineId)
    insist(line, 'invoice_credit_line_not_found', 400)
    const source = text(entry.source, 'source', 400)
    const href = `/app/invoices/${encodeURIComponent(invoice.id)}/lines/${encodeURIComponent(line.id)}`
    insist(source === href || source === `${href}#evidence` || source === `${href}#calculation`, 'invoice_credit_source_mismatch')
    const quote = text(entry.quote, 'quote', 2000)
    const material = source.endsWith('#calculation') ? invoice.calculation_json : source.endsWith('#evidence') ? line.evidence_json : line.description
    // Compare decoded string values too, so JSON escaping cannot hide an actual quotation.
    const strings = (value: unknown): string[] => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : []
    insist((typeof material === 'string' && material.includes(quote)) || strings(parseJson(material, null)).some(value => value.includes(quote)), 'invoice_credit_quote_mismatch')
    return { line_id: lineId, source, quote }
  })
}

async function invoiceCreditPlan(env: Bindings, business: Business, payload: Row) {
  insist(payload.invoice_credit === true, 'invalid_invoice_credit')
  const generation = await one<{ value: number }>(env, 'SELECT value FROM nc_privacy_generation WHERE id=1')
  insist(generation && Number.isSafeInteger(generation.value), 'invoice_credit_revenue_fence_required', 409)
  const invoice = await issuedInvoice(env, text(payload.invoice, 'invoice', 100))
  insist(invoice.balance_cents > 0, 'invoice_already_settled', 409)
  const amount = cents(text(payload.amount, 'amount', 20))
  insist(amount > 0 && amount <= invoice.balance_cents, 'exceeds_balance', 409)
  const [customer, lines, policy, creditHistory] = await Promise.all([
    one(env, 'SELECT id,billing_email,language FROM nc_customers WHERE id=?', invoice.customer_id),
    all(env, 'SELECT * FROM nc_invoice_lines WHERE invoice_id=? ORDER BY seq,id', invoice.id),
    creditPolicy(env),
    all(env, 'SELECT id,invoice_id,amount_cents,subtotal_cents,issued_at FROM nc_credit_notes WHERE invoice_id=? ORDER BY issued_at,id', invoice.id),
  ])
  insist(customer && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.billing_email), 'customer_billing_email_required', 409)
  const recipient = customer.billing_email
  insist(payload.recipient === undefined || payload.recipient === recipient, 'invoice_credit_recipient_fixed')
  const reason = text(payload.reason, 'reason', 500)
  const explanation = text(payload.explanation, 'explanation', 8000)
  const subject = text(payload.subject, 'subject', 200)
  insist(!/[\r\n]/.test(subject), 'invalid_subject')
  const body = text(payload.body, 'body', 12000)
  const citations = citationsFor(payload, invoice, lines)
  const calculation = parseJson<Row>(invoice.calculation_json, {})
  const tax = calculation.inputs?.tax
  insist(tax && ['no_tax','flat_rate'].includes(tax.mode), 'invoice_credit_calculation_unavailable', 409)
  const computed = invoiceTotals(tax, lines.map(line => ({ amountCents: line.amount_cents, taxable: !!line.taxable } as Line)))
  const correctionTax=lines.filter(line=>line.kind==='usage_correction').reduce((n,line)=>n+Number(parseJson<Row>(line.evidence_json,{}).taxDeltaCents??0),0)
  computed.taxCents+=correctionTax;computed.totalCents+=correctionTax
  insist(!computed.exceptions.length && computed.subtotalCents === invoice.subtotal_cents && computed.taxCents === invoice.tax_cents && computed.totalCents === invoice.total_cents, 'invoice_credit_calculation_mismatch', 409)
  const originalSchedules = recognitionForSavedInvoice(invoice, lines, business.timezone)
  const historicalAdjustments = creditHistory.map(credit => {
    insist(typeof credit.id === 'string' && Number.isSafeInteger(credit.issued_at), 'invoice_credit_revenue_source_required', 409)
    return creditRevenueSchedule(invoice.id, credit.id, credit.subtotal_cents??credit.amount_cents, localDate(credit.issued_at, business.timezone).slice(0, 7))
  })
  const issueMonth = localDate(clockInstant(env), business.timezone).slice(0, 7)
  insist(payload.revenueIssueMonth === undefined || payload.revenueIssueMonth === issueMonth, 'proposal_stale', 409)
  const beforeRevenue = await revenuePreview([...originalSchedules, ...historicalAdjustments])
  const adjustment = creditRevenueSchedule(invoice.id, 'proposed', amount, issueMonth)
  const afterRevenue = await revenuePreview([...originalSchedules, ...historicalAdjustments, adjustment])
  const revenueDeltas = revenuePeriodDeltas(beforeRevenue, afterRevenue)
  insist(revenueDeltas.reduce((sum, entry) => sum + BigInt(entry.deltaCents), 0n) === -BigInt(amount)
    && revenueDeltas.every(entry => entry.period === issueMonth || entry.deltaCents === 0), 'invoice_credit_revenue_mismatch', 409)
  const L = customerText(customer.language)
  const revenueExplanation = [L.t('correction.revenue.heading'), L.t('correction.revenue.policy', { policy: REVENUE_POLICY_VERSION }),
    L.t('correction.revenue.credit', { amount: L.money(amount), from: L.day(`${issueMonth}-01`) }),
    ...revenueDeltas.map(entry => L.t('correction.revenue.period', { from: L.day(`${entry.period}-01`), before: L.money(entry.beforeCents), after: L.money(entry.afterCents), change: L.money(entry.deltaCents) }))].join('\n')
  const invoiceSource = `/app/invoices/${encodeURIComponent(invoice.id)}`
  const revenueCitations: Row[] = originalSchedules.flatMap((schedule, index) => schedule.entries.map((entry, entryIndex) => ({
    line_id: schedule.lineId, source: `${invoiceSource}/lines/${encodeURIComponent(schedule.lineId)}#calculation`,
    quote: L.t('correction.revenue.schedule', { line: schedule.lineId, amount: L.money(entry.amountCents), from: L.day(`${entry.period}-01`), policy: REVENUE_POLICY_VERSION }),
    policyVersion: REVENUE_POLICY_VERSION, fingerprint: beforeRevenue.fingerprint, recordPath: `/revenue/before/schedules/${index}/entries/${entryIndex}`,
  })))
  revenueCitations.push({ source: invoiceSource, quote: L.t('correction.revenue.policy', { policy: REVENUE_POLICY_VERSION }),
    policyVersion: REVENUE_POLICY_VERSION, fingerprint: beforeRevenue.fingerprint, recordPath: '/revenue/policyVersion' })
  historicalAdjustments.forEach((schedule, index) => revenueCitations.push({ source: invoiceSource, credit_id: creditHistory[index].id,
    quote: L.t('correction.revenue.credit', { amount: L.money(creditHistory[index].amount_cents), from: L.day(`${schedule.entries[0].period}-01`) }),
    policyVersion: REVENUE_POLICY_VERSION, fingerprint: beforeRevenue.fingerprint, recordPath: `/revenue/before/schedules/${originalSchedules.length + index}` }))
  revenueCitations.push({ source: invoiceSource, quote: L.t('correction.revenue.credit', { amount: L.money(amount), from: L.day(`${issueMonth}-01`) }),
    policyVersion: REVENUE_POLICY_VERSION, fingerprint: afterRevenue.fingerprint, recordPath: '/revenue/adjustment', amountCents: -amount, period: issueMonth })
  const normalized = { invoice_credit: true, invoice: invoice.id, amount: plainMoney(amount), reason, explanation, recipient, subject, body, citations,
    revenueIssueMonth: issueMonth, revenueNotice: { explanation: revenueExplanation, citations: revenueCitations } }
  const mailBody = `${body}\n\n${revenueExplanation}`, mailExplanation = `${explanation}\n\n${revenueExplanation}`
  const mailCitations = [...citations, ...revenueCitations]
  const impact = {
    invoice: { id: invoice.id, number: invoice.number, customer: invoice.customer_id, currency: invoice.currency,
      subtotalCents: computed.subtotalCents, taxCents: computed.taxCents, totalCents: computed.totalCents, balanceCents: invoice.balance_cents },
    credit: { amountCents: amount, balanceBeforeCents: invoice.balance_cents, balanceAfterCents: invoice.balance_cents - amount,
      needsSecondApprover: policy.two_person_above_cents !== null && amount > policy.two_person_above_cents },
    issuedInvoice: 'The issued invoice, its lines, subtotal, original tax and total remain unchanged. The credit note reduces only the amount owed.',
    tax: 'Original invoice tax remains unchanged. This credit does not compute or record a tax reversal.',
    futureInvoices: 'This credit note does not rewrite future invoices or change subscription pricing or contract terms.',
    revenue: { policyVersion: REVENUE_POLICY_VERSION, issueMonth, before: beforeRevenue, after: afterRevenue, periods: revenueDeltas,
      adjustment: { kind: 'contra-revenue', amountCents: -amount, period: issueMonth, invoiceId: invoice.id }, citations: revenueCitations },
    mrr: 'This proposal does not change subscription terms or compute normalized MRR.',
    portal: 'No customer portal visibility or delivery is asserted by this proposal.',
    mail: { recipient, subject, body: mailBody, explanation: mailExplanation, citations: mailCitations, outcome: 'Queued only after human approval; provider acceptance does not confirm mailbox delivery.',
      // PORT-006: the author writes in the customer's language; Nectar never translates this text.
      language: customer.language, translation: 'Sent exactly as written; Nectar does not translate it.' },
  }
  const basis = { invoiceCredit: await fingerprint({
    invoice: { id: invoice.id, status: invoice.status, customer: invoice.customer_id, calculation: invoice.calculation_json,
      fingerprint: invoice.source_fingerprint, version: invoice.calc_version, subtotal: invoice.subtotal_cents,
      tax: invoice.tax_cents, total: invoice.total_cents, balance: invoice.balance_cents, currency: invoice.currency },
    lines, policy, recipient, normalized, revenue: impact.revenue, creditHistory,
  }) }
  return { normalized, impact, basis, source: { invoice, lines, policy, creditHistory, generation: generation.value, issueMonth, timezone: business.timezone } }
}

export async function planInvoiceCredit(env: Bindings, business: Business, payload: Row, _saved = false) {
  const { normalized, impact, basis } = await invoiceCreditPlan(env, business, payload)
  return { normalized, impact, basis }
}

/** Snapshot guards run in the credit/preparation batch, after the read-only plan. */
function sourceGuards(env: Bindings, source: CreditSource, payload: Row) {
  const { invoice, lines, policy, creditHistory } = source
  const monthStart = zonedStart(`${source.issueMonth}-01`, source.timezone), monthEnd = zonedStart(addMonths(`${source.issueMonth}-01`, 1), source.timezone)
  const localClock = env.AUTH_LOCAL === 'true' && (env as Bindings & { NECTAR_LOCAL_TIME?: string }).NECTAR_LOCAL_TIME !== undefined
  const clock = localClock ? '?' : "CAST(strftime('%s','now') AS INTEGER)*1000"
  const monthParams = localClock ? [clockInstant(env), monthStart, clockInstant(env), monthEnd] : [monthStart, monthEnd]
  return [
    guard(env, 'proposal_stale', '(SELECT value FROM nc_privacy_generation WHERE id=1)=?', source.generation),
    guard(env, 'proposal_stale', `${clock}>=? AND ${clock}<?`, ...monthParams),
    guard(env, 'proposal_stale', 'EXISTS(SELECT 1 FROM nc_business WHERE singleton=1 AND timezone=?)', source.timezone),
    guard(env, 'proposal_stale', `EXISTS(SELECT 1 FROM nc_invoices i WHERE i.id=? AND i.status='issued' AND i.calculation_json=? AND i.source_fingerprint=? AND i.subtotal_cents=? AND i.tax_cents=? AND i.total_cents=? AND ${BALANCE_SQL}=?)`, invoice.id, invoice.calculation_json, invoice.source_fingerprint, invoice.subtotal_cents, invoice.tax_cents, invoice.total_cents, invoice.balance_cents),
    guard(env, 'proposal_stale', 'EXISTS(SELECT 1 FROM nc_customers WHERE id=? AND billing_email=?)', invoice.customer_id, payload.recipient),
    guard(env, 'proposal_stale', 'COALESCE((SELECT revision FROM nc_credit_policy WHERE singleton=1),0)=? AND (SELECT two_person_above_cents FROM nc_credit_policy WHERE singleton=1) IS ?', policy.revision, policy.two_person_above_cents),
    guard(env, 'proposal_stale', '(SELECT COUNT(*) FROM nc_invoice_lines WHERE invoice_id=?)=?', invoice.id, lines.length),
    ...lines.map(line => {
      const snapshot = `json_object(${Object.keys(line).flatMap(key => [`'${key}'`, `"${key.replaceAll('"', '""')}"`]).join(',')})`
      return guard(env, 'proposal_stale', `EXISTS(SELECT 1 FROM nc_invoice_lines WHERE id=? AND invoice_id=? AND ${snapshot}=?)`, line.id, invoice.id, JSON.stringify(line))
    }),
    guard(env, 'proposal_stale', '(SELECT COUNT(*) FROM nc_credit_notes WHERE invoice_id=?)=?', invoice.id, creditHistory.length),
    ...creditHistory.map(credit => guard(env, 'proposal_stale', 'EXISTS(SELECT 1 FROM nc_credit_notes WHERE id=? AND invoice_id=? AND amount_cents=? AND issued_at=?)', credit.id, invoice.id, credit.amount_cents, credit.issued_at)),
  ]
}

function pendingGuard(env: Bindings, row: Row) {
  return guard(env, 'proposal_stale', "EXISTS(SELECT 1 FROM nc_proposals WHERE id=? AND kind='amendment' AND status='pending' AND payload_json=? AND basis_json=?)", row.id, row.payload_json, row.basis_json)
}

async function checkedPlan(env: Bindings, row: Row, payload: Row) {
  insist(row.kind === 'amendment' && row.status === 'pending', 'proposal_not_pending', 409)
  insist(canonical(payload) === canonical(parseJson(row.payload_json, null)), 'proposal_stale', 409)
  const plan = await invoiceCreditPlan(env, await requireBusiness(env), payload)
  insist(canonical(plan.basis) === canonical(parseJson(row.basis_json, null)), 'proposal_stale', 409)
  return plan
}

/** A human prepares the exact saved proposal through the existing GOV002 request. */
export async function prepareInvoiceCredit(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'approve')
  const row = await one(env, 'SELECT * FROM nc_proposals WHERE id=?', input.text('proposal', { max: 100 }))
  insist(row, 'proposal_not_found', 404)
  const payload = parseJson<Row>(row.payload_json, {})
  const plan = await checkedPlan(env, row, payload)
  insist(!await one(env, 'SELECT 1 FROM nc_credit_correction_requests WHERE proposal_id=?', row.id), 'invoice_credit_already_prepared', 409)
  const invoice = plan.source.invoice
  const prepared = await creditRequestStatements(env, actor, Input.of({ amount: payload.amount, reason: payload.reason }), invoice)
  await commit(env, [pendingGuard(env, row), ...sourceGuards(env, plan.source, payload), ...prepared.statements,
    stmt(env, 'INSERT INTO nc_credit_correction_requests(proposal_id,request_id,prepared_at) VALUES (?,?,?)', row.id, prepared.request, now())],
    [...prepared.audits, { actor: actorLabel(actor), action: 'proposal.credit.prepare', subject: row.id, detail: { request: prepared.request } }])
  return { id: row.id, request: prepared.request }
}

/** Caller adds proposal close statements and commits all statements/audits once.
 * The customer mail is already frozen when the transaction becomes visible. */
export async function invoiceCreditStatements(env: Bindings, actor: Actor, proposalRow: Row, payload: Row) {
  requireMember(actor, 'approve')
  const plan = await checkedPlan(env, proposalRow, payload)
  const invoice = plan.source.invoice
  const binding = await one(env, 'SELECT request_id FROM nc_credit_correction_requests WHERE proposal_id=?', proposalRow.id)
  const credit = await creditNoteStatements(env, actor, Input.of({ invoice: invoice.id, amount: payload.amount, reason: payload.reason,
    ...(binding ? { request: binding.request_id } : {}) }), proposalRow.id)
  return {
    statements: [pendingGuard(env, proposalRow), ...sourceGuards(env, plan.source, payload),
      guard(env, 'proposal_stale', '(SELECT request_id FROM nc_credit_correction_requests WHERE proposal_id=?) IS ?', proposalRow.id, binding?.request_id ?? null),
      ...credit.statements,
      stmt(env, `INSERT INTO nc_credit_correction_mail(proposal_id,credit_id,customer_id,recipient,subject,body,explanation,citations_json,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,'pending',?,?)`, proposalRow.id, credit.result.credit, invoice.customer_id, payload.recipient, payload.subject, plan.impact.mail.body, plan.impact.mail.explanation, JSON.stringify(plan.impact.mail.citations), now(), now())],
    audits: [...credit.audits, { actor: actorLabel(actor), action: 'proposal.credit.mail.queue', subject: proposalRow.id, detail: { credit: credit.result.credit, recipient: payload.recipient } }],
    result: { ...credit.result, mail: 'pending', proposal: proposalRow.id },
  }
}
