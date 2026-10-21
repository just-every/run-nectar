// Retention settings are inactive until an exact saved owner request is approved.
import type { Bindings } from '../auth.server'
import { actorLabel, requireCapability, requireMember, requireOwner, type Actor } from './actor'
import { all, commit, guard, insist, newId, now, one, stmt } from './core'
import type { Input } from './input'

export interface RetentionSettings {
  enabled: boolean
  save_kind: 'discount' | 'pause' | 'downgrade'
  save_percent: number
  save_months: number
  save_price_id: string
  pause_price_id: string
  winback_price_id: string
  pause_months: number
  downgrade_source_price_id: string
  downgrade_price_id: string
  winback_enabled: boolean
  winback_days: number
  winback_percent: number
  winback_months: number
}

const DEFAULTS: RetentionSettings = {
  enabled: false, save_kind: 'discount', save_percent: 50, save_months: 2,
  pause_months: 1, save_price_id: '', pause_price_id: '', winback_price_id: '', downgrade_source_price_id:'', downgrade_price_id: '', winback_enabled: false,
  winback_days: 60, winback_percent: 30, winback_months: 3,
}
const ACTIVE = "SELECT * FROM nc_retention_policies WHERE status='approved' ORDER BY decided_at DESC,id DESC LIMIT 1"
const REVISION = "COALESCE((SELECT id FROM nc_retention_policies WHERE status='approved' ORDER BY decided_at DESC,id DESC LIMIT 1),'initial')"
const OTHER_APPROVERS = "SELECT 1 FROM nc_members WHERE status='active' AND role IN ('owner','finance') AND id<>?"
const ACTIVE_OWNER = "EXISTS(SELECT 1 FROM nc_members WHERE id=? AND status='active' AND role='owner')"
const ACTIVE_APPROVER = "EXISTS(SELECT 1 FROM nc_members WHERE id=? AND status='active' AND role IN ('owner','finance'))"

export async function retentionPolicy(env: Bindings): Promise<RetentionSettings & { id: string | null; revision: string }> {
  const row = await one(env, ACTIVE)
  return row ? { ...DEFAULTS, ...JSON.parse(row.payload_json) as RetentionSettings, id: row.id, revision: row.id }
    : { ...DEFAULTS, id: null, revision: 'initial' }
}

function settings(input: Input): RetentionSettings {
  const kind = input.text('save_kind', { max: 20, optional: true }) || DEFAULTS.save_kind
  insist(kind === 'discount' || kind === 'pause' || kind === 'downgrade', 'invalid_save_kind')
  const source=input.text('downgrade_source_price_id',{max:100,optional:true})
  const target = input.text('downgrade_price_id', { max: 100, optional: true })
  insist(kind !== 'downgrade' || target&&source, 'missing_downgrade_price_id')
  return {
    enabled: input.flag('enabled'), save_kind: kind,
    save_percent: input.integer('save_percent', { min: 0, max: 100, optional: true }) ?? DEFAULTS.save_percent,
    save_price_id: input.text('save_price_id', { max: 100, optional: true }),
    pause_price_id: input.text('pause_price_id', { max: 100, optional: true }),
    winback_price_id: input.text('winback_price_id', { max: 100, optional: true }),
    save_months: input.integer('save_months', { min: 1, max: 36, optional: true }) ?? DEFAULTS.save_months,
    pause_months: input.integer('pause_months', { min: 1, max: 12, optional: true }) ?? DEFAULTS.pause_months,
    downgrade_source_price_id:source,downgrade_price_id: target, winback_enabled: input.flag('winback_enabled'),
    winback_days: input.integer('winback_days', { min: 1, max: 365, optional: true }) ?? DEFAULTS.winback_days,
    winback_percent: input.integer('winback_percent', { min: 0, max: 100, optional: true }) ?? DEFAULTS.winback_percent,
    winback_months: input.integer('winback_months', { min: 1, max: 36, optional: true }) ?? DEFAULTS.winback_months,
  }
}

