import type { Bindings } from '../auth.server'
import { clockInstant } from './clock'
import { commit, guard, one, sha256Hex, stmt } from './core'
import { customerText } from './locale'
import { h, page } from './ui/html'

export async function erasurePublic(request: Request, env: Bindings): Promise<Response | null> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith('/erase/')) return null
  let L = customerText(null)
  const reply = (key: string, status = 200, form = false) => page(L.t(key), null, h`<h1>${L.t(key)}</h1>${form ? h`<p>${L.t('erasure.confirm.body')}</p><form method="post" action="${url.pathname}"><button name="confirm" value="yes">${L.t('erasure.confirm.button')}</button></form>` : ''}`, { status, showNav: false, lang: L.tag })
  if (!['GET', 'HEAD', 'POST'].includes(request.method)) return new Response(null, { status: 405, headers: { allow: 'GET, HEAD, POST' } })
  if (request.method === 'POST' && request.headers.get('origin') !== env.AUTH_ORIGIN) { await request.arrayBuffer(); return reply('public.forbidden', 403) }
  const token = url.pathname.match(/^\/erase\/([a-f0-9]{64})$/)?.[1]
  const hash = token ? await sha256Hex(token) : ''
  const row = await one(env, `SELECT r.*,c.language FROM nc_erasure_requests r JOIN nc_customers c ON c.id=r.customer_id WHERE r.token_hash=? AND r.status='pending' AND r.expires_at>? AND c.revision=r.customer_revision AND c.billing_email=r.recipient AND c.erased_at IS NULL`, hash, clockInstant(env))
  if (!row) { if (request.body) await request.arrayBuffer(); return reply('erasure.unavailable', 404) }
  L = customerText(row.language)
  if (request.method !== 'POST') return reply('erasure.confirm.title', 200, true)
  let form: FormData
  try { form = await request.formData() } catch { return reply('erasure.confirm.title', 400, true) }
  if (form.get('confirm') !== 'yes') return reply('erasure.confirm.title', 400, true)
  try {
    await commit(env, [guard(env, 'stale', `EXISTS(SELECT 1 FROM nc_erasure_requests r JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=? AND r.token_hash=? AND r.status='pending' AND r.expires_at>? AND c.revision=r.customer_revision AND c.billing_email=r.recipient AND c.erased_at IS NULL)`, row.id, hash, clockInstant(env)), stmt(env, `UPDATE nc_erasure_requests SET status='verified',verified_at=?,verified_method='billing-email',token_hash=NULL WHERE id=?`, clockInstant(env), row.id)], { actor: 'customer:erasure-link', action: 'erasure.verify', subject: row.id, detail: { customer: row.customer_id } })
  } catch { return reply('erasure.unavailable', 409) }
  return reply('erasure.verified')
}
