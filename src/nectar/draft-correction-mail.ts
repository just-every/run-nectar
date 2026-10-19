// Frozen, engine-derived customer explanations. Preparation never queues or sends.
import type { Bindings } from '../auth.server'
import { operatorMail } from '../mail.server.mjs'
import { NectarError, all, canonical, commit, fingerprint, guard, insist, now, one, parseJson, stmt, type Row } from './core'
import { isDate, parseInstant } from './dates'
import { canonicalDecimal, money } from './decimal'
import { esc } from './ui/html'

export type DraftCorrectionKind = 'amendment' | 'usage_correction'
export interface DraftCorrectionCitation { source: string; quote: string; fingerprint?: string }
export interface DraftCorrectionNotice {
  customer: string; recipient: string; subject: string; body: string; citations: DraftCorrectionCitation[]
}
interface Prepared { normalized: Row; impact: any; basis: Row }
interface EngineTotal { subtotalCents: number; taxCents: number; totalCents: number; fingerprint: string; lines: { description: string; amountCents: number }[] }
interface PeriodImpact { subscription: string; customer?: string; period: { start: string; end: string }; before: EngineTotal; after: EngineTotal }
interface UsageSource { id: string; customer: string; meter: string; action: string; quantity: string; occurredAt: number }
interface CustomerImpact { customer: Row; rows: PeriodImpact[]; subscriptions: Row[] }

const email = (value: unknown): value is string => typeof value === 'string' && value.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[\w-]{1,100}$/.test(value)
function engineTotal(value: EngineTotal) {
  insist(value && ['subtotalCents', 'taxCents', 'totalCents'].every(key => Number.isSafeInteger((value as unknown as Row)[key]))
    && value.subtotalCents + value.taxCents === value.totalCents
    && /^[a-f0-9]{64}$/.test(value.fingerprint) && Array.isArray(value.lines)
    && value.lines.every(line => line && typeof line.description === 'string' && Number.isSafeInteger(line.amountCents))
    && value.lines.reduce((sum, line) => sum + line.amountCents, 0) === value.subtotalCents, 'correction_calculation_required', 409)
}
function validatePeriod(row: PeriodImpact) {
  insist(row && row.period && isDate(row.period.start) && isDate(row.period.end) && row.period.start < row.period.end, 'invalid_correction_period')
  engineTotal(row.before); engineTotal(row.after)
}

async function usageSources(env: Bindings, payload: Row, rows: Row[]): Promise<UsageSource[]> {
  insist(Array.isArray(payload.void) && Array.isArray(payload.add) && Array.isArray(rows) && rows.length > 0, 'correction_sources_required')
  const sources: UsageSource[] = []
  for (const row of rows) {
    insist(row && typeof row.event === 'string' && ['void', 'add'].includes(row.action), 'invalid_correction_source')
    insist(!sources.some(source => source.id === row.event), 'duplicate_correction_source')
    if (row.action === 'void') {
      insist(payload.void.some((entry: Row) => entry.event_id === row.event && entry.reason === row.reason), 'correction_source_mismatch')
      const source = await one(env, "SELECT event_id,customer_id,meter_id,quantity,occurred_at FROM nc_usage_events WHERE event_id=? AND status='active' AND invoice_id IS NULL", row.event)
      insist(source && source.quantity === row.quantity && source.occurred_at === parseInstant(row.occurredAt), 'correction_source_mismatch', 409)
      sources.push({ id: source.event_id, customer: source.customer_id, meter: source.meter_id, action: row.action, quantity: source.quantity, occurredAt: source.occurred_at })
    } else {
      const entry = payload.add.find((entry: Row) => entry.event_id === row.event)
      insist(entry && canonicalDecimal(entry.quantity, 'quantity') === row.quantity && parseInstant(entry.occurred_at) === parseInstant(row.occurredAt), 'correction_source_mismatch')
      const [customer, meter] = await Promise.all([
        one(env, 'SELECT id FROM nc_customers WHERE external_id=?', entry.customer),
        one(env, 'SELECT id FROM nc_meters WHERE code=? AND source_meter_id IS NULL', entry.meter),
      ])
      insist(customer && meter, 'correction_source_mismatch')
      sources.push({ id: row.event, customer: customer.id, meter: meter.id, action: row.action, quantity: row.quantity, occurredAt: parseInstant(row.occurredAt) })
    }
  }
  insist(sources.length === payload.void.length + payload.add.length, 'correction_source_mismatch')
  return sources
}

