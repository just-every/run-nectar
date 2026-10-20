// GOV-005 request and verification custody. A provider acceptance never verifies
// identity: only the single-use confirmation POST or an evidenced owner decision.
import type { Bindings } from '../auth.server'
import { actorLabel, requireCapability, requireMember, requireOwner, type Actor } from './actor'
import { all, commit, guard, insist, newId, one, sha256Hex, stmt } from './core'
import { clockInstant } from './clock'
import { requireCustomer } from './customers'
import type { Input } from './input'
import { operatorMail } from '../mail.server.mjs'
import { customerText } from './locale'
import { esc } from './ui/html'

export async function erasureRequests(env: Bindings, actor: Actor) {
  requireMember(actor, 'read')
  return await all(env, `SELECT id,customer_id,claimed_email,status,expires_at,requested_by,requested_at,mail_status,verified_at,verified_method,verification_reason,evidence_name,evidence_sha256,evidence_size,approved_by,approved_at,receipt_json,retain_until,purged_at FROM nc_erasure_requests ORDER BY requested_at DESC`)
}
export async function requestErasure(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'records')
  const claimed=input.text('claimed_email',{max:200,optional:true}).toLowerCase()
  insist(!claimed||/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claimed),'invalid_claimed_email')
  return await recordErasureRequest(env, input.text('customer'), actorLabel(actor), claimed)
}

/** Internal operation; callers establish operator authority or a scoped customer session. */
export async function recordErasureRequest(env: Bindings, customerId: string, requestedBy: string, claimed = '') {
  const customer = await requireCustomer(env, customerId)
  insist(!customer.erased_at, 'customer_already_erased', 409)
  insist(customer.billing_email, 'billing_email_required')
  const id = newId(), at = clockInstant(env), expires = at + 7 * 86400000
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('')
  const hash = await sha256Hex(token)
  await commit(env, [
    guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_customers WHERE id=? AND revision=? AND erased_at IS NULL)', customer.id, customer.revision),
    stmt(env, `INSERT INTO nc_erasure_requests(id,customer_id,customer_revision,recipient,token_hash,expires_at,requested_by,requested_at,claimed_email) VALUES(?,?,?,?,?,?,?,?,?)`, id, customer.id, customer.revision, customer.billing_email, hash, expires, requestedBy, at,claimed),
  ], { actor: requestedBy, action: 'erasure.request', subject: id, detail: { customer: customer.id, expires } })
  const mail = operatorMail(env), L = customerText(customer.language)
  let status = 'not_configured', provider: string | null = null
  if (mail && env.MAIL_FROM) {
    const link = new URL(`/erase/${token}`, env.AUTH_ORIGIN).href
    status = 'uncertain'
    try {
      const text = L.t('erasure.mail.body', { link })
      const result = await mail.send({ deliveryId: `erasure-${id}`, from: env.MAIL_FROM, to: [customer.billing_email], subject: L.t('erasure.mail.subject'), text, html: `<p>${esc(text)}</p>`, headers: { 'Auto-Submitted': 'auto-generated' } })
      status = result.status === 'development' ? 'suppressed' : result.status
      provider = result.providerMessageId ?? null
    } catch { status = 'uncertain' }
  }
  await commit(env, [stmt(env, 'UPDATE nc_erasure_requests SET mail_status=?,provider_ref=? WHERE id=?', status, provider, id)], { actor: requestedBy, action: 'erasure.mail', subject: id, detail: { status } })
  return { id, status: 'pending', mail_status: status, expires_at: expires }
}
export async function verifyErasureOtherwise(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor)
  const id = input.text('request'), reason = input.text('reason', { max: 2000 })
  const file = (await input.file('evidence', { maxBytes: 256000 }))!
  const digest = await sha256Hex(file.bytes)
  await commit(env, [
    guard(env, 'stale', `EXISTS(SELECT 1 FROM nc_erasure_requests r JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=? AND r.status='pending' AND c.erased_at IS NULL AND c.revision=r.customer_revision)`, id),
    stmt(env, `UPDATE nc_erasure_requests SET status='verified',token_hash=NULL,verified_at=?,verified_method='owner-evidence',verification_reason=?,evidence_name=?,evidence_type=?,evidence_base64=?,evidence_sha256=?,evidence_size=? WHERE id=?`, clockInstant(env), reason, file.filename, file.declaredType, btoa(Array.from(file.bytes, b => String.fromCharCode(b)).join('')), digest, file.bytes.length, id),
  ], { actor: actorLabel(actor), action: 'erasure.verify.alternative', subject: id, detail: { reason, evidenceSha256: digest, evidenceSize: file.bytes.length } })
  return { id }
}
export async function erasureEvidence(env: Bindings, actor: Actor, id: string) {
  requireOwner(actor)
  const row = await one(env, 'SELECT * FROM nc_erasure_requests WHERE id=?', id)
  insist(row?.evidence_base64, 'evidence_not_available', 404)
  return new Response(Uint8Array.from(atob(row.evidence_base64), b => b.charCodeAt(0)), { headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="verification-evidence"', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" } })
}
