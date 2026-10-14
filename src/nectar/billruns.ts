// Flows 9 and 10: a bill run drafts one invoice per subscription period that
// started in the chosen month and has ended, compares each with the previous
// period (and with the previous biller's invoice when one was moved in), and
// lists exceptions. A person approves exact drafts; finalising numbers and
// issues only approved invoices whose recorded inputs still match.
import type { Bindings } from '../auth.server'
import { actorLabel, requireCapability, requireMember, type Actor } from './actor'
import { requireBusiness, taxReady, type Business } from './business'
import { all, commit, guard, insist, newId, now, one, parseJson, stmt, type Row } from './core'
import { addDays, isMonth, periodStartingIn, requireDate, today } from './dates'
import { rated } from './inputs'
import { RATING_VERSION, type Exception, type Rating } from './rating'
import type { Input } from './input'

const BLOCKING = new Set(['tax_undeclared', 'negative_total'])

interface Draft { sub: Row; period: { start: string; end: string }; rating: Rating; fingerprint: string; input: unknown; comparison: Row; exceptions: Exception[] }

async function incumbentComparison(env: Bindings, sub: Row, period: { start: string }, rating: Rating) {
  if (!sub.provider_ref) return null
  const invoices = await all(env, 'SELECT * FROM nc_incumbent_invoices WHERE subscription_id = ?', sub.id)
  const lines = invoices.flatMap(invoice => parseJson<Row[]>(invoice.lines_json, []).map((line): Row => ({ ...line, invoice: invoice.number || invoice.provider_ref })))
    .filter(line => line.period_start === period.start)
  if (!lines.length) return { found: false }
  const refs = new Map((await all(env, 'SELECT id, provider_ref FROM nc_prices WHERE provider_ref IS NOT NULL')).map(row => [row.id, row.provider_ref]))
  const ours = new Map<string, number>(), theirs = new Map<string, number>()
  for (const line of rating.lines) {
    const key = line.priceId ? refs.get(line.priceId) ?? line.priceId : line.kind
    ours.set(key, (ours.get(key) ?? 0) + line.amountCents)
  }
  for (const line of lines) theirs.set(line.price_ref ?? line.kind ?? 'other', (theirs.get(line.price_ref ?? line.kind ?? 'other') ?? 0) + line.amount_cents)
  const keys = [...new Set([...ours.keys(), ...theirs.keys()])].sort()
  const rows = keys.map(key => ({ price: key, nectarCents: ours.get(key) ?? 0, incumbentCents: theirs.get(key) ?? 0 })).filter(row => row.nectarCents !== 0 || row.incumbentCents !== 0)
  const incumbentTotal = lines.reduce((sum, line) => sum + line.amount_cents, 0)
  return { found: true, invoices: [...new Set(lines.map(line => line.invoice))], rows, incumbentSubtotalCents: incumbentTotal, nectarSubtotalCents: rating.subtotalCents, reconciled: rows.every(row => row.nectarCents === row.incumbentCents) }
}

async function draftFor(env: Bindings, business: Business, sub: Row, period: { start: string; end: string }): Promise<Draft> {
  const { rating, fingerprint, input } = await rated(env, business, sub.id, period)
  const exceptions = [...rating.exceptions]
  const previous = await one(env, "SELECT number, period_start, total_cents, subtotal_cents FROM nc_invoices WHERE subscription_id = ? AND status = 'issued' AND period_start < ? ORDER BY period_start DESC LIMIT 1", sub.id, period.start)
  const incumbent = await incumbentComparison(env, sub, period, rating)
  const metered = rating.lines.some(line => line.kind === 'usage' || line.kind === 'trial_usage')
  const hasMeteredItem = Object.values((input as any).prices as Record<string, Row>).some(price => price.kind === 'unit') && (input as any).items.some((item: Row) => (input as any).prices[item.priceId]?.kind === 'unit' && item.from < period.end && (item.to ?? '9999') > period.start)
  if (hasMeteredItem && !metered) exceptions.push({ code: 'missing_usage', message: 'This subscription has a metered price but no usage was recorded for the period. Check the usage feed before approving.' })
  if (!sub.billing_email) exceptions.push({ code: 'no_billing_email', message: 'The customer has no billing email.' })
  if (previous && previous.subtotal_cents > 0 && Math.abs(rating.subtotalCents - previous.subtotal_cents) * 4 > previous.subtotal_cents) exceptions.push({ code: 'large_change', message: `The subtotal changed by more than a quarter from invoice ${previous.number}.` })
  if (incumbent?.found && !incumbent.reconciled) exceptions.push({ code: 'incumbent_mismatch', message: 'Nectar does not agree with the previous biller for this period; reconcile each price before cutover.' })
  const comparison = { previous: previous ? { number: previous.number, periodStart: previous.period_start, subtotalCents: previous.subtotal_cents, totalCents: previous.total_cents, deltaCents: rating.subtotalCents - previous.subtotal_cents } : null, incumbent }
  return { sub, period, rating, fingerprint, input, comparison, exceptions }
}

