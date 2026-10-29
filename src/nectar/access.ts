// Access: the owner gives members sign-in access (Base operator-auth
// invitations) in a preset or custom role, defines custom roles from explicit
// capabilities (GOV-001), ends access, and the owner or a developer issues or
// revokes scoped application credentials for an agent or metering pipeline.
import { operatorAuth, type Bindings } from '../auth.server'
import { CUSTOM_CAPABILITIES, ROLES, SCOPES, actorLabel, requireCapability, requireOwner, type Actor, type Capability, type Role, type Scope } from './actor'
import { LATEST_VERSION, checkVersion } from './api-versions'
import { all, commit, guard, insist, newId, now, one, sha256Hex, stmt } from './core'
import type { Input } from './input'
import { requireFreshFactor } from './mfa'

export async function members(env: Bindings, actor: Actor) {
  requireOwner(actor)
  return await all<{ id: string; email: string; name: string; role: Role; custom_role_id: string | null; custom_role: string | null; status: string; created_at: number }>(env,
    'SELECT m.id, m.email, m.name, m.role, m.custom_role_id, r.name AS custom_role, m.status, m.created_at FROM nc_members m LEFT JOIN nc_roles r ON r.id = m.custom_role_id ORDER BY m.status, m.name')
}

/** The owner's custom roles with the capabilities each one holds now. */
export async function customRoles(env: Bindings, actor: Actor) {
  requireOwner(actor)
  return (await all<{ id: string; name: string; capabilities: string; revision: number; updated_by: string; updated_at: number }>(env,
    'SELECT id, name, capabilities, revision, updated_by, updated_at FROM nc_roles ORDER BY lower(name)')).map(role => ({ ...role, capabilities: role.capabilities.split(' ') }))
}

function chosenCapabilities(input: Input): Capability[] {
  const chosen = [...new Set(input.list('capabilities'))].sort() as Capability[]
  insist(chosen.length > 0 && chosen.every(c => CUSTOM_CAPABILITIES.includes(c)), 'invalid_capabilities')
  return chosen
}

/** GOV-001: a custom role is a named, explicit capability list. */
export async function defineRole(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor)
  await requireFreshFactor(env, actor)
  input.only(['name', 'capabilities', 'returnTo'])
  const name = input.text('name', { max: 60 }).trim()
  insist(name.length > 0, 'invalid_name')
  const capabilities = chosenCapabilities(input)
  insist(!await one(env, 'SELECT 1 FROM nc_roles WHERE lower(name) = lower(?)', name), 'role_exists', 409)
  const id = newId(), at = now(), by = actorLabel(actor)
  await commit(env, [stmt(env, 'INSERT INTO nc_roles (id, name, capabilities, revision, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)', id, name, capabilities.join(' '), by, at, by, at)],
    { actor: by, action: 'role.define', subject: id, detail: { name, capabilities } })
  return { id, name, capabilities, revision: 1 }
}

/** Changes apply to every member holding the role from their next request. */
export async function updateRole(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor)
  await requireFreshFactor(env, actor)
  input.only(['role', 'revision', 'capabilities', 'returnTo'])
  const role = await one(env, 'SELECT * FROM nc_roles WHERE id = ?', input.text('role', { max: 100 }))
  insist(role, 'role_not_found', 404)
  const revision = input.integer('revision', { min: 1, max: Number.MAX_SAFE_INTEGER - 1 })
  insist(revision !== null, 'invalid_revision')
  insist(revision === role.revision, 'stale', 409)
  const capabilities = chosenCapabilities(input)
  await commit(env, [guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_roles WHERE id = ? AND revision = ?)', role.id, revision),
    stmt(env, 'UPDATE nc_roles SET capabilities = ?, revision = revision + 1, updated_by = ?, updated_at = ? WHERE id = ?', capabilities.join(' '), actorLabel(actor), now(), role.id)],
  { actor: actorLabel(actor), action: 'role.update', subject: role.id, detail: { name: role.name, from: String(role.capabilities).split(' '), to: capabilities, revision: revision + 1 } })
  return { id: role.id, name: role.name, capabilities, revision: revision + 1 }
}

export async function agentKeys(env: Bindings, actor: Actor) {
  requireCapability(actor, 'credentials')
  return await all(env, 'SELECT id, name, scopes, api_version, created_by, created_at, last_used_at, revoked_at FROM nc_agent_keys ORDER BY created_at DESC')
}

async function operatorByEmail(env: Bindings, request: Request, email: string) {
  return (await operatorAuth(env).listOperators(request)).find(operator => operator.email.toLowerCase() === email) ?? null
}

