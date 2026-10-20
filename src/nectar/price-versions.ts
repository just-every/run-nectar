// V1 is catalogue setup. A later catalogue version is prepared, then published
// by another person (or explicitly confirmed by the sole owner).
import type { Bindings } from '../auth.server'
import { requireRead, actorLabel, requireMember, requireOwner, type Actor } from './actor'
import { all, commit, guard, insist, newId, now, one, parseJson, stmt, type Row } from './core'
import type { Input } from './input'
import { priceStatements, readPriceDraft } from './price-drafts'

const OTHER_APPROVERS = "SELECT 1 FROM nc_members WHERE status='active' AND role IN ('owner','finance') AND id<>?"

export async function createPrice(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'records')
  const draft = await readPriceDraft(env, input), id = newId()
  if (draft.version === 1) {
    await commit(env, priceStatements(env, actor, draft, id), { actor: actorLabel(actor), action: 'price.create', subject: id, detail: draft })
    return { id, version: 1 }
  }
  await commit(env, [
    guard(env, 'price_request_stale', 'COALESCE((SELECT MAX(version) FROM nc_prices WHERE product_id=?),0)=?', draft.product, draft.version - 1),
    stmt(env, 'INSERT INTO nc_price_requests (id,product_id,version,meter_id,payload_json,prepared_by_id,prepared_by,prepared_at) VALUES (?,?,?,?,?,?,?,?)', id, draft.product, draft.version, draft.meterId, JSON.stringify(draft), actor.id, actorLabel(actor), now()),
  ], { actor: actorLabel(actor), action: 'price.prepare', subject: id, detail: draft })
  return { request: id, status: 'pending', version: draft.version }
}

export async function priceRequests(env: Bindings, actor: Actor): Promise<Row[]> {
  requireRead(actor, 'catalog')
  const rows = await all(env, 'SELECT r.*,p.name AS product_name,COALESCE((SELECT MAX(version) FROM nc_prices WHERE product_id=r.product_id),0) AS current_version FROM nc_price_requests r JOIN nc_products p ON p.id=r.product_id ORDER BY prepared_at DESC,r.id DESC LIMIT 200')
  const other = await one(env, OTHER_APPROVERS, actor.id)
  return rows.map(row => ({ ...row, payload: parseJson<Row>(row.payload_json, {}), payload_json: undefined,
    stale: row.status === 'pending' && row.version !== row.current_version + 1,
    singleAllowed: actor.kind === 'member' && actor.role === 'owner' && row.prepared_by_id === actor.id && !other }))
}

export async function decidePrice(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'approve')
  const row = await one(env, 'SELECT * FROM nc_price_requests WHERE id=?', input.text('request', { max: 100 }))
  insist(row, 'price_request_not_found', 404)
  insist(row.status === 'pending', 'price_already_decided', 409)
  const decision = input.text('decision', { max: 10 })
  insist(decision === 'approved' || decision === 'rejected', 'invalid_decision')
  const at = now(), by = actorLabel(actor)
  const pending = guard(env, 'price_already_decided', "EXISTS(SELECT 1 FROM nc_price_requests WHERE id=? AND status='pending')", row.id)
  if (decision === 'rejected') {
    await commit(env, [pending, stmt(env, "UPDATE nc_price_requests SET status='rejected',decided_by=?,decided_at=? WHERE id=?", by, at, row.id)], { actor: by, action: 'price.reject', subject: row.id })
    return { request: row.id, status: 'rejected' }
  }
  const single = row.prepared_by_id === actor.id
  if (single) {
    requireOwner(actor)
    insist(!await one(env, OTHER_APPROVERS, actor.id), 'second_approver_required', 409)
    insist(input.flag('confirm_single'), 'single_confirmation_required', 409)
  }
  const mode = single ? 'single-approver' : 'two-person', id = newId(), draft = parseJson<Row>(row.payload_json, {})
  await commit(env, [pending,
    guard(env, 'price_preparer_inactive', "EXISTS(SELECT 1 FROM nc_members WHERE id=? AND status='active' AND role IN ('owner','finance'))", row.prepared_by_id),
    guard(env, 'forbidden', "EXISTS(SELECT 1 FROM nc_members WHERE id=? AND status='active' AND role IN ('owner','finance'))", actor.id),
    ...(single ? [guard(env, 'second_approver_required', `NOT EXISTS(${OTHER_APPROVERS})`, actor.id)] : []),
    ...priceStatements(env, actor, draft, id),
    stmt(env, "UPDATE nc_price_requests SET status='published',decided_by=?,decided_at=?,approval_mode=?,price_id=? WHERE id=?", by, at, mode, id, row.id),
  ], [{ actor: by, action: 'price.publish', subject: row.id, detail: { ...draft, price: id, preparedBy: row.prepared_by, mode } },
    { actor: by, action: 'price.create', subject: id, detail: { request: row.id, version: draft.version, mode } }])
  return { id, version: draft.version, request: row.id, status: 'published', mode }
}
