// Who is acting: a signed-in member (owner, finance operator or read-only
// accountant) or an application credential held by the owner's agent or
// metering pipeline. Every handler checks a capability before it reads or
// writes; approvals additionally require a member, never a credential.
import { operatorAuth, type Bindings } from '../auth.server'
import { NectarError, insist, newId, now, one, sha256Hex, stmt } from './core'

export const ROLES = ['owner', 'finance', 'accountant'] as const
export type Role = typeof ROLES[number]

export const CAPABILITIES = ['read', 'records', 'usage', 'approve', 'receivables', 'export', 'propose', 'settings'] as const
export type Capability = typeof CAPABILITIES[number]

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner: everything, including settings, access and move-in cutover',
  finance: 'Finance operator: records, usage, bill runs, approvals, receivables',
  accountant: 'Accountant: read and export only',
}

/** A role as people read it, in the sidebar and on Access. */
export const ROLE_NAMES: Record<Role, string> = { owner: 'Owner', finance: 'Finance', accountant: 'Accountant' }

export const ROLE_CAPABILITIES: Record<Role, Capability[]> = {
  owner: [...CAPABILITIES],
  finance: ['read', 'records', 'usage', 'approve', 'receivables', 'export', 'propose'],
  accountant: ['read', 'export'],
}

/** Credential scopes: `prepare` reads and proposes; `usage` submits usage events. Neither approves. */
export const SCOPES = { prepare: ['read', 'propose'], usage: ['usage'] } as const satisfies Record<string, Capability[]>
export type Scope = keyof typeof SCOPES

export interface Actor {
  id: string
  kind: 'member' | 'agent'
  name: string
  email: string
  role: Role | null
  /** The operator-auth session behind a member's request; null for a credential. */
  sessionId: string | null
  capabilities: Set<Capability>
}

export const can = (actor: Actor, capability: Capability) => actor.capabilities.has(capability)

export function requireCapability(actor: Actor, capability: Capability) {
  insist(can(actor, capability), 'forbidden', 403)
}

/** Approvals and other decisions belong to a person. */
export function requireMember(actor: Actor, capability: Capability) {
  requireCapability(actor, capability)
  insist(actor.kind === 'member', 'person_required', 403)
}

export function requireOwner(actor: Actor) {
  insist(actor.kind === 'member' && actor.role === 'owner', 'owner_required', 403)
}

export const actorLabel = (actor: Actor) => actor.kind === 'agent' ? `agent:${actor.name}` : actor.email

export async function currentActor(env: Bindings, request: Request): Promise<Actor | null> {
  const bearer = request.headers.get('authorization')?.match(/^Bearer (nectar_[A-Za-z0-9_-]{20,100})$/)?.[1]
  if (bearer) return await agentActor(env, bearer)
  const session = await operatorAuth(env).getSession(request)
  if (!session) return null
  const email = session.operator.email.toLowerCase()
  if (session.operator.role === 'owner') await ensureOwnerMember(env, email, session.operator.displayName || email)
  const member = await one<{ id: string; name: string; role: Role; status: string }>(env, 'SELECT id, name, role, status FROM nc_members WHERE email = ?', email)
  insist(member && member.status === 'active', 'not_a_member', 403)
  const role: Role = session.operator.role === 'owner' ? 'owner' : member.role === 'owner' ? 'finance' : member.role
  return { id: member.id, kind: 'member', name: member.name, email, role, sessionId: session.id, capabilities: new Set(ROLE_CAPABILITIES[role]) }
}

async function ensureOwnerMember(env: Bindings, email: string, name: string) {
  await env.DB.batch([
    stmt(env, "INSERT INTO nc_members (id, email, name, role, status, created_at, updated_at) VALUES (?, ?, ?, 'owner', 'active', ?, ?) ON CONFLICT(email) DO UPDATE SET role = 'owner', status = 'active'", newId(), email, name, now(), now()),
  ])
}

async function agentActor(env: Bindings, key: string): Promise<Actor> {
  const row = await one<{ id: string; name: string; scopes: string; revoked_at: number | null }>(env, 'SELECT id, name, scopes, revoked_at FROM nc_agent_keys WHERE key_hash = ?', await sha256Hex(key))
  if (!row || row.revoked_at) throw new NectarError('invalid_credential', 401)
  await env.DB.prepare('UPDATE nc_agent_keys SET last_used_at = ? WHERE id = ?').bind(now(), row.id).run()
  const capabilities = new Set<Capability>(row.scopes.split(' ').flatMap(scope => SCOPES[scope as Scope] ?? []))
  return { id: row.id, kind: 'agent', name: row.name, email: '', role: null, sessionId: null, capabilities }
}
