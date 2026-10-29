import { operatorAuth, type Bindings } from '../auth.server'
import { actorLabel, currentActor, requireOwner, type Actor, type Role } from './actor'
import { all, commit, fingerprint, guard, insist, newId, now, one, stmt } from './core'
import { clockInstant } from './clock'
import type { Input } from './input'
import { mfaHold, mfaPolicy, standing } from './mfa'
import { ssoConfig } from './sso-config'

export type LinkBasis = { member: string; operator: string; session: string; email: string; role: Role; memberUpdated: number; operatorVersion: number; configRevision: number; issuer: string }
export type LinkIdentity = { subject: string; email: string; sourceRole: string; role: Role; authenticatedAt: number; mfa: boolean }

// The session, rather than an email claim, selects the existing member.
export async function linkingBasis(env: Bindings, request: Request): Promise<LinkBasis> {
  const actor = await currentActor(env, request), session = await operatorAuth(env).getSession(request), config = await ssoConfig(env)
  insist(actor?.kind === 'member' && actor.role !== 'owner' && actor.role !== 'custom' && session && config, 'link_member_required', 403)
  insist(!await mfaHold(env, actor), 'mfa_required', 403)
  const member = await one(env, 'SELECT updated_at FROM nc_members WHERE id=?', actor.id)
  const basis = { member: actor.id, operator: session.operator.id, session: session.id, email: actor.email, role: actor.role!, memberUpdated: member!.updated_at, operatorVersion: session.operator.version, configRevision: config.revision, issuer: config.issuer }
  // This read also refuses an already managed or bound account before redirect.
  await assertBasis(env, basis)
  return basis
}

const basisCondition = `EXISTS(SELECT 1 FROM nc_members m JOIN oa_operators o ON o.email=m.email JOIN oa_sessions s ON s.operator_id=o.id JOIN nc_sso_config c ON c.singleton=1
 WHERE m.id=? AND m.email=? AND m.role=? AND m.role NOT IN('owner','custom') AND m.status='active' AND m.updated_at=?
 AND o.id=? AND o.role='member' AND o.status='active' AND o.version=? AND s.id=? AND s.operator_version=o.version AND s.revoked_at IS NULL AND s.expires_at>?
 AND c.revision=? AND c.issuer=?)
 AND NOT EXISTS(SELECT 1 FROM nc_scim_users WHERE member_id=?)
 AND NOT EXISTS(SELECT 1 FROM oa_external_identities WHERE operator_id=? AND issuer=?)`
const basisArgs = (basis: LinkBasis) => [basis.member, basis.email, basis.role, basis.memberUpdated, basis.operator, basis.operatorVersion, basis.session, now(), basis.configRevision, basis.issuer, basis.member, basis.operator, basis.issuer]
const basisGuard = (env: Bindings, basis: LinkBasis) => guard(env, 'link_basis_changed', basisCondition, ...basisArgs(basis))
async function assertBasis(env: Bindings, basis: LinkBasis) {
  insist((await one(env, `SELECT (${basisCondition}) AS valid`, ...basisArgs(basis)))?.valid, 'link_basis_changed', 409)
}

export async function checkLinkIdentity(env: Bindings, basis: LinkBasis, identity: LinkIdentity) {
  await assertBasis(env, basis)
  insist(identity.email === basis.email && identity.role === basis.role, 'identity_mapping_mismatch', 403)
  insist(!await one(env, 'SELECT 1 FROM nc_scim_users WHERE external_id=? UNION ALL SELECT 1 FROM oa_external_identities WHERE issuer=? AND subject=? UNION ALL SELECT 1 FROM nc_sso_links WHERE subject=? AND status=\'revoked\'', identity.subject, basis.issuer, identity.subject, identity.subject), 'identity_exists', 409)
}

export async function requestLink(env: Bindings, request: Request, basis: LinkBasis, identity: LinkIdentity) {
  const actor = await currentActor(env, request)
  insist(actor?.id === basis.member && actor.sessionId === basis.session, 'invalid_saml_binding', 403)
  insist(!await mfaHold(env, actor), 'mfa_required', 403)
  await checkLinkIdentity(env, basis, identity)
  const expires = Math.min(now() + 300000, identity.authenticatedAt + 300000), id = newId()
  insist(expires > now(), 'stale_authentication', 403)
  const proof = await fingerprint({ basis, identity, expires })
  await commit(env, [basisGuard(env, basis),
    guard(env, 'identity_exists', 'NOT EXISTS(SELECT 1 FROM nc_sso_links WHERE subject=? AND status=\'revoked\')', identity.subject),
    stmt(env, "INSERT INTO nc_sso_links(id,basis_json,subject,source_role,authenticated_at,mfa,expires_at,fingerprint,status) VALUES(?,?,?,?,?,?,?,?,'pending')", id, JSON.stringify(basis), identity.subject, identity.sourceRole, identity.authenticatedAt, identity.mfa ? 1 : 0, expires, proof)],
  { actor: actorLabel(actor), action: 'sso.link.request', subject: basis.member, detail: { link: id, basis: proof, issuer: basis.issuer, providerSubject: identity.subject, configRevision: basis.configRevision, role: basis.role, authenticatedAt: identity.authenticatedAt } })
}

