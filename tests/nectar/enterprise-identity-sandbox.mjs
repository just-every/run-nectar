// Outside Verify, using only the held Integrator organization. No secret or
// assertion is printed or persisted. All identities and the app are removed.
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { harness } from './harness.mjs'
const origin = process.env.OKTA_ORG_URL?.replace(/\/$/, ''), token = process.env.OKTA_API_TOKEN
const check = (condition, code) => { if (!condition) throw new Error(code) }
check(origin && token && /^https:\/\/[^/]+\.okta(?:preview|-emea)?\.com$/.test(origin), 'held_okta_configuration_required')
const result = { head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), provider: 'Okta Integrator', checks: [], cleanup: [] }
let phase = 'worker', h, app, group, user, failed = false
const suffix = randomBytes(6).toString('hex'), label = 'nectar-c-i821-' + suffix
async function okta(path, method = 'GET', body) {
  const response = await fetch(origin + path, { method, headers: { authorization: 'SSWS ' + token, 'content-type': 'application/json', accept: 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const text = await response.text()
  if (!response.ok) { if (phase === 'owned_app') { try { const error = JSON.parse(text); console.error(JSON.stringify({appConfigurationError: error.errorCauses?.map(cause => cause.errorSummary)})) } catch {} } let code; try { code = JSON.parse(text).errorCode } catch {} throw new Error('okta_' + response.status + '_' + (/^[A-Z0-9]+$/.test(code) ? code : 'request_refused')) }
  if (!text) return null
  try { return JSON.parse(text) } catch { return text }
}
async function api(path, owner, body, status = 200) {
  const response = await h.raw('/api/nectar/' + path, { cookie: owner, body })
  check(response.status === status, 'nectar_' + path.replace(/[^a-z.]/g, '_') + '_' + response.status)
  return response.json()
}
async function scim(path, credential, method, body, status) {
  const response = await h.raw('/scim/v2/Users' + path, { method, body, headers: { authorization: 'Bearer ' + credential } })
  check(response.status === status, 'scim_' + response.status)
  return response.status === 204 ? null : response.json()
}
try {
  h = await harness()
  check((await h.raw('/auth/bootstrap', { body: { token: h.vars.SETUP_TOKEN, displayName: 'Nectar owner' } })).status === 303, 'owner_bootstrap')
  const owner = await h.signIn(h.vars.OWNER_EMAIL)
  phase = 'owned_group'
  group = await okta('/api/v1/groups', 'POST', { profile: { name: label, description: 'Temporary Nectar enterprise identity sandbox' } })
  phase = 'owned_app'
  app = await okta('/api/v1/apps?activate=true', 'POST', { label, signOnMode: 'SAML_2_0', visibility: { autoSubmitToolbar: false, hide: { iOS: false, web: false } }, settings: { signOn: {
    ssoAcsUrl: h.origin + '/sso/acs', recipient: h.origin + '/sso/acs', destination: h.origin + '/sso/acs', audience: h.origin + '/sso/metadata',
    idpIssuer: 'http://www.okta.com/${org.externalKey}', subjectNameIdTemplate: '${user.id}', subjectNameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
    responseSigned: true, assertionSigned: true, signatureAlgorithm: 'RSA_SHA256', digestAlgorithm: 'SHA256', honorForceAuthn: true,
    authnContextClassRef: 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport', requestCompressed: true,
    attributeStatements: [{ type: 'EXPRESSION', namespace: 'urn:oasis:names:tc:SAML:2.0:attrname-format:unspecified', name: 'email', values: ['user.email'] }, { type: 'EXPRESSION', namespace: 'urn:oasis:names:tc:SAML:2.0:attrname-format:unspecified', name: 'role', values: [`isMemberOfGroup("${group.id}") ? "billing" : "none"`] }, { type: 'EXPRESSION', namespace: 'urn:oasis:names:tc:SAML:2.0:attrname-format:unspecified', name: 'amr', values: ['session.amr'] }],
  } } })
  await okta('/api/v1/apps/' + app.id + '/groups/' + group.id, 'PUT', {})
  phase = 'owned_user'
  const email = label + '@example.test', password = 'Rer!' + randomBytes(24).toString('base64url') + '8a'
  user = await okta('/api/v1/users?activate=true', 'POST', { profile: { firstName: 'Nectar', lastName: 'Sandbox', login: email, email }, credentials: { password: { value: password } }, groupIds: [group.id] })
  check(user.status === 'ACTIVE', 'okta_user_not_active')
  phase = 'metadata'
  const metadata = await okta('/api/v1/apps/' + app.id + '/sso/saml/metadata?kid=' + encodeURIComponent(app.credentials.signing.kid))
  const issuer = metadata.match(/entityID="([^"]+)"/)?.[1], certificate = metadata.match(/<(?:\w+:)?X509Certificate[^>]*>([^<]+)</)?.[1], entry = metadata.match(/<(?:\w+:)?SingleSignOnService[^>]*Location="([^"]+)"/)?.[1]
  check(issuer && certificate && entry, 'okta_metadata_missing')
  const pem = ['-----BEGIN ' + 'CERTIFICATE-----', certificate, '-----END ' + 'CERTIFICATE-----'].join('\n')
  const configured = await api('sso.configure', owner, { issuer, entry_point: entry.replaceAll('&amp;', '&'), certificate: pem, role_map: { billing: 'accountant' }, revision: 0 })
  const provisioned = await scim('', configured.scim_token, 'POST', { externalId: user.id, userName: email, displayName: 'Okta billing analyst', roles: [{ value: 'billing' }], active: true }, 201)
  result.checks.push('held org SAML app and per-seed group, SCIM-created mapped account')
  async function assertion() {
    phase = 'okta_password_authentication'
    const authentication = await okta('/api/v1/authn', 'POST', { username: email, password })
    check(authentication.status === 'SUCCESS' && authentication.sessionToken, 'okta_interaction_' + authentication.status)
    const start = await h.raw('/sso/start'), target = new URL(start.headers.get('location'))
    check(target.origin === origin, 'unexpected_saml_destination')
    const binding = start.headers.getSetCookie().map(line => line.split(';')[0]).join('; ')
    target.searchParams.set('sessionToken', authentication.sessionToken)
    phase = 'okta_signed_response'
    const response = await fetch(target, { redirect: 'follow' }), html = await response.text()
    const encoded = html.match(/name="SAMLResponse"[^>]*value="([^"]+)"/)?.[1] ?? html.match(/value="([^"]+)"[^>]*name="SAMLResponse"/)?.[1]
    check(response.ok && encoded, 'okta_saml_interaction_required')
    const relay = target.searchParams.get('RelayState')
    const posted = await h.raw('/sso/acs', { form: new URLSearchParams({ SAMLResponse: encoded.replaceAll('&#x2b;', '+').replaceAll('&#x3d;', '=').replaceAll('&#43;', '+').replaceAll('&#61;', '='), RelayState: relay }) })
    return { binding, posted }
  }
  const signed = await assertion()
  phase = 'native_saml_session'
  check(signed.posted.status === 303, 'live_saml_assertion_refused')
  const finished = await h.raw(signed.posted.headers.get('location'), { cookie: signed.binding })
  check(finished.status === 303, 'live_saml_finish_refused')
  const member = finished.headers.getSetCookie().map(line => line.split(';')[0]).join('; ')
  check((await api('me', member)).role === 'accountant', 'live_role_mismatch')
  result.checks.push('authentic Okta signed response, browser binding, native mapped-role session')
  phase = 'required_mfa_refusal'
  await api('mfa.policy', owner, { scope: 'roles', roles: ['accountant'] })
  check((await assertion()).posted.status === 403, 'password_only_assertion_not_refused')
  result.checks.push('GOV-007 required: authentic password-only Okta assertion refused')
  phase = 'deprovision'
  const began = performance.now()
  await scim('/' + provisioned.id, configured.scim_token, 'PATCH', { Operations: [{ op: 'replace', path: 'active', value: false }] }, 200)
  await api('me', member, undefined, 401)
  check(performance.now() - began < 60000, 'deprovision_deadline')
  result.checks.push('SCIM deprovisioning ends existing native session within one minute')
  result.orgReference = createHash('sha256').update(origin).digest('hex').slice(0, 16)
} catch (error) {
  failed = true
  result.failure = { phase, code: /^[a-zA-Z0-9_.-]+$/.test(error.message) ? error.message : 'sandbox_failure' }
} finally {
  for (const [kind, value] of [['user', user], ['app', app], ['group', group]]) {
    if (!value?.id) continue
    try {
      if (kind === 'user') { await okta('/api/v1/users/' + value.id + '/lifecycle/deactivate?sendEmail=false', 'POST'); await okta('/api/v1/users/' + value.id, 'DELETE') }
      if (kind === 'app') { await okta('/api/v1/apps/' + value.id + '/lifecycle/deactivate', 'POST'); await okta('/api/v1/apps/' + value.id, 'DELETE') }
      if (kind === 'group') await okta('/api/v1/groups/' + value.id, 'DELETE')
      result.cleanup.push(kind + ' removed')
    } catch { failed = true; result.cleanup.push(kind + ' cleanup failed') }
  }
  await h?.close()
  result.status = failed ? 'failed' : 'passed'
  console.log(JSON.stringify(result))
  if (failed) process.exitCode = 1
}
