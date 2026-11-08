// Who is acting: a signed-in member (owner, finance operator, accountant, one
// of the GOV-001 billing roles, or an owner-defined custom role) or an
// application credential held by the owner's agent or metering pipeline.
// Every handler checks a capability before it reads or writes; approvals
// additionally require a member, never a credential.
import { operatorAuth, type Bindings } from '../auth.server'
import { NectarError, insist, newId, now, one, sha256Hex, stmt } from './core'

export const ROLES = ['owner', 'finance', 'accountant', 'collections', 'sales', 'support', 'developer', 'custom'] as const
export type Role = typeof ROLES[number]

/** Record families a scoped role can read one by one (GOV-001); `read` reads them all. */
export const RECORD_FAMILIES = ['customers', 'catalog', 'subscriptions', 'invoices', 'payments', 'reports'] as const
export type RecordFamily = typeof RECORD_FAMILIES[number]

export const CAPABILITIES = ['read', 'records', 'usage', 'approve', 'receivables', 'export', 'propose', 'settings',
  'read.customers', 'read.catalog', 'read.subscriptions', 'read.invoices', 'read.payments', 'read.reports',
  'notes', 'draft', 'credits.limited', 'credentials'] as const
export type Capability = typeof CAPABILITIES[number]

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner: everything, including settings, access and move-in cutover',
  finance: 'Finance operator: records, usage, bill runs, approvals, receivables',
  accountant: 'Accountant: read and export only',
  collections: 'Collections: customers, invoices and payments; allocations, reminders, follow-up tasks and notes',
  sales: 'Sales: customers, catalog and subscriptions; prepares plan changes, amendments and order setups for approval',
  support: "Support: a customer's whole record, notes and credits up to the support limit",
  developer: 'Developer: reads billing and manages agent credentials and outbound webhooks; no financial actions',
  custom: 'Custom: only the capabilities chosen for the role',
}

/** A role as people read it, in the sidebar and on Access. */
export const ROLE_NAMES: Record<Role, string> = { owner: 'Owner', finance: 'Finance', accountant: 'Accountant', collections: 'Collections', sales: 'Sales', support: 'Support', developer: 'Developer', custom: 'Custom' }

export const ROLE_CAPABILITIES: Record<Role, Capability[]> = {
  owner: [...CAPABILITIES],
  finance: ['read', 'records', 'usage', 'approve', 'receivables', 'export', 'propose'],
  accountant: ['read', 'export'],
  collections: ['read.customers', 'read.invoices', 'read.payments', 'receivables', 'notes'],
  sales: ['read.customers', 'read.catalog', 'read.subscriptions', 'draft'],
  support: ['read.customers', 'read.subscriptions', 'read.invoices', 'read.payments', 'notes', 'credits.limited'],
  developer: ['read', 'credentials'],
  custom: [],
}

/** What the owner can combine into a custom role: never settings, access, approvals or credentials. */
export const CUSTOM_CAPABILITIES: Capability[] = ['read.customers', 'read.catalog', 'read.subscriptions', 'read.invoices', 'read.payments', 'read.reports', 'export', 'notes', 'receivables', 'draft', 'credits.limited', 'propose']

/** A member's capabilities, from their preset role or their custom role's saved list. */
export function memberCapabilities(role: Role, custom: string | null | undefined): Set<Capability> {
  if (role !== 'custom') return new Set(ROLE_CAPABILITIES[role])
  return new Set(String(custom ?? '').split(' ').filter((c): c is Capability => CUSTOM_CAPABILITIES.includes(c as Capability)))
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
  /** A custom role's own name; preset roles use ROLE_NAMES. */
  roleName?: string
  /** The operator-auth session behind a member's request; null for a credential. */
  sessionId: string | null
  capabilities: Set<Capability>
  /** A credential's pinned dated API version (DEV-002); members use the latest unless a request names one. */
  apiVersion?: string
}

export const can = (actor: Actor, capability: Capability) => actor.capabilities.has(capability)

