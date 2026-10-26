import { SAML, ValidateInResponseTo } from '@node-saml/node-saml'
import { operatorAuth, type Bindings } from '../auth.server'
import { memberCapabilities, type Actor, type Role } from './actor'
import { commit, guard, insist, now, one, sha256Hex, stmt } from './core'
import { mfaPolicy } from './mfa'
import { mappedRole, ssoCallback, ssoConfig, ssoEntity, ssoToken, type SsoConfig } from './sso-config'

type Transaction = { state_hash: string; binding_hash: string; config_revision: number; request_id: string; request_time: string; expires_at: number; consumed: number; principal: string | null }
type Principal = { subject: string; user: string; revision: number; role: Role; authenticatedAt: number; mfa: boolean }
const cookieName = (env: Bindings) => 'nectar_saml_' + (new URL(env.AUTH_ORIGIN).port || '443')
const cookie = (env: Bindings, value: string) => `${cookieName(env)}=${value}; Path=/sso; HttpOnly; SameSite=Lax; Max-Age=300${env.AUTH_ORIGIN.startsWith('https:') ? '; Secure' : ''}`
const redirect = (path: string, headers: Record<string, string> = {}) => new Response(null, { status: 303, headers: { location: path, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', ...headers } })

function verifier(env: Bindings, config: SsoConfig, transaction: Transaction) {
  return new SAML({ issuer: ssoEntity(env), audience: ssoEntity(env), callbackUrl: ssoCallback(env), entryPoint: config.entry_point,
    idpCert: config.certificate, idpIssuer: config.issuer, wantAssertionsSigned: true, wantAuthnResponseSigned: true,
    validateInResponseTo: ValidateInResponseTo.always, acceptedClockSkewMs: 0, maxAssertionAgeMs: 300000,
    requestIdExpirationPeriodMs: 300000, disableRequestedAuthnContext: true, forceAuthn: true,
    cacheProvider: {
      async saveAsync(key, value) {
        await env.DB.prepare('UPDATE nc_saml_transactions SET request_id=?,request_time=? WHERE state_hash=? AND consumed=0').bind(key, value, transaction.state_hash).run()
        return { value, createdAt: now() }
      },
      async getAsync(key) { return key === transaction.request_id && transaction.expires_at > now() ? transaction.request_time : null },
      async removeAsync() { return null },
    } })
}

async function principal(env: Bindings, config: SsoConfig, profile: any, transaction: Transaction): Promise<Principal> {
  insist(profile && profile.issuer === config.issuer && typeof profile.nameID === 'string', 'invalid_identity', 403)
  const assertion = profile.getAssertion()?.Assertion
  const confirmations = assertion?.Subject?.[0]?.SubjectConfirmation
  insist(confirmations?.length === 1 && confirmations[0].$.Method === 'urn:oasis:names:tc:SAML:2.0:cm:bearer', 'invalid_subject', 403)
  const data = confirmations[0].SubjectConfirmationData?.[0]?.$
  insist(data?.Recipient === ssoCallback(env) && data.InResponseTo === transaction.request_id && Date.parse(data.NotOnOrAfter) > now(), 'invalid_recipient', 403)
  const statements = assertion.AuthnStatement
  insist(statements?.length === 1, 'invalid_authentication_context', 403)
  const auth = statements[0], authenticatedAt = Date.parse(auth.$.AuthnInstant)
  insist(Number.isFinite(authenticatedAt) && authenticatedAt <= now() + 30000 && authenticatedAt > now() - 300000, 'stale_authentication', 403)
  const context = auth.AuthnContext?.[0]?.AuthnContextClassRef?.[0]
  // Okta's dynamic signed amr attribute describes the actual session. A static
  // password class alone never proves a second factor.
  const methods = [profile.amr ?? []].flat().flatMap(value => String(value).split(/[ ,]+/))
  const mfa = ['https://refeds.org/profile/mfa', 'urn:oasis:names:tc:SAML:2.0:ac:classes:TimeSyncToken', 'urn:oasis:names:tc:SAML:2.0:ac:classes:SmartcardPKI'].includes(context) || methods.includes('mfa')
  const user = await one(env, 'SELECT s.*,m.role,m.status FROM nc_scim_users s JOIN nc_members m ON m.id=s.member_id WHERE s.external_id=?', profile.nameID)
  insist(user && user.active && user.status === 'active', 'not_provisioned', 403)
  insist(profile.email === user.email && mappedRole(config, profile.role) === user.role && profile.role === user.source_role, 'identity_mapping_mismatch', 403)
  const policy = await mfaPolicy(env)
  insist(mfa || !(policy.scope === 'all' || (policy.scope === 'roles' && policy.roles.includes(user.role))), 'idp_mfa_required', 403)
  return { subject: profile.nameID, user: user.id, revision: user.revision, role: user.role, authenticatedAt, mfa }
}

export async function samlResponse(request: Request, env: Bindings): Promise<Response | null> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith('/sso/')) return null
  try {
    insist(url.origin === env.AUTH_ORIGIN, 'invalid_host', 403)
    const config = await ssoConfig(env)
    insist(config, 'sso_not_configured', 404)
    if (request.method === 'GET' && url.pathname === '/sso/start') {
      const state = ssoToken(), binding = ssoToken(), hash = await sha256Hex(state)
      const limits = await one<{ n: number }>(env, 'SELECT COUNT(*) AS n FROM nc_saml_transactions WHERE expires_at>?', now())
      insist(limits!.n < 100, 'sign_in_busy', 429)
      await env.DB.batch([stmt(env, 'DELETE FROM nc_saml_transactions WHERE expires_at<=?', now()), stmt(env, 'INSERT INTO nc_saml_transactions(state_hash,binding_hash,config_revision,expires_at) VALUES(?,?,?,?)', hash, await sha256Hex(binding), config.revision, now() + 300000)])
      const transaction = (await one<Transaction>(env, 'SELECT * FROM nc_saml_transactions WHERE state_hash=?', hash))!
      const target = await verifier(env, config, transaction).getAuthorizeUrlAsync(state, undefined, {})
      return redirect(target, { 'set-cookie': cookie(env, binding) })
    }
    if (request.method === 'GET' && url.pathname === '/sso/metadata') {
      const xml = verifier(env, config, {} as Transaction).generateServiceProviderMetadata(null)
      return new Response(xml, { headers: { 'content-type': 'application/samlmetadata+xml', 'cache-control': 'no-store' } })
    }
    const state = request.method === 'POST' ? null : url.searchParams.get('state')
    if (request.method === 'POST' && url.pathname === '/sso/acs') {
      const text = await request.text()
      insist(text.length <= 200000 && request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded'), 'invalid_saml_response')
      const form = new URLSearchParams(text), relay = form.get('RelayState')
      insist(relay && /^[a-f0-9]{64}$/.test(relay) && form.getAll('SAMLResponse').length === 1 && form.getAll('RelayState').length === 1, 'invalid_saml_state', 403)
      // The one-use transition also fences concurrent replay before validation.
      const transaction = await env.DB.prepare('UPDATE nc_saml_transactions SET consumed=1 WHERE state_hash=? AND consumed=0 AND expires_at>? AND config_revision=? RETURNING *').bind(await sha256Hex(relay), now(), config.revision).first<Transaction>()
      insist(transaction, 'invalid_saml_state', 403)
      try {
        const { profile } = await verifier(env, config, transaction).validatePostResponseAsync({ SAMLResponse: form.get('SAMLResponse')! })
        const identity = await principal(env, config, profile, transaction)
        await env.DB.prepare('UPDATE nc_saml_transactions SET principal=? WHERE state_hash=?').bind(JSON.stringify(identity), transaction.state_hash).run()
        return redirect('/sso/finish?state=' + relay)
      } catch {
        await env.DB.prepare('DELETE FROM nc_saml_transactions WHERE state_hash=?').bind(transaction.state_hash).run()
        insist(false, 'saml_assertion_refused', 403)
      }
    }
    if (request.method === 'GET' && url.pathname === '/sso/finish') {
      insist(state && /^[a-f0-9]{64}$/.test(state), 'invalid_saml_state', 403)
      const bindings = (request.headers.get('cookie') ?? '').split(';').map(item => item.trim()).filter(item => item.startsWith(cookieName(env) + '='))
      insist(bindings.length === 1, 'invalid_saml_binding', 403)
      const transaction = await env.DB.prepare('DELETE FROM nc_saml_transactions WHERE state_hash=? AND binding_hash=? AND consumed=1 AND principal IS NOT NULL AND expires_at>? AND config_revision=? RETURNING *').bind(await sha256Hex(state), await sha256Hex(bindings[0].slice(cookieName(env).length + 1)), now(), config.revision).first<Transaction>()
      insist(transaction, 'invalid_saml_binding', 403)
      const identity: Principal = JSON.parse(transaction.principal!)
      const user = await one(env, 'SELECT s.*,m.name,m.role,m.status FROM nc_scim_users s JOIN nc_members m ON m.id=s.member_id WHERE s.id=? AND s.revision=? AND s.active=1 AND m.status=\'active\'', identity.user, identity.revision)
      insist(user && user.role === identity.role, 'not_provisioned', 403)
      const auth = operatorAuth(env)
      const completed = await auth.admission.admit(request, { issuer: config.issuer, subject: identity.subject, associatedEmail: user.email }, { returnTo: '/app' })
      try {
        const actor: Actor = { id: user.member_id, kind: 'member', name: user.name, email: user.email, role: user.role, sessionId: completed.session.id, capabilities: memberCapabilities(user.role, null) }
        const policy = await mfaPolicy(env)
        insist(identity.mfa || !(policy.scope === 'all' || (policy.scope === 'roles' && policy.roles.includes(actor.role!))), 'idp_mfa_required', 403)
        await commit(env, [guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_scim_users WHERE id=? AND active=1 AND revision=?) AND EXISTS(SELECT 1 FROM nc_sso_config WHERE revision=?)', user.id, identity.revision, config.revision),
          ...(identity.mfa ? [stmt(env, "INSERT INTO nc_mfa_sessions(session_id,member_id,verified_at,method) VALUES(?,?,?,'saml')", completed.session.id, user.member_id, identity.authenticatedAt)] : [])],
        { actor: user.email, action: 'sso.signin', subject: user.member_id, detail: { mfa: identity.mfa, authenticatedAt: identity.authenticatedAt } })
      } catch (error) { await auth.accounts.revokeSession(completed.session.id); throw error }
      return redirect('/app', { 'set-cookie': completed.cookie })
    }
    insist(false, 'not_found', 404)
  } catch (error: any) {
    return Response.json({ error: error.code ?? 'saml_assertion_refused' }, { status: error.status ?? 403, headers: { 'cache-control': 'no-store' } })
  }
}
