import { X509Certificate } from 'node:crypto'
import type { Bindings } from '../auth.server'
import { requireOwner, actorLabel, ROLES, type Actor, type Role } from './actor'
import { all, commit, guard, insist, now, one, sha256Hex, stmt } from './core'
import type { Input } from './input'
import { requireFreshFactor } from './mfa'

export type SsoConfig = { revision: number; protocol: 'saml' | 'oidc'; issuer: string; entry_point: string; certificate: string; role_map: string; scim_hash: string }
export const ssoConfig = (env: Bindings) => one<SsoConfig>(env, 'SELECT * FROM nc_sso_config WHERE singleton=1')
export const ssoToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('')
export const ssoEntity = (env: Bindings) => env.AUTH_ORIGIN + '/sso/metadata'
export const ssoCallback = (env: Bindings) => env.AUTH_ORIGIN + '/sso/acs'
export function mappedRole(config: SsoConfig, source: unknown): Role {
  insist(typeof source === 'string', 'unmapped_sso_role', 403)
  const role = JSON.parse(config.role_map)[source] as Role
  insist(ROLES.includes(role) && role !== 'owner' && role !== 'custom', 'unmapped_sso_role', 403)
  return role
}
export async function configureSso(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor)
  await requireFreshFactor(env, actor)
  input.only(['issuer', 'entry_point', 'certificate', 'role_map', 'revision', 'returnTo'])
  const issuer = input.text('issuer', { max: 500 }), entry = input.text('entry_point', { max: 1000 }), certificate = input.text('certificate', { max: 16000 })
  insist(/^https?:\/\//.test(issuer), 'invalid_issuer')
  const url = new URL(entry)
  insist(url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search, 'invalid_entry_point')
  let cert: X509Certificate
  try { cert = new X509Certificate(certificate) } catch { insist(false, 'invalid_certificate') }
  insist(Date.parse(cert.validTo) > now() && Date.parse(cert.validFrom) <= now(), 'expired_certificate')
  const mapping = input.json('role_map')
  insist(mapping && typeof mapping === 'object' && !Array.isArray(mapping), 'invalid_role_map')
  const entries = Object.entries(mapping)
  insist(entries.length > 0 && entries.length <= 20 && entries.every(([key, role]) => key.length > 0 && key.length <= 100 && ROLES.includes(role as Role) && role !== 'owner' && role !== 'custom'), 'invalid_role_map')
  // Reconfiguration never silently remaps or transfers an existing identity.
  const old = await ssoConfig(env), revision = input.integer('revision', { min: 0 })
  insist(revision === (old?.revision ?? 0), 'stale', 409)
  const users = await all(env, 'SELECT source_role FROM nc_scim_users')
  insist(!old || (old.issuer === issuer && users.every(user => JSON.parse(old.role_map)[user.source_role] === (mapping as Record<string, unknown>)[user.source_role])), 'provisioned_identity_fixed', 409)
  const token = ssoToken(), next = (old?.revision ?? 0) + 1
  await commit(env, [guard(env, 'stale', 'COALESCE((SELECT revision FROM nc_sso_config WHERE singleton=1),0)=?', revision),
    stmt(env, `INSERT INTO nc_sso_config(singleton,revision,issuer,entry_point,certificate,role_map,scim_hash,updated_at) VALUES(1,?,?,?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,issuer=excluded.issuer,entry_point=excluded.entry_point,certificate=excluded.certificate,role_map=excluded.role_map,scim_hash=excluded.scim_hash,updated_at=excluded.updated_at,protocol='saml'`, next, issuer, entry, certificate, JSON.stringify(mapping), await sha256Hex(token), now()),
    stmt(env, 'DELETE FROM nc_saml_transactions'),
    stmt(env, "UPDATE oa_sessions SET revoked_at=? WHERE id IN (SELECT session_id FROM oa_provider_sessions WHERE issuer=?)", now(), issuer),
    stmt(env, 'UPDATE oa_auth_settings SET idp_sign_in=1 WHERE singleton=1')],
  { actor: actorLabel(actor), action: 'sso.configure', subject: 'installation', detail: { issuer, entryPoint: entry, roles: mapping, revision: next } })
  return { revision: next, scim_token: token }
}
