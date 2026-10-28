import type { Bindings } from '../auth.server'
import { actorLabel, type Actor } from './actor'
import { commit, insist, newId, now, one, sha256Hex, stmt, type Row } from './core'
import { setupOwner, setupOwnerFence } from './hosted-setup-basis'
import type { Input } from './input'
import { portalProfileAuthority } from './portal-profile-authority'
import type { CustomerSession } from './portal-session'

/** Owner-supplied PDF only, with affirmative permission to share with customers. */
export async function storeMerchantW9(env: Bindings, actor: Actor, input: Input) {
  await setupOwner(env, actor)
  input.only(['file', 'confirm_share', 'returnTo'])
  insist(input.flag('confirm_share'), 'merchant_w9_share_confirmation_required')
  const file = (await input.file('file', { maxBytes: 500_000 }))!
  insist(file.declaredType === 'application/pdf' && new TextDecoder().decode(file.bytes.slice(0, 5)) === '%PDF-', 'invalid_merchant_w9_file')
  const digest = await sha256Hex(file.bytes), revision = newId()
  let binary = ''; for (const byte of file.bytes) binary += String.fromCharCode(byte)
  await commit(env, [
    ...setupOwnerFence(env, actor),
    stmt(env, `INSERT INTO nc_merchant_w9(singleton,filename,media_type,content_base64,sha256,revision,shared_by,shared_at)
      VALUES(1,?,'application/pdf',?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET filename=excluded.filename,media_type=excluded.media_type,
      content_base64=excluded.content_base64,sha256=excluded.sha256,revision=excluded.revision,shared_by=excluded.shared_by,shared_at=excluded.shared_at`,
    file.filename, btoa(binary), digest, revision, actorLabel(actor), now()),
  ], { actor: actorLabel(actor), action: 'merchant.w9.share', subject: revision, detail: { sha256: digest } })
  return { revision, sha256: digest }
}

async function attachment(record: Row) {
  insist(typeof record.content_base64 === 'string' && record.content_base64.length <= Math.ceil(500_000 / 3) * 4
    && /^[A-Za-z0-9+/]*={0,2}$/.test(record.content_base64), 'invalid_document_file', 409)
  const bytes = Uint8Array.from(atob(record.content_base64), character => character.charCodeAt(0))
  insist(bytes.length > 0 && bytes.length <= 500_000 && await sha256Hex(bytes) === record.sha256, 'invalid_document_file', 409)
  const signature = record.media_type === 'application/pdf' ? new TextDecoder().decode(bytes.slice(0, 5)) === '%PDF-'
    : record.media_type === 'image/png' ? bytes.slice(0, 8).join(',') === '137,80,78,71,13,10,26,10'
      : record.media_type === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  insist(signature && typeof record.filename === 'string', 'invalid_document_file', 409)
  const filename = record.filename.replace(/[^\x20-\x7e]|["\\]/g, '_')
  return new Response(bytes, { headers: {
    'content-type': record.media_type, 'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; sandbox",
  } })
}

export async function portalMerchantW9(env: Bindings, session: CustomerSession) {
  const { sql, params } = portalProfileAuthority(env, session)
  const record = await one(env, `SELECT w.filename,w.media_type,w.content_base64,w.sha256 FROM nc_merchant_w9 w WHERE w.singleton=1 AND ${sql}`, ...params)
  insist(record, 'merchant_w9_not_found', 404)
  return attachment(record)
}

export async function portalCertificateFile(env: Bindings, session: CustomerSession, id: string) {
  const { sql, params } = portalProfileAuthority(env, session)
  const record = await one(env, `SELECT d.filename,d.media_type,d.content_base64,d.sha256 FROM nc_certificates d
    WHERE d.id=? AND d.customer_id=? AND ${sql}`, id, session.customer, ...params)
  insist(record, 'certificate_not_found', 404)
  return attachment(record)
}
