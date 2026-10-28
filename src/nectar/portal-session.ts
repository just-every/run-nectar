// PORT-005: installation-signed, short-lived, revocable customer capabilities.
// Never resolve an operator Actor from one of these tokens.
import type { Bindings } from '../auth.server'
import { clockInstant } from './clock'
import { insist, one, sha256Hex, type Row } from './core'
import { b64url, fromB64url } from './mfa-crypto'

export const PORTAL_LIFETIME = 15 * 60 * 1000
export type PortalClaims = { v: 1; iss: string; jti: string; customer: string; origin: string; audience: 'embedded' | 'hosted'; parent: string; iat: number; exp: number }
export type CustomerSession = PortalClaims & { language: string; currency: string; contactId: string | null; emailHash: string | null; contactEmail: string | null }

async function signingKey(env: Bindings) {
  insist(env.PORTAL_KEY && env.PORTAL_KEY.length >= 32, 'portal_key_missing', 503)
  return crypto.subtle.importKey('raw', new TextEncoder().encode(env.PORTAL_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

export async function signPortalSession(env: Bindings, claims: PortalClaims) {
  const body = b64url(new TextEncoder().encode(JSON.stringify(claims)))
  const mac = await crypto.subtle.sign('HMAC', await signingKey(env), new TextEncoder().encode(`nectar-portal-v1.${body}`))
  return `${body}.${b64url(new Uint8Array(mac))}`
}

export async function portalContactBinding(env: Bindings, row: Row) {
  if(row.email_hash===null){insist(row.contact_id===null,'invalid_customer_session',401);return {contactId:null,emailHash:null,contactEmail:null}}
  const customer=await one(env,`SELECT c.status,c.erased_at,CASE WHEN ? IS NULL THEN c.billing_email ELSE bc.email END AS email
    FROM nc_customers c LEFT JOIN nc_contacts bc ON bc.id=? AND bc.customer_id=c.id AND bc.role='billing' WHERE c.id=?`,row.contact_id,row.contact_id,row.customer_id)
  const email=typeof customer?.email==='string'?customer.email.trim().toLowerCase():''
  insist(customer?.status==='active'&&!customer.erased_at&&email&&await sha256Hex(email)===row.email_hash,'invalid_customer_session',401)
  return {contactId:row.contact_id as string|null,emailHash:row.email_hash as string,contactEmail:email}
}

/** This is the only entrance to customer data, shared by HTML and JSON. */
export async function customerSession(env: Bindings, request: Request): Promise<CustomerSession> {
  const url = new URL(request.url), tokens = url.searchParams.getAll('session')
  insist(tokens.length === 1 && tokens[0].length <= 2048, 'invalid_customer_session', 401)
  const token = tokens[0], parts = token.split('.')
  insist(parts.length === 2 && parts.every(part => /^[A-Za-z0-9_-]+$/.test(part)), 'invalid_customer_session', 401)
  let claims: PortalClaims
  try {
    insist(await crypto.subtle.verify('HMAC', await signingKey(env), fromB64url(parts[1]) as BufferSource, new TextEncoder().encode(`nectar-portal-v1.${parts[0]}`)), 'invalid_customer_session', 401)
    claims = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])))
    insist(claims && typeof claims === 'object' && !Array.isArray(claims) && ['iss','jti','customer','origin','audience','parent'].every(key => typeof (claims as unknown as Row)[key] === 'string'), 'invalid_customer_session', 401)
  } catch { insist(false, 'invalid_customer_session', 401) }
  const at = clockInstant(env)
  insist(claims!.v === 1 && claims!.iss === env.AUTH_ORIGIN && claims!.origin === url.origin && ['embedded','hosted'].includes(claims!.audience) && Number.isSafeInteger(claims!.iat) && Number.isSafeInteger(claims!.exp) && claims!.iat <= at && claims!.exp > at && claims!.exp - claims!.iat === PORTAL_LIFETIME, 'invalid_customer_session', 401)
  const row = await one<Row>(env, `SELECT s.*, c.language,c.currency,c.status AS customer_status, CASE WHEN s.contact_id IS NULL THEN c.billing_email ELSE bc.email END AS current_email FROM nc_portal_sessions s JOIN nc_customers c ON c.id=s.customer_id LEFT JOIN nc_contacts bc ON bc.id=s.contact_id AND bc.customer_id=c.id AND bc.role='billing' JOIN nc_portal_policy p ON p.singleton=1 AND p.revision=s.policy_revision
    WHERE s.id=? AND s.customer_id=? AND s.token_hash=? AND s.origin=? AND s.audience=? AND s.parent_origin=? AND s.issued_at=? AND s.expires_at=? AND s.revoked_at IS NULL AND c.erased_at IS NULL
      AND (s.email_hash IS NULL OR NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(s.id,c.id)))
      AND NOT EXISTS(SELECT 1 FROM nc_dunning_mail_authority a JOIN nc_dunning_deliveries d ON d.id=a.id WHERE a.portal_session_id=s.id AND d.expires_at<=?)
      AND NOT EXISTS(SELECT 1 FROM nc_card_expiry_notice_authority a JOIN nc_card_expiry_notices n ON n.id=a.id WHERE a.portal_session_id=s.id AND n.expires_at<=?)`,
    claims!.jti, claims!.customer, await sha256Hex(token), claims!.origin, claims!.audience, claims!.parent, claims!.iat, claims!.exp, at, at)
  insist(row, 'invalid_customer_session', 401)
  if (row.email_hash !== null) {
    insist(row.customer_status === 'active' && typeof row.current_email === 'string' && row.current_email.trim() !== '' && await sha256Hex(row.current_email.trim().toLowerCase()) === row.email_hash, 'invalid_customer_session', 401)
  } else insist(row.contact_id === null, 'invalid_customer_session', 401)
  return { ...claims!, language: row.language, currency: row.currency, contactId: row.contact_id, emailHash: row.email_hash, contactEmail: row.email_hash === null ? null : row.current_email.trim().toLowerCase() }
}
