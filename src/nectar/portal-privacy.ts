import type { Bindings } from '../auth.server'
import type { CustomerSession } from './portal-session'
import { insist, all } from './core'
import { Input } from './input'
import { recordErasureRequest } from './erasure-requests'
import { customerText } from './locale'
import { h } from './ui/html'

export async function portalPrivacyRequest(request: Request, env: Bindings, session: CustomerSession) {
  insist(request.headers.get('origin') === session.origin, 'forbidden', 403)
  const input = await Input.from(request)
  input.only(['confirm'])
  insist(input.text('confirm') === 'yes', 'erasure_confirmation_required')
  await recordErasureRequest(env, session.customer, `customer:portal:${session.jti}`)
  const url = new URL(request.url)
  url.pathname = '/portal/privacy'
  return new Response(null, { status: 303, headers: { location: url.href } })
}

export async function portalPrivacy(env: Bindings, session: CustomerSession, link: (path: string) => string) {
  const L = customerText(session.language)
  // Never reuse the operator request projection: it contains other customers,
  // verification evidence, private recipients, tokens and approval identities.
  const requests = await all(env, 'SELECT status,mail_status FROM nc_erasure_requests WHERE customer_id=? ORDER BY requested_at DESC', session.customer)
  return h`<h1>${L.t('portal.privacy.heading')}</h1><p>${L.t('erasure.confirm.body')}</p>
    <p><a href="${link('/portal')}">${L.t('portal.back')}</a></p>
    ${requests.map(row => h`<section class="card"><h2>${L.t(row.status === 'verified' ? 'erasure.verified' : 'portal.privacy.pending')}</h2><p>${L.t(`portal.privacy.mail.${row.mail_status}`)}</p></section>`)}
    <form method="post" action="${link('/portal/privacy')}"><button name="confirm" value="yes">${L.t('portal.privacy.request')}</button></form>`
}
