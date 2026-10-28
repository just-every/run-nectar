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
  const brandName = input.text('brand_name', { optional: true, max: 120 })
  const brandColor = input.text('brand_color', { optional: true, max: 7 }) || '#245c46'
  insist(/^#[0-9a-f]{6}$/i.test(brandColor), 'invalid_portal_brand_color')
  const revision = newId()
  await commit(env, [stmt(env, 'INSERT INTO nc_portal_policy(singleton,hosts_json,parents_json,revision,brand_name,brand_color) VALUES(1,?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET hosts_json=excluded.hosts_json,parents_json=excluded.parents_json,revision=excluded.revision,brand_name=excluded.brand_name,brand_color=excluded.brand_color', JSON.stringify(hosts), JSON.stringify(parents), revision, brandName, brandColor)], { actor: actorLabel(actor), action: 'portal.configure', subject: revision, detail: { hosts, parents, brandName, brandColor } })
  return { hosts, parents, revision, brandName, brandColor }
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
  const prepared = await preparePortalSession(env, { customer: customer.id, origin, audience, parent, policyRevision: policy.revision })
  await commit(env, [guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_portal_policy WHERE singleton=1 AND revision=?) AND EXISTS(SELECT 1 FROM nc_customers WHERE id=? AND erased_at IS NULL)', policy.revision, customer.id), prepared.statement], { actor: actorLabel(actor), action: 'portal.session.issue', subject: prepared.id, detail: { customer: customer.id, origin, audience, parent, expiresAt: prepared.expiresAt } })
  return { id: prepared.id, token: prepared.token, url: prepared.url, expiresAt: prepared.expiresAt }
}

/** Prepares a capability without persisting authority. The caller must commit
 * its current authorization fence and this statement in one atomic batch. */
export async function preparePortalSession(env: Bindings, source: {
  customer: string; origin: string; audience: 'hosted' | 'embedded'; parent: string;
  policyRevision: string; contactId?: string | null; emailHash?: string | null
}) {
  approvedOrigin(env, source.origin)
  const iat = clockInstant(env), id = newId(), exp = iat + PORTAL_LIFETIME
  const claims: PortalClaims = { v: 1, iss: env.AUTH_ORIGIN, jti: id, customer: source.customer, origin: source.origin, audience: source.audience, parent: source.parent, iat, exp }
  const token = await signPortalSession(env, claims)
  const statement = stmt(env, 'INSERT INTO nc_portal_sessions(id,customer_id,token_hash,origin,audience,parent_origin,policy_revision,issued_at,expires_at,contact_id,email_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?)', id, source.customer, await sha256Hex(token), source.origin, source.audience, source.parent, source.policyRevision, iat, exp, source.contactId ?? null, source.emailHash ?? null)
  return { id, token, statement, url: `${source.origin}/portal?session=${encodeURIComponent(token)}`, expiresAt: exp }
}

export async function revokePortalSession(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor)
  await requireFreshFactor(env, actor)
  const id = input.text('session', { max: 100 })
  insist(await one(env, 'SELECT id FROM nc_portal_sessions WHERE id=?', id), 'session_not_found', 404)
  await commit(env, [stmt(env, 'UPDATE nc_portal_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE id=?', clockInstant(env), id)], { actor: actorLabel(actor), action: 'portal.session.revoke', subject: id })
  return { id, revoked: true }
}
