import type { Bindings } from '../auth.server'
import { actorLabel, requireOwner, type Actor } from './actor'
import { commit, guard, insist, newId, one, parseJson, sha256Hex, stmt } from './core'
import { clockInstant } from './clock'
import type { Input } from './input'
import { requireFreshFactor } from './mfa'
import { PORTAL_LIFETIME, signPortalSession, type PortalClaims } from './portal-session'

function approvedOrigin(env: Bindings, value: string) {
  let url: URL
  try { url = new URL(value) } catch { insist(false, 'invalid_portal_origin') }
  insist(url!.origin === value && !url!.username && !url!.password && !url!.hostname.includes('*') && (url!.protocol === 'https:' || env.AUTH_LOCAL === 'true' && url!.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url!.hostname)), 'invalid_portal_origin')
  return value
}

export async function configurePortal(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor)
  await requireFreshFactor(env, actor)
  const hosts = [...new Set(input.list('hosts').map(value => approvedOrigin(env, value)))], parents = [...new Set(input.list('parents').map(value => approvedOrigin(env, value)))]
  insist(hosts.length <= 20 && parents.length <= 20, 'too_many_portal_origins')
  const revision = newId()
  await commit(env, [stmt(env, 'INSERT INTO nc_portal_policy(singleton,hosts_json,parents_json,revision) VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET hosts_json=excluded.hosts_json,parents_json=excluded.parents_json,revision=excluded.revision', JSON.stringify(hosts), JSON.stringify(parents), revision)], { actor: actorLabel(actor), action: 'portal.configure', subject: revision, detail: { hosts, parents } })
  return { hosts, parents, revision }
}

export async function issuePortalSession(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor)
  await requireFreshFactor(env, actor)
  const customer = await one(env, 'SELECT id FROM nc_customers WHERE id=? AND erased_at IS NULL', input.text('customer', { max: 100 }))
  insist(customer, 'customer_not_found', 404)
  const origin = approvedOrigin(env, input.text('origin', { max: 300 })), audience = input.text('audience', { max: 20 }), parent = input.text('parent', { max: 300, optional: true })
  insist(audience === 'embedded' || audience === 'hosted', 'invalid_portal_audience')
  const policy = await one(env, 'SELECT * FROM nc_portal_policy WHERE singleton=1')
  insist(policy && parseJson<string[]>(policy.hosts_json, []).includes(origin), 'portal_host_not_approved', 403)
  insist(audience === 'embedded' ? parseJson<string[]>(policy.parents_json, []).includes(parent) : parent === '', 'portal_parent_not_approved', 403)
  const iat = clockInstant(env), id = newId(), exp = iat + PORTAL_LIFETIME
  const claims: PortalClaims = { v: 1, iss: env.AUTH_ORIGIN, jti: id, customer: customer.id, origin, audience, parent, iat, exp }
  const token = await signPortalSession(env, claims)
  await commit(env, [guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_portal_policy WHERE singleton=1 AND revision=?) AND EXISTS(SELECT 1 FROM nc_customers WHERE id=? AND erased_at IS NULL)', policy.revision, customer.id), stmt(env, 'INSERT INTO nc_portal_sessions(id,customer_id,token_hash,origin,audience,parent_origin,policy_revision,issued_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)', id, customer.id, await sha256Hex(token), origin, audience, parent, policy.revision, iat, exp)], { actor: actorLabel(actor), action: 'portal.session.issue', subject: id, detail: { customer: customer.id, origin, audience, parent, expiresAt: exp } })
  return { id, token, url: `${origin}/portal?session=${encodeURIComponent(token)}`, expiresAt: exp }
}

export async function revokePortalSession(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor)
  await requireFreshFactor(env, actor)
  const id = input.text('session', { max: 100 })
  insist(await one(env, 'SELECT id FROM nc_portal_sessions WHERE id=?', id), 'session_not_found', 404)
  await commit(env, [stmt(env, 'UPDATE nc_portal_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE id=?', clockInstant(env), id)], { actor: actorLabel(actor), action: 'portal.session.revoke', subject: id })
  return { id, revoked: true }
}
