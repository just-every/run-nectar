import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { oidcFixture } from './oidc-fixture.mjs'
import { totp } from './mfa.mjs'
const idp = oidcFixture()
export const harnessOptions = () => ({ identityFetch: request => idp.fetch(request), settings: { SSO_OIDC_SECRET: idp.secret, SSO_OIDC_TRANSACTION_SECRET: randomBytes(32).toString('base64url') } })
const address = n => ['synthetic-nectar-' + n, 'example.test'].join(String.fromCharCode(64))
const cookies = response => response.headers.getSetCookie().map(line => line.split(';')[0]).join('; ')

export async function enterpriseOidcFlow(h, owner, { onState } = {}) {
  const settings = { provider: idp.provider, role_map: { billing: 'accountant', ops: 'finance' }, revision: 0 }
  await h.api('sso.oidc.configure', undefined, settings, 401)
  await h.api('sso.oidc.configure', owner, settings, 403)
  const at = Date.now()
  await h.advanceClock(new Date(at).toISOString())
  const factor = await h.api('mfa.totp.start', owner, { label: 'Enterprise connection consent' })
  await h.api('mfa.totp.confirm', owner, { factor: factor.factor, code: totp(factor.secret, at) })
  await h.api('sso.oidc.configure', owner, { ...settings, role_map: { billing: 'owner' } }, 400)
  await h.api('sso.oidc.configure', owner, { ...settings, role_map: { billing: 'custom' } }, 400)
  let configured = await h.api('sso.oidc.configure', owner, settings)
  const scim = async (path = '', { body, method = 'GET', status = 200, token = configured.scim_token } = {}) => {
    const response = await h.raw('/scim/v2/Users' + path, { method, body, headers: { authorization: 'Bearer ' + token } })
    assert.equal(response.status, status)
    return status === 204 ? null : response.json()
  }
  const email = address(201)
  const user = await scim('', { method: 'POST', body: { externalId: 'synthetic-nectar-oidc', userName: email, roles: [{ value: 'billing' }] }, status: 201 })
  const begin = async (options = {}) => {
    const response = await h.raw((options.publicStart ? '/sso/start' : '/sso/oidc/start') + (options.link ? '?link=1' : ''), { ...(options.publicStart ? {} : { body: {} }), cookie: options.cookie })
    assert.equal(response.status, 303, 'OIDC start returns the pinned provider')
    return { response, binding: cookies(response), callback: idp.authorize(response.headers.get('location'), { email, ...options.claims }) }
  }
  const finish = (start, options = {}) => h.raw(start.callback.pathname + start.callback.search, { cookie: options.cookie ?? start.binding })
  const signIn = async (claims = {}, expected = 303) => {
    const start = await begin({ claims }), response = await finish(start)
    assert.equal(response.status, expected, 'Signed OIDC response status: ' + (response.status === expected ? '' : await response.text()))
    return { start, response, session: cookies(response) }
  }
  assert.equal((await h.raw('/sso/oidc/start', { body: {}, headers: { origin: 'https://foreign.nectar-app.com' } })).status, 403)
  assert.equal((await h.raw('/sso/start', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403)
  const browserBound = await begin({ publicStart: true })
  assert.equal((await finish(browserBound, { cookie: 'synthetic-nectar-unbound' })).status, 403)
  const first = await finish(browserBound)
  assert.equal(first.status, 303)
  const member = cookies(first)
  assert.equal((await h.api('me', member)).role, 'accountant')
  await h.api('customers', member)
  await h.api('customer.create', member, {}, 403)
  await h.api('sso.oidc.configure', member, settings, 403)
  assert.equal((await finish(browserBound)).status, 403, 'A callback is single-use')
  assert.equal((await h.raw('/auth/magic-link', { body: { email } })).status, 403)
  for (const claims of [
    { sub: 'synthetic-nectar-email-only' }, { role: 'ops' }, { role: 'owner' },
    { aud: 'synthetic-nectar-foreign-client' }, { iss: 'https://foreign.nectar-app.com' },
    { nonce: 'synthetic-nectar-wrong-nonce' }, { auth_time: Math.floor(Date.now() / 1000) - 600 },
    { auth_time: null }, { auth_time: Math.floor(Date.now() / 1000) + 600 },
    { exp: Math.floor(Date.now() / 1000) - 10 }, { forged: true }, { header: { alg: 'HS256' } },
  ]) await signIn(claims, 403)
  const replay = await begin()
  const replies = await Promise.all([finish(replay), finish(replay)])
  assert.deepEqual(replies.map(row => row.status).sort(), [303, 403], 'Concurrent callback consumes one durable claim')
  await h.api('mfa.policy', owner, { scope: 'roles', roles: ['accountant'] })
  await signIn({}, 403)
  await signIn({ amr: ['pwd'], acr: 'generic-success' }, 403)
  const authenticated = Math.floor(Date.now() / 1000) - 30
  const strong = await signIn({ amr: ['pwd', 'mfa'], auth_time: authenticated })
  assert.equal((await h.api('me', strong.session)).role, 'accountant')
  const standing = await h.api('mfa', strong.session)
  assert.equal(standing.state, null, 'A signed actual MFA result satisfies GOV-007')
  assert.equal(standing.verified_at, authenticated * 1000, 'Receipt never refreshes provider authentication time')
  await onState?.({ label: 'oidc-managed', session: strong.session })
  const auditBefore = (await h.api('audit', owner)).filter(row => row.action === 'sso.signin').length
  await h.rejectAudit('sso.signin')
  await signIn({ amr: ['mfa'] }, 500)
  await h.rejectAudit(null)
  assert.equal((await h.api('audit', owner)).filter(row => row.action === 'sso.signin').length, auditBefore)
  const flight = await begin({ claims: { amr: ['mfa'] } }), started = performance.now()
  await scim('/' + user.id, { method: 'DELETE', status: 204 })
  await h.api('me', member, undefined, 401)
  await h.api('me', strong.session, undefined, 401)
  assert.equal((await finish(flight)).status, 403)
  assert.ok(performance.now() - started < 60000)
  await scim('/' + user.id, { method: 'PATCH', body: { Operations: [{ op: 'replace', path: 'active', value: true }] } })
  await h.api('me', strong.session, undefined, 401)
  const renewed = await signIn({ amr: ['mfa'] })
  await onState?.({ label: 'oidc-reactivated', session: renewed.session })

  // The same existing-session and explicit owner approval door binds an OIDC
  // subject; a provider email alone never establishes that account ownership.
  const native = await h.api('access.give', owner, { email: address(202), name: 'Existing analyst', role: 'accountant' })
  const local = await h.signIn(native.email, { requested: true })
  await h.api('mfa.policy', owner, { scope: 'off' })
  const link = await begin({ link: true, cookie: local, claims: { sub: 'synthetic-nectar-linked', email: native.email, amr: ['mfa'] } })
  assert.equal((await finish(link, { cookie: link.binding + '; ' + local })).status, 303)
  const request = (await h.api('sso-links', owner)).find(row => row.member.member === native.id)
  assert.ok(request)
  await h.api('sso.link.approve', owner, { link: request.id, basis: request.basis })
  await h.api('me', local, undefined, 401)
  const linked = await signIn({ sub: 'synthetic-nectar-linked', email: native.email, amr: ['mfa'] })
  assert.equal((await h.api('me', linked.session)).id, native.id, 'OIDC linking preserves member attribution')
  const rotatedFlight = await begin(), oldToken = configured.scim_token
  idp.changeDiscovery({ token_endpoint: idp.issuer + '/other-token' })
  assert.equal((await h.raw('/sso/oidc/start', { body: {} })).status, 403, 'Discovery cannot silently repin endpoints')
  idp.changeDiscovery()
  await h.advanceClock(new Date(at + 960000).toISOString())
  await h.api('sso.oidc.configure', owner, { ...settings, revision: 1 }, 403)
  await h.advanceClock(new Date(at).toISOString())
  configured = await h.api('sso.oidc.configure', owner, { ...settings, revision: 1 })
  await h.api('me', renewed.session, undefined, 401)
  await h.api('me', linked.session, undefined, 401)
  assert.equal((await finish(rotatedFlight)).status, 403, 'Connection changes end pending sign-ins')
  await scim('', { token: oldToken, status: 401 })
  await h.assertStorageExcludes([idp.secret, h.vars.SSO_OIDC_TRANSACTION_SECRET, oldToken, configured.scim_token, 'synthetic-nectar-access', 'synthetic-nectar-refresh'])
  const final = await signIn({ amr: ['mfa'] })
  const pendingMember = await h.api('access.give', owner, { email: address(203), name: 'Pending analyst', role: 'accountant' })
  const pendingSession = await h.signIn(pendingMember.email, { requested: true })
  const pendingProof = await begin({ link: true, cookie: pendingSession, claims: { sub: 'synthetic-nectar-pending-oidc', email: pendingMember.email } })
  assert.equal((await finish(pendingProof, { cookie: pendingProof.binding + '; ' + pendingSession })).status, 303)
  const pending = (await h.api('sso-links', owner)).find(row => row.member.member === pendingMember.id)
  assert.ok(pending)
  console.log('Enterprise OIDC: signed subject, PKCE, role and MFA custody, owner consent, linking, replay, audit rollback and immediate SCIM revocation passed')
  return { pending, member: await h.api('me', final.session), session: final.session }
}
