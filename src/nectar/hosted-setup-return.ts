// Operational return custody only: never retain or reconstruct a portal token.
import type { Bindings } from '../auth.server'
import { clockInstant } from './clock'
import { guard, insist, one, sha256Hex, stmt, type Row } from './core'
import { b64url } from './mfa-crypto'
import { PORTAL_LIFETIME, type CustomerSession } from './portal-session'

export type SetupReturn = { session: CustomerSession; setup: string; hash: string }

const cookieName = 'nectar_setup_return'
const cookieAttributes = 'Path=/portal/payment-methods; Secure; HttpOnly; SameSite=Lax'
export const clearSetupReturnCookie = `${cookieName}=; ${cookieAttributes}; Max-Age=0`

// Both resolution and transaction guards use the same current authority checks.
const source = `FROM nc_hosted_setups s
  JOIN nc_customers c ON c.id=s.customer_id
  JOIN nc_stripe_customer_bindings b ON b.id=s.binding_id AND b.customer_id=c.id AND b.revision=s.binding_revision
  JOIN nc_portal_sessions p ON p.customer_id=c.id
  JOIN nc_portal_policy policy ON policy.singleton=1 AND policy.revision=p.policy_revision`
const currentBasis = `c.erased_at IS NULL AND c.status='active' AND c.revision=s.customer_revision AND b.account_ref=s.account_ref AND b.stripe_customer_ref=s.customer_ref AND s.livemode=0
  AND p.revoked_at IS NULL AND p.audience='hosted' AND p.parent_origin=''
  AND p.issued_at<=? AND p.expires_at>? AND p.expires_at-p.issued_at=?
  AND EXISTS(SELECT 1 FROM json_each(policy.hosts_json) WHERE value=p.origin)
  AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(s.id,c.id,b.id,p.id))
  AND NOT EXISTS(SELECT 1 FROM nc_dunning_mail_authority a JOIN nc_dunning_deliveries d ON d.id=a.id WHERE a.portal_session_id=p.id AND d.expires_at<=?)`
const sessionBasis = `p.id=? AND p.customer_id=? AND p.origin=? AND p.audience=?
  AND p.parent_origin=? AND p.issued_at=? AND p.expires_at=?`
const returnSource = `FROM nc_hosted_setup_returns r
  JOIN nc_hosted_setups s ON s.id=r.setup_id AND s.customer_id=r.customer_id
  JOIN nc_customers c ON c.id=s.customer_id
  JOIN nc_stripe_customer_bindings b ON b.id=s.binding_id AND b.customer_id=c.id AND b.revision=s.binding_revision
  JOIN nc_portal_sessions p ON p.id=r.portal_session_id AND p.customer_id=c.id
  JOIN nc_portal_policy policy ON policy.singleton=1 AND policy.revision=p.policy_revision`
const liveReturn = `r.id=? AND r.purpose='hosted-setup' AND r.consumed_at IS NULL AND r.expires_at>?
  AND r.expires_at<=p.expires_at AND r.account_ref=b.account_ref AND r.livemode=s.livemode
  AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id=r.id)`

const sessionParams = (session: CustomerSession) => [session.jti, session.customer, session.origin, session.audience, session.parent, session.iat, session.exp]
const timeParams = (at: number) => [at, at, PORTAL_LIFETIME, at]

export async function createSetupReturn(env: Bindings, session: CustomerSession, setup: string, account: string, livemode: boolean) {
  const at = clockInstant(env), expiresAt = Math.min(at + PORTAL_LIFETIME, session.exp)
  insist(session.v === 1 && session.iss === env.AUTH_ORIGIN && session.audience === 'hosted'
    && session.parent === '' && Number.isSafeInteger(session.iat) && Number.isSafeInteger(session.exp)
    && session.iat <= at && session.exp - session.iat === PORTAL_LIFETIME && expiresAt > at,
  'invalid_customer_session', 401)
  const token = b64url(crypto.getRandomValues(new Uint8Array(32))), hash = await sha256Hex(token)
  // Conditional insertion refuses a revocation, policy edit or erasure racing issuance.
  // The capability and its hash never enter an audit event.
  const result = await stmt(env, `INSERT INTO nc_hosted_setup_returns
    (id,setup_id,customer_id,portal_session_id,account_ref,livemode,purpose,expires_at)
    SELECT ?,s.id,c.id,p.id,b.account_ref,s.livemode,'hosted-setup',? ${source}
    WHERE s.id=? AND b.account_ref=? AND s.livemode=? AND ${currentBasis} AND ${sessionBasis} RETURNING id`,
  hash, expiresAt, setup, account, Number(livemode), ...timeParams(at), ...sessionParams(session)).first<{id:string}>()
  insist(result?.id === hash, 'invalid_customer_session', 401)
  const maxAge = Math.floor((expiresAt - at) / 1000)
  return { token, hash, expiresAt, cookie: `${cookieName}=${token}; ${cookieAttributes}; Max-Age=${maxAge}` }
}

/** Read-only resolution. GET must never consume the return or finish setup. */
export async function resolveSetupReturn(env: Bindings, request: Request): Promise<{ session: CustomerSession; setup: string; hash: string } | null> {
  const cookies = (request.headers.get('cookie') ?? '').split(';').map(part => part.trim())
    .filter(part => part.split('=', 1)[0].trim() === cookieName)
  if (cookies.length === 0) return null
  insist(cookies.length === 1, 'invalid_customer_session', 401)
  const token = cookies[0].slice(cookies[0].indexOf('=') + 1)
  insist(/^[A-Za-z0-9_-]{43}$/.test(token), 'invalid_customer_session', 401)
  const hash = await sha256Hex(token), at = clockInstant(env), origin = new URL(request.url).origin
  insist(!request.headers.has('origin') || request.headers.get('origin') === origin, 'invalid_customer_session', 401)
  const row = await one<Row>(env, `SELECT r.setup_id,p.id AS portal_session_id,p.customer_id,p.origin,p.audience,
    p.parent_origin,p.issued_at,p.expires_at,c.language,c.currency ${returnSource}
    WHERE ${liveReturn} AND ${currentBasis} AND p.origin=?`, hash, at, ...timeParams(at), origin)
  insist(row, 'invalid_customer_session', 401)
  // Claims are reconstructed solely from live, scoped rows after validation.
  const session: CustomerSession = {
    v: 1, iss: env.AUTH_ORIGIN, jti: row.portal_session_id, customer: row.customer_id,
    origin: row.origin, audience: row.audience, parent: row.parent_origin,
    iat: row.issued_at, exp: row.expires_at, language: row.language, currency: row.currency,
  }
  return { session, setup: row.setup_id, hash }
}

/** Include immediately before the completion claim and consumption in one batch. */
export function setupReturnGuard(env: Bindings, hash: string, setup: string, session: CustomerSession): D1PreparedStatement {
  const at = clockInstant(env)
  return guard(env, 'invalid_customer_session', `EXISTS(SELECT 1 ${returnSource}
    WHERE ${liveReturn} AND ${currentBasis} AND s.id=? AND ${sessionBasis})`,
  hash, at, ...timeParams(at), setup, ...sessionParams(session))
}

/** Never execute separately from setupReturnGuard and the durable completion claim. */
export function consumeSetupReturn(env: Bindings, hash: string): D1PreparedStatement {
  return stmt(env, 'UPDATE nc_hosted_setup_returns SET consumed_at=? WHERE id=? AND consumed_at IS NULL', clockInstant(env), hash)
}
