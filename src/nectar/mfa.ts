// GOV-007: required multi-factor sign-in. The owner requires a second factor
// installation-wide or for chosen roles; members enroll an authenticator app
// (TOTP, its secret sealed under MFA_KEY) or a passkey and get one-time
// recovery codes. A covered member is held at every door until a factor is
// enrolled and presented in the current session, and the sensitive actions
// below ask again once the last check is older than 15 minutes.
import { operatorAuth, type Bindings } from '../auth.server'
import branding from '../branding.json'
import { actorLabel, requireOwner, ROLES, type Actor, type Role } from './actor'
import { clockInstant } from './clock'
import { all, commit, insist, newId, NectarError, now, one, stmt } from './core'
import type { Input } from './input'
import { b64url, base32, matchTotp, recoveryCode, recoveryHash, RECOVERY_CODES, seal, unseal } from './mfa-crypto'
import { verifyAssertion, verifyRegistration } from './webauthn'

/** A check older than this (strictly) is asked again before a sensitive action. */
export const STEP_UP_MS = 15 * 60 * 1000
/** "Chosen roles" defaults to every role that can credit, issue invoices, change prices, manage access or credentials, or cut over a move-in. */
export const DEFAULT_ROLES: Role[] = ['owner', 'finance']
const CHALLENGE_MS = 5 * 60 * 1000
const LOCK_FAILURES = 5, LOCK_MS = 15 * 60 * 1000

/** Actions a held member may still use: enrolling and presenting their own factor. */
export const SELF_SERVICE = ['mfa.totp.start', 'mfa.totp.confirm', 'mfa.verify', 'mfa.passkey.options', 'mfa.passkey.register', 'mfa.passkey.verify']

export interface Policy { scope: 'off' | 'roles' | 'all'; roles: Role[] }

export async function mfaPolicy(env: Bindings): Promise<Policy> {
  const row = await one<{ scope: Policy['scope']; roles: string }>(env, 'SELECT scope, roles FROM nc_mfa_policy WHERE singleton = 1')
  return { scope: row?.scope ?? 'off', roles: (row?.roles ?? '').split(' ').filter(Boolean) as Role[] }
}

const covers = (policy: Policy, role: Role | null) => !!role && (policy.scope === 'all' || (policy.scope === 'roles' && policy.roles.includes(role)))

type Factor = { id: string; kind: 'totp' | 'passkey'; label: string; status: string; sealed_secret: string | null; last_step: number; credential_id: string | null; public_key: string | null; sign_count: number; created_at: number }

export const KEY_REASONS: Record<string, string> = {
  mfa_key_missing: 'Your authenticator app was sealed under this installation’s MFA key, and this copy has no MFA key (for example, it was restored without it). Enroll a factor again.',
  mfa_key_changed: 'Your authenticator app was sealed under an MFA key this copy does not hold (for example, it was restored without that key). Enroll a factor again.',
}

/** Where a member stands: whether a factor is required, which factors still work, and the current session's last check. */
export async function standing(env: Bindings, actor: Actor) {
  const policy = await mfaPolicy(env)
  const factors = await all<Factor>(env, "SELECT * FROM nc_mfa_factors WHERE member_id = ? AND status = 'active' ORDER BY created_at", actor.id)
  const usable: Factor[] = [], unreadable: Factor[] = []
  for (const factor of factors) (factor.kind === 'passkey' || await unseal(env.MFA_KEY, factor.sealed_secret!, binding(factor.id, actor.id)) ? usable : unreadable).push(factor)
  const session = actor.sessionId ? await one<{ verified_at: number }>(env, 'SELECT verified_at FROM nc_mfa_sessions WHERE session_id = ? AND member_id = ?', actor.sessionId, actor.id) : null
  const required = covers(policy, actor.role)
  const reason = !usable.length && unreadable.length ? (env.MFA_KEY ? 'mfa_key_changed' : 'mfa_key_missing') : null
  const state: 'enroll' | 'verify' | null = !required ? null : !usable.length ? 'enroll' : !session ? 'verify' : null
  return { policy, required, usable, unreadable, verifiedAt: session?.verified_at ?? null, state, reason }
}

/** The hold on a covered member, or null when every door is open to them. */
export async function mfaHold(env: Bindings, actor: Actor) {
  if (actor.kind !== 'member') return null
  const { state, reason } = await standing(env, actor)
  return state ? { state, code: state === 'enroll' ? 'mfa_enrollment_required' : 'mfa_required', reason } : null
}