function amendmentTerms(payload: Row) {
  insist(['discount_percent', 'fixed_credit', 'price_override'].includes(payload.kind)
    && typeof payload.value === 'string' && isDate(payload.effective_from)
    && (payload.effective_to === null || payload.effective_to === undefined || isDate(payload.effective_to) && payload.effective_to > payload.effective_from), 'invalid_correction_terms')
  const value = canonicalDecimal(payload.value)
  const term = payload.kind === 'discount_percent' ? `Recurring discount: ${value}%`
    : payload.kind === 'fixed_credit' ? `One-time contract credit: USD ${value}` : `Unit price override: USD ${value} for price ${payload.price}`
  return `${term}; effective ${payload.effective_from}${payload.effective_to ? ` through ${payload.effective_to} (end exclusive)` : ', with no recorded end date'}.`
}

function periodExplanation(row: PeriodImpact) {
  const total = (label: string, value: EngineTotal) => `${label}: subtotal ${money(value.subtotalCents)}, tax ${money(value.taxCents)}, total ${money(value.totalCents)} (USD).`
  const lineText = (label: string, value: EngineTotal) => `${label} rated lines:\n${value.lines.map(line => `- ${line.description}: ${money(line.amountCents)}`).join('\n') || '- No charges.'}`
  return [`Subscription ${row.subscription}; service period ${row.period.start} to ${row.period.end} (end exclusive).`,
    total('Before', row.before), total('After', row.after),
    `Change: subtotal ${money(row.after.subtotalCents - row.before.subtotalCents)}, tax ${money(row.after.taxCents - row.before.taxCents)}, total ${money(row.after.totalCents - row.before.totalCents)} (USD).`,
    lineText('Before', row.before), lineText('After', row.after)].join('\n')
}

