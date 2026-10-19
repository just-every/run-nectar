// Operator-validated certificate custody, scoped to a state and service dates.
import type { Bindings } from '../auth.server'
import { actorLabel, requireCapability, requireMember, type Actor } from './actor'
import { US_STATES } from './business'
import { all, commit, guard, insist, newId, now, one, sha256Hex, stmt } from './core'
import { requireCustomer } from './customers'
import { requireDate } from './dates'
import type { Input } from './input'

const stateOf = (input: Input) => {
  const state = input.text('state', { max: 2 }).toUpperCase()
  insist(US_STATES.includes(state), 'invalid_tax_jurisdiction')
  return state
}

export async function claimExemption(env: Bindings, actor: Actor, input: Input) {
  requireCapability(actor, 'records')
  const customer = await requireCustomer(env, input.text('customer', { max: 100 }))
  const state = stateOf(input)
  await commit(env, [stmt(env, 'INSERT OR IGNORE INTO nc_exemption_claims (customer_id,state,created_by,created_at) VALUES (?,?,?,?)', customer.id, state, actorLabel(actor), now())],
    { actor: actorLabel(actor), action: 'exemption.claim', subject: customer.id, detail: { state } })
  return { id: customer.id }
}

export async function collectCertificate(env: Bindings, actor: Actor, input: Input) {
  requireCapability(actor, 'records')
  const customer = await requireCustomer(env, input.text('customer', { max: 100 }))
  const state = stateOf(input), reference = input.text('reference', { max: 120 })
  const from = requireDate(input.text('valid_from', { max: 10 }), 'valid_from')
  const expires = requireDate(input.text('expires_on', { max: 10 }), 'expires_on')
  insist(expires >= from, 'invalid_certificate_dates')
  const file = (await input.file('file', { maxBytes: 500_000 }))!
  const type = file.declaredType
  insist(['application/pdf', 'image/png', 'image/jpeg'].includes(type), 'unsupported_certificate_type')
  const bytes = file.bytes
  const signatureOk = type === 'application/pdf' ? new TextDecoder().decode(bytes.slice(0, 5)) === '%PDF-' : type === 'image/png' ? bytes.slice(0, 8).join(',') === '137,80,78,71,13,10,26,10' : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  insist(signatureOk, 'invalid_certificate_file')
  const digest = await sha256Hex(bytes), id = newId()
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte)
  await commit(env, [
    stmt(env, 'INSERT OR IGNORE INTO nc_exemption_claims (customer_id,state,created_by,created_at) VALUES (?,?,?,?)', customer.id, state, actorLabel(actor), now()),
    stmt(env, 'INSERT INTO nc_certificates (id,customer_id,state,reference,valid_from,expires_on,filename,media_type,content_base64,sha256,collected_by,collected_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', id, customer.id, state, reference, from, expires, file.filename, type, btoa(binary), digest, actorLabel(actor), now()),
  ], { actor: actorLabel(actor), action: 'certificate.collect', subject: id, detail: { customer: customer.id, state, reference, from, expires, sha256: digest } })
  return { id: customer.id, certificate: id }
}

export async function validateCertificate(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'approve')
  const certificate = await one(env, 'SELECT * FROM nc_certificates WHERE id = ?', input.text('certificate', { max: 100 }))
  insist(certificate, 'certificate_not_found', 404)
  const decision = input.text('decision', { max: 20 })
  insist(['validated', 'rejected'].includes(decision), 'invalid_decision')
  const note = input.text('review_note', { max: 1000 })
  insist(certificate.status === 'pending', 'certificate_already_reviewed', 409)
  await commit(env, [
    guard(env, 'certificate_already_reviewed', "EXISTS(SELECT 1 FROM nc_certificates WHERE id=? AND status='pending')", certificate.id),
    stmt(env, 'UPDATE nc_certificates SET status=?,reviewed_by=?,reviewed_at=?,review_note=? WHERE id=?', decision, actorLabel(actor), now(), note, certificate.id),
  ], { actor: actorLabel(actor), action: 'certificate.review', subject: certificate.id, detail: { decision, note, sha256: certificate.sha256 } })
  return { id: certificate.customer_id }
}

export async function certificates(env: Bindings, actor: Actor, customer: string) {
  requireCapability(actor, 'read')
  return await all(env, 'SELECT id,state,reference,valid_from,expires_on,filename,sha256,status,collected_by,collected_at,reviewed_by,reviewed_at,review_note FROM nc_certificates WHERE customer_id=? ORDER BY collected_at DESC,id', customer)
}

export async function certificateFile(env: Bindings, actor: Actor, id: string) {
  requireCapability(actor, 'read')
  const record = await one(env, 'SELECT * FROM nc_certificates WHERE id=?', id)
  insist(record, 'certificate_not_found', 404)
  return new Response(Uint8Array.from(atob(record.content_base64), c => c.charCodeAt(0)), { headers: {
    'content-type': record.media_type, 'content-disposition': `attachment; filename="${record.filename.replace(/["\\]/g, '_')}"`,
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox",
  } })
}

/** No claim in this state means taxable; a claim without valid custody blocks issue. */
export async function certificateBasis(env: Bindings, customer: string, state: string, period: { start: string; end: string }) {
  const claims = await all(env, 'SELECT state FROM nc_exemption_claims WHERE customer_id=? ORDER BY state', customer)
  if (!claims.length) return null // The released NEC-02 reference-only path.
  if (!claims.some(claim => claim.state === state)) return { exempt: false, exemptRef: '', certificate: null, exception: null }
  const valid = await one(env, "SELECT id,reference,sha256,valid_from,expires_on,reviewed_by FROM nc_certificates WHERE customer_id=? AND state=? AND status='validated' AND valid_from<=? AND expires_on>=date(?,'-1 day') ORDER BY expires_on DESC,id LIMIT 1", customer, state, period.start, period.end)
  return { exempt: !!valid, exemptRef: valid?.reference ?? '', certificate: valid,
    exception: valid ? null : { code: 'exemption_certificate', message: `The ${state} exemption claim has no validated certificate covering ${period.start} through the end of this service period. Collect or renew its certificate before issuing.`, detail: { state, period } } }
}