/**
 * Credits, credential changes, access changes and the move-in cutover ask for
 * the factor again when the session's last check is older than 15 minutes.
 * Agent and application credentials can never perform them.
 */
export async function requireFreshFactor(env: Bindings, actor: Actor) {
  insist(actor.kind === 'member', 'person_required', 403)
  const { required, verifiedAt } = await standing(env, actor)
  if (!required) return
  insist(verifiedAt !== null && clockInstant(env) - verifiedAt <= STEP_UP_MS, 'mfa_step_up_required', 403)
}

const binding = (factor: string, member: string) => `${factor}:${member}`
const label = (input: Input, fallback: string) => input.text('label', { optional: true, max: 80 }) || fallback
const requireMemberActor = (actor: Actor) => insist(actor.kind === 'member' && actor.sessionId, 'person_required', 403)

/** Adding a factor beside a working one needs this session to have presented it. */
async function requireEnrollable(env: Bindings, actor: Actor) {
  requireMemberActor(actor)
  const { usable, verifiedAt } = await standing(env, actor)
  insist(!usable.length || verifiedAt !== null, 'mfa_required', 403)
}

const markSession = (env: Bindings, actor: Actor, method: string) =>
  stmt(env, 'INSERT INTO nc_mfa_sessions (session_id, member_id, verified_at, method) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET verified_at = excluded.verified_at, method = excluded.method', actor.sessionId, actor.id, clockInstant(env), method)

async function recoveryStatements(env: Bindings, actor: Actor) {
  const left = await one<{ n: number }>(env, 'SELECT COUNT(*) AS n FROM nc_mfa_recovery WHERE member_id = ? AND used_at IS NULL', actor.id)
  if (left!.n > 0) return { codes: null, statements: [] }
  const codes = Array.from({ length: RECOVERY_CODES }, recoveryCode)
  return { codes, statements: [stmt(env, 'DELETE FROM nc_mfa_recovery WHERE member_id = ?', actor.id), ...await Promise.all(codes.map(async code => stmt(env, 'INSERT INTO nc_mfa_recovery (member_id, code_hash) VALUES (?, ?)', actor.id, await recoveryHash(code))))] }
}

export async function setPolicy(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor)
  await requireFreshFactor(env, actor)
  const scope = input.text('scope', { max: 10 }) as Policy['scope']
  insist(['off', 'roles', 'all'].includes(scope), 'invalid_scope')
  const chosen = input.list('roles') as Role[]
  insist(chosen.every(role => ROLES.includes(role)), 'invalid_role')
  const roles = scope === 'roles' ? (chosen.length ? [...new Set(chosen)].sort() : DEFAULT_ROLES) : []
  await commit(env, [stmt(env, 'INSERT INTO nc_mfa_policy (singleton, scope, roles, updated_by, updated_at) VALUES (1, ?, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET scope = excluded.scope, roles = excluded.roles, updated_by = excluded.updated_by, updated_at = excluded.updated_at', scope, roles.join(' '), actorLabel(actor), now())],
    { actor: actorLabel(actor), action: 'mfa.policy', subject: 'installation', detail: { scope, roles } })
  return { scope, roles }
}

export async function startTotp(env: Bindings, actor: Actor, input: Input) {
  await requireEnrollable(env, actor)
  insist(env.MFA_KEY, 'mfa_key_missing', 409)
  const secret = crypto.getRandomValues(new Uint8Array(20)), id = newId()
  await env.DB.batch([
    stmt(env, "DELETE FROM nc_mfa_factors WHERE member_id = ? AND kind = 'totp' AND status = 'pending'", actor.id),
    stmt(env, "INSERT INTO nc_mfa_factors (id, member_id, kind, label, status, sealed_secret, created_at) VALUES (?, ?, 'totp', ?, 'pending', ?, ?)", id, actor.id, label(input, 'Authenticator app'), await seal(env.MFA_KEY, secret, binding(id, actor.id)), now()),
  ])
  const text = base32(secret), issuer = encodeURIComponent(branding.name)
  return { factor: id, secret: text, uri: `otpauth://totp/${issuer}:${encodeURIComponent(actor.email)}?secret=${text}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30` }
}