/** Prepares (or prepares again) the draft run for a month. Earlier drafts for that month are discarded, never edited. */
export async function prepareRun(env: Bindings, actor: Actor, input: Input) {
  requireCapability(actor, 'records')
  const business = await requireBusiness(env)
  const month = input.text('period', { max: 7 })
  insist(isMonth(month), 'invalid_period')
  const day = today(business.timezone)
  const subs = await all(env, 'SELECT s.*, c.name AS customer_name, c.billing_email FROM nc_subscriptions s JOIN nc_customers c ON c.id = s.customer_id ORDER BY c.name, s.created_at')
  const drafts: Draft[] = [], skipped: Row[] = [], open: Row[] = []
  for (const sub of subs) {
    const period = periodStartingIn(sub.anchor_day, month)
    if (sub.start_date >= period.end || (sub.end_date && sub.end_date <= period.start)) continue
    if (sub.cutover_start && period.end <= sub.cutover_start) { skipped.push({ subscription: sub.id, customer: sub.customer_name, reason: `billed by the previous biller before cutover on ${sub.cutover_start}` }); continue }
    if (await one(env, "SELECT 1 FROM nc_invoices WHERE subscription_id = ? AND period_start = ? AND status = 'issued'", sub.id, period.start)) { skipped.push({ subscription: sub.id, customer: sub.customer_name, reason: 'already invoiced' }); continue }
    if (period.end > day) { open.push({ subscription: sub.id, customer: sub.customer_name, periodEnd: period.end }); continue }
    drafts.push(await draftFor(env, business, sub, period))
  }
  const previousRun = await one(env, "SELECT id, period, summary_json FROM nc_bill_runs WHERE status = 'finalised' AND period < ? ORDER BY period DESC, finalised_at DESC LIMIT 1", month)
  const totals = drafts.reduce((sum, draft) => ({ subtotal: sum.subtotal + draft.rating.subtotalCents, tax: sum.tax + draft.rating.taxCents, total: sum.total + draft.rating.totalCents }), { subtotal: 0, tax: 0, total: 0 })
  const exceptionCounts: Record<string, number> = {}
  for (const draft of drafts) for (const exception of draft.exceptions) exceptionCounts[exception.code] = (exceptionCounts[exception.code] ?? 0) + 1
  const summary = {
    invoices: drafts.filter(d => d.sub.billing_mode === 'live').length, shadow: drafts.filter(d => d.sub.billing_mode === 'shadow').length, totals, exceptions: exceptionCounts, skipped, open,
    previous: previousRun ? { run: previousRun.id, period: previousRun.period, totals: parseJson<Row>(previousRun.summary_json, {}).totals ?? null } : null,
  }
  const runId = newId(), at = now(), statements: D1PreparedStatement[] = []
  const prior = await one(env, "SELECT id FROM nc_bill_runs WHERE period = ? AND status = 'draft'", month)
  // A replaced draft keeps any invoice it already issued: it closes as finalised, otherwise it is discarded.
  if (prior) statements.push(
    stmt(env, "UPDATE nc_invoices SET status = 'discarded' WHERE bill_run_id = ? AND status IN ('draft', 'shadow', 'approved')", prior.id),
    stmt(env, "UPDATE nc_bill_runs SET status = CASE WHEN EXISTS(SELECT 1 FROM nc_invoices WHERE bill_run_id = ?1 AND status = 'issued') THEN 'finalised' ELSE 'discarded' END WHERE id = ?1 AND status = 'draft'", prior.id))
  statements.push(stmt(env, "INSERT INTO nc_bill_runs (id, period, cutoff_at, calc_version, status, summary_json, created_by, created_at) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)", runId, month, at, RATING_VERSION, JSON.stringify(summary), actorLabel(actor), at))
  for (const draft of drafts) {
    const invoiceId = newId()
    statements.push(stmt(env, `INSERT INTO nc_invoices (id, bill_run_id, customer_id, subscription_id, period_start, period_end, status, subtotal_cents, tax_cents, total_cents, calc_version, source_fingerprint, calculation_json, comparison_json, exceptions_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, invoiceId, runId, draft.sub.customer_id, draft.sub.id, draft.period.start, draft.period.end, draft.sub.billing_mode === 'shadow' ? 'shadow' : 'draft',
      draft.rating.subtotalCents, draft.rating.taxCents, draft.rating.totalCents, RATING_VERSION, draft.fingerprint,
      JSON.stringify({ version: RATING_VERSION, fingerprint: draft.fingerprint, tax: draft.rating.tax, consumedEvents: draft.rating.consumedEvents, inputs: draft.input }), JSON.stringify(draft.comparison), JSON.stringify(draft.exceptions), at))
    draft.rating.lines.forEach((line, index) => statements.push(stmt(env, `INSERT INTO nc_invoice_lines (id, invoice_id, seq, kind, description, quantity, unit_amount, amount_cents, taxable, price_id, meter_id, period_start, period_end, evidence_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, newId(), invoiceId, index + 1, line.kind, line.description, line.quantity, line.unitAmount, line.amountCents, line.taxable ? 1 : 0, line.priceId, line.meterId, line.periodStart, line.periodEnd, JSON.stringify(line.evidence))))
  }
  await commit(env, statements, { actor: actorLabel(actor), action: 'billrun.prepare', subject: runId, detail: { period: month, invoices: drafts.length, totals, replaced: prior?.id ?? null } })
  return { id: runId, period: month, summary }
}