export async function pendingLinks(env: Bindings, actor: Actor) {
  requireOwner(actor)
  return (await all(env, "SELECT * FROM nc_sso_links WHERE status='pending' AND expires_at>? ORDER BY expires_at", now())).map(row => ({ id: row.id, basis: row.fingerprint, member: JSON.parse(row.basis_json), subject: row.subject, sourceRole: row.source_role, expiresAt: row.expires_at }))
}

export async function approveLink(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor)
  input.only(['link', 'basis', 'returnTo'])
  // Linking always needs an actual fresh factor, even if the global policy is off.
  const { verifiedAt } = await standing(env, actor), clock = clockInstant(env)
  insist(verifiedAt !== null && verifiedAt <= clock && clock - verifiedAt <= 900000, 'mfa_step_up_required', 403)
  const row = await one(env, "SELECT * FROM nc_sso_links WHERE id=? AND fingerprint=? AND status='pending' AND expires_at>?", input.text('link'), input.text('basis'), now())
  insist(row, 'link_unavailable', 409)
  const basis: LinkBasis = JSON.parse(row.basis_json), policy = await mfaPolicy(env)
  insist(row.mfa || !(policy.scope === 'all' || policy.scope === 'roles' && policy.roles.includes(basis.role)), 'idp_mfa_required', 403)
  await assertBasis(env, basis)
  await commit(env, [basisGuard(env, basis),
    guard(env, 'link_unavailable', "EXISTS(SELECT 1 FROM nc_sso_links WHERE id=? AND fingerprint=? AND status='pending' AND expires_at>?)", row.id, row.fingerprint, now()),
    guard(env, 'mfa_step_up_required', `EXISTS(SELECT 1 FROM nc_mfa_sessions f JOIN nc_members m ON m.id=f.member_id JOIN oa_sessions s ON s.id=f.session_id JOIN oa_operators o ON o.id=s.operator_id
      WHERE f.session_id=? AND f.member_id=? AND f.verified_at=? AND m.role='owner' AND m.status='active' AND o.email=m.email AND o.role='owner' AND o.status='active' AND s.operator_version=o.version AND s.revoked_at IS NULL AND s.expires_at>?)`, actor.sessionId, actor.id, verifiedAt, now()),
    guard(env, 'idp_mfa_required', "?=1 OR NOT EXISTS(SELECT 1 FROM nc_mfa_policy WHERE scope='all' OR scope='roles' AND instr(' '||roles||' ',' '||?||' ')>0)", row.mfa, basis.role),
    guard(env, 'identity_exists', 'NOT EXISTS(SELECT 1 FROM nc_scim_users WHERE external_id=?) AND NOT EXISTS(SELECT 1 FROM oa_external_identities WHERE issuer=? AND subject=?)', row.subject, basis.issuer, row.subject),
    stmt(env, 'INSERT INTO nc_scim_users VALUES(?,?,?,?,?,?,1,1)', row.id, row.subject, basis.email, basis.member, basis.operator, row.source_role),
    stmt(env, 'INSERT INTO oa_external_identities(issuer,subject,operator_id) VALUES(?,?,?)', basis.issuer, row.subject, basis.operator),
    stmt(env, 'UPDATE oa_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE operator_id=?', now(), basis.operator),
    stmt(env, 'UPDATE oa_tokens SET revoked_at=COALESCE(revoked_at,?) WHERE operator_id=?', now(), basis.operator),
    stmt(env, 'DELETE FROM nc_mfa_sessions WHERE member_id=?', basis.member),
    stmt(env, "UPDATE nc_sso_links SET status=CASE WHEN id=? THEN 'approved' ELSE 'revoked' END WHERE json_extract(basis_json,'$.member')=? AND status='pending'", row.id, basis.member),
    stmt(env, "DELETE FROM nc_saml_transactions WHERE json_extract(link_basis,'$.member')=?", basis.member)],
  { actor: actorLabel(actor), action: 'sso.link.approve', subject: basis.member, detail: { link: row.id, basis: row.fingerprint, issuer: basis.issuer, providerSubject: row.subject, configRevision: basis.configRevision, operator: basis.operator, role: basis.role, ownerVerifiedAt: verifiedAt } })
  return { id: row.id, member: basis.member, role: basis.role }
}