export async function confirmTotp(env: Bindings, actor: Actor, input: Input) {
  await requireEnrollable(env, actor)
  const factor = await one<Factor>(env, "SELECT * FROM nc_mfa_factors WHERE id = ? AND member_id = ? AND kind = 'totp' AND status = 'pending'", input.text('factor', { max: 100 }), actor.id)
  insist(factor, 'factor_not_found', 404)
  const secret = await unseal(env.MFA_KEY, factor.sealed_secret!, binding(factor.id, actor.id))
  insist(secret, 'mfa_key_changed', 409)
  const step = await matchTotp(secret, input.text('code', { max: 12 }).replace(/\s/g, ''), clockInstant(env))
  if (step === null) return await refuse(env, actor, 'totp')
  const recovery = await recoveryStatements(env, actor)
  await commit(env, [
    stmt(env, "UPDATE nc_mfa_factors SET status = 'active', last_step = ?, confirmed_at = ? WHERE id = ?", step, now(), factor.id),
    ...(await standing(env, actor)).unreadable.map(old => stmt(env, 'DELETE FROM nc_mfa_factors WHERE id = ?', old.id)),
    markSession(env, actor, 'totp'), ...recovery.statements,
  ], { actor: actorLabel(actor), action: 'mfa.enroll', subject: actor.id, detail: { kind: 'totp', factor: factor.id, label: factor.label } })
  return { factor: factor.id, kind: 'totp', recovery_codes: recovery.codes }
}

async function lockedOut(env: Bindings, actor: Actor) {
  const failures = await one<{ n: number }>(env, "SELECT COUNT(*) AS n FROM nc_audit WHERE action = 'mfa.refused' AND subject = ? AND at > ?", actor.id, now() - LOCK_MS)
  insist(failures!.n < LOCK_FAILURES, 'mfa_locked', 429)
}

async function refuse(env: Bindings, actor: Actor, method: string): Promise<never> {
  await commit(env, [], { actor: actorLabel(actor), action: 'mfa.refused', subject: actor.id, detail: { method } })
  throw new NectarError('mfa_code_invalid', 403)
}

async function presented(env: Bindings, actor: Actor, method: string, extra: D1PreparedStatement[]) {
  const before = await one(env, 'SELECT 1 FROM nc_mfa_sessions WHERE session_id = ?', actor.sessionId)
  await commit(env, [...extra, markSession(env, actor, method)], { actor: actorLabel(actor), action: before ? 'mfa.step_up' : 'mfa.verify', subject: actor.id, detail: { method } })
  return { verified: true, method, step_up: !!before }
}

/** Presents an authenticator code or a one-time recovery code. */
export async function verifyFactor(env: Bindings, actor: Actor, input: Input) {
  requireMemberActor(actor)
  await lockedOut(env, actor)
  const { usable } = await standing(env, actor)
  insist(usable.length, 'mfa_enrollment_required', 409)
  const code = input.text('code', { max: 20 }).replace(/\s/g, '')
  if (/^\d{6}$/.test(code)) {
    for (const factor of usable.filter(f => f.kind === 'totp')) {
      const step = await matchTotp((await unseal(env.MFA_KEY, factor.sealed_secret!, binding(factor.id, actor.id)))!, code, clockInstant(env))
      if (step !== null && step > factor.last_step) return await presented(env, actor, 'totp', [stmt(env, 'UPDATE nc_mfa_factors SET last_step = ? WHERE id = ? AND last_step < ?', step, factor.id, step)])
    }
    return await refuse(env, actor, 'totp')
  }
  const hash = await recoveryHash(code)
  const recovery = await one(env, 'SELECT 1 FROM nc_mfa_recovery WHERE member_id = ? AND code_hash = ? AND used_at IS NULL', actor.id, hash)
  if (!recovery) return await refuse(env, actor, 'recovery')
  return await presented(env, actor, 'recovery', [stmt(env, 'UPDATE nc_mfa_recovery SET used_at = ? WHERE member_id = ? AND code_hash = ?', now(), actor.id, hash)])
}

const relyingParty = (env: Bindings) => ({ origin: env.AUTH_ORIGIN, rpId: new URL(env.AUTH_ORIGIN).hostname })