export async function runs(env: Bindings, actor: Actor) {
  requireCapability(actor, 'read')
  return (await all(env, "SELECT id, period, status, summary_json, created_by, created_at, finalised_at FROM nc_bill_runs WHERE status <> 'discarded' ORDER BY period DESC, created_at DESC LIMIT 60"))
    .map(row => ({ ...row, summary: parseJson(row.summary_json, {}), summary_json: undefined }))
}

export async function runDetail(env: Bindings, actor: Actor, id: string): Promise<Row> {
  requireCapability(actor, 'read')
  const run = await one(env, 'SELECT * FROM nc_bill_runs WHERE id = ?', id)
  insist(run, 'bill_run_not_found', 404)
  const invoices = await all(env, 'SELECT i.id, i.status, i.number, i.period_start, i.period_end, i.subtotal_cents, i.tax_cents, i.total_cents, i.exceptions_json, i.comparison_json, i.approved_by, c.name AS customer_name, c.id AS customer_id, c.external_id, s.billing_mode FROM nc_invoices i JOIN nc_customers c ON c.id = i.customer_id JOIN nc_subscriptions s ON s.id = i.subscription_id WHERE i.bill_run_id = ? ORDER BY c.name', id)
  return { ...run, summary: parseJson(run.summary_json, {}), summary_json: undefined, invoices: invoices.map(row => ({ ...row, exceptions: parseJson(row.exceptions_json, []), comparison: parseJson(row.comparison_json, {}), exceptions_json: undefined, comparison_json: undefined })) }
}

