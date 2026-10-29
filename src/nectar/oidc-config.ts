import type { Bindings } from '../auth.server'
import { configure } from './oidc-protocol.mjs'
import { discover } from './oidc-protocol.mjs'
import { keyedHash } from './oidc-protocol.mjs'
import { actorLabel, requireOwner, ROLES, type Actor, type Role } from './actor'
import { all, commit, guard, insist, now, one, sha256Hex, stmt } from './core'
import { clockInstant } from './clock'
import type { Input } from './input'
import { standing } from './mfa'
import { ssoConfig, ssoToken } from './sso-config'

export function oidcSettings(env: Bindings, provider: any) {
  insist(provider && typeof provider === 'object' && !Array.isArray(provider) && Object.keys(provider).every(key => ['preset', 'issuer', 'tenant', 'clientId', 'tokenAuthMethod', 'endpointPins'].includes(key)), 'invalid_oidc_provider')
  const method = provider.tokenAuthMethod ?? 'private_key_jwt'
  return configure({ origin: env.AUTH_ORIGIN, local: env.AUTH_LOCAL === 'true', transactionSecret: env.SSO_OIDC_TRANSACTION_SECRET,
    transactionSeconds: 300, maxTokenAgeSeconds: 300, clockSkewSeconds: 0,
    providers: [{ ...provider, id: 'enterprise', redirectUri: env.AUTH_ORIGIN + '/sso/oidc/callback',
      ...(method === 'private_key_jwt' ? { privateKey: JSON.parse(env.SSO_OIDC_PRIVATE_KEY ?? 'null') } : { clientSecret: env.SSO_OIDC_SECRET }) }] })
}
export const oidcCredentialBasis = (env: Bindings) => keyedHash(env.SSO_OIDC_TRANSACTION_SECRET!, 'nectar-client', JSON.stringify([env.SSO_OIDC_SECRET ?? '', env.SSO_OIDC_PRIVATE_KEY ?? '']))
export const oidcConfig = (env: Bindings) => one(env, 'SELECT * FROM nc_oidc_config WHERE singleton=1')

export async function configureOidc(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor)
  const { verifiedAt } = await standing(env, actor), at = clockInstant(env)
  insist(verifiedAt !== null && verifiedAt <= at && at - verifiedAt <= 900000, 'mfa_step_up_required', 403)
  input.only(['provider', 'role_map', 'revision', 'returnTo'])
  const provider = input.json('provider'), settings = oidcSettings(env, provider), selected = settings.providers[0]
  const mapping = input.json('role_map')
  insist(mapping && typeof mapping === 'object' && !Array.isArray(mapping), 'invalid_role_map')
  const entries = Object.entries(mapping)
  insist(entries.length > 0 && entries.length <= 20 && entries.every(([key, role]) => key.length > 0 && key.length <= 100 && ROLES.includes(role as Role) && role !== 'owner' && role !== 'custom'), 'invalid_role_map')
  const old = await ssoConfig(env), revision = input.integer('revision', { min: 0 }), users = await all(env, 'SELECT source_role FROM nc_scim_users')
  insist(revision === (old?.revision ?? 0), 'stale', 409)
  insist(!old || old.issuer === selected.issuer && users.every(user => JSON.parse(old.role_map)[user.source_role] === (mapping as Record<string, unknown>)[user.source_role]) || !users.length, 'provisioned_identity_fixed', 409)
  const pin = await discover(fetch, selected, settings), token = ssoToken(), next = revision + 1
  await commit(env, [guard(env, 'stale', 'COALESCE((SELECT revision FROM nc_sso_config WHERE singleton=1),0)=?', revision),
    guard(env, 'mfa_step_up_required', `EXISTS(SELECT 1 FROM nc_mfa_sessions f JOIN nc_members m ON m.id=f.member_id JOIN oa_sessions s ON s.id=f.session_id JOIN oa_operators o ON o.id=s.operator_id WHERE f.session_id=? AND f.member_id=? AND f.verified_at=? AND m.role='owner' AND m.status='active' AND o.email=m.email AND o.role='owner' AND o.status='active' AND s.operator_version=o.version AND s.revoked_at IS NULL AND s.expires_at>?)`, actor.sessionId, actor.id, verifiedAt, now()),
    stmt(env, `INSERT INTO nc_sso_config(singleton,revision,issuer,entry_point,certificate,role_map,scim_hash,updated_at,protocol) VALUES(1,?,?,?,'',?,?,?,'oidc') ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,issuer=excluded.issuer,entry_point=excluded.entry_point,certificate='',role_map=excluded.role_map,scim_hash=excluded.scim_hash,updated_at=excluded.updated_at,protocol='oidc'`, next, selected.issuer, pin.authorization, JSON.stringify(mapping), await sha256Hex(token), now()),
    stmt(env, 'INSERT OR REPLACE INTO nc_oidc_config VALUES(1,?,?,?)', JSON.stringify(provider), JSON.stringify({ ...pin, clientId: selected.clientId }), await oidcCredentialBasis(env)),
    stmt(env, 'UPDATE oa_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE id IN (SELECT session_id FROM oa_provider_sessions)', now()),
    stmt(env, 'UPDATE oa_auth_settings SET idp_sign_in=1 WHERE singleton=1')],
  { actor: actorLabel(actor), action: 'sso.configure', subject: 'installation', detail: { protocol: 'oidc', issuer: selected.issuer, clientId: selected.clientId, roles: mapping, revision: next, ownerVerifiedAt: verifiedAt } })
  return { revision: next, scim_token: token, start: '/sso/oidc/start', callback: selected.redirectUri }
}
