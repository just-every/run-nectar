import { amendmentPlan, correctionPlan } from './draft-correction-plan'
import { planInvoiceCredit, invoiceCreditStatements } from './credit-correction'
import { deliverCorrectionMail } from './credit-correction-mail'
import { draftCorrectionPlan, draftCorrectionMailStatements, deliverDraftCorrectionMail } from './draft-correction-mail'
import { setupPlan } from './setup-plan'
import { setupStatements } from './setup-apply'
import { alertStatements } from './notifications'
import { deliverAlerts } from './notification-mail'
// Agent-prepared work. An agent (or a person) proposes; a person approves.
// Nectar computes every amount itself with the rating engine; a proposal's
// own numbers are never trusted. Each proposal records the source versions it
// was prepared against (`basis`); approval re-reads them and refuses a stale
// proposal. Approving a data correction re-prepares a draft bill run but
// approves no invoice: those still need their own approval.
import type { Bindings } from '../auth.server'
import { actorLabel, requireCapability, requireMember, type Actor } from './actor'
import { requireBusiness, type Business } from './business'
import { all, canonical, commit, guard, insist, newId, now, one, parseJson, stmt, type Row } from './core'
import { addDays } from './dates'
import { requirePrice } from './catalog'
import { Input } from './input'
import { basisKey, reminderBasis, reminderDraft } from './collections'
import { ingestStatements, screen, type RawEvent } from './usage'
import { notIssuedGuard } from './subscriptions'
import { prepareRun } from './billruns'
import { priceChangePlan } from './price-migrations'

const KINDS = ['amendment', 'price_change', 'usage_correction', 'collection'] as const
type Kind = typeof KINDS[number]

async function collectionPlan(env: Bindings, payload: Row) {
  const basis = await reminderBasis(env, String(payload.customer ?? ''))
  insist(basis.overdue.length, 'nothing_overdue', 409)
  const draft = reminderDraft(basis)
  const recipient = String(payload.recipient ?? basis.customer.billing_email ?? '').toLowerCase()
  return {
    normalized: { customer: basis.customer.id, recipient, subject: String(payload.subject || draft.subject).slice(0, 200), body: String(payload.body || draft.body).slice(0, 8000) },
    impact: { overdue: basis.overdue, balanceCents: basis.balanceCents, recentPayments: basis.recentPayments },
    basis: { balances: basisKey(basis) },
  }
}

async function plan(env: Bindings, kind: Kind, payload: Row, saved = false):Promise<{normalized:Row;impact:any;basis:Row}> {
  const business = await requireBusiness(env)
  if (kind === 'amendment' && payload.invoice_credit === true) return await planInvoiceCredit(env,business,payload,saved)
  if (kind === 'amendment' && payload.setup === true) return await setupPlan(env,business,payload,saved)
  if (kind === 'amendment') return await draftCorrectionPlan(env,kind,await amendmentPlan(env,business,payload))
  if (kind === 'price_change') return await priceChangePlan(env, business, payload, saved)
  if (kind === 'usage_correction') return await draftCorrectionPlan(env,kind,await correctionPlan(env,business,payload))
  return await collectionPlan(env, payload)
}

/** Reads the current value of everything a proposal was prepared against. */
async function currentBasis(env: Bindings, kind: Kind, payload: Row) {
  return (await plan(env, kind, payload, true)).basis
}