export async function passkeyOptions(env: Bindings, actor: Actor, input: Input) {
  const purpose = input.text('purpose', { max: 10 }) as 'register' | 'verify'
  insist(purpose === 'register' || purpose === 'verify', 'invalid_purpose')
  if (purpose === 'register') await requireEnrollable(env, actor)
  else { requireMemberActor(actor); await lockedOut(env, actor) }
  const passkeys = (await standing(env, actor)).usable.filter(factor => factor.kind === 'passkey')
  insist(purpose === 'register' || passkeys.length, 'no_passkey', 409)
  const id = newId(), challenge = b64url(crypto.getRandomValues(new Uint8Array(32)))
  await env.DB.batch([
    stmt(env, 'DELETE FROM nc_mfa_challenges WHERE member_id = ? OR expires_at < ?', actor.id, clockInstant(env)),
    stmt(env, 'INSERT INTO nc_mfa_challenges (id, member_id, session_id, purpose, challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?)', id, actor.id, actor.sessionId, purpose, challenge, clockInstant(env) + CHALLENGE_MS),
  ])
  const { rpId } = relyingParty(env), credentials = passkeys.map(factor => ({ type: 'public-key', id: factor.credential_id }))
  return { challenge_id: id, publicKey: purpose === 'register'
    ? { challenge, rp: { id: rpId, name: branding.name }, user: { id: b64url(new TextEncoder().encode(actor.id)), name: actor.email, displayName: actor.name || actor.email }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }], excludeCredentials: credentials, authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' }, attestation: 'none', timeout: CHALLENGE_MS }
    : { challenge, rpId, allowCredentials: credentials, userVerification: 'preferred', timeout: CHALLENGE_MS } }
}

async function takeChallenge(env: Bindings, actor: Actor, input: Input, purpose: string) {
  const row = await one<{ challenge: string; expires_at: number }>(env, 'SELECT challenge, expires_at FROM nc_mfa_challenges WHERE id = ? AND member_id = ? AND session_id = ? AND purpose = ?', input.text('challenge_id', { max: 100 }), actor.id, actor.sessionId, purpose)
  insist(row && row.expires_at >= clockInstant(env), 'passkey_challenge_expired', 409)
  await env.DB.prepare('DELETE FROM nc_mfa_challenges WHERE id = ?').bind(input.text('challenge_id', { max: 100 })).run()
  return row.challenge
}

export async function registerPasskey(env: Bindings, actor: Actor, input: Input) {
  await requireEnrollable(env, actor)
  const challenge = await takeChallenge(env, actor, input, 'register')
  const registration = await verifyRegistration({ clientDataJSON: input.text('client_data_json', { max: 4000 }), attestationObject: input.text('attestation_object', { max: 20000 }) }, { challenge, ...relyingParty(env) })
  const id = newId(), recovery = await recoveryStatements(env, actor), name = label(input, 'Passkey')
  await commit(env, [
    stmt(env, "INSERT INTO nc_mfa_factors (id, member_id, kind, label, status, credential_id, public_key, sign_count, created_at, confirmed_at) VALUES (?, ?, 'passkey', ?, 'active', ?, ?, ?, ?, ?)", id, actor.id, name, registration.credentialId, JSON.stringify(registration.publicKey), registration.signCount, now(), now()),
    markSession(env, actor, 'passkey'), ...recovery.statements,
  ], { actor: actorLabel(actor), action: 'mfa.enroll', subject: actor.id, detail: { kind: 'passkey', factor: id, label: name } })
  return { factor: id, kind: 'passkey', recovery_codes: recovery.codes }
}

export async function verifyPasskey(env: Bindings, actor: Actor, input: Input) {
  requireMemberActor(actor)
  await lockedOut(env, actor)
  const challenge = await takeChallenge(env, actor, input, 'verify')
  const factor = (await standing(env, actor)).usable.find(f => f.kind === 'passkey' && f.credential_id === input.text('credential_id', { max: 1500 }))
  if (!factor) return await refuse(env, actor, 'passkey')
  let count: number
  try {
    count = await verifyAssertion({ clientDataJSON: input.text('client_data_json', { max: 4000 }), authenticatorData: input.text('authenticator_data', { max: 4000 }), signature: input.text('signature', { max: 2000 }) }, { publicKey: JSON.parse(factor.public_key!), signCount: factor.sign_count }, { challenge, ...relyingParty(env) })
  } catch { return await refuse(env, actor, 'passkey') }
  return await presented(env, actor, 'passkey', [stmt(env, 'UPDATE nc_mfa_factors SET sign_count = ? WHERE id = ?', count, factor.id)])
}

