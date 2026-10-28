import type { Bindings } from '../auth.server'
import { operatorMail } from '../mail.server.mjs'
import { clockInstant } from './clock'
import { commit, guard, insist, NectarError, newId, one, parseJson, sha256Hex, stmt, type Row } from './core'
import { customerText } from './locale'
import { b64url } from './mfa-crypto'
import { portalHeaders } from './portal-page'
import { preparePortalSession } from './portal-policy'
import { PORTAL_LIFETIME } from './portal-session'
import { portalSigninPage } from './portal-signin-page'
import { h } from './ui/html'

const source = `FROM nc_portal_signins s JOIN nc_customers c ON c.id=s.customer_id
 LEFT JOIN nc_contacts bc ON bc.id=s.contact_id AND bc.customer_id=c.id AND bc.role='billing'
 JOIN nc_portal_policy p ON p.singleton=1 AND p.revision=s.policy_revision`
const mailbox = 'CASE WHEN s.contact_id IS NULL THEN c.billing_email ELSE bc.email END'
const live = `s.purpose='request' AND s.token_hash=? AND s.origin=? AND s.policy_revision=?
 AND s.ready_at IS NOT NULL AND s.consumed_at IS NULL AND s.revoked_at IS NULL
 AND s.issued_at<=? AND s.expires_at>? AND s.expires_at=s.issued_at+${PORTAL_LIFETIME}
 AND c.status='active' AND c.erased_at IS NULL AND c.revision=s.customer_revision
 AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(s.id,c.id))
 AND EXISTS(SELECT 1 FROM json_each(p.hosts_json) WHERE value=s.origin)`
const normalized = (value: string) => value.trim().toLowerCase()