export async function invoiceDetail(env: Bindings, actor: Actor, id: string): Promise<Row> {
  requireCapability(actor, 'read')
  const invoice = await one(env, 'SELECT i.*, c.name AS customer_name, c.external_id, c.billing_email, c.address AS customer_address, s.billing_mode FROM nc_invoices i JOIN nc_customers c ON c.id = i.customer_id JOIN nc_subscriptions s ON s.id = i.subscription_id WHERE i.id = ?', id)
  insist(invoice, 'invoice_not_found', 404)
  const lines = await all(env, 'SELECT * FROM nc_invoice_lines WHERE invoice_id = ? ORDER BY seq', id)
  const credits = await all(env, 'SELECT * FROM nc_credit_notes WHERE invoice_id = ? ORDER BY issued_at', id)
  const allocations = await all(env, 'SELECT a.*, p.reference, p.received_on, p.method FROM nc_allocations a JOIN nc_payments p ON p.id = a.payment_id WHERE a.invoice_id = ? ORDER BY a.allocated_at', id)
  const credited = credits.reduce((sum, row) => sum + row.amount_cents, 0), paid = allocations.reduce((sum, row) => sum + row.amount_cents, 0)
  return {
    ...invoice, calculation: parseJson(invoice.calculation_json, {}), comparison: parseJson(invoice.comparison_json, {}), exceptions: parseJson(invoice.exceptions_json, []),
    calculation_json: undefined, comparison_json: undefined, exceptions_json: undefined,
    lines: lines.map(line => ({ ...line, evidence: parseJson(line.evidence_json, {}), evidence_json: undefined })),
    credits, allocations, creditedCents: credited, paidCents: paid, balanceCents: invoice.status === 'issued' ? invoice.total_cents - credited - paid : null,
  }
}

async function currentFingerprint(env: Bindings, business: Business, invoice: Row) {
  return (await rated(env, business, invoice.subscription_id, { start: invoice.period_start, end: invoice.period_end })).fingerprint
}

async function approveOne(env: Bindings, actor: Actor, business: Business, invoice: Row, acknowledged: boolean) {
  insist(invoice.status === 'draft', invoice.status === 'shadow' ? 'shadow_invoice' : 'not_a_draft', 409)
  const exceptions = parseJson<Exception[]>(invoice.exceptions_json, [])
  insist(!exceptions.some(e => BLOCKING.has(e.code)), 'blocking_exception', 409, exceptions.filter(e => BLOCKING.has(e.code)))
  insist(!exceptions.length || acknowledged, 'exceptions_not_acknowledged', 409, exceptions)
  insist(await currentFingerprint(env, business, invoice) === invoice.source_fingerprint, 'source_changed', 409)
  return [
    guard(env, 'stale', "EXISTS(SELECT 1 FROM nc_invoices WHERE id = ? AND status = 'draft' AND source_fingerprint = ?)", invoice.id, invoice.source_fingerprint),
    stmt(env, "UPDATE nc_invoices SET status = 'approved', approved_fingerprint = source_fingerprint, approved_by = ?, approved_at = ? WHERE id = ?", actorLabel(actor), now(), invoice.id),
  ]
}

/** Approves one draft invoice, or every clean draft in a run, against the exact inputs shown. */
export async function approve(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'approve')
  const business = await requireBusiness(env)
  const acknowledged = input.flag('acknowledge')
  if (input.has('invoice')) {
    const invoice = await one(env, 'SELECT * FROM nc_invoices WHERE id = ?', input.text('invoice', { max: 100 }))
    insist(invoice, 'invoice_not_found', 404)
    await commit(env, await approveOne(env, actor, business, invoice, acknowledged), { actor: actorLabel(actor), action: 'invoice.approve', subject: invoice.id, detail: { fingerprint: invoice.source_fingerprint, acknowledged: parseJson<Exception[]>(invoice.exceptions_json, []).map(e => e.code) } })
    return { id: invoice.id, status: 'approved' }
  }
  const run = await one(env, "SELECT * FROM nc_bill_runs WHERE id = ? AND status = 'draft'", input.text('run', { max: 100 }))
  insist(run, 'bill_run_not_found', 404)
  const drafts = await all(env, "SELECT * FROM nc_invoices WHERE bill_run_id = ? AND status = 'draft'", run.id)
  const clean = drafts.filter(invoice => !parseJson<Exception[]>(invoice.exceptions_json, []).length || acknowledged)
    .filter(invoice => !parseJson<Exception[]>(invoice.exceptions_json, []).some(e => BLOCKING.has(e.code)))
  insist(clean.length, 'nothing_to_approve', 409)
  const statements = (await Promise.all(clean.map(invoice => approveOne(env, actor, business, invoice, acknowledged)))).flat()
  await commit(env, statements, clean.map(invoice => ({ actor: actorLabel(actor), action: 'invoice.approve', subject: invoice.id, detail: { run: run.id, fingerprint: invoice.source_fingerprint, acknowledged: parseJson<Exception[]>(invoice.exceptions_json, []).map(e => e.code) } })))
  return { id: run.id, approved: clean.length, remaining: drafts.length - clean.length }
}