/** Ends every session of the operator behind `email`; the requesting session last, so the request can finish. */
async function endSessions(env: Bindings, request: Request, operatorId: string | undefined, current: string | null) {
  const auth = operatorAuth(env)
  const sessions = (await auth.listSessions(request, operatorId)).filter(session => session.active)
  for (const session of [...sessions.filter(s => s.id !== current), ...sessions.filter(s => s.id === current)]) await auth.revokeSession(request, session.id)
  return sessions.length
}

/** A member removes one of their own factors; every one of their sessions ends. */
export async function removeFactor(env: Bindings, actor: Actor, input: Input, request: Request) {
  requireMemberActor(actor)
  await requireFreshFactor(env, actor)
  const factor = await one<Factor>(env, 'SELECT * FROM nc_mfa_factors WHERE id = ? AND member_id = ?', input.text('factor', { max: 100 }), actor.id)
  insist(factor, 'factor_not_found', 404)
  const last = (await one<{ n: number }>(env, 'SELECT COUNT(*) AS n FROM nc_mfa_factors WHERE member_id = ? AND id != ?', actor.id, factor.id))!.n === 0
  await commit(env, [stmt(env, 'DELETE FROM nc_mfa_factors WHERE id = ?', factor.id), ...(last ? [stmt(env, 'DELETE FROM nc_mfa_recovery WHERE member_id = ?', actor.id)] : []), stmt(env, 'DELETE FROM nc_mfa_sessions WHERE member_id = ?', actor.id)],
    { actor: actorLabel(actor), action: 'mfa.remove', subject: actor.id, detail: { kind: factor.kind, factor: factor.id, label: factor.label } })
  const ended = await endSessions(env, request, undefined, actor.sessionId)
  return { id: factor.id, removed: true, sessions_ended: ended }
}

/** The owner resets a member's factors: all of them go, with the recovery codes, and every session of that member ends at once. */
export async function resetFactors(env: Bindings, actor: Actor, input: Input, request: Request) {
  requireOwner(actor)
  await requireFreshFactor(env, actor)
  const member = await one<{ id: string; email: string }>(env, 'SELECT id, email FROM nc_members WHERE id = ?', input.text('member', { max: 100 }))
  insist(member, 'member_not_found', 404)
  const removed = (await one<{ n: number }>(env, 'SELECT COUNT(*) AS n FROM nc_mfa_factors WHERE member_id = ?', member.id))!.n
  await commit(env, [stmt(env, 'DELETE FROM nc_mfa_factors WHERE member_id = ?', member.id), stmt(env, 'DELETE FROM nc_mfa_recovery WHERE member_id = ?', member.id), stmt(env, 'DELETE FROM nc_mfa_sessions WHERE member_id = ?', member.id)],
    { actor: actorLabel(actor), action: 'mfa.reset', subject: member.id, detail: { email: member.email, factorsRemoved: removed } })
  const operator = (await operatorAuth(env).listOperators(request)).find(o => o.email.toLowerCase() === member.email)
  const ended = operator ? await endSessions(env, request, operator.id, actor.sessionId) : 0
  return { id: member.id, factors_removed: removed, sessions_ended: ended }
}

/** GET /api/nectar/mfa: the signed-in member's own standing. */
export async function mfaView(env: Bindings, actor: Actor) {
  requireMemberActor(actor)
  const s = await standing(env, actor)
  const recovery = await one<{ n: number }>(env, 'SELECT COUNT(*) AS n FROM nc_mfa_recovery WHERE member_id = ? AND used_at IS NULL', actor.id)
  const factors = [...s.usable.map(f => ({ ...f, usable: true })), ...s.unreadable.map(f => ({ ...f, usable: false }))].map(f => ({ id: f.id, kind: f.kind, label: f.label, created_at: f.created_at, usable: f.usable }))
  return { policy: s.policy, required: s.required, state: s.state, reason: s.reason, reason_text: s.reason ? KEY_REASONS[s.reason] : null, verified_at: s.verifiedAt, step_up_minutes: STEP_UP_MS / 60000, factors, recovery_codes_left: recovery!.n }
}

/** Factor counts per member for the owner's Access page. */
export async function memberFactors(env: Bindings) {
  return new Map((await all<{ member_id: string; n: number }>(env, "SELECT member_id, COUNT(*) AS n FROM nc_mfa_factors WHERE status = 'active' GROUP BY member_id")).map(row => [row.member_id, row.n]))
}
