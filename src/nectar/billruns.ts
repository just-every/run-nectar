import { currencyRecord } from './currency-rates'
import { planChangeInvoiceFingerprint } from './plan-changes'
import { consolidationCalculation,hierarchyPreIssue,hierarchyIssueStatements } from './hierarchies'
import { writeOffsFor } from './write-offs'
import { issueApplicationStatements } from './balance'
import { sharedCreditNotes } from './shared-credit-custody'
import { prepaidIssueStatements } from './prepaid-issue'
import { prepaidPurchaseCalculation, prepaidPurchaseIssueStatements } from './prepaid-purchase'
import { billingWindowsForMonth,currentBillingWindow } from './billing-plan'
import { billingComponentClaimStatements } from './billing-components'
import type { BillingWindow } from './billing-calendar'
import { invoiceContent } from './invoice-content'
import { canonical } from './core'
import { carriedUsageCredits, usageCreditAllocations } from './usage-correction-records'
import { fingerprint as correctionFingerprint } from './core'
import { invoiceNumberAllocation } from './invoice-numbering'
import { revenueIssueStatements } from './revenue-records'
import { clockInstant } from './clock'
import { cancellationApproval } from './lifecycle-approval'
import { metadataFor,withMetadata } from './metadata'
import { alertStatements } from './notifications'
import { deliverAlerts } from './notification-mail'
// Flows 9 and 10: a bill run drafts one invoice per subscription period that
// started in the chosen month and has ended, compares each with the previous
// period (and with the previous biller's invoice when one was moved in), and
// lists exceptions. A person approves exact drafts; finalising numbers and
// issues only approved invoices whose recorded inputs still match.
import type { Bindings } from '../auth.server'
import { canRead, requireRead, actorLabel, requireCapability, requireMember, type Actor } from './actor'
import { requireBusiness, taxReady, type Business } from './business'
import { all, commit, fingerprint as hashInputs, guard, insist, newId, now, one, parseJson, stmt, type Row } from './core'
import { addDays, isMonth, periodStartingIn, requireDate, today, zonedStart } from './dates'
import { rated } from './inputs'
import { manualCalculation } from './manual-invoices'
import { creditPolicy, creditRequests } from './credit-policy'
import { reconciliationFor } from './reconciliation'
import { RATING_VERSION, type Exception, type Rating } from './rating'
import { Input } from './input'

const BLOCKING = new Set(['historical_usage_correction','usage_correction_pending','po_required','tax_undeclared', 'exemption_certificate', 'negative_total', 'usage_reconciliation','commitment_prior_periods','metric_late_correction','metric_duplicate_selection','metric_negative_quantity'])

interface Draft { sub: Row; period: { start: string; end: string }; rating: Rating; fingerprint: string; input: { version: string;currency?:string }; comparison: Row; exceptions: Exception[] }