/** Numbers and issues approved invoices. Each issue is atomic: number, usage consumption and status together. */
export async function finalise(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'approve')
  let business = await requireBusiness(env)
  insist(taxReady(business), 'tax_not_reviewed', 409)
  const runId = input.has('run') ? input.text('run', { max: 100 }) : null
  const targets = runId
    ? await all(env, "SELECT * FROM nc_invoices WHERE bill_run_id = ? AND status = 'approved' ORDER BY customer_id, period_start", runId)
    : await all(env, "SELECT * FROM nc_invoices WHERE id = ? AND status = 'approved'", input.text('invoice', { max: 100 }))
  insist(targets.length, 'nothing_approved', 409)
  // The invoice date defaults to today; it may be any day from the end of the billed period up to today.
  const day = today(business.timezone)
  const issueDate = input.has('issue_date') ? requireDate(input.text('issue_date', { max: 10 }), 'issue_date') : day
  insist(issueDate <= day && targets.every(invoice => issueDate >= invoice.period_end), 'invalid_issue_date')
  const issued: string[] = [], refused: Row[] = []
  for (const invoice of targets) {
    if (await currentFingerprint(env, business, invoice) !== invoice.approved_fingerprint) { refused.push({ invoice: invoice.id, reason: 'source_changed' }); continue }
    const calculation = parseJson<Row>(invoice.calculation_json, {})
    const consumed: string[] = calculation.consumedEvents ?? []
    const sequence = business.next_invoice_number
    const number = `${business.invoice_prefix}-${String(sequence).padStart(6, '0')}`
    const due = addDays(issueDate, business.payment_terms_days)
    await commit(env, [
      guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_business WHERE singleton = 1 AND next_invoice_number = ?)', sequence),
      guard(env, 'stale', "EXISTS(SELECT 1 FROM nc_invoices WHERE id = ? AND status = 'approved' AND approved_fingerprint = ?)", invoice.id, invoice.approved_fingerprint),
      ...(consumed.length ? [guard(env, 'already_billed', `NOT EXISTS(SELECT 1 FROM nc_usage_events WHERE event_id IN (${consumed.map(() => '?').join(',')}) AND (invoice_id IS NOT NULL OR status <> 'active'))`, ...consumed)] : []),
      stmt(env, 'UPDATE nc_business SET next_invoice_number = next_invoice_number + 1 WHERE singleton = 1'),
      ...chunk(consumed, 90).map(ids => stmt(env, `UPDATE nc_usage_events SET invoice_id = ? WHERE event_id IN (${ids.map(() => '?').join(',')})`, invoice.id, ...ids)),
      stmt(env, "UPDATE nc_invoices SET status = 'issued', number = ?, issue_date = ?, due_date = ?, issued_by = ?, issued_at = ? WHERE id = ?", number, issueDate, due, actorLabel(actor), now(), invoice.id),
    ], { actor: actorLabel(actor), action: 'invoice.issue', subject: invoice.id, detail: { number, total: invoice.total_cents, fingerprint: invoice.approved_fingerprint, events: consumed.length } })
    issued.push(number)
    business = await requireBusiness(env)
  }
  // A run whose every live draft is issued is finalised.
  for (const run of new Set(targets.map(invoice => invoice.bill_run_id as string)))
    if (issued.length && !await one(env, "SELECT 1 FROM nc_invoices WHERE bill_run_id = ? AND status IN ('draft', 'approved')", run))
      await commit(env, [stmt(env, "UPDATE nc_bill_runs SET status = 'finalised', finalised_by = ?, finalised_at = ? WHERE id = ? AND status = 'draft'", actorLabel(actor), now(), run)], { actor: actorLabel(actor), action: 'billrun.finalise', subject: run, detail: { issued } })
  insist(issued.length, 'source_changed', 409, refused)
  return { issued, refused }
}

const chunk = <T>(list: T[], size: number) => Array.from({ length: Math.ceil(list.length / size) }, (_, index) => list.slice(index * size, index * size + size))