async function validateDowngrade(env:Bindings,payload:RetentionSettings) {
  const scoped=[]
  for (const id of new Set([payload.save_price_id,payload.pause_price_id,payload.winback_price_id].filter(Boolean))) {
    insist(await one(env,"SELECT 1 FROM nc_prices WHERE id=? AND status='active' AND kind IN ('flat','seat')",id),'retention_price_unavailable',409)
    scoped.push(guard(env,'retention_price_unavailable',"EXISTS(SELECT 1 FROM nc_prices WHERE id=? AND status='active' AND kind IN ('flat','seat'))",id))
  }
  if(!payload.enabled||payload.save_kind!=='downgrade')return scoped
  const rows=await all(env,"SELECT p.id,p.kind,p.meter_id,p.dimensions_json,b.interval_unit,b.interval_count,b.billing_timing FROM nc_prices p LEFT JOIN nc_price_intervals b ON b.price_id=p.id WHERE p.id IN (?,?) AND p.status='active'",payload.downgrade_source_price_id,payload.downgrade_price_id)
  const source=rows.find(r=>r.id===payload.downgrade_source_price_id),target=rows.find(r=>r.id===payload.downgrade_price_id)
  insist(source&&target&&source.id!==target.id&&source.kind===target.kind&&source.meter_id===target.meter_id&&source.dimensions_json===target.dimensions_json,'downgrade_not_compatible',409)
  const cadence=(price:Record<string,any>)=>JSON.stringify([price.interval_unit??'month',price.interval_count??1,price.billing_timing??'arrears'])
  insist(cadence(source)===cadence(target),'downgrade_not_compatible',409)
  return [...scoped,guard(env,'downgrade_not_compatible',"(SELECT COUNT(*) FROM nc_prices WHERE id IN (?,?) AND status='active')=2",source.id,target.id)]
}

export async function prepareRetentionPolicy(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor)
  const revision = input.text('revision', { max: 100 }), payload = settings(input)
  const id = newId(), by = actorLabel(actor),prices=await validateDowngrade(env,payload)
  await commit(env, [...prices,guard(env, 'policy_changed', `${REVISION}=?`, revision),
    guard(env, 'owner_required', ACTIVE_OWNER, actor.id),
    stmt(env, 'INSERT INTO nc_retention_policies(id,payload_json,base_revision,prepared_by_id,prepared_by,prepared_at) VALUES(?,?,?,?,?,?)', id, JSON.stringify(payload), revision, actor.id, by, now())],
  { actor: by, action: 'retention.policy.prepare', subject: id, detail: { payload, revision } })
  return { request: id, status: 'pending', payload, base_revision: revision }
}

export async function decideRetentionPolicy(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'approve')
  const row = await one(env, 'SELECT * FROM nc_retention_policies WHERE id=?', input.text('request', { max: 100 }))
  insist(row, 'policy_request_not_found', 404)
  insist(row.status === 'pending', 'policy_already_decided', 409)
  const decision = input.text('decision', { max: 10 })
  insist(decision === 'approved' || decision === 'rejected', 'invalid_decision')
  const statements = [guard(env, 'policy_already_decided', "EXISTS(SELECT 1 FROM nc_retention_policies WHERE id=? AND status='pending')", row.id),
    guard(env, 'forbidden', ACTIVE_APPROVER, actor.id)]
  let mode: 'single-approver' | 'two-person' | null = null
  let at = now()
  if (decision === 'approved') {
    statements.push(...await validateDowngrade(env,JSON.parse(row.payload_json)))
    const active = await one(env, ACTIVE)
    // Strictly increasing decision time keeps selection stable even within one millisecond.
    at = Math.max(at, (active?.decided_at ?? 0) + 1)
    const single = row.prepared_by_id === actor.id
    if (single) {
      requireOwner(actor)
      insist(!await one(env, OTHER_APPROVERS, actor.id), 'second_approver_required', 409)
      insist(input.flag('confirm_single'), 'single_confirmation_required', 409)
      statements.push(guard(env, 'second_approver_required', `NOT EXISTS(${OTHER_APPROVERS})`, actor.id))
    }
    mode = single ? 'single-approver' : 'two-person'
    statements.push(guard(env, 'policy_changed', `${REVISION}=?`, row.base_revision),
      guard(env, 'policy_preparer_inactive', ACTIVE_OWNER, row.prepared_by_id))
  }
  const by = actorLabel(actor)
  statements.push(stmt(env, 'UPDATE nc_retention_policies SET status=?,decided_by_id=?,decided_by=?,decided_at=?,approval_mode=? WHERE id=?', decision, actor.id, by, at, mode, row.id))
  await commit(env, statements, { actor: by, action: 'retention.policy.decide', subject: row.id,
    detail: { decision, payload: JSON.parse(row.payload_json), preparedBy: row.prepared_by, baseRevision: row.base_revision, mode } })
  return { request: row.id, status: decision, mode }
}

export async function retentionPolicyHistory(env: Bindings, actor: Actor) {
  requireCapability(actor, 'read')
  const rows = await all(env, 'SELECT * FROM nc_retention_policies ORDER BY prepared_at DESC,id DESC LIMIT 200')
  const policy = await retentionPolicy(env), other = await one(env, OTHER_APPROVERS, actor.id)
  return rows.map(row => ({ ...row, payload: JSON.parse(row.payload_json) as RetentionSettings, payload_json: undefined,
    stale: row.status === 'pending' && row.base_revision !== policy.revision,
    singleAllowed: actor.kind === 'member' && actor.role === 'owner' && row.prepared_by_id === actor.id && !other }))
}
