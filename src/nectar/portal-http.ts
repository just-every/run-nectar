import type { Bindings } from '../auth.server'
import { NectarError } from './core'
import { customerSession } from './portal-session'
import { portalData } from './portal-data'
import { customerText } from './locale'
import { h, page } from './ui/html'

export async function portalResponse(request: Request, env: Bindings): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== '/portal' && !url.pathname.startsWith('/portal/')) return null
  const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }
  if (!['GET','HEAD'].includes(request.method)) {
    if (request.body) await request.arrayBuffer()
    return new Response(null, { status: 405, headers: { ...headers, allow: 'GET, HEAD' } })
  }
  try {
    const session = await customerSession(env, request)
    const invoice = url.pathname.match(/^\/portal\/invoices\/([\w-]+)$/)?.[1]
    if (!['/portal','/portal/data'].includes(url.pathname) && !invoice) throw new NectarError('not_found', 404)
    const data = await portalData(env, session, invoice), L = customerText(data.customer.language)
    if (url.pathname === '/portal/data') return Response.json(data, { headers: { ...headers, 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" } })
    const token = url.searchParams.get('session')!
    const link = (path: string) => `${path}?session=${encodeURIComponent(token)}`
    const body = h`<header><p>${data.merchant?.legal_name}</p><h1>${L.t('portal.heading')}</h1><p>${data.customer.name}</p><p>${L.t('portal.readonly')}</p></header>
      ${invoice ? h`<p><a href="${link('/portal')}">${L.t('portal.back')}</a></p>` : ''}
      ${data.invoices.length ? data.invoices.map(row => h`<section class="card"><h2>${invoice ? row.number : h`<a href="${link(`/portal/invoices/${row.id}`)}">${row.number}</a>`}</h2>
        <dl><dt>${L.t('portal.issued')}</dt><dd>${L.day(row.issue_date)}</dd><dt>${L.t('portal.due')}</dt><dd>${L.day(row.due_date)}</dd>
        <dt>${L.t('portal.total')}</dt><dd>${L.money(row.total_cents)}</dd><dt>${L.t('portal.credited')}</dt><dd>${L.money(row.credited_cents)}</dd><dt>${L.t('portal.paid')}</dt><dd>${L.money(row.paid_cents)}</dd><dt>${L.t('portal.owed')}</dt><dd>${L.money(row.balance_cents)}</dd></dl>
        ${invoice ? h`<h3>${L.t('portal.lines')}</h3>${data.lines?.map(line => h`<p>${line.description} · ${L.money(line.amount_cents)}</p>`)}<p>${L.t('portal.subtotal')}: ${L.money(row.subtotal_cents)} · ${L.t('portal.tax')}: ${L.money(row.tax_cents)}</p>
          ${data.credits?.map(credit => h`<p>${credit.number} · ${L.money(credit.amount_cents)} · ${credit.reason}</p>`)}${data.payments?.map(payment => h`<p>${L.t('portal.payment')} · ${L.day(payment.received_on)} · ${L.money(payment.amount_cents)}</p>`)}` : ''}</section>`) : h`<p>${L.t('portal.empty')}</p>`}`
    const response = page(L.t('portal.heading'), null, body, { showNav: false, lang: L.tag })
    const resultHeaders = new Headers(response.headers)
    Object.entries(headers).forEach(([key,value]) => resultHeaders.set(key,value))
    resultHeaders.set('content-security-policy', `default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; form-action 'none'; frame-ancestors ${session.audience === 'embedded' ? session.parent : "'none'"}; base-uri 'none'`)
    return new Response(request.method === 'HEAD' ? null : response.body, { headers: resultHeaders })
  } catch (error) {
    if (!(error instanceof NectarError)) throw error
    const L = customerText(null)
    const response = page(L.t('portal.unavailable'), null, h`<h1>${L.t('portal.unavailable')}</h1><p>${L.t('portal.unavailable.body')}</p>`, { status: error.status, showNav: false })
    return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers: { ...Object.fromEntries(response.headers), ...headers } })
  }
}