async function form(request: Request) {
  insist(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'application/x-www-form-urlencoded', 'invalid_signin_form', 415)
  const reader = request.body?.getReader(), chunks: Uint8Array[] = []
  let length = 0
  if (reader) for (;;) {
    const part = await reader.read()
    if (part.done) break
    length += part.value.byteLength
    if (length > 4096) { await reader.cancel(); throw new NectarError('invalid_signin_form', 413) }
    chunks.push(part.value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return new URLSearchParams(new TextDecoder().decode(bytes))
}

async function rate(env: Bindings, request: Request, purpose: 'request' | 'confirmation', subject: string) {
  const at = clockInstant(env), id = newId(), origin = new URL(request.url).origin
  const ip = request.headers.get('cf-connecting-ip') ?? 'unavailable'
  const key = await sha256Hex(`${origin}:${ip.slice(0, 128)}`), since = at - PORTAL_LIFETIME
  await commit(env, [
    stmt(env, 'DELETE FROM nc_portal_signins WHERE expires_at<=?', at - PORTAL_LIFETIME),
    guard(env, 'portal_signin_rate_limited', `
      (SELECT count(*) FROM nc_portal_signins WHERE purpose=? AND rate_key=? AND issued_at>?)<20
      AND (SELECT count(*) FROM nc_portal_signins WHERE purpose=? AND rate_subject=? AND issued_at>?)<?
      AND (SELECT count(*) FROM nc_portal_signins WHERE purpose=? AND issued_at>?)<500`,
    purpose, key, since, purpose, subject, since, purpose === 'request' ? 3 : 10, purpose, since),
    stmt(env, 'INSERT INTO nc_portal_signins(id,purpose,rate_key,rate_subject,issued_at,expires_at) VALUES(?,?,?,?,?,?)', id, purpose, key, subject, at, at + PORTAL_LIFETIME),
  ], { actor: 'customer:portal', action: 'portal.signin.attempt', subject: id, detail: { purpose } })
  return { id, at }
}

async function authorized(env: Bindings, tokenHash: string, origin: string, revision: string) {
  const at = clockInstant(env)
  const row = await one(env, `SELECT s.*,c.language,${mailbox} AS mailbox ${source} WHERE ${live}`, tokenHash, origin, revision, at, at)
  if (!row || typeof row.mailbox !== 'string' || !row.mailbox.trim() || await sha256Hex(normalized(row.mailbox)) !== row.email_hash) return null
  return row
}

function fence(env: Bindings, row: Row, tokenHash: string, origin: string, revision: string, at: number) {
  return guard(env, 'portal_signin_changed', `EXISTS(SELECT 1 ${source} WHERE s.id=? AND ${live} AND lower(trim(${mailbox}))=?)`, row.id, tokenHash, origin, revision, at, at, normalized(row.mailbox))
}

async function requestLink(env: Bindings, request: Request, values: URLSearchParams, policy: Row) {
  const customer = values.get('customer')?.trim() ?? '', email = normalized(values.get('email') ?? '')
  const emailHash = await sha256Hex(email)
  const attempt = await rate(env, request, 'request', emailHash)
  if (values.getAll('customer').length !== 1 || values.getAll('email').length !== 1 || !customer || customer.length > 100 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return
  const row = await one(env, `SELECT c.id,c.revision,c.language,
    CASE WHEN lower(trim(c.billing_email))=? THEN NULL ELSE bc.id END AS contact_id,
    CASE WHEN lower(trim(c.billing_email))=? THEN c.billing_email ELSE bc.email END AS mailbox
    FROM nc_customers c LEFT JOIN nc_contacts bc ON bc.customer_id=c.id AND bc.role='billing' AND lower(trim(bc.email))=?
    WHERE c.external_id=? AND c.status='active' AND c.erased_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id=c.id)
    AND (lower(trim(c.billing_email))=? OR bc.id IS NOT NULL) ORDER BY bc.id LIMIT 1`, email, email, email, customer, email)
  if (!row) return
  const mail = operatorMail(env)
  if (!mail || !env.MAIL_FROM) return
  const token = b64url(crypto.getRandomValues(new Uint8Array(32))), tokenHash = await sha256Hex(token)
  const origin = new URL(request.url).origin
  await commit(env, [guard(env, 'portal_signin_changed', `
    EXISTS(SELECT 1 FROM nc_portal_policy WHERE singleton=1 AND revision=? AND EXISTS(SELECT 1 FROM json_each(hosts_json) WHERE value=?))
    AND EXISTS(SELECT 1 FROM nc_customers c WHERE c.id=? AND c.revision=? AND c.erased_at IS NULL AND c.status='active'
      AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id=c.id)
      AND ((? IS NULL AND lower(trim(c.billing_email))=?) OR EXISTS(SELECT 1 FROM nc_contacts bc WHERE bc.id=? AND bc.customer_id=c.id AND bc.role='billing' AND lower(trim(bc.email))=?)))`,
    policy.revision, origin, row.id, row.revision, row.contact_id, email, row.contact_id, email),
    stmt(env, `UPDATE nc_portal_signins SET token_hash=?,customer_id=?,customer_revision=?,contact_id=?,email_hash=?,origin=?,policy_revision=? WHERE id=? AND consumed_at IS NULL AND revoked_at IS NULL`,
    tokenHash, row.id, row.revision, row.contact_id, emailHash, origin, policy.revision, attempt.id),
  ], { actor: 'customer:portal', action: 'portal.signin.prepare', subject: attempt.id })
  const L = customerText(row.language), url = `${origin}/portal/signin/${token}`
  const subject = L.t('portal.signin.mailSubject'), text = L.t('portal.signin.mailBody', { url })
  let accepted = false
  try {
    const result = await mail.send({ deliveryId: `portal-signin-${attempt.id}`, from: env.MAIL_FROM, to: [row.mailbox.trim()], subject, text,
      html: h`<p>${text}</p><p><a href="${url}">${L.t('portal.signin.confirm')}</a></p>`.html, headers: { 'Auto-Submitted': 'auto-generated' } })
    accepted = result.status === 'accepted' || result.status === 'development' && env.AUTH_LOCAL === 'true'
  } catch { /* An uncertain delivery must not confer authority. */ }
  const at = clockInstant(env)
  await commit(env, [stmt(env, accepted ? 'UPDATE nc_portal_signins SET ready_at=? WHERE id=? AND revoked_at IS NULL AND expires_at>?' : 'UPDATE nc_portal_signins SET revoked_at=? WHERE id=? AND expires_at>?', at, attempt.id, at)],
    { actor: 'customer:portal', action: 'portal.signin.delivery', subject: attempt.id, detail: { accepted } })
}

export async function portalSigninResponse(request: Request, env: Bindings): Promise<Response | null> {
  const url = new URL(request.url), entry = url.pathname === '/portal/signin'
  if (!entry && !url.pathname.startsWith('/portal/signin/')) return null
  let language = customerText(url.searchParams.get('language')).tag
  try {
    const policy = await one(env, 'SELECT * FROM nc_portal_policy WHERE singleton=1')
    if (!policy || !parseJson<string[]>(policy.hosts_json, []).includes(url.origin)) return portalSigninPage(language, 'unavailable', undefined, 403)
    if (!['GET', 'POST'].includes(request.method)) return new Response(null, { status: 405, headers: { ...portalHeaders, allow: 'GET, POST' } })
    if (request.method === 'POST') insist(request.headers.get('origin') === url.origin && !['cross-site', 'none'].includes(request.headers.get('sec-fetch-site') ?? ''), 'portal_signin_origin', 403)
    if (entry) {
      if (request.method === 'GET') return portalSigninPage(language, 'request')
      const values = await form(request)
      language = customerText(values.get('language')).tag
      try { await requestLink(env, request, values, policy) }
      catch { /* Public requests never reveal eligibility or delivery outcomes. */ }
      return portalSigninPage(language, 'sent')
    }
    const token = url.pathname.slice('/portal/signin/'.length)
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return portalSigninPage(language, 'invalid', undefined, 400)
    const tokenHash = await sha256Hex(token)
    if (request.method === 'POST') {
      await rate(env, request, 'confirmation', tokenHash)
      if (request.body) await form(request)
    }
    const row = await authorized(env, tokenHash, url.origin, policy.revision)
    if (!row) return portalSigninPage(language, 'invalid', undefined, 400)
    language = customerText(row.language).tag
    if (request.method === 'GET') return portalSigninPage(language, 'confirm', url.pathname)
    const prepared = await preparePortalSession(env, { customer: row.customer_id, origin: url.origin, audience: 'hosted', parent: '', policyRevision: row.policy_revision, contactId: row.contact_id, emailHash: row.email_hash })
    const at = clockInstant(env)
    await commit(env, [fence(env, row, tokenHash, url.origin, policy.revision, at),
      stmt(env, 'UPDATE nc_portal_signins SET consumed_at=? WHERE id=? AND consumed_at IS NULL', at, row.id), prepared.statement],
    { actor: 'customer:portal', action: 'portal.signin.consume', subject: row.id, detail: { session: prepared.id } })
    return new Response(null, { status: 303, headers: { ...portalHeaders, location: prepared.url } })
  } catch (error) {
    if (error instanceof NectarError && ['portal_signin_changed', 'portal_signin_rate_limited'].includes(error.code)) return portalSigninPage(language, 'invalid', undefined, 400)
    if (error instanceof NectarError && error.status < 500) return portalSigninPage(language, 'invalid', undefined, error.status)
    return portalSigninPage(language, 'unavailable', undefined, 503)
  }
}