export async function propose(env: Bindings, actor: Actor, input: Input) {
  requireCapability(actor, 'propose')
  const kind = input.text('kind', { max: 20 }) as Kind
  insist(KINDS.includes(kind), 'invalid_kind')
  const title = input.text('title', { max: 200 })
  const payload = input.json('payload') as Row
  insist(payload && typeof payload === 'object' && !Array.isArray(payload), 'invalid_payload')
  const evidence = (input.has('evidence') ? input.json('evidence') : {}) as Row
  insist(evidence && typeof evidence === 'object' && !Array.isArray(evidence), 'invalid_evidence')
  if (kind === 'amendment' && payload.setup !== true && payload.invoice_credit !== true) {
    const clauses = Array.isArray(evidence.clauses) ? evidence.clauses.filter((c: Row) => typeof c?.quote === 'string' && c.quote.trim()) : []
    insist(clauses.length, 'quoted_clause_required')
  }
  if (kind === 'usage_correction') insist(Array.isArray(evidence.sources) && evidence.sources.length, 'source_reference_required')
  if (kind === 'price_change' && payload.simulation === true && actor.kind === 'member') requireMember(actor,'records')
  if (kind === 'amendment' && payload.setup === true) {
    if(actor.kind==='member')requireMember(actor,'records')
    if(Array.isArray(payload.ambiguities)&&payload.ambiguities.some((a:Row)=>a?.resolution))requireMember(actor,'records')
  }
  const prepared = await plan(env, kind, payload)
  if(kind==='amendment'&&payload.setup===true&&payload.revises){
    requireMember(actor,'records')
    const previous=await one(env,"SELECT * FROM nc_proposals WHERE id=? AND status='pending'",String(payload.revises))
    insist(previous,'proposal_not_found',404)
    const old=parseJson<Row>(previous.payload_json,{})
    insist(old.setup&&canonical(old.source)===canonical(prepared.normalized.source),'setup_source_changed',409)
    const oldIssues=(old.input?.ambiguities??[]) as Row[]
    insist(oldIssues.every(a=>(payload.ambiguities??[]).some((b:Row)=>b.issue===a.issue&&typeof b.resolution==='string'&&b.resolution.trim())),'setup_resolutions_required')
  }
  if(payload.setup===true)insist(new TextEncoder().encode(JSON.stringify([prepared.normalized,prepared.impact,prepared.basis])).length<=1500000,'setup_proposal_too_large')
  const id = newId()
  await commit(env, [...await alertStatements(env,'proposals',id,`/app/proposals/${id}`),stmt(env, "INSERT INTO nc_proposals (id, kind, title, payload_json, evidence_json, impact_json, basis_json, status, created_by, created_by_kind, created_at, prepared_by_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)",
    id, kind, title, JSON.stringify(prepared.normalized), JSON.stringify(evidence), JSON.stringify(prepared.impact), JSON.stringify(prepared.basis), actorLabel(actor), actor.kind, now(), actor.id)],
  { actor: actorLabel(actor), action: 'proposal.create', subject: id, detail: { kind, title } })
  await deliverAlerts(env,'proposals',id,actorLabel(actor))
  return { id, kind, impact: prepared.impact }
}

export async function proposals(env: Bindings, actor: Actor) {
  requireCapability(actor, 'read')
  return await all(env, 'SELECT id, kind, json_extract(payload_json, \'$.invoice_credit\') AS invoice_credit,title, status, created_by, created_by_kind, created_at, decided_by, decided_at FROM nc_proposals ORDER BY status = \'pending\' DESC, created_at DESC LIMIT 200')
}

