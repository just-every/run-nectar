// Owner-prepared policy changes: saved exact values, separate confirmation,
// revision guards and an explicit, audited single-owner confirmation path.
import type { Bindings } from '../auth.server'
import { actorLabel, requireCapability, requireMember, requireOwner, type Actor } from './actor'
import { all, commit, guard, insist, newId, now, one, parseJson, stmt, type Row } from './core'
import type { Input } from './input'
import { requireFreshFactor } from './mfa'

type Kind = 'credit' | 'certificate' | 'tax' | 'lifecycle' | 'feature' | 'usage'
const TABLES: Record<Kind, string> = { credit: 'nc_credit_policy', certificate: 'nc_certificate_policy', tax: 'nc_business', lifecycle: 'nc_lifecycle_policy', feature: 'nc_feature_policy_revision', usage: 'nc_usage_policy' }
const revisionSQL = (kind: Kind) => `COALESCE((SELECT revision FROM ${TABLES[kind]} WHERE singleton=1),0)`
const OTHER_APPROVERS = "SELECT 1 FROM nc_members WHERE status='active' AND role IN ('owner','finance') AND id<>?"

export async function preparePolicyChange(env: Bindings, actor: Actor, kind: Kind, payload: Row) {
  requireOwner(actor)
  const revision = (await one(env, `SELECT ${revisionSQL(kind)} AS revision`))!.revision
  const id = newId()
  await commit(env, [guard(env, 'policy_changed', `${revisionSQL(kind)}=?`, revision),
    stmt(env, 'INSERT INTO nc_policy_changes (id,kind,payload_json,base_revision,prepared_by_id,prepared_by,prepared_at) VALUES (?,?,?,?,?,?,?)', id, kind, JSON.stringify(payload), revision, actor.id, actorLabel(actor), now())],
  { actor: actorLabel(actor), action: 'policy.prepare', subject: id, detail: { kind, payload, revision } })
  return { request: id, status: 'pending', kind, payload }
}

export async function policySettings(env: Bindings, actor: Actor) {
  requireCapability(actor, 'read')
  const credit = await one(env, 'SELECT two_person_above_cents,support_limit_cents,balance_application,revision FROM nc_credit_policy WHERE singleton=1')
  const usage = await one(env,'SELECT disposition,revision FROM nc_usage_policy WHERE singleton=1')
  const certificate = await one(env, 'SELECT enabled,revision FROM nc_certificate_policy WHERE singleton=1')
  return { usageDisposition:usage?.disposition??'next_invoice',usagePolicyRevision:usage?.revision??0,creditLimitCents: credit?.two_person_above_cents ?? null, supportLimitCents: credit?.support_limit_cents ?? 0, balanceApplication: credit?.balance_application ?? 'manual', creditRevision: credit?.revision ?? 0,
    certificateRemindersEnabled: !!certificate?.enabled, certificateRevision: certificate?.revision ?? 0 }
}

export async function policyChanges(env: Bindings, actor: Actor) {
  requireCapability(actor, 'read')
  const rows = await all(env, 'SELECT * FROM nc_policy_changes ORDER BY prepared_at DESC,id DESC LIMIT 200')
  const other = await one(env, OTHER_APPROVERS, actor.id)
  const revisions = (await one(env, `SELECT ${revisionSQL('credit')} AS credit,${revisionSQL('certificate')} AS certificate,${revisionSQL('tax')} AS tax,${revisionSQL('lifecycle')} AS lifecycle,${revisionSQL('feature')} AS feature,${revisionSQL('usage')} AS usage`))!
  const result: Row[] = []
  for (const row of rows) result.push({ ...row, payload: parseJson<Row>(row.payload_json, {}), payload_json: undefined,
    stale: row.status === 'pending' && row.base_revision !== revisions[row.kind],
    singleAllowed: actor.kind === 'member' && actor.role === 'owner' && row.prepared_by_id === actor.id && !other })
  return result
}