async function incumbentComparison(env: Bindings, sub: Row, period: { start: string }, rating: Rating) {
  if (!sub.provider_ref) return null
  const invoices = await all(env, "SELECT * FROM nc_incumbent_invoices WHERE document_kind='invoice' AND subscription_id = ?", sub.id)
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

async function reconciledRating(env: Bindings, business: Business, subscription: string, period: { start: string; end: string },window?:BillingWindow) {
  const result = await rated(env, business, subscription, period,undefined,window)
  const selectedMeters = window ? new Set(result.input.items.filter(item => window.components.some(component => component.itemId === item.id)).flatMap(item => { const price=result.input.prices[item.priceId]; return price.kind==='unit' ? [price.metric?.sourceId ?? price.meterId!] : [] })) : undefined
  const reconciliation = selectedMeters?.size===0 ? [] : await reconciliationFor(env, subscription, period, business.timezone, result.input.events, selectedMeters)
  if (!reconciliation.length) return result
  const input = { ...result.input, reconciliation }
  const exceptions = reconciliation.filter(row => row.mismatch && !row.acknowledged).map(row => ({
    code: 'usage_reconciliation', message: `${row.day} · ${row.meter}: source expects ${row.expectedCount} events / ${row.expectedQuantity}; ingested ${row.actualCount} / ${row.actualQuantity} (difference ${row.countDifference} events / ${row.quantityDifference}). Resolve or acknowledge before issue.`, detail: row,
  }))
  return { input, rating: { ...result.rating, exceptions: [...result.rating.exceptions, ...exceptions] }, fingerprint: await hashInputs(input) }
}

export async function draftFor(env: Bindings, business: Business, sub: Row, period: { start: string; end: string },window?:BillingWindow): Promise<Draft> {
  const { rating, fingerprint, input } = await reconciledRating(env, business, sub.id, period,window)
  const exceptions = [...rating.exceptions]
  const previous = await one(env, "SELECT number, period_start, total_cents, subtotal_cents FROM nc_invoices WHERE subscription_id = ? AND status = 'issued' AND period_start < ? ORDER BY period_start DESC LIMIT 1", sub.id, period.start)
  const incumbent = await incumbentComparison(env, sub, period, rating)
  const metered = rating.lines.some(line => line.kind === 'usage' || line.kind === 'overage' || line.kind === 'metric_usage' || line.kind === 'trial_usage' || line.kind === 'paused_usage')
  const hasMeteredItem = Object.values((input as any).prices as Record<string, Row>).some(price => price.kind === 'unit') && (input as any).items.some((item: Row) => (input as any).prices[item.priceId]?.kind === 'unit' && (!window || window.components.some(component=>component.itemId===item.id)) && item.from < period.end && (item.to ?? '9999') > period.start)
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
  const day = today(business.timezone,clockInstant(env))
  const subs = await all(env, 'SELECT s.*, c.name AS customer_name, c.billing_email FROM nc_subscriptions s JOIN nc_customers c ON c.id = s.customer_id WHERE c.erased_at IS NULL ORDER BY c.name, s.created_at')
  const drafts: Draft[] = [], skipped: Row[] = [], open: Row[] = []
  for (const sub of subs) {
    const windows=await billingWindowsForMonth(env,sub,month)
    if(windows) {
      for(const window of windows) {
        if(window.dueDate>day){open.push({subscription:sub.id,customer:sub.customer_name,periodEnd:window.period.end,dueDate:window.dueDate});continue}
        drafts.push(await draftFor(env,business,sub,window.period,window))
      }
      if(!windows.length)skipped.push({subscription:sub.id,customer:sub.customer_name,reason:'No unbilled component is due in this month'})
      continue
    }
    const period = periodStartingIn(sub.anchor_day, month)
    if(await one(env,'SELECT 1 FROM nc_hierarchy_consumed WHERE subscription_id=? AND period_start=?',sub.id,period.start)){skipped.push({subscription:sub.id,customer:sub.customer_name,reason:'already consolidated'});continue}
    if (sub.start_date >= period.end || (sub.end_date && sub.end_date <= period.start)) continue
    if (sub.cutover_start && period.end <= sub.cutover_start) { skipped.push({ subscription: sub.id, customer: sub.customer_name, reason: `billed by the previous biller before cutover on ${sub.cutover_start}` }); continue }
    if (await one(env, "SELECT 1 FROM nc_invoices WHERE subscription_id = ? AND invoice_kind = 'recurring' AND period_start = ? AND status = 'issued'", sub.id, period.start)) { skipped.push({ subscription: sub.id, customer: sub.customer_name, reason: 'already invoiced' }); continue }
    if (period.end > day) { open.push({ subscription: sub.id, customer: sub.customer_name, periodEnd: period.end }); continue }
    drafts.push(await draftFor(env, business, sub, period))
  }
  const previousRun = await one(env, "SELECT id, period, summary_json FROM nc_bill_runs WHERE status = 'finalised' AND kind = 'recurring' AND period < ? ORDER BY period DESC, finalised_at DESC LIMIT 1", month)
  const totals = drafts.reduce((sum, draft) => ({ subtotal: sum.subtotal + draft.rating.subtotalCents, tax: sum.tax + draft.rating.taxCents, total: sum.total + draft.rating.totalCents }), { subtotal: 0, tax: 0, total: 0 })
  const exceptionCounts: Record<string, number> = {}
  for (const draft of drafts) for (const exception of draft.exceptions) exceptionCounts[exception.code] = (exceptionCounts[exception.code] ?? 0) + 1
  const totalsByCurrency:Record<string,{subtotal:number;tax:number;total:number}>={}
  for(const draft of drafts.filter(d=>d.sub.billing_mode==='live')){const currency=draft.input.currency??'USD',t=totalsByCurrency[currency]??{subtotal:0,tax:0,total:0};t.subtotal+=draft.rating.subtotalCents;t.tax+=draft.rating.taxCents;t.total+=draft.rating.totalCents;totalsByCurrency[currency]=t}
  const currencies=Object.keys(totalsByCurrency),runCurrency=currencies.length>1?'mixed':currencies[0]??'USD'
  const summary = {
    ...(runCurrency==='USD'?{}:{currency:runCurrency,totalsByCurrency}),
    invoices: drafts.filter(d => d.sub.billing_mode === 'live').length, shadow: drafts.filter(d => d.sub.billing_mode === 'shadow').length, totals:runCurrency==='mixed'?null:totals, exceptions: exceptionCounts, skipped, open,
    previous: previousRun ? { run: previousRun.id, period: previousRun.period, ...(parseJson<Row>(previousRun.summary_json, {}).currency?{currency:parseJson<Row>(previousRun.summary_json, {}).currency}:{}), totals: parseJson<Row>(previousRun.summary_json, {}).totals ?? null } : null,
  }
  const runVersion = drafts.find(draft => draft.input.version !== RATING_VERSION)?.input.version ?? RATING_VERSION
  const runId = newId(), at = now(), statements: D1PreparedStatement[] = []
  const prior = await one(env, "SELECT id FROM nc_bill_runs WHERE period = ? AND kind = 'recurring' AND status = 'draft'", month)
  // A replaced draft keeps any invoice it already issued: it closes as finalised, otherwise it is discarded.
  if (prior) statements.push(
    stmt(env, "UPDATE nc_invoices SET status = 'discarded' WHERE bill_run_id = ? AND status IN ('draft', 'shadow', 'approved')", prior.id),
    stmt(env, "UPDATE nc_bill_runs SET status = CASE WHEN EXISTS(SELECT 1 FROM nc_invoices WHERE bill_run_id = ?1 AND status = 'issued') THEN 'finalised' ELSE 'discarded' END WHERE id = ?1 AND status = 'draft'", prior.id))
  statements.push(stmt(env, "INSERT INTO nc_bill_runs (id, period, cutoff_at, calc_version, status, summary_json, created_by, created_at) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)", runId, month, at, runVersion, JSON.stringify(summary), actorLabel(actor), at))
  for (const draft of drafts) {
    const invoiceId = newId()
    statements.push(stmt(env, `INSERT INTO nc_invoices (id, bill_run_id, customer_id, subscription_id, period_start, period_end, status, subtotal_cents, tax_cents, total_cents, calc_version, source_fingerprint, calculation_json, comparison_json, exceptions_json, created_at,billing_key,currency)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,?,?)`, invoiceId, runId, draft.sub.customer_id, draft.sub.id, draft.period.start, draft.period.end, draft.sub.billing_mode === 'shadow' ? 'shadow' : 'draft',
      draft.rating.subtotalCents, draft.rating.taxCents, draft.rating.totalCents, draft.input.version, draft.fingerprint,
      JSON.stringify({ version: draft.input.version, fingerprint: draft.fingerprint, tax: draft.rating.tax, consumedEvents: draft.rating.consumedEvents, inputs: draft.input }), JSON.stringify(draft.comparison), JSON.stringify(draft.exceptions), at,(draft.input as any).billing?.key??'legacy-monthly-arrears',draft.input.currency??'USD'))
    draft.rating.lines.forEach((line, index) => statements.push(stmt(env, `INSERT INTO nc_invoice_lines (id, invoice_id, seq, kind, description, quantity, unit_amount, amount_cents, taxable, price_id, meter_id, period_start, period_end, evidence_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, newId(), invoiceId, index + 1, line.kind, line.description, line.quantity, line.unitAmount, line.amountCents, line.taxable ? 1 : 0, line.priceId, line.meterId, line.periodStart, line.periodEnd, JSON.stringify(line.evidence))))
  }
  const notify = Object.keys(exceptionCounts).length > 0
  if (notify) statements.push(...await alertStatements(env,'billrun_exceptions',runId,`/app/billing/${runId}`))
  await commit(env, statements, { actor: actorLabel(actor), action: 'billrun.prepare', subject: runId, detail: { period: month, invoices: drafts.length, totals, replaced: prior?.id ?? null } })
  if (notify) await deliverAlerts(env,'billrun_exceptions',runId,actorLabel(actor))
  return { id: runId, period: month, summary }
}

export async function runs(env: Bindings, actor: Actor) {
  requireCapability(actor, 'read')
  return (await all(env, "SELECT id, period, kind, status, summary_json, created_by, created_at, finalised_at FROM nc_bill_runs WHERE status <> 'discarded' ORDER BY period DESC, created_at DESC LIMIT 60"))
    .map(row => ({ ...row, summary: parseJson(row.summary_json, {}), summary_json: undefined }))
}

export async function runDetail(env: Bindings, actor: Actor, id: string): Promise<Row> {
  requireCapability(actor, 'read')
  const run = await one(env, 'SELECT * FROM nc_bill_runs WHERE id = ?', id)
  insist(run, 'bill_run_not_found', 404)
  const invoices = await all(env, `SELECT i.id, i.subscription_id, i.status, i.number, i.currency, i.period_start, i.period_end, i.subtotal_cents, i.tax_cents, i.total_cents, i.exceptions_json, i.comparison_json, i.approved_by, c.name AS customer_name, c.id AS customer_id, c.external_id, COALESCE(s.billing_mode,'live') AS billing_mode, i.invoice_kind FROM nc_invoices i JOIN nc_customers c ON c.id = i.customer_id LEFT JOIN nc_subscriptions s ON s.id = i.subscription_id WHERE i.bill_run_id = ? ORDER BY c.name`, id)
  return { ...run, summary: parseJson(run.summary_json, {}), summary_json: undefined, invoices: invoices.map(row => ({ ...row, exceptions: parseJson(row.exceptions_json, []), comparison: parseJson(row.comparison_json, {}), exceptions_json: undefined, comparison_json: undefined })) }
}

export async function invoiceDetail(env: Bindings, actor: Actor, id: string): Promise<Row> {
  requireRead(actor, 'invoices')
  return await invoiceRecord(env, actor, id)
}

/** An invoice's full record. Callers authorize first: the invoice door, or a
 * report figure drilling to its source invoice (GOV-001 report readers). */
export async function invoiceRecord(env: Bindings, actor: Actor, id: string): Promise<Row> {
  const invoice = await one(env, `SELECT i.*, c.name AS customer_name, c.external_id, c.billing_email, c.address AS customer_address, COALESCE(s.billing_mode,'live') AS billing_mode, i.invoice_kind FROM nc_invoices i JOIN nc_customers c ON c.id = i.customer_id LEFT JOIN nc_subscriptions s ON s.id = i.subscription_id WHERE i.id = ?`, id)
  insist(invoice, 'invoice_not_found', 404)
  const lines = await all(env, 'SELECT * FROM nc_invoice_lines WHERE invoice_id = ? ORDER BY seq', id)
  const credits = await sharedCreditNotes(env,'n.invoice_id=?',id)
  const allocations = await all(env, 'SELECT a.*, p.reference, p.received_on, p.method FROM nc_allocations a JOIN nc_payments p ON p.id = a.payment_id WHERE a.invoice_id = ? ORDER BY a.allocated_at', id)
  const carriedApplications=await all(env,'SELECT a.*,n.number,n.correction_id FROM nc_usage_credit_applications a JOIN nc_credit_notes n ON n.id=a.credit_id WHERE a.invoice_id=? ORDER BY a.applied_at,a.id',id)
  const writeOffs = invoice.status === 'issued' ? await writeOffsFor(env, id) : [], writtenOff = writeOffs.reduce((sum, row) => sum + row.netCents, 0)
  const balanceApplications = await all(env, "SELECT * FROM nc_balance_entries WHERE kind='application' AND grant_id IS NOT NULL AND invoice_id=? ORDER BY created_at,id", id)
  const credited = credits.reduce((sum, row) => sum + (row.applied_cents??row.amount_cents), 0)+carriedApplications.reduce((n,r)=>n+r.amount_cents,0)+balanceApplications.reduce((n,r)=>n+r.amount_cents,0), paid = allocations.reduce((sum, row) => sum + row.amount_cents, 0)
  return {
    ...await currencyRecord(env,invoice,invoice.total_cents,invoice.issue_date??invoice.period_start),retainedFinancial:await one(env,"SELECT legal_name,document_date,retain_until,tax_json FROM nc_erasure_financial WHERE kind='invoice' AND record_id=?",id),...await metadataFor(env,'invoice',id), creditPolicy: await creditPolicy(env), creditRequests: canRead(actor, 'invoices') ? await creditRequests(env, actor, id) : [], calculation: parseJson(invoice.calculation_json, {}), comparison: parseJson(invoice.comparison_json, {}), exceptions: parseJson(invoice.exceptions_json, []),
    calculation_json: undefined, comparison_json: undefined, exceptions_json: undefined,
    lines: lines.map(line => ({ ...line, evidence: parseJson(line.evidence_json, {}), evidence_json: undefined })),
    voidedBy:credits.find(row=>row.void_replacement_id)??null, reissuedFrom:parseJson<Row>(invoice.calculation_json,{}).inputs?.reissue??null,
    carriedApplications, credits:await withMetadata(env,'credit-note',credits), allocations, balanceApplications, writeOffs, writtenOffCents: writtenOff, creditedCents: credited, paidCents: paid, balanceCents: invoice.status === 'issued' ? invoice.total_cents - credited - paid - writtenOff : null,
  }
}

export async function currentFingerprint(env: Bindings, business: Business, invoice: Row) {
  if (invoice.invoice_kind === 'manual') {
    const saved = parseJson<Row>(invoice.calculation_json, {}).inputs
    insist(saved && await one(env,'SELECT 1 FROM nc_customers WHERE id=? AND erased_at IS NULL',invoice.customer_id),'customer_erased',409)
    if(saved.reissue) {
      const source=await one(env,"SELECT 1 FROM nc_invoices i JOIN nc_credit_notes n ON n.invoice_id=i.id WHERE i.id=? AND i.status='issued' AND i.source_fingerprint=? AND n.id=? AND n.void_replacement_id=? AND n.amount_cents=i.total_cents",saved.reissue.invoice,saved.reissue.sourceFingerprint,saved.reissue.credit,invoice.id)
      insist(source,'source_changed',409)
      return correctionFingerprint({...saved,invoiceContent:await invoiceContent(env,business,invoice.customer_id)})
    }
    if(saved.planChange)return planChangeInvoiceFingerprint(env,invoice)
    if (saved.consolidation)return (await consolidationCalculation(env,saved.consolidation.parent,saved.consolidation.sections.map((s:Row)=>s.sourceInvoice))).fingerprint
    if (saved.prepaidPurchase) return (await prepaidPurchaseCalculation(env, business, invoice.customer_id, saved.prepaidPurchase.intent, saved.date)).fingerprint
    if(saved.usageCorrection){
      const approved=await one(env,"SELECT 1 FROM nc_usage_corrections WHERE id=? AND status='approved'",saved.usageCorrection)
      const staged=await all(env,'SELECT id,line_json,tax_cents FROM nc_usage_adjustments WHERE correction_id=? AND target_invoice_id=? ORDER BY id',saved.usageCorrection,invoice.id)
      insist(approved&&canonicalAdjustments(staged,saved.usageAdjustments),'correction_source_changed',409)
      const current={...saved,usageCredits:await carriedUsageCredits(env,invoice.customer_id),invoiceContent:await invoiceContent(env,business,invoice.customer_id)}
      return correctionFingerprint(current)
    }
    return (await manualCalculation(env, business, invoice.customer_id, saved.charges.map((c: Row) => c.id), saved.date)).fingerprint
  }
  return (await reconciledRating(env, business, invoice.subscription_id, { start: invoice.period_start, end: invoice.period_end },await currentBillingWindow(env,invoice))).fingerprint
}

async function approveOne(env: Bindings, actor: Actor, business: Business, invoice: Row, acknowledged: boolean, authority?: () => D1PreparedStatement) {
  const customer = await one(env, 'SELECT revision FROM nc_customers WHERE id=?', invoice.customer_id)
  await cancellationApproval(env,actor,invoice)
  insist(!await one(env,"SELECT 1 FROM nc_customer_hierarchies WHERE customer_id=? AND billing_mode='consolidated'",invoice.customer_id),'consolidation_required',409)
  insist(invoice.status === 'draft', invoice.status === 'shadow' ? 'shadow_invoice' : 'not_a_draft', 409)
  const exceptions = parseJson<Exception[]>(invoice.exceptions_json, [])
  insist(!exceptions.some(e => BLOCKING.has(e.code)), 'blocking_exception', 409, exceptions.filter(e => BLOCKING.has(e.code)))
  insist(!exceptions.length || acknowledged, 'exceptions_not_acknowledged', 409, exceptions)
  insist(await currentFingerprint(env, business, invoice) === invoice.source_fingerprint, 'source_changed', 409)
  return [
    ...(authority?[authority()]:[]),
    guard(env, 'source_changed', 'EXISTS(SELECT 1 FROM nc_business WHERE singleton=1 AND revision=?) AND EXISTS(SELECT 1 FROM nc_customers WHERE id=? AND revision=?)', business.revision, invoice.customer_id, customer?.revision ?? ''),
    guard(env, 'stale', "EXISTS(SELECT 1 FROM nc_invoices WHERE id = ? AND status = 'draft' AND source_fingerprint = ?)", invoice.id, invoice.source_fingerprint),
    stmt(env, "UPDATE nc_invoices SET status = 'approved', approved_fingerprint = source_fingerprint, approved_by = ?, approved_at = ? WHERE id = ?", actorLabel(actor), now(), invoice.id),
  ]
}

/** Approves one draft invoice, or every clean draft in a run, against the exact inputs shown. */
export async function approveWithAuthority(env: Bindings, actor: Actor, input: Input, authority?: () => D1PreparedStatement) {
  requireMember(actor, 'approve')
  const business = await requireBusiness(env)
  const acknowledged = input.flag('acknowledge')
  if (input.has('invoice')) {
    const invoice = await one(env, 'SELECT * FROM nc_invoices WHERE id = ?', input.text('invoice', { max: 100 }))
    insist(invoice, 'invoice_not_found', 404)
    await commit(env, await approveOne(env, actor, business, invoice, acknowledged, authority), { actor: actorLabel(actor), action: 'invoice.approve', subject: invoice.id, detail: { fingerprint: invoice.source_fingerprint, acknowledged: parseJson<Exception[]>(invoice.exceptions_json, []).map(e => e.code) } })
    return { id: invoice.id, status: 'approved' }
  }
  const run = await one(env, "SELECT * FROM nc_bill_runs WHERE id = ? AND status = 'draft'", input.text('run', { max: 100 }))
  insist(run, 'bill_run_not_found', 404)
  const drafts = await all(env, "SELECT * FROM nc_invoices WHERE bill_run_id = ? AND status = 'draft'", run.id)
  const clean = drafts.filter(invoice => !parseJson<Exception[]>(invoice.exceptions_json, []).length || acknowledged)
    .filter(invoice => !parseJson<Exception[]>(invoice.exceptions_json, []).some(e => BLOCKING.has(e.code)))
  insist(clean.length, 'nothing_to_approve', 409)
  const statements = (await Promise.all(clean.map(invoice => approveOne(env, actor, business, invoice, acknowledged, authority)))).flat()
  await commit(env, statements, clean.map(invoice => ({ actor: actorLabel(actor), action: 'invoice.approve', subject: invoice.id, detail: { run: run.id, fingerprint: invoice.source_fingerprint, acknowledged: parseJson<Exception[]>(invoice.exceptions_json, []).map(e => e.code) } })))
  return { id: run.id, approved: clean.length, remaining: drafts.length - clean.length }
}

/** Numbers and issues approved invoices. Each issue is atomic: number, usage consumption and status together. */
export async function finaliseWithAuthority(env: Bindings, actor: Actor, input: Input, authority?: () => D1PreparedStatement) {
  requireMember(actor, 'approve')
  return finaliseCore(env, actor, input, undefined, authority)
}

async function finaliseCore(env: Bindings, actor: Actor, input: Input, trialAuthorization?: Row, authority?: () => D1PreparedStatement) {
  let business = await requireBusiness(env)
  insist(taxReady(business), 'tax_not_reviewed', 409)
  const runId = input.has('run') ? input.text('run', { max: 100 }) : null
  const targets = runId
    ? await all(env, "SELECT * FROM nc_invoices WHERE bill_run_id = ? AND status = 'approved' ORDER BY customer_id, period_start", runId)
    : await all(env, "SELECT * FROM nc_invoices WHERE id = ? AND status = 'approved'", input.text('invoice', { max: 100 }))
  insist(targets.length, 'nothing_approved', 409)
  // The invoice date defaults to today; it may be any day from the end of the billed period up to today.
  const day = today(business.timezone,clockInstant(env))
  const issueDate = input.has('issue_date') ? requireDate(input.text('issue_date', { max: 10 }), 'issue_date') : day
  insist(issueDate <= day && targets.every(invoice => issueDate >= (invoice.invoice_kind === 'manual' ? invoice.period_start : parseJson<Row>(invoice.calculation_json,{}).inputs?.billing?.dueDate??invoice.period_end)), 'invalid_issue_date')
  const issued: string[] = [], refused: Row[] = []
  for (const invoice of targets) {
    const trial = trialAuthorization ? await import('./trial-collection-records') : null
    if (trial && trialAuthorization) {
      insist(trialAuthorization.status === 'active' && trialAuthorization.invoice_id === invoice.id, 'trial_collection_authority_changed', 409)
      const { q } = await trial.currentTrialCollection(env, trialAuthorization, true)
      insist(invoice.source_fingerprint === q.fingerprint && invoice.total_cents === q.amountCents && issueDate === q.chargeDate, 'trial_collection_terms_changed', 409)
    }
    const customer = await one(env, 'SELECT * FROM nc_customers WHERE id=?', invoice.customer_id)
    insist(customer, 'customer_not_found', 404)
    await cancellationApproval(env,actor,invoice)
    if (await currentFingerprint(env, business, invoice) !== invoice.approved_fingerprint) { refused.push({ invoice: invoice.id, reason: 'source_changed' }); continue }
    const calculation = parseJson<Row>(invoice.calculation_json, {})
    const allAdjustments:Row[]=calculation.inputs?.usageAdjustments??[]
    const planAdjustments=allAdjustments.filter(a=>a.source==='plan-change'),usageAdjustments=allAdjustments.filter(a=>a.source!=='plan-change')
    const carried=usageCreditAllocations(calculation.inputs?.usageCredits??[],invoice.total_cents)
    insist(carried.every(c=>c.issuedAt<zonedStart(addDays(issueDate,1),business.timezone)),'credit_after_invoice_date',409)
    const consumed: string[] = calculation.consumedEvents ?? []
    const charges: string[] = (calculation.inputs?.charges ?? []).map((c: Row) => c.id)
    const allocation = await invoiceNumberAllocation(env, business, customer)
    const { number } = allocation
    const content = calculation.inputs?.invoiceContent
    const approvedEntity = content?.billingEntity
    if ((approvedEntity?.id ?? null) !== allocation.entityId || approvedEntity && canonical(approvedEntity.route) !== canonical(parseJson(allocation.routeJson, {}))) {
      refused.push({ invoice: invoice.id, reason: 'source_changed' }); continue
    }
    insist(!content?.poRequired || content.poNumber, 'po_required', 409)
    const due = addDays(issueDate, content?.paymentTermsDays ?? business.payment_terms_days)
    await commit(env, [
      ...(authority?[authority()]:[]),
      ...(trial && trialAuthorization ? [trial.trialCollectionGuard(env, trialAuthorization)] : []),
      ...await hierarchyPreIssue(env,invoice),
      ...(approvedEntity ? [guard(env, 'source_changed', 'EXISTS(SELECT 1 FROM nc_billing_entities WHERE id=? AND revision=?)', approvedEntity.id, approvedEntity.revision)] : []),
      ...allocation.statements,
      guard(env, 'source_changed', 'EXISTS(SELECT 1 FROM nc_customers WHERE id=? AND revision=? AND invoice_settings_json=?)', invoice.customer_id, customer.revision, customer.invoice_settings_json),
      guard(env, 'stale', "EXISTS(SELECT 1 FROM nc_invoices WHERE id = ? AND status = 'approved' AND approved_fingerprint = ?)", invoice.id, invoice.approved_fingerprint),
      ...chunk(consumed, 90).map(ids => guard(env, 'already_billed', `NOT EXISTS(SELECT 1 FROM nc_usage_events WHERE event_id IN (${ids.map(() => '?').join(',')}) AND (invoice_id IS NOT NULL OR status <> 'active'))`, ...ids)),
      ...planAdjustments.map((a:Row)=>guard(env,'plan_change_already_billed','EXISTS(SELECT 1 FROM nc_plan_change_adjustments WHERE id=? AND invoice_id IS NULL)',a.id)),
      ...planAdjustments.map((a:Row)=>stmt(env,'UPDATE nc_plan_change_adjustments SET invoice_id=? WHERE id=? AND invoice_id IS NULL',invoice.id,a.id)),
      ...usageAdjustments.map((a:Row)=>guard(env,'correction_already_billed','EXISTS(SELECT 1 FROM nc_usage_adjustments WHERE id=? AND invoice_id IS NULL AND (target_invoice_id IS NULL OR target_invoice_id=?))',a.id,invoice.id)),
      ...usageAdjustments.map((a:Row)=>stmt(env,'UPDATE nc_usage_adjustments SET invoice_id=? WHERE id=? AND invoice_id IS NULL',invoice.id,a.id)),
      ...carried.flatMap(c=>[guard(env,'credit_balance_changed',`(SELECT amount_cents-applied_cents-COALESCE((SELECT SUM(amount_cents) FROM nc_usage_credit_applications WHERE credit_id=n.id),0) FROM nc_credit_notes n WHERE n.id=?)>=?`,c.id,c.amountCents),
        stmt(env,'INSERT INTO nc_usage_credit_applications(id,credit_id,invoice_id,customer_id,amount_cents,applied_at) VALUES(?,?,?,?,?,?)',newId(),c.id,invoice.id,invoice.customer_id,c.amountCents,now())]),
      ...charges.map(id => guard(env, 'charges_already_billed_or_missing', 'EXISTS(SELECT 1 FROM nc_charges WHERE id=? AND invoice_id IS NULL)', id)),
      ...charges.map(id => stmt(env, 'UPDATE nc_charges SET invoice_id=? WHERE id=?', invoice.id, id)),
      ...chunk(consumed, 90).map(ids => stmt(env, `UPDATE nc_usage_events SET invoice_id = ? WHERE event_id IN (${ids.map(() => '?').join(',')})`, invoice.id, ...ids)),
      stmt(env, "UPDATE nc_invoices SET legal_name=(SELECT name FROM nc_customers WHERE id=nc_invoices.customer_id), status = 'issued', number = ?, issue_date = ?, due_date = ?, issued_by = ?, issued_at = ?,billing_entity_id=?,billing_route_json=? WHERE id = ?", number, issueDate, due, actorLabel(actor), now(),allocation.entityId,allocation.routeJson, invoice.id),
      ...await hierarchyIssueStatements(env,invoice),
      ...prepaidPurchaseIssueStatements(env,invoice,calculation.inputs ?? {}),
      ...await issueApplicationStatements(env,invoice,carried.reduce((n,c)=>n+c.amountCents,0)),
      ...await prepaidIssueStatements(env,invoice,calculation,issueDate),
      ...await revenueIssueStatements(env,{...invoice,issue_date:issueDate}),
      ...(calculation.inputs?.billing?billingComponentClaimStatements(env,invoice.subscription_id,invoice.id,calculation.inputs.billing):[]),
    ], { actor: actorLabel(actor), action: 'invoice.issue', subject: invoice.id, detail: { number, total: invoice.total_cents, fingerprint: invoice.approved_fingerprint, events: consumed.length, charges } })
    await (await import('./automatic-collection-jobs')).collectAutomaticInvoice(env,invoice.id)
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


function canonicalAdjustments(rows:Row[],saved:Row[]) {
  return canonical(rows.map(r=>({id:r.id,line:parseJson(r.line_json,{}),taxCents:r.tax_cents})))===canonical([...saved].sort((a,b)=>a.id.localeCompare(b.id)).map(r=>({id:r.id,line:r.line,taxCents:r.taxCents})))
}

export async function approve(env: Bindings, actor: Actor, input: Input) {
  return approveWithAuthority(env,actor,input)
}
export async function finalise(env: Bindings, actor: Actor, input: Input) {
  return finaliseWithAuthority(env,actor,input)
}

/** Execute only the saved exact-term trial policy. All normal approval, tax,
 * source, numbering, component, revenue and issue obligations remain in force.
 * This internal scheduler door never accepts a caller-supplied actor or quote. */
export async function issueAuthorizedTrialInvoice(env: Bindings, authorization: string) {
  const records = await import('./trial-collection-records'), { trialSystem } = await import('./trial-collection-invoice')
  let row = await records.storedTrialCollection(env, authorization)
  insist(row.status === 'active', 'trial_collection_inactive', 409)
  const { q } = await records.currentTrialCollection(env, row, true), actor = trialSystem(row.id), at = clockInstant(env)
  if (!row.invoice_id) {
    const invoice = newId(), run = newId(), revision = newId()
    const statements = [records.trialCollectionGuard(env, row),
      stmt(env, "INSERT INTO nc_bill_runs(id,period,cutoff_at,calc_version,status,summary_json,created_by,created_at) VALUES(?,?,?,?,'draft',?,?,?)", run, q.trialEnd.slice(0,7), at, q.input.version, JSON.stringify({invoices:1,trialAuthorization:row.id}), actorLabel(actor), at),
      stmt(env, `INSERT INTO nc_invoices(id,bill_run_id,customer_id,subscription_id,period_start,period_end,status,subtotal_cents,tax_cents,total_cents,calc_version,source_fingerprint,calculation_json,comparison_json,exceptions_json,created_at,billing_key,currency)
        VALUES(?,?,?,?,?,?,'draft',?,?,?,?,?,?,'{}','[]',?,?,?)`, invoice, run, q.customer, q.subscription, q.window.period.start, q.window.period.end,
        q.rating.subtotalCents, q.rating.taxCents, q.amountCents, q.input.version, q.fingerprint,
        JSON.stringify({version:q.input.version,fingerprint:q.fingerprint,tax:q.rating.tax,consumedEvents:q.rating.consumedEvents,inputs:q.input}), at, q.window.key,q.input.currency??'USD'),
      ...q.rating.lines.map((line,index)=>stmt(env, `INSERT INTO nc_invoice_lines(id,invoice_id,seq,kind,description,quantity,unit_amount,amount_cents,taxable,price_id,meter_id,period_start,period_end,evidence_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, newId(), invoice, index+1, line.kind, line.description, line.quantity, line.unitAmount, line.amountCents, line.taxable?1:0, line.priceId, line.meterId, line.periodStart, line.periodEnd, JSON.stringify(line.evidence))),
      stmt(env,'UPDATE nc_trial_collections SET invoice_id=?,revision=? WHERE id=?',invoice,revision,row.id)]
    await commit(env,statements,{actor:actorLabel(actor),action:'trial.collection.invoice.prepare',subject:invoice,detail:{authorization:row.id,basis:row.basis_hash,fingerprint:q.fingerprint,amountCents:q.amountCents}})
    row = await records.storedTrialCollection(env, authorization)
  }
  const invoice = await one(env,'SELECT * FROM nc_invoices WHERE id=?',row.invoice_id)
  insist(invoice,'invoice_not_found',404)
  if(invoice.status==='draft'){
    const business = await requireBusiness(env)
    await commit(env,[records.trialCollectionGuard(env,row),...await approveOne(env,actor,business,invoice,false)],
      {actor:actorLabel(actor),action:'invoice.approve',subject:invoice.id,detail:{authorization:row.id,basis:row.basis_hash,owner:row.prepared_by,approver:row.approved_by,fingerprint:q.fingerprint}})
  }
  if(invoice.status!=='issued')await finaliseCore(env,actor,Input.of({invoice:invoice.id,issue_date:q.chargeDate}),row)
  return { invoice: invoice.id }
}

/** Complete an already captured hosted payment through ordinary native issue.
 * Authority comes from its exact owner policy and customer consent, never an impersonated member. */
export async function issueAuthorizedPaymentLinkInvoice(env: Bindings, attemptId: string) {
  const { paymentLinkInvoiceAuthority, paymentLinkSystem } = await import('./payment-links-one-time')
  const attempt = await one(env, "SELECT * FROM nc_payment_link_attempts WHERE id=? AND status='recording_invoice'", attemptId)
  insist(attempt?.invoice_id && attempt.customer_id && attempt.proof_json, 'payment_link_source_missing', 409)
  const invoice = await one(env, 'SELECT * FROM nc_invoices WHERE id=? AND customer_id=?', attempt.invoice_id, attempt.customer_id)
  insist(invoice, 'invoice_not_found', 404)
  const actor = paymentLinkSystem(attempt.id), authority = () => paymentLinkInvoiceAuthority(env, attempt.id)
  if (invoice.status === 'draft') {
    const business = await requireBusiness(env)
    await commit(env, [authority(), ...await approveOne(env, actor, business, invoice, false, authority)],
      { actor: actorLabel(actor), action: 'invoice.approve', subject: invoice.id, detail: { paymentLinkAttempt: attempt.id, consent: attempt.consent_hash, fingerprint: invoice.source_fingerprint } })
  }
  if (invoice.status !== 'issued') await finaliseCore(env, actor, Input.of({ invoice: invoice.id, issue_date: parseJson<Row>(attempt.proof_json, {}).receivedOn }), undefined, authority)
  return { invoice: invoice.id }
}
