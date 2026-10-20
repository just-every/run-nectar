// Access: the owner gives finance operators and accountants sign-in access
// (Base operator-auth invitations), ends it, and issues or revokes scoped
// application credentials for an agent or metering pipeline.
import { operatorAuth, type Bindings } from '../auth.server'
import { ROLES, SCOPES, actorLabel, requireOwner, type Actor, type Role, type Scope } from './actor'
import { LATEST_VERSION, checkVersion } from './api-versions'
import { all, commit, insist, newId, now, one, sha256Hex, stmt } from './core'
import type { Input } from './input'

export async function members(env: Bindings, actor: Actor) {
  requireOwner(actor)
  return await all<{ id: string; email: string; name: string; role: Role; status: string; created_at: number }>(env, 'SELECT id, email, name, role, status, created_at FROM nc_members ORDER BY status, name')
}

export async function agentKeys(env: Bindings, actor: Actor) {
  requireOwner(actor)
  return await all(env, 'SELECT id, name, scopes, api_version, created_by, created_at, last_used_at, revoked_at FROM nc_agent_keys ORDER BY created_at DESC')
}

async function operatorByEmail(env: Bindings, request: Request, email: string) {
  return (await operatorAuth(env).listOperators(request)).find(operator => operator.email.toLowerCase() === email) ?? null
}

export async function giveAccess(env: Bindings, actor: Actor, input: Input, request: Request) {
  requireOwner(actor)
  const email = input.text('email', { max: 200 }).toLowerCase()
  insist(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 'invalid_email')
  const name = input.text('name', { max: 120 })
  const role = input.text('role', { max: 20 }) as Role
  insist(ROLES.includes(role) && role !== 'owner', 'invalid_role')
  const existing = await one(env, 'SELECT * FROM nc_members WHERE email = ?', email)
  insist(!existing || existing.status === 'ended', 'already_has_access', 409)
  const auth = operatorAuth(env), operator = await operatorByEmail(env, request, email)
  insist(operator?.role !== 'owner', 'already_has_access', 409)
  if (!operator) await auth.invite(request, { email, displayName: name, role: 'member', returnTo: '/app' })
  else if (operator.status === 'inactive') await auth.setOperatorStatus(request, operator.id, 'active')
  const id = existing?.id ?? newId()
  await commit(env, [existing
    ? stmt(env, "UPDATE nc_members SET name = ?, role = ?, status = 'active', updated_at = ? WHERE id = ?", name, role, now(), id)
    : stmt(env, "INSERT INTO nc_members (id, email, name, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)", id, email, name, role, now(), now())],
  { actor: actorLabel(actor), action: 'access.give', subject: id, detail: { email, role, invited: !operator } })
  return { id, email, role }
}

export async function endAccess(env: Bindings, actor: Actor, input: Input, request: Request) {
  requireOwner(actor)
  const member = await one(env, 'SELECT * FROM nc_members WHERE id = ?', input.text('member', { max: 100 }))
  insist(member, 'member_not_found', 404)
  insist(member.role !== 'owner', 'owner_access_fixed', 409)
  insist(member.status === 'active', 'no_access_to_end', 409)
  const auth = operatorAuth(env), operator = await operatorByEmail(env, request, member.email)
  if (operator && operator.status === 'active') {
    await auth.setOperatorStatus(request, operator.id, 'inactive')
    for (const session of await auth.listSessions(request, operator.id)) if (session.active) await auth.revokeSession(request, session.id)
  }
  await commit(env, [stmt(env, "UPDATE nc_members SET status = 'ended', updated_at = ? WHERE id = ?", now(), member.id)], { actor: actorLabel(actor), action: 'access.end', subject: member.id })
  return { id: member.id, status: 'ended' }
}

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** Issues a credential. The key is returned once and only its hash is stored. */
export async function issueKey(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor)
  const name = input.text('name', { max: 80 })
  const scopes = input.list('scopes')
  insist(scopes.length > 0 && scopes.every(scope => scope in SCOPES), 'invalid_scopes')
  const version = checkVersion(input.text('api_version', { optional: true, max: 20 }) || LATEST_VERSION)
  const key = `nectar_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`
  const id = newId()
  await commit(env, [stmt(env, 'INSERT INTO nc_agent_keys (id, name, key_hash, scopes, api_version, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, name, await sha256Hex(key), [...new Set(scopes)].sort().join(' '), version, actorLabel(actor), now())],
    { actor: actorLabel(actor), action: 'credential.issue', subject: id, detail: { name, scopes, api_version: version } })
  return { id, name, scopes: scopes as Scope[], api_version: version, key }
}

export async function revokeKey(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor)
  const id = input.text('key', { max: 100 })
  const row = await one(env, 'SELECT id, revoked_at FROM nc_agent_keys WHERE id = ?', id)
  insist(row, 'credential_not_found', 404)
  insist(!row.revoked_at, 'already_revoked', 409)
  await commit(env, [stmt(env, 'UPDATE nc_agent_keys SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL', now(), actorLabel(actor), id)], { actor: actorLabel(actor), action: 'credential.revoke', subject: id })
  return { id, revoked: true }
}

/** Repins a live credential to another dated API version (DEV-002); its next request uses it. */
export async function pinKeyVersion(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor)
  const id = input.text('key', { max: 100 })
  const version = checkVersion(input.text('api_version', { max: 20 }))
  const row = await one(env, 'SELECT id, api_version, revoked_at FROM nc_agent_keys WHERE id = ?', id)
  insist(row, 'credential_not_found', 404)
  insist(!row.revoked_at, 'already_revoked', 409)
  await commit(env, [stmt(env, 'UPDATE nc_agent_keys SET api_version = ? WHERE id = ? AND revoked_at IS NULL', version, id)], { actor: actorLabel(actor), action: 'credential.version', subject: id, detail: { from: row.api_version, to: version } })
  return { id, api_version: version }
}