export async function decidePolicyChange(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'approve')
  const row = await one(env, 'SELECT * FROM nc_policy_changes WHERE id=?', input.text('request', { max: 100 }))
  insist(row, 'policy_request_not_found', 404)
  insist(row.status === 'pending', 'policy_already_decided', 409)
  const decision = input.text('decision', { max: 10 })
  insist(decision === 'approved' || decision === 'rejected', 'invalid_decision')
  const at = now(), by = actorLabel(actor)
  const pending = guard(env, 'policy_already_decided', "EXISTS(SELECT 1 FROM nc_policy_changes WHERE id=? AND status='pending')", row.id)
  if (decision === 'rejected') {
    await commit(env, [pending, stmt(env, "UPDATE nc_policy_changes SET status='rejected',decided_by_id=?,decided_by=?,decided_at=? WHERE id=?", actor.id, by, at, row.id)],
      { actor: by, action: 'policy.reject', subject: row.id, detail: { kind: row.kind } })
    return { request: row.id, status: 'rejected' }
  }
  const single = row.prepared_by_id === actor.id
  if (single) {
    requireOwner(actor)
    insist(!await one(env, OTHER_APPROVERS, actor.id), 'second_approver_required', 409)
    insist(input.flag('confirm_single'), 'single_confirmation_required', 409)
  }
  const mode = single ? 'single-approver' : 'two-person'
  const kind = row.kind as Kind, payload = parseJson<Row>(row.payload_json, {})
  const statements = [pending,
    guard(env, 'policy_changed', `${revisionSQL(kind)}=?`, row.base_revision),
    guard(env, 'policy_preparer_inactive', "EXISTS(SELECT 1 FROM nc_members WHERE id=? AND status='active' AND role='owner')", row.prepared_by_id),
    guard(env, 'forbidden', "EXISTS(SELECT 1 FROM nc_members WHERE id=? AND status='active' AND role IN ('owner','finance'))", actor.id),
    ...(single ? [guard(env, 'second_approver_required', `NOT EXISTS(${OTHER_APPROVERS})`, actor.id)] : []),
  ]
  if (kind === 'credit') {
    // GOV-007: approving a new support credit limit also asks for a fresh factor.
    const current = await one(env, 'SELECT support_limit_cents FROM nc_credit_policy WHERE singleton=1')
    const support = payload.supportLimitCents ?? current?.support_limit_cents ?? 0
    if (support !== (current?.support_limit_cents ?? 0)) await requireFreshFactor(env, actor)
    statements.push(stmt(env, 'INSERT INTO nc_credit_policy (singleton,two_person_above_cents,support_limit_cents,balance_application,revision,changed_by,changed_at) VALUES (1,?,?,?,1,?,?) ON CONFLICT(singleton) DO UPDATE SET two_person_above_cents=excluded.two_person_above_cents,support_limit_cents=excluded.support_limit_cents,balance_application=excluded.balance_application,revision=revision+1,changed_by=excluded.changed_by,changed_at=excluded.changed_at', payload.twoPersonAboveCents, support, payload.balanceApplication ?? (await one(env, 'SELECT balance_application FROM nc_credit_policy WHERE singleton=1'))?.balance_application ?? 'manual', row.prepared_by, at))
  }
  if (kind === 'certificate') statements.push(stmt(env, 'INSERT INTO nc_certificate_policy (singleton,enabled,revision,changed_by,changed_at) VALUES (1,?,1,?,?) ON CONFLICT(singleton) DO UPDATE SET enabled=excluded.enabled,revision=revision+1,changed_by=excluded.changed_by,changed_at=excluded.changed_at', payload.enabled ? 1 : 0, row.prepared_by, at))
  if (kind === 'lifecycle') statements.push(stmt(env, 'INSERT INTO nc_lifecycle_policy (singleton,credit_unused,reactivation_days,proration_policy,revision,changed_by,changed_at) VALUES (1,?,?,?,1,?,?) ON CONFLICT(singleton) DO UPDATE SET credit_unused=excluded.credit_unused,reactivation_days=excluded.reactivation_days,proration_policy=excluded.proration_policy,revision=revision+1,changed_by=excluded.changed_by,changed_at=excluded.changed_at', payload.creditUnused ? 1 : 0, payload.reactivationDays,payload.prorationPolicy??(await one(env,'SELECT proration_policy FROM nc_lifecycle_policy WHERE singleton=1'))?.proration_policy??null,row.prepared_by, at))
  if (kind === 'feature') {
    await requireFreshFactor(env, actor)
    statements.push(stmt(env, `INSERT INTO nc_feature_policies(product_id,feature,meter_id,quota,quota_policy,grace_days,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(product_id,feature) DO UPDATE SET meter_id=excluded.meter_id,quota=excluded.quota,
      quota_policy=excluded.quota_policy,grace_days=excluded.grace_days,revision=revision+1,updated_at=excluded.updated_at`,
      payload.product,payload.feature,payload.meter,payload.quota,payload.policy,payload.graceDays,at),
      stmt(env, 'UPDATE nc_feature_policy_revision SET revision=revision+1 WHERE singleton=1'))
  }
  if (kind === 'usage') statements.push(stmt(env, 'UPDATE nc_usage_policy SET disposition=?,revision=revision+1 WHERE singleton=1', payload.disposition))
  if (kind === 'tax') statements.push(stmt(env, 'UPDATE nc_business SET tax_jurisdiction=?,tax_mode=?,tax_rate=?,tax_note=?,tax_reviewed_by=NULL,tax_reviewed_at=NULL,revision=revision+1,updated_at=? WHERE singleton=1', payload.jurisdiction, payload.mode, payload.rate, payload.note, at))
  statements.push(stmt(env, "UPDATE nc_policy_changes SET status='applied',decided_by_id=?,decided_by=?,decided_at=?,approval_mode=? WHERE id=?", actor.id, by, at, mode, row.id))
  await commit(env, statements, { actor: by, action: 'policy.apply', subject: row.id, detail: { kind, payload, preparedBy: row.prepared_by, mode } })
  return { request: row.id, status: 'applied', mode }
}