export async function proposalDetail(env: Bindings, actor: Actor, id: string): Promise<Row> {
  requireCapability(actor, 'read')
  const row = await one(env, 'SELECT * FROM nc_proposals WHERE id = ?', id)
  insist(row, 'proposal_not_found', 404)
  const payload = parseJson<Row>(row.payload_json, {})
  let stale = false
  if (row.status === 'pending') {
    try { stale = canonical(await currentBasis(env, row.kind, payload)) !== canonical(parseJson(row.basis_json, {})) } catch { stale = true }
  }
  const changesPrice = payload.setup === true || row.kind === 'price_change' || (row.kind === 'amendment' && payload.kind === 'price_override')
  const needsPreparation = changesPrice && row.created_by_kind === 'member' && !row.prepared_by_id
  let needsOtherApprover = changesPrice && row.created_by_kind === 'member' && row.prepared_by_id === actor.id
  const correctionMail=await one(env,'SELECT * FROM nc_credit_correction_mail WHERE proposal_id=?',id)
  const binding=await one(env,'SELECT b.request_id,r.prepared_by FROM nc_credit_correction_requests b JOIN nc_credit_requests r ON r.id=b.request_id WHERE b.proposal_id=?',id)
  const customerMessages=await all(env,'SELECT * FROM nc_draft_correction_mail WHERE proposal_id=? ORDER BY customer_id',id)
  const needsCreditPreparation=payload.invoice_credit===true && parseJson<Row>(row.impact_json,{}).credit?.needsSecondApprover && !binding
  needsOtherApprover=needsOtherApprover || payload.invoice_credit===true && parseJson<Row>(row.impact_json,{}).credit?.needsSecondApprover && binding?.prepared_by===actor.id
  return { ...row, needsCreditPreparation,correctionMail,creditRequest:binding?.request_id??null,customerMessages,needsPreparation, needsOtherApprover, payload, evidence: parseJson(row.evidence_json, {}), impact: parseJson(row.impact_json, {}), basis: parseJson(row.basis_json, {}), result: parseJson(row.result_json, null), stale, payload_json: undefined, evidence_json: undefined, impact_json: undefined, basis_json: undefined, result_json: undefined }
}