export async function giveAccess(env: Bindings, actor: Actor, input: Input, request: Request) {
  requireOwner(actor)
  await requireFreshFactor(env, actor)
  const email = input.text('email', { max: 200 }).toLowerCase()
  insist(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 'invalid_email')
  const name = input.text('name', { max: 120 })
  const role = input.text('role', { max: 20 }) as Role
  insist(ROLES.includes(role) && role !== 'owner', 'invalid_role')
  const custom = role === 'custom' ? await one(env, 'SELECT id, name FROM nc_roles WHERE id = ?', input.text('custom_role', { max: 100 })) : null
  insist(role !== 'custom' || custom, 'role_not_found', 404)
  const customId = custom?.id ?? null
  const existing = await one(env, 'SELECT * FROM nc_members WHERE email = ?', email)
  insist(!existing || existing.status === 'ended', 'already_has_access', 409)
  const auth = operatorAuth(env), operator = await operatorByEmail(env, request, email)
  insist(operator?.role !== 'owner', 'already_has_access', 409)
  if (!operator) await auth.invite(request, { email, displayName: name, role: 'member', returnTo: '/app' })
  else if (operator.status === 'inactive') await auth.setOperatorStatus(request, operator.id, 'active')
  const id = existing?.id ?? newId()
  const identity = await one(env, 'SELECT id FROM oa_operators WHERE email=?', email)
  insist(identity, 'native_operator_required', 409)
  insist(!existing?.operator_id || existing.operator_id === identity.id, 'native_binding_mismatch', 409)
  await commit(env, [existing
    ? stmt(env, "UPDATE nc_members SET name = ?, role = ?, custom_role_id = ?, operator_id = ?, status = 'active', updated_at = ? WHERE id = ?", name, role, customId, identity.id, now(), id)
    : stmt(env, "INSERT INTO nc_members (id, email, name, role, custom_role_id, operator_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)", id, email, name, role, customId, identity.id, now(), now())],
  { actor: actorLabel(actor), action: 'access.give', subject: id, detail: { email, role, ...(custom ? { customRole: custom.name } : {}), invited: !operator } })
  return { id, email, role, ...(customId ? { custom_role: customId } : {}) }
}

export async function endAccess(env: Bindings, actor: Actor, input: Input, request: Request) {
  requireOwner(actor)
  await requireFreshFactor(env, actor)
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

/** The owner, or a developer (GOV-001); credentials never approve or move money. */
function requireMemberCredentials(actor: Actor) {
  requireCapability(actor, 'credentials')
  insist(actor.kind === 'member', 'person_required', 403)
}

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** Issues a credential. The key is returned once and only its hash is stored. */
export async function issueKey(env: Bindings, actor: Actor, input: Input) {
  requireMemberCredentials(actor)
  await requireFreshFactor(env, actor)
  const name = input.text('name', { max: 80 })
  const scopes = input.list('scopes')
  insist(scopes.length > 0 && scopes.every(scope => Object.hasOwn(SCOPES, scope)), 'invalid_scopes')
  const version = checkVersion(input.text('api_version', { optional: true, max: 20 }) || LATEST_VERSION)
  const key = `nectar_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`
  const id = newId()
  await commit(env, [stmt(env, 'INSERT INTO nc_agent_keys (id, name, key_hash, scopes, api_version, created_by, created_at, sponsor_member_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, name, await sha256Hex(key), [...new Set(scopes)].sort().join(' '), version, actorLabel(actor), now(), actor.id)],
    { actor: actorLabel(actor), action: 'credential.issue', subject: id, detail: { name, scopes, api_version: version } })
  return { id, name, scopes: scopes as Scope[], api_version: version, key }
}

export async function revokeKey(env: Bindings, actor: Actor, input: Input) {
  requireMemberCredentials(actor)
  await requireFreshFactor(env, actor)
  const id = input.text('key', { max: 100 })
  const row = await one(env, 'SELECT id, revoked_at FROM nc_agent_keys WHERE id = ?', id)
  insist(row, 'credential_not_found', 404)
  insist(!row.revoked_at, 'already_revoked', 409)
  await commit(env, [stmt(env, 'UPDATE nc_agent_keys SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL', now(), actorLabel(actor), id)], { actor: actorLabel(actor), action: 'credential.revoke', subject: id })
  return { id, revoked: true }
}

/** Repins a live credential to another dated API version (DEV-002); its next request uses it. */
export async function pinKeyVersion(env: Bindings, actor: Actor, input: Input) {
  requireMemberCredentials(actor)
  await requireFreshFactor(env, actor)
  const id = input.text('key', { max: 100 })
  const version = checkVersion(input.text('api_version', { max: 20 }))
  const row = await one(env, 'SELECT id, api_version, revoked_at FROM nc_agent_keys WHERE id = ?', id)
  insist(row, 'credential_not_found', 404)
  insist(!row.revoked_at, 'already_revoked', 409)
  await commit(env, [stmt(env, 'UPDATE nc_agent_keys SET api_version = ? WHERE id = ? AND revoked_at IS NULL', version, id)], { actor: actorLabel(actor), action: 'credential.version', subject: id, detail: { from: row.api_version, to: version } })
  return { id, api_version: version }
}
