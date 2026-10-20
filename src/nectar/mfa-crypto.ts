// GOV-007 primitives: RFC 6238 authenticator codes (SHA-1, 6 digits, 30-second
// steps), sealing of authenticator secrets under the installation's MFA_KEY
// (HKDF-SHA-256 to AES-256-GCM, bound to the factor and member), and one-time
// recovery codes kept only as SHA-256 hashes.
import { sha256Hex } from './core'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
export const STEP_SECONDS = 30

export function base32(bytes: Uint8Array) {
  let bits = 0, value = 0, out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5 }
  }
  return bits > 0 ? out + ALPHABET[(value << (5 - bits)) & 31] : out
}

export function fromBase32(text: string) {
  const bytes: number[] = []
  let bits = 0, value = 0
  for (const char of text.replace(/[\s=]/g, '').toUpperCase()) {
    const index = ALPHABET.indexOf(char)
    if (index < 0) throw new Error('invalid_base32')
    value = (value << 5) | index; bits += 5
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8 }
  }
  return new Uint8Array(bytes)
}

export const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export function fromB64url(text: string) {
  const plain = text.replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(plain + '='.repeat((4 - plain.length % 4) % 4)), char => char.charCodeAt(0))
}

/** The 6-digit code for one 30-second step. */
export async function totpAt(secret: Uint8Array, step: number) {
  const counter = new Uint8Array(8)
  new DataView(counter.buffer).setBigUint64(0, BigInt(step))
  const key = await crypto.subtle.importKey('raw', secret as BufferSource, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter))
  const offset = mac[19] & 15
  const binary = ((mac[offset] & 127) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3]
  return String(binary % 1_000_000).padStart(6, '0')
}

/** The matching step within one step either side of `instant`, or null. */
export async function matchTotp(secret: Uint8Array, code: string, instant: number) {
  const current = Math.floor(instant / 1000 / STEP_SECONDS)
  for (const step of [current, current - 1, current + 1]) if (await totpAt(secret, step) === code) return step
  return null
}

async function sealingKey(mfaKey: string) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(mfaKey), 'HKDF', false, ['deriveKey'])
  return await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('nectar-mfa'), info: new TextEncoder().encode('totp-secret-v1') }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

/** `v1.<iv>.<ciphertext>`, readable only under the same MFA_KEY and the same factor and member. */
export async function seal(mfaKey: string, secret: Uint8Array, binding: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(binding) }, await sealingKey(mfaKey), secret as BufferSource))
  return `v1.${b64url(iv)}.${b64url(sealed)}`
}

/** The secret, or null when the key is missing or is not the one it was sealed under. */
export async function unseal(mfaKey: string | undefined, sealed: string, binding: string) {
  const [version, iv, body] = sealed.split('.')
  if (!mfaKey || version !== 'v1' || !iv || !body) return null
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64url(iv) as BufferSource, additionalData: new TextEncoder().encode(binding) }, await sealingKey(mfaKey), fromB64url(body) as BufferSource))
  } catch { return null }
}

export const RECOVERY_CODES = 10
export const normalizeRecovery = (code: string) => code.toUpperCase().replace(/[^A-Z2-7]/g, '')
export const recoveryHash = (code: string) => sha256Hex(`nectar-recovery:${normalizeRecovery(code)}`)
export function recoveryCode() {
  const text = base32(crypto.getRandomValues(new Uint8Array(7))).slice(0, 10)
  return `${text.slice(0, 5)}-${text.slice(5)}`
}