/** A person approves or rejects. Approval re-reads the basis and applies the typed change through the normal records. */
export async function decide(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'approve')
  const row = await one(env, 'SELECT * FROM nc_proposals WHERE id = ?', input.text('proposal', { max: 100 }))
  insist(row, 'proposal_not_found', 404)
  insist(row.status === 'pending', 'already_decided', 409)
  const decision = input.text('decision', { max: 10 })
  insist(decision === 'approved' || decision === 'rejected', 'invalid_decision')
  const note = input.text('note', { max: 500, optional: true })
  const by = actorLabel(actor), at = now()
  const close = (result: unknown) => [
    guard(env, 'stale', "EXISTS(SELECT 1 FROM nc_proposals WHERE id = ? AND status = 'pending')", row.id),
    stmt(env, 'UPDATE nc_proposals SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, result_json = ? WHERE id = ?', decision, by, at, note, JSON.stringify(result ?? null), row.id),
  ]
  if (decision === 'rejected') {
    await commit(env, close(null), { actor: by, action: 'proposal.reject', subject: row.id, detail: { note } })
    return { id: row.id, status: 'rejected' }
  }
  const payload = parseJson<Row>(row.payload_json, {})
  const simulationSeq = payload.simulation === true || payload.setup === true || payload.invoice_credit === true || row.kind === 'usage_correction' || row.kind === 'amendment' ? (await one(env,'SELECT COALESCE(MAX(seq),0) AS seq FROM nc_audit'))!.seq : null
  if ((payload.setup === true || row.kind === 'price_change' || (row.kind === 'amendment' && payload.kind === 'price_override')) && row.created_by_kind === 'member') {
    insist(row.prepared_by_id, 'price_proposal_needs_preparation', 409)
    insist(row.prepared_by_id !== actor.id, 'second_approver_required', 409)
  }
  let basis: unknown
  try { basis = await currentBasis(env, row.kind, payload) } catch { basis = null }
  insist(canonical(basis) === canonical(parseJson(row.basis_json, {})), 'proposal_stale', 409)
  if(payload.setup===true)insist(!(parseJson<Row>(row.impact_json,{}).unresolvedAmbiguities??[]).length,'setup_ambiguities_unresolved',409)
  const audit = { actor: by, action: 'proposal.approve', subject: row.id, detail: { kind: row.kind, note } }
  const basisGuards = payload.setup===true || payload.invoice_credit===true ? [] : await basisGuardStatements(env, row.kind, parseJson<Row>(row.basis_json, {}))
  if(simulationSeq!==null) basisGuards.push(guard(env,'proposal_stale','(SELECT COALESCE(MAX(seq),0) FROM nc_audit)=?',simulationSeq))

  if(payload.invoice_credit===true){
    const applied=await invoiceCreditStatements(env,actor,row,payload)
    await commit(env,[...basisGuards,...applied.statements,...close(applied.result)],[audit,...applied.audits])
    await deliverCorrectionMail(env,row.id)
    return {...applied.result,invoice:applied.result.id,id:row.id,status:'approved'}
  }
  if(payload.setup===true){
    const applied=setupStatements(env,actor,payload,row)
    await commit(env,[...basisGuards,...applied.statements,...close(applied.result)],[audit,applied.audit])
    return {id:row.id,status:'approved',...applied.result}
  }

  if (row.kind === 'amendment') {
    const amendment = newId()
    await commit(env, [...basisGuards, ...draftCorrectionMailStatements(env,row,payload),notIssuedGuard(env, payload.subscription, payload.effective_from), ...close({ amendment }),
      stmt(env, "INSERT INTO nc_amendments (id, subscription_id, kind, value, price_id, effective_from, effective_to, note, clause, status, origin, proposal_id, created_by, created_at, decided_by, decided_at, prepared_by_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', 'proposal', ?, ?, ?, ?, ?, ?)",
        amendment, payload.subscription, payload.kind, payload.value, payload.price, payload.effective_from, payload.effective_to, String(payload.note ?? ''), JSON.stringify(parseJson<Row>(row.evidence_json, {}).clauses ?? []), row.id, row.created_by, row.created_at, by, at, row.prepared_by_id),
      stmt(env, 'UPDATE nc_subscriptions SET revision = ?, updated_at = ? WHERE id = ?', newId(), at, payload.subscription)], audit)
    await deliverDraftCorrectionMail(env,row.id)
    return { id: row.id, status: 'approved', amendment }
  }
  if (row.kind === 'price_change') {
    const target = payload.target_price ? await requirePrice(env, payload.target_price) : null
    const priceId = target?.id ?? newId(), version = target?.version ?? parseJson<Row>(row.basis_json, {}).productVersion[1] + 1
    const statements = [...basisGuards,
      guard(env, 'stale', "EXISTS(SELECT 1 FROM nc_products WHERE id = ? AND status = 'active')", payload.product),
      ...(target ? [guard(env, 'stale', "EXISTS(SELECT 1 FROM nc_prices WHERE id = ? AND product_id = ? AND status = 'active')", priceId, payload.product)] : [
        stmt(env, "INSERT INTO nc_prices (id, product_id, version, kind, unit_amount, meter_id, taxable, nickname, origin, revision, created_by, created_at,dimensions_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'native', ?, ?, ?,?)",
          priceId, payload.product, version, payload.kind, payload.unit_amount, payload.meter, payload.taxable ? 1 : 0, payload.nickname, newId(), by, at,canonical(payload.dimensions??{})),
      ]),
    ]
    for (const entry of parseJson<Row[]>(row.impact_json, [])) {
      const date = entry.effective_date ?? payload.effective_date
      statements.push(notIssuedGuard(env,entry.subscription,date))
      for(const source of entry.sourceItems ?? [{id:entry.item,quantity:entry.quantity}]) {
        const item = await one(env,'SELECT * FROM nc_items WHERE id=? AND subscription_id=?',source.id,entry.subscription)
        insist(item,'proposal_stale',409)
        statements.push(guard(env,'stale','EXISTS(SELECT 1 FROM nc_items WHERE id=? AND subscription_id=? AND price_id=? AND quantity=? AND effective_from=? AND effective_to IS ?)',item.id,entry.subscription,item.price_id,source.quantity,item.effective_from,item.effective_to),
          ...(item.effective_from===date ? [stmt(env,'UPDATE nc_items SET price_id=?,quantity=?,change_id=? WHERE id=?',priceId,source.targetQuantity??source.quantity,row.id,item.id)] : [
            stmt(env,'UPDATE nc_items SET effective_to=? WHERE id=?',date,item.id),
            stmt(env,"INSERT INTO nc_items (id,subscription_id,price_id,quantity,effective_from,effective_to,change_id,origin,created_at) VALUES (?,?,?,?,?,?,?,'native',?)",newId(),entry.subscription,priceId,source.targetQuantity??source.quantity,date,item.effective_to,row.id,at),
          ]))
      }
      statements.push(stmt(env,'UPDATE nc_subscriptions SET revision=?,updated_at=? WHERE id=?',newId(),at,entry.subscription))
    }
    await commit(env, [...statements, ...close({ price: priceId, version })], audit)
    return { id: row.id, status: 'approved', price: priceId }
  }
  if (row.kind === 'usage_correction') {
    // The voids, the additions and the proposal's record land together or not at all.
    const adds = payload.add as RawEvent[]
    const write = adds.length ? ingestStatements(env, actor, await screen(env, adds), { kind: 'correction' }) : null
    const statements = [...basisGuards, ...(payload.void as Row[]).map(entry => stmt(env, "UPDATE nc_usage_events SET status = 'voided', void_reason = ? WHERE event_id = ? AND status = 'active' AND invoice_id IS NULL", `${entry.reason} (proposal ${row.id})`, entry.event_id)), ...(write?.statements ?? [])]
    const result = { voided: (payload.void as Row[]).length, added: adds.length, batch: write?.batch ?? null }
    await commit(env, [...statements,...draftCorrectionMailStatements(env,row,payload), ...close(result)], write ? [audit, write.audit] : audit)
    let rerun = null
    if (payload.run && await one(env, "SELECT 1 FROM nc_bill_runs WHERE id = ? AND status = 'draft'", payload.run)) {
      rerun = await prepareRun(env, actor, Input.of({ period: payload.period }))
    }
    await deliverDraftCorrectionMail(env,row.id)
    return { id: row.id, status: 'approved', ...result, rerun: rerun?.id ?? null }
  }
  // collection: the person approves the exact recipient and wording.
  const recipient = input.text('recipient', { max: 200, optional: true }) || payload.recipient
  insist(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient), 'invalid_recipient')
  const subject = input.text('subject', { max: 200, optional: true }) || payload.subject
  const body = input.text('body', { max: 8000, optional: true }) || payload.body
  const reminder = await reminderBasis(env, payload.customer)
  const notice = newId()
  await commit(env, [...close({ notice }),
    stmt(env, "INSERT INTO nc_notices (id, customer_id, invoice_ids, balance_cents, recipient, subject, body, basis, status, proposal_id, created_by, created_at, approved_by, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?)",
      notice, payload.customer, JSON.stringify(reminder.overdue.map(r => r.id)), reminder.balanceCents, recipient, subject, body, basisKey(reminder), row.id, row.created_by, row.created_at, by, at),
    stmt(env, "INSERT INTO nc_tasks (id, customer_id, invoice_id, title, due_date, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)", newId(), payload.customer, reminder.overdue[0]?.id ?? null, `Follow up on the reminder to ${recipient}`, addDays(reminder.day, 7), by, at)], audit)
  return { id: row.id, status: 'approved', notice }
}

/** In-batch guards that the recorded basis still holds at commit time. */
async function basisGuardStatements(env: Bindings, kind: Kind, basis: Row) {
  if (kind === 'amendment') return [guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_subscriptions WHERE id = ? AND revision = ?)', basis.subscription[0], basis.subscription[1])]
  if (kind === 'price_change') return [
    guard(env, 'stale', 'COALESCE((SELECT MAX(version) FROM nc_prices WHERE product_id = ?), 0) = ?', basis.productVersion[0], basis.productVersion[1]),
    ...Object.entries(basis).filter(([key]) => key !== 'productVersion' && key !== 'ratings' && key !== 'replay').map(([id, revision]) => guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_subscriptions WHERE id = ? AND revision = ?)', id, revision)),
  ]
  if (kind === 'usage_correction') return Object.keys(basis).filter(key => key.startsWith('event:')).map(key => guard(env, 'already_billed', "EXISTS(SELECT 1 FROM nc_usage_events WHERE event_id = ? AND status = 'active' AND invoice_id IS NULL)", key.slice('event:'.length)))
  return []
}
