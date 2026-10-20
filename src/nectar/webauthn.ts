// GOV-007 passkeys: verifies WebAuthn registrations and assertions with Web
// Crypto. Registration accepts any attestation format without checking the
// authenticator's maker (Nectar never claims an attested device); the public
// key, the relying-party id hash, the challenge, the origin and the
// user-presence flag are always checked. ES256 and RS256 keys are accepted.
import { insist, sha256Hex } from './core'
import { b64url, fromB64url } from './mfa-crypto'

type Cbor = number | bigint | string | boolean | null | Uint8Array | Cbor[] | Map<Cbor, Cbor>

/** A minimal CBOR reader for attestation objects and COSE keys. Returns the value and the offset after it. */
export function cbor(bytes: Uint8Array, start = 0): [Cbor, number] {
  let at = start
  const initial = bytes[at++], major = initial >> 5, info = initial & 31
  const length = () => {
    if (info < 24) return info
    const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0
    insist(size > 0, 'invalid_passkey')
    let value = 0
    for (let i = 0; i < size; i++) value = value * 256 + bytes[at++]
    return value
  }
  if (major === 7) return [info === 20 ? false : info === 21 ? true : null, at]
  const n = length()
  if (major === 0) return [n, at]
  if (major === 1) return [-1 - n, at]
  if (major === 2) return [bytes.slice(at, at + n), at + n]
  if (major === 3) return [new TextDecoder().decode(bytes.slice(at, at + n)), at + n]
  if (major === 4) { const items: Cbor[] = []; for (let i = 0; i < n; i++) { const [item, next] = cbor(bytes, at); items.push(item); at = next } return [items, at] }
  if (major === 5) { const map = new Map<Cbor, Cbor>(); for (let i = 0; i < n; i++) { const [key, next] = cbor(bytes, at); const [value, after] = cbor(bytes, next); map.set(key, value); at = after } return [map, at] }
  throw new Error('invalid_passkey')
}

interface AuthData { rpIdHash: Uint8Array; flags: number; signCount: number; credentialId?: Uint8Array; publicKey?: JsonWebKey }

function authData(bytes: Uint8Array): AuthData {
  insist(bytes.length >= 37, 'invalid_passkey')
  const flags = bytes[32], signCount = new DataView(bytes.buffer, bytes.byteOffset + 33, 4).getUint32(0)
  const parsed: AuthData = { rpIdHash: bytes.slice(0, 32), flags, signCount }
  if (flags & 0x40) {
    const idLength = (bytes[53] << 8) | bytes[54]
    parsed.credentialId = bytes.slice(55, 55 + idLength)
    const [key] = cbor(bytes, 55 + idLength)
    parsed.publicKey = coseToJwk(key)
  }
  return parsed
}

function coseToJwk(key: Cbor): JsonWebKey {
  insist(key instanceof Map, 'invalid_passkey')
  const bytes = (label: number) => { const value = key.get(label); insist(value instanceof Uint8Array, 'invalid_passkey'); return b64url(value) }
  if (key.get(1) === 2 && key.get(3) === -7 && key.get(-1) === 1) return { kty: 'EC', crv: 'P-256', x: bytes(-2), y: bytes(-3), alg: 'ES256' }
  if (key.get(1) === 3 && key.get(3) === -257) return { kty: 'RSA', n: bytes(-1), e: bytes(-2), alg: 'RS256' }
  throw new Error('unsupported_passkey_algorithm')
}

const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')

async function clientData(text: string, type: string, challenge: string, origin: string) {
  let data: { type?: string; challenge?: string; origin?: string }
  try { data = JSON.parse(new TextDecoder().decode(fromB64url(text))) } catch { throw new Error('invalid_passkey') }
  insist(data.type === type, 'invalid_passkey')
  insist(data.challenge === challenge, 'passkey_challenge_mismatch', 403)
  insist(data.origin === origin, 'passkey_origin_mismatch', 403)
}

async function checkAuthData(data: AuthData, rpId: string) {
  insist(hex(data.rpIdHash) === await sha256Hex(rpId), 'passkey_rp_mismatch', 403)
  insist(data.flags & 0x01, 'passkey_user_not_present', 403)
}

export interface Registration { credentialId: string; publicKey: JsonWebKey; signCount: number }

export async function verifyRegistration(input: { clientDataJSON: string; attestationObject: string }, expected: { challenge: string; origin: string; rpId: string }): Promise<Registration> {
  await clientData(input.clientDataJSON, 'webauthn.create', expected.challenge, expected.origin)
  const [attestation] = cbor(fromB64url(input.attestationObject))
  insist(attestation instanceof Map && attestation.get('authData') instanceof Uint8Array, 'invalid_passkey')
  const data = authData(attestation.get('authData') as Uint8Array)
  await checkAuthData(data, expected.rpId)
  insist(data.credentialId && data.publicKey, 'invalid_passkey')
  return { credentialId: b64url(data.credentialId), publicKey: data.publicKey, signCount: data.signCount }
}

// WebAuthn ES256 signatures are DER; Web Crypto verifies raw r||s.
function derToRaw(der: Uint8Array) {
  insist(der[0] === 0x30, 'invalid_passkey')
  let at = 2
  const part = () => { insist(der[at] === 0x02, 'invalid_passkey'); const length = der[at + 1]; let value = der.slice(at + 2, at + 2 + length); at += 2 + length; while (value.length > 32 && value[0] === 0) value = value.slice(1); const out = new Uint8Array(32); out.set(value, 32 - value.length); return out }
  const r = part(), s = part(), raw = new Uint8Array(64)
  raw.set(r); raw.set(s, 32)
  return raw
}

/** Verifies an assertion against the stored key; returns the authenticator's new signature counter. */
export async function verifyAssertion(input: { clientDataJSON: string; authenticatorData: string; signature: string }, stored: { publicKey: JsonWebKey; signCount: number }, expected: { challenge: string; origin: string; rpId: string }) {
  await clientData(input.clientDataJSON, 'webauthn.get', expected.challenge, expected.origin)
  const rawAuth = fromB64url(input.authenticatorData)
  const data = authData(rawAuth)
  await checkAuthData(data, expected.rpId)
  const signed = new Uint8Array(rawAuth.length + 32)
  signed.set(rawAuth); signed.set(new Uint8Array(await crypto.subtle.digest('SHA-256', fromB64url(input.clientDataJSON) as BufferSource)), rawAuth.length)
  const ec = stored.publicKey.kty === 'EC'
  const key = await crypto.subtle.importKey('jwk', stored.publicKey, ec ? { name: 'ECDSA', namedCurve: 'P-256' } : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
  const signature = fromB64url(input.signature)
  const ok = await crypto.subtle.verify(ec ? { name: 'ECDSA', hash: 'SHA-256' } : 'RSASSA-PKCS1-v1_5', key, (ec ? derToRaw(signature) : signature) as BufferSource, signed as BufferSource)
  insist(ok, 'passkey_signature_invalid', 403)
  // A counter that stops increasing means a cloned authenticator; zero means the authenticator keeps none.
  insist(data.signCount === 0 && stored.signCount === 0 || data.signCount > stored.signCount, 'passkey_counter_replayed', 403)
  return data.signCount
}
