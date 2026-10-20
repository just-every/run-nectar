import type { Bindings } from '../auth.server'
import { NectarError } from './core'
import { customerSession } from './portal-session'
import { portalData } from './portal-data'
import { customerText } from './locale'
import { h } from './ui/html'
import { portalHeaders, portalPage, portalStyle } from './portal-page'
import { one } from './core'
import { Input } from './input'
import { portalUpcomingPage, portalAdjustmentsPage, portalUsageCsv } from './portal-billing-views'
import { portalUpcoming, portalUpcomingSubscriptions } from './portal-upcoming'
import { portalCorrectionsData } from './portal-correction-data'
import { portalProposeCredit, portalCreditProposal, portalCreditProposalPage } from './portal-answer-proposals'
import { portalAnswer, portalAnswersPage } from './portal-answers'
import { customerAnswerInvoice, customerAnswerLine } from './portal-answer-data'
import { portalPrivacy, portalPrivacyRequest } from './portal-privacy'

export async function portalResponse(request: Request, env: Bindings): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== '/portal' && !url.pathname.startsWith('/portal/')) return null
  const headers = portalHeaders
  let language: string | null = null
  // Public stylesheet for refusal pages has no customer or merchant data.
  if (url.pathname === '/portal/theme.css' && !url.search) return ['GET','HEAD'].includes(request.method) ? portalStyle() : new Response(null, { status: 405, headers: { ...headers, allow: 'GET, HEAD' } })
  if (!['GET','HEAD'].includes(request.method) && !(['/portal/privacy','/portal/answer-proposal'].includes(url.pathname) && request.method === 'POST')) {
    if (request.body) await request.arrayBuffer()
    return new Response(null, { status: 405, headers: { ...headers, allow: 'GET, HEAD' } })
  }
  try {
    const session = await customerSession(env, request)
    language = session.language
    if (url.pathname === '/portal/answer-proposal' && request.method === 'POST') {
      if (request.headers.get('origin') !== session.origin) throw new NectarError('forbidden',403)
      const result=await portalProposeCredit(env,session,await Input.from(request))
      if (request.headers.get('content-type')?.startsWith('application/json')) return Response.json(result,{headers})
      return new Response(null,{status:303,headers:{...headers,location:`/portal/proposals/${result.id}?session=${encodeURIComponent(url.searchParams.get('session')!)}`}})
    }
    if (url.pathname === '/portal/privacy' && request.method === 'POST') {
      const response = await portalPrivacyRequest(request, env, session)
      return new Response(null, { status: response.status, headers: { ...Object.fromEntries(response.headers), ...headers } })
    }
    if (url.pathname === '/portal/theme.css') {
      const brand = await one(env, 'SELECT brand_color FROM nc_portal_policy WHERE singleton=1')
      return portalStyle(brand?.brand_color)
    }
    if(url.pathname==='/portal/usage.csv') return new Response(await portalUsageCsv(env,session,url),{headers:{...headers,'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename=usage.csv'}})
    const upcoming=url.pathname.match(/^\/portal\/subscriptions\/([\w-]+)\/upcoming$/)
    if (upcoming) return Response.json(await portalUpcoming(env,session,upcoming[1],url.searchParams.get('period')),{headers})
    const correction=url.pathname.match(/^\/portal\/corrections(?:\/([\w-]+))?$/)
    if(correction) return Response.json(await portalCorrectionsData(env,session,correction[1]),{headers})
    const evidence = url.pathname.match(/^\/portal\/evidence\/invoices\/([\w-]+)(?:\/lines\/([\w-]+))?$/)
    if (evidence) return Response.json(evidence[2] ? await customerAnswerLine(env, session, evidence[1], evidence[2]) : (await customerAnswerInvoice(env, session, evidence[1])).invoice, { headers })
    const input = Input.of(Object.fromEntries([...url.searchParams].filter(([key])=>key!=='session')))
    if (url.pathname === '/portal/answer') return Response.json(await portalAnswer(env,session,input), { headers })
    const proposal = url.pathname.match(/^\/portal\/proposals\/([\w-]+)$/)?.[1]
    const invoice = url.pathname.match(/^\/portal\/invoices\/([\w-]+)$/)?.[1]
    if (!['/portal','/portal/data','/portal/privacy','/portal/answers','/portal/upcoming','/portal/adjustments'].includes(url.pathname) && !invoice && !proposal) throw new NectarError('not_found', 404)
    const data = await portalData(env, session, invoice), L = customerText(data.customer.language)
    if (url.pathname === '/portal/data') return Response.json(data, { headers: { ...headers, 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" } })
    const token = url.searchParams.get('session')!
    const link = (path: string) => `${path}?session=${encodeURIComponent(token)}`
    const body = url.pathname==='/portal/upcoming' ? await portalUpcomingPage(env,session,url,link) : url.pathname==='/portal/adjustments' ? await portalAdjustmentsPage(env,session,link) : proposal ? portalCreditProposalPage(session,await portalCreditProposal(env,session,proposal),link) : url.pathname === '/portal/answers' ? await portalAnswersPage(env,session,input,link) : url.pathname === '/portal/privacy' ? await portalPrivacy(env, session, link) : h`<header><h1>${L.t('portal.heading')}</h1><p>${data.customer.name}</p><p>${L.t('portal.readonly')}</p><a href="${link('/portal/privacy')}">${L.t('portal.privacy.heading')}</a> · <a href="${link('/portal/upcoming')}">${L.t('portal.upcoming.heading')}</a> · <a href="${link('/portal/adjustments')}">${L.t('portal.adjustments.heading')}</a></header>
      ${invoice ? h`<p><a href="${link('/portal')}">${L.t('portal.back')}</a></p>` : ''}
      ${data.invoices.length ? data.invoices.map(row => h`<section class="card"><h2>${invoice ? row.number : h`<a href="${link(`/portal/invoices/${row.id}`)}">${row.number}</a>`}</h2>
        <dl><dt>${L.t('portal.issued')}</dt><dd>${L.day(row.issue_date)}</dd><dt>${L.t('portal.due')}</dt><dd>${L.day(row.due_date)}</dd>
        <dt>${L.t('portal.total')}</dt><dd>${L.money(row.total_cents)}</dd><dt>${L.t('portal.credited')}</dt><dd>${L.money(row.credited_cents)}</dd><dt>${L.t('portal.paid')}</dt><dd>${L.money(row.paid_cents)}</dd><dt>${L.t('portal.owed')}</dt><dd>${L.money(row.balance_cents)}</dd></dl>
        ${invoice ? h`<p><a href="${link('/portal/answers')}&amp;invoice=${row.id}">${L.t('portal.answer.heading')}</a></p><h3>${L.t('portal.lines')}</h3>${data.lines?.map(line => h`<p>${line.description} · ${L.money(line.amount_cents)}</p>`)}<p>${L.t('portal.subtotal')}: ${L.money(row.subtotal_cents)} · ${L.t('portal.tax')}: ${L.money(row.tax_cents)}</p>
          ${data.credits?.map(credit => h`<p>${credit.number} · ${L.money(credit.amount_cents)} · ${credit.reason}</p>`)}${data.payments?.map(payment => h`<p>${L.t('portal.payment')} · ${L.day(payment.received_on)} · ${L.money(payment.amount_cents)}</p>`)}` : ''}</section>`) : h`<p>${L.t('portal.empty')}</p>`}`
    const response = portalPage(L.t('portal.heading'), body, { lang: L.tag, name: data.brand?.brand_name || data.merchant?.legal_name || '', style: link('/portal/theme.css') })
    const resultHeaders = new Headers(response.headers)
    Object.entries(headers).forEach(([key,value]) => resultHeaders.set(key,value))
    // Match the ordinary erasure confirmation page: origin-only referrers let
    // native POST forms supply Origin without ever disclosing the session URL.
    if (['/portal/privacy','/portal/answers','/portal/upcoming','/portal/adjustments'].includes(url.pathname)) resultHeaders.set('referrer-policy', 'strict-origin')
    resultHeaders.set('content-security-policy', `default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors ${session.audience === 'embedded' ? session.parent : "'none'"}; base-uri 'none'`)
    return new Response(request.method === 'HEAD' ? null : response.body, { headers: resultHeaders })
  } catch (error) {
    if (!(error instanceof NectarError)) throw error
    if(url.pathname==='/portal/answer-proposal' && request.headers.get('content-type')?.startsWith('application/json')) return Response.json({error:error.code},{status:error.status,headers})
    const known = language !== null && ![401,403].includes(error.status)
    const L = customerText(known ? language : null)
    const title = L.t(known ? 'portal.request.unavailable' : 'portal.unavailable')
    const response = portalPage(title, h`<h1>${title}</h1><p>${L.t(known ? 'portal.request.unavailable.body' : 'portal.unavailable.body')}</p>`, { status: error.status, lang: L.tag })
    return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers: { ...Object.fromEntries(response.headers), ...headers, 'content-security-policy': "default-src 'none'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" } })
  }
}