/** Full `read` reads every family; a scoped role reads only the families it holds. */
export const canRead = (actor: Actor, family: RecordFamily) => can(actor, 'read') || can(actor, `read.${family}`)

export function requireRead(actor: Actor, family: RecordFamily) {
  insist(canRead(actor, family), 'forbidden', 403)
}

/** At least one of the capabilities, for doors several roles share. */
export function requireAny(actor: Actor, capabilities: Capability[]) {
  insist(capabilities.some(capability => can(actor, capability)), 'forbidden', 403)
}

/** A signed-in person acting on their own settings, whatever their role. */
export function requirePerson(actor: Actor) {
  insist(actor.kind === 'member', 'person_required', 403)
}

export function requireCapability(actor: Actor, capability: Capability) {
  insist(can(actor, capability), 'forbidden', 403)
}

/** Approvals and other decisions belong to a person. */
export function requireMember(actor: Actor, capability: Capability) {
  requireCapability(actor, capability)
  insist(actor.kind === 'member', 'person_required', 403)
}

export const roleName = (actor: Actor | null) => actor?.roleName ?? (actor?.role ? ROLE_NAMES[actor.role] : '')

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
  const managed = await one(env, 'SELECT external_id,active FROM nc_scim_users WHERE operator_id=?', session.operator.id)
  if (managed) {
    const provider = await one(env, 'SELECT 1 FROM oa_provider_sessions p JOIN nc_sso_config c ON c.issuer=p.issuer WHERE p.session_id=? AND p.subject=?', session.id, managed.external_id)
    insist(managed.active && provider, 'provider_required', 401)
  }
  if (session.operator.role === 'owner') await ensureOwnerMember(env, email, session.operator.displayName || email)
  // The role (and a custom role's capabilities) is read on every request, so a
  // change the owner makes applies from the member's next request.
  const member = await one<{ id: string; name: string; role: Role; status: string; custom_name: string | null; custom_capabilities: string | null }>(env,
    'SELECT m.id, m.name, m.role, m.status, r.name AS custom_name, r.capabilities AS custom_capabilities FROM nc_members m LEFT JOIN nc_roles r ON r.id = m.custom_role_id WHERE m.email = ?', email)
  insist(member && member.status === 'active', 'not_a_member', 403)
  const role: Role = session.operator.role === 'owner' ? 'owner' : member.role === 'owner' ? 'finance' : member.role
  return { id: member.id, kind: 'member', name: member.name, email, role, ...(role === 'custom' && member.custom_name ? { roleName: member.custom_name } : {}), sessionId: session.id, capabilities: memberCapabilities(role, member.custom_capabilities) }
}

async function ensureOwnerMember(env: Bindings, email: string, name: string) {
  await env.DB.batch([
    stmt(env, "INSERT INTO nc_members (id, email, name, role, status, created_at, updated_at) VALUES (?, ?, ?, 'owner', 'active', ?, ?) ON CONFLICT(email) DO UPDATE SET role = 'owner', status = 'active'", newId(), email, name, now(), now()),
  ])
}

async function agentActor(env: Bindings, key: string): Promise<Actor> {
  const row = await one<{ id: string; name: string; scopes: string; api_version: string; revoked_at: number | null }>(env, 'SELECT id, name, scopes, api_version, revoked_at FROM nc_agent_keys WHERE key_hash = ?', await sha256Hex(key))
  if (!row || row.revoked_at) throw new NectarError('invalid_credential', 401)
  await env.DB.prepare('UPDATE nc_agent_keys SET last_used_at = ? WHERE id = ?').bind(now(), row.id).run()
  const capabilities = new Set<Capability>(row.scopes.split(' ').flatMap(scope => Object.hasOwn(SCOPES, scope) ? SCOPES[scope as Scope] : []))
  return { id: row.id, kind: 'agent', name: row.name, email: '', role: null, sessionId: null, capabilities, apiVersion: row.api_version }
}
