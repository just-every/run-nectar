import { operatorAuth, type Bindings } from '../auth.server'
import { discover, exchange, readJson } from './oidc-protocol.mjs'
import { parseIdToken, verifyIdToken } from './oidc-protocol.mjs'
import { digest, random, isRandom, seal, unseal } from './oidc-protocol.mjs'
import { commit, guard, insist, now, one, sha256Hex, stmt } from './core'
import { mappedRole, ssoConfig } from './sso-config'
import { oidcConfig, oidcCredentialBasis, oidcSettings } from './oidc-config'
import { checkLinkIdentity, linkingBasis, requestLink, type LinkIdentity } from './sso-linking'
import { mfaPolicy } from './mfa'

const cookieName = (env: Bindings, state: string) => 'nectar_oidc_' + (new URL(env.AUTH_ORIGIN).port || '443') + '_' + state
const cookie = (env: Bindings, state: string, value: string, age = 300) => `${cookieName(env, state)}=${value}; Path=/sso; HttpOnly; SameSite=Lax; Max-Age=${age}${env.AUTH_ORIGIN.startsWith('https:') ? '; Secure' : ''}`
const redirect = (location: string, cookies: string[] = []) => {
  const headers = new Headers({ location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
  for (const value of cookies) headers.append('set-cookie', value)
  return new Response(null, { status: 303, headers })
}

export async function oidcResponse(request: Request, env: Bindings): Promise<Response | null> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith('/sso/oidc/') && url.pathname !== '/sso/start') return null
  const config = await ssoConfig(env)
  if (url.pathname === '/sso/start' && config?.protocol !== 'oidc') return null
  try {
    insist(url.origin === env.AUTH_ORIGIN && (!request.headers.has('host') || request.headers.get('host') === url.host), 'invalid_host', 403)
    insist(config?.protocol === 'oidc', 'sso_not_configured', 404)
    const record = await oidcConfig(env)
    insist(record, 'sso_not_configured', 404)
    const settings = oidcSettings(env, JSON.parse(record.provider_json)), provider = settings.providers[0], pin = JSON.parse(record.pin_json)
    insist(record.credential_basis === await oidcCredentialBasis(env), 'sso_reauthorization_required', 403)
    if (request.method === 'POST' && url.pathname === '/sso/oidc/start' || request.method === 'GET' && url.pathname === '/sso/start') {
      insist((request.method === 'GET' || request.headers.get('origin') === env.AUTH_ORIGIN) && request.headers.get('sec-fetch-site') !== 'cross-site', 'invalid_origin', 403)
      const link = url.searchParams.get('link') === '1' ? await linkingBasis(env, request) : null
      const latest = await discover(fetch, provider, settings)
      insist(JSON.stringify({ ...latest, clientId: provider.clientId }) === record.pin_json, 'sso_reauthorization_required', 403)
      const count = await one(env, 'SELECT COUNT(*) AS n FROM nc_oidc_transactions WHERE expires_at>?', now())
      insist(count!.n < 100, 'sign_in_busy', 429)
      const state = random(), binding = random(), nonce = random(), verifier = random(), hash = await sha256Hex(state), expiresAt = now() + 300000
      const payload = await seal(settings.transactionSecret, hash, { nonce, verifier, link, expiresAt })
      await env.DB.batch([stmt(env, 'DELETE FROM nc_oidc_transactions WHERE expires_at<=?', now()), stmt(env, 'INSERT INTO nc_oidc_transactions VALUES(?,?,?,?,?)', hash, await sha256Hex(binding), config.revision, payload, expiresAt)])
      const target = new URL(pin.authorization)
      const params = { response_type: 'code', response_mode: 'query', client_id: provider.clientId, redirect_uri: provider.redirectUri, scope: provider.scope, state, nonce, code_challenge: await digest(verifier), code_challenge_method: 'S256', max_age: '300' }
      for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value)
      return redirect(target.href, [cookie(env, state, binding)])
    }
    insist(request.method === 'GET' && url.pathname === '/sso/oidc/callback' && request.url.length <= 12288, 'invalid_oidc_response', 403)
    for (const key of url.searchParams.keys()) insist(url.searchParams.getAll(key).length === 1, 'invalid_oidc_response', 403)
    const state = url.searchParams.get('state')
    insist(isRandom(state), 'invalid_oidc_state', 403)
    const bindings = (request.headers.get('cookie') ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(cookieName(env, state!) + '='))
    insist(bindings.length === 1, 'invalid_oidc_binding', 403)
    const hash = await sha256Hex(state!), transaction = await env.DB.prepare('DELETE FROM nc_oidc_transactions WHERE state_hash=? AND binding_hash=? AND config_revision=? AND expires_at>? RETURNING *').bind(hash, await sha256Hex(bindings[0].slice(cookieName(env, state!).length + 1)), config.revision, now()).first<any>()
    insist(transaction, 'invalid_oidc_state', 403)
    const proof = await unseal(settings.transactionSecret, hash, transaction.payload)
    const responseIssuer = url.searchParams.get('iss'), code = url.searchParams.get('code')
    insist((responseIssuer === null ? !pin.responseIssuer : responseIssuer === pin.issuer) && !url.searchParams.has('error') && typeof code === 'string' && code.length <= 4096 && /^[\x21-\x7e]+$/.test(code), 'invalid_oidc_response', 403)
    const tokens = await exchange(fetch, pin, provider, settings, code, proof.verifier, now())
    const parsed = parseIdToken(tokens.id_token, pin), keys = await readJson(fetch, pin.jwks, settings, {}, 262144)
    const claims = await verifyIdToken(parsed, keys, pin, provider, settings, proof, { ...tokens, code }, now())
    const authenticatedAt = claims.auth_time * 1000
    insist(Number.isSafeInteger(claims.auth_time) && authenticatedAt <= now() && authenticatedAt > now() - 300000 && now() < proof.expiresAt, 'stale_authentication', 403)
    const mfa = Array.isArray(claims.amr) && claims.amr.includes('mfa') || ['https://refeds.org/profile/mfa', 'urn:oasis:names:tc:SAML:2.0:ac:classes:TimeSyncToken', 'urn:oasis:names:tc:SAML:2.0:ac:classes:SmartcardPKI'].includes(claims.acr)
    const identity: LinkIdentity = { subject: claims.sub, email: claims.email, sourceRole: claims.role, role: mappedRole(config, claims.role), authenticatedAt, mfa }
    const policy = await mfaPolicy(env)
    insist(mfa || !(policy.scope === 'all' || policy.scope === 'roles' && policy.roles.includes(identity.role)), 'idp_mfa_required', 403)
    if (proof.link) {
      await checkLinkIdentity(env, proof.link, identity)
      await requestLink(env, request, proof.link, identity)
      return redirect('/app/security?notice=Provider+identity+proved.+Ask+the+owner+to+approve+within+five+minutes.', [cookie(env, state!, '', 0)])
    }
    const user = await one(env, `SELECT s.*,m.role,m.status FROM nc_scim_users s JOIN nc_members m ON m.id=s.member_id WHERE s.external_id=? AND s.active=1 AND m.status='active'`, identity.subject)
    insist(user && user.email === identity.email && user.role === identity.role && user.source_role === identity.sourceRole, 'not_provisioned', 403)
    const auth = operatorAuth(env)
    const completed = await auth.admission.admit(request, { issuer: config.issuer, subject: identity.subject, associatedEmail: user.email }, { returnTo: '/app' })
    try {
      await commit(env, [guard(env, 'stale', `EXISTS(SELECT 1 FROM nc_scim_users s JOIN nc_members m ON m.id=s.member_id WHERE s.id=? AND s.active=1 AND s.revision=? AND m.status='active' AND m.role=?) AND EXISTS(SELECT 1 FROM nc_sso_config WHERE revision=?)`, user.id, user.revision, user.role, config.revision),
        guard(env, 'idp_mfa_required', "?=1 OR NOT EXISTS(SELECT 1 FROM nc_mfa_policy WHERE scope='all' OR scope='roles' AND instr(' '||roles||' ',' '||?||' ')>0)", mfa ? 1 : 0, user.role),
        ...(mfa ? [stmt(env, "INSERT INTO nc_mfa_sessions(session_id,member_id,verified_at,method) VALUES(?,?,?,'oidc')", completed.session.id, user.member_id, authenticatedAt)] : [])],
      { actor: user.email, action: 'sso.signin', subject: user.member_id, detail: { protocol: 'oidc', mfa, authenticatedAt } })
    } catch (error) { await auth.accounts.revokeSession(completed.session.id); throw error }
    return redirect('/app', [cookie(env, state!, '', 0), completed.cookie])
  } catch (error: any) {
    return Response.json({ error: error.code ?? 'oidc_assertion_refused' }, { status: error.status ?? 403, headers: { 'cache-control': 'no-store' } })
  }
}