/** Rebuild from the engine result, discarding any supplied message drafts. */
export async function draftCorrectionPlan(env: Bindings, kind: DraftCorrectionKind, prepared: Prepared) {
  insist(kind === 'amendment' || kind === 'usage_correction', 'invalid_correction_kind')
  insist(prepared && prepared.normalized && typeof prepared.normalized === 'object' && !Array.isArray(prepared.normalized)
    && prepared.basis && typeof prepared.basis === 'object' && !Array.isArray(prepared.basis), 'invalid_correction_plan')
  const { noticeDrafts: _discardedDrafts, ...normalized } = prepared.normalized
  const { correctionState: _discardedState, ...originalBasis } = prepared.basis
  const sources = kind === 'usage_correction' ? await usageSources(env, normalized, prepared.impact?.rows) : []
  const impacts: PeriodImpact[] = kind === 'amendment'
    ? (Array.isArray(prepared.impact) ? prepared.impact.map(row => ({ ...row, subscription: normalized.subscription })) : [])
    : prepared.impact?.invoices
  insist(Array.isArray(impacts) && impacts.length > 0, 'correction_affected_periods_required')
  const terms = kind === 'amendment' ? amendmentTerms(normalized) : null
  const groups = new Map<string, CustomerImpact>()
  for (const impact of impacts) {
    validatePeriod(impact)
    insist(identifier(impact.subscription), 'invalid_correction_subscription')
    const sub = await one(env, `SELECT s.id,s.customer_id,s.revision,c.name,c.billing_email,c.address,c.revision AS customer_revision
      FROM nc_subscriptions s JOIN nc_customers c ON c.id=s.customer_id WHERE s.id=?`, impact.subscription)
    insist(sub, 'subscription_not_found', 404)
    insist(email(sub.billing_email), 'customer_billing_email_required', 409)
    insist(impact.customer === undefined || impact.customer === sub.name || impact.customer === sub.customer_id, 'correction_customer_mismatch')
    if (kind === 'usage_correction') {
      const meters = await all(env, `SELECT DISTINCT COALESCE(m.source_meter_id,p.meter_id) AS source FROM nc_items i
        JOIN nc_prices p ON p.id=i.price_id LEFT JOIN nc_meters m ON m.id=p.meter_id WHERE i.subscription_id=? AND p.meter_id IS NOT NULL`, sub.id)
      insist(sources.some(source => source.customer === sub.customer_id && meters.some(meter => meter.source === source.meter)), 'correction_customer_mismatch')
    }
    const group: CustomerImpact = groups.get(sub.customer_id) ?? { customer: sub, rows: [], subscriptions: [] }
    insist(!group.rows.some(row => row.subscription === impact.subscription && row.period.start === impact.period.start), 'duplicate_correction_period')
    group.rows.push(impact); group.subscriptions.push(sub); groups.set(sub.customer_id, group)
  }
  insist(sources.every(source => groups.has(source.customer)), 'correction_affected_periods_required')
  const noticeDrafts: DraftCorrectionNotice[] = []
  for (const [customer, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    group.rows.sort((a, b) => a.period.start.localeCompare(b.period.start) || a.subscription.localeCompare(b.subscription))
    const ownSources = sources.filter(source => source.customer === customer)
    const explanation = group.rows.map(periodExplanation).join('\n\n')
    const citations: DraftCorrectionCitation[] = group.rows.flatMap(row => {
      const source = `/app/subscriptions/${encodeURIComponent(row.subscription)}?preview_period=${row.period.start.slice(0, 7)}#upcoming`
      return [{ source, quote: `Before: subtotal ${row.before.subtotalCents} cents, tax ${row.before.taxCents} cents, total ${row.before.totalCents} cents.`, fingerprint: row.before.fingerprint },
        { source, quote: `After: subtotal ${row.after.subtotalCents} cents, tax ${row.after.taxCents} cents, total ${row.after.totalCents} cents.`, fingerprint: row.after.fingerprint }]
    })
    if (ownSources.length) citations.push(...ownSources.map(source => ({ source: '/app/usage',
      quote: `${source.action} usage ${source.id}; quantity ${source.quantity}; occurred ${new Date(source.occurredAt).toISOString()}.` })))
    const body = [`Hello ${group.customer.name},`, 'This billing correction changes the draft calculations shown below.',
      terms ?? `Usage correction sources: ${ownSources.map(source => `${source.action} ${source.id} (${source.quantity})`).join('; ')}.`,
      `Next affected invoice service period: ${group.rows[0].period.start} to ${group.rows[0].period.end} (end exclusive).`, explanation,
      'These are exact invoice-engine calculations from the recorded inputs. Preparing this explanation does not issue an invoice; invoice approval and issue remain separate.'].join('\n\n')
    noticeDrafts.push({ customer, recipient: group.customer.billing_email, subject: 'Billing correction and draft invoice explanation', body, citations })
  }
  const correctionState = await fingerprint({ kind, normalized, impact: prepared.impact, originalBasis, sources,
    recipients: [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([customer, group]) => ({ customer, subscriptions: group.subscriptions })), noticeDrafts })
  return { ...prepared, normalized: { ...normalized, noticeDrafts }, basis: { ...originalBasis, correctionState } }
}

/** Include these in the adjustment/proposal-close transaction; this sends nothing. */
export function draftCorrectionMailStatements(env: Bindings, proposalRow: Row, payload: Row): D1PreparedStatement[] {
  insist(['amendment', 'usage_correction'].includes(proposalRow.kind) && proposalRow.status === 'pending', 'proposal_not_pending', 409)
  insist(canonical(payload) === canonical(parseJson(proposalRow.payload_json, null)), 'proposal_stale', 409)
  const drafts = payload.noticeDrafts as DraftCorrectionNotice[]
  insist(Array.isArray(drafts) && drafts.length > 0 && typeof parseJson<Row>(proposalRow.basis_json, {}).correctionState === 'string', 'correction_mail_drafts_required', 409)
  const statements: D1PreparedStatement[] = [], customers = new Set<string>(), at = now()
  for (const draft of drafts) {
    insist(draft && identifier(draft.customer) && !customers.has(draft.customer) && email(draft.recipient)
      && typeof draft.subject === 'string' && draft.subject.length > 0 && draft.subject.length <= 200 && !/[\r\n]/.test(draft.subject)
      && typeof draft.body === 'string' && draft.body.length > 0 && Array.isArray(draft.citations) && draft.citations.length > 0, 'invalid_correction_mail_draft')
    customers.add(draft.customer)
    statements.push(guard(env, 'proposal_stale', 'EXISTS(SELECT 1 FROM nc_customers WHERE id=? AND billing_email=?)', draft.customer, draft.recipient),
      stmt(env, `INSERT INTO nc_draft_correction_mail(proposal_id,customer_id,proposal_kind,recipient,subject,body,citations_json,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,'pending',?,?)`, proposalRow.id, draft.customer, proposalRow.kind, draft.recipient, draft.subject, draft.body, JSON.stringify(draft.citations), at, at))
  }
  return statements
}

/** One claim and one provider attempt per approved proposal/customer. Never retry a claim. */
export async function deliverDraftCorrectionMail(env: Bindings, proposalId: string) {
  const outcomes: { customer: string; status: string; providerRef: string | null }[] = []
  for (const row of await all(env, `SELECT m.* FROM nc_draft_correction_mail m JOIN nc_proposals p ON p.id=m.proposal_id
    WHERE m.proposal_id=? AND m.status='pending' AND p.status='approved' ORDER BY m.customer_id`, proposalId)) {
    try{
      await commit(env,[guard(env,'stale',"EXISTS(SELECT 1 FROM nc_draft_correction_mail m JOIN nc_proposals p ON p.id=m.proposal_id WHERE m.proposal_id=? AND m.customer_id=? AND m.status='pending' AND p.status='approved')",proposalId,row.customer_id),
        stmt(env,"UPDATE nc_draft_correction_mail SET status='sending',updated_at=? WHERE proposal_id=? AND customer_id=? AND status='pending'",now(),proposalId,row.customer_id)],
        {actor:'system:draft-correction',action:'proposal.correction.mail.claim',subject:proposalId,detail:{customer:row.customer_id}})
    }catch(error){if(error instanceof NectarError&&error.code==='stale')continue;throw error}
    let status = 'failed', provider: string | null = null, code = 'mail_not_configured'
    try {
      const mail = operatorMail(env)
      if (mail && env.MAIL_FROM) {
        status = 'uncertain'; code = 'provider_outcome_unknown'
        const deliveryId = `draft-correction-${await fingerprint([proposalId, row.customer_id])}`
        const result = await mail.send({ deliveryId, from: env.MAIL_FROM, to: [row.recipient], subject: row.subject,
          text: row.body, html: `<pre>${esc(row.body)}</pre>`, headers: { 'Auto-Submitted': 'auto-generated' } })
        status = result.status === 'accepted' ? 'accepted' : result.status === 'development' ? 'suppressed'
          : result.status === 'rejected' ? 'rejected' : result.status === 'rate_limited' ? 'failed' : 'uncertain'
        provider = result.providerMessageId ?? null
        code = result.status
      }
    } catch (error) {
      // Only known preflight failures prove no provider submission occurred.
      // Result validation can fail after submission and must stay uncertain.
      const preflightCodes = ['invalid_config', 'invalid_provider', 'invalid_mode', 'api_key_required', 'invalid_api_key', 'cloudflare_account_required']
      if (error instanceof Error && (error.name === 'DevelopmentOutboxError'
        || error.name === 'MailValidationError' && preflightCodes.includes((error as Error & { code?: string }).code ?? ''))) {
        status = 'failed'; code = error.name === 'DevelopmentOutboxError' ? 'development_outbox_failed' : 'invalid_mail_configuration'
      }
    }
    await commit(env, [stmt(env, `UPDATE nc_draft_correction_mail SET status=?,provider_ref=?,outcome_code=?,updated_at=?
      WHERE proposal_id=? AND customer_id=? AND status='sending'`, status, provider, code, now(), proposalId, row.customer_id)],
      { actor: 'system:draft-correction', action: 'proposal.correction.mail.delivery', subject: proposalId, detail: { customer: row.customer_id, status, provider, code } })
    outcomes.push({ customer: row.customer_id, status, providerRef: provider })
  }
  return outcomes
}

/** Resume only never-claimed approved mail after a request boundary or restart. */
export async function deliverPendingDraftCorrectionMail(env: Bindings) {
  const pending = await all(env, `SELECT DISTINCT m.proposal_id,m.created_at FROM nc_draft_correction_mail m
    JOIN nc_proposals p ON p.id=m.proposal_id WHERE m.status='pending' AND p.status='approved'
    ORDER BY m.created_at,m.proposal_id LIMIT 100`)
  for (const row of pending) await deliverDraftCorrectionMail(env, row.proposal_id)
}
