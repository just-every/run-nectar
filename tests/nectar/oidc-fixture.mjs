import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, createHash, sign } from 'node:crypto'

// The provider's actual discovery, code exchange and signed identity-token
// responses are substituted only at the Worker's outbound network edge.
export function oidcFixture() {
  const issuer = 'https://identity.nectar-app.com', clientId = 'synthetic-nectar-client', secret = 'synthetic-nectar-secret'
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const codes = new Map(), traffic = []
  let tokenChanges = {}, discoveryChanges = {}, afterExchange
  const endpoints = { authorization: issuer + '/authorize', token: issuer + '/token', jwks: issuer + '/keys' }
  const json = value => Response.json(value)
  return {
    issuer, clientId, secret, traffic,
    provider: { preset: 'okta', issuer, clientId, tokenAuthMethod: 'client_secret_basic' },
    changeToken(value = {}) { tokenChanges = value },
    changeDiscovery(value = {}) { discoveryChanges = value },
    afterExchange(fn) { afterExchange = fn },
    authorize(target, claims = {}) {
      const url = new URL(target), params = Object.fromEntries(url.searchParams)
      assert.equal(url.origin + url.pathname, endpoints.authorization)
      assert.equal(params.response_type, 'code')
      assert.equal(params.client_id, clientId)
      assert.equal(params.code_challenge_method, 'S256')
      const code = 'synthetic-nectar-' + randomBytes(16).toString('hex')
      codes.set(code, { params, claims })
      return new URL(params.redirect_uri + '?' + new URLSearchParams({ state: params.state, code, iss: issuer }))
    },
    async fetch(request) {
      const url = new URL(request.url); traffic.push(url.pathname)
      if (url.pathname === '/.well-known/openid-configuration') return json({ issuer, authorization_endpoint: endpoints.authorization, token_endpoint: endpoints.token, jwks_uri: endpoints.jwks, response_types_supported: ['code'], id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_basic'], code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: true, ...discoveryChanges })
      if (url.pathname === '/keys') return json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'synthetic-nectar-key', use: 'sig', alg: 'RS256' }] })
      assert.equal(url.pathname, '/token', 'Only the pinned token endpoint receives credentials')
      assert.equal(request.headers.get('authorization'), 'Basic ' + Buffer.from(clientId + ':' + secret).toString('base64'))
      const form = new URLSearchParams(await request.text()), value = codes.get(form.get('code'))
      if (!value) return Response.json({ error: 'invalid_grant' }, { status: 400 })
      codes.delete(form.get('code'))
      assert.equal(form.get('redirect_uri'), value.params.redirect_uri)
      assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), value.params.code_challenge, 'Provider verifies actual PKCE')
      const at = Math.floor(Date.now() / 1000), changes = { ...tokenChanges, ...value.claims }
      const header = { alg: 'RS256', kid: 'synthetic-nectar-key', typ: 'JWT', ...changes.header }
      const claims = { iss: issuer, sub: 'synthetic-nectar-oidc', aud: clientId, iat: at, exp: at + 180, auth_time: at, nonce: value.params.nonce, role: 'billing', ...changes }
      delete claims.header; delete claims.forged
      const input = [header, claims].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.')
      const signature = sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')
      const token = input + '.' + (changes.forged ? signature.replace(/^./, signature[0] === 'A' ? 'B' : 'A') : signature)
      await afterExchange?.()
      return json({ id_token: token, access_token: 'synthetic-nectar-access', refresh_token: 'synthetic-nectar-refresh', token_type: 'Bearer' })
    },
  }
}
