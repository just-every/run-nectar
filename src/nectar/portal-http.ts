import { invoicePartialResponse } from './invoice-partial-payment-http'
import { invoicePartialPage } from './invoice-partial-payment-page'
import { portalChangePreview, portalChangePreviewPage } from './portal-change-preview'
import { portalWinbackData, portalWinbackPage, operatePortalWinback } from './portal-winback'
import { portalRenewalData, portalRenewalPage, operatePortalRenewal } from './portal-renewal'
import { portalChangesPage } from './portal-change-page'
import { portalChangeData, requestPortalChange } from './portal-change-requests'
import { customerPortalMethodActions, operatePortalMethodAction } from './portal-method-actions'
import { resolveSetupReturn, clearSetupReturnCookie } from './hosted-setup-return'
import { operateHostedSetup } from './hosted-setup'
import { hostedSetupPage } from './hosted-setup-page'
import { customerLineFacts } from './customer-invoice'
import { invoicePdf } from './invoice-pdf'
import { requestPortalPrepaidRefund } from './prepaid-refund-intake'
import { portalTopupPage } from './portal-prepaid-topups'
import { portalPrepaidTopupAuthorization, acceptPrepaidTopupAuthorization, revokePortalPrepaidTopupAuthorization } from './prepaid-topup-authorization'
import { portalPrepaidData, portalPrepaidSource, portalPrepaidPage, portalPrepaidSourcePage, portalPrepaidCsv } from './portal-prepaid'
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
  const headers: Record<string,string> = {...portalHeaders}
  let language: string | null = null
  // Public stylesheet for refusal pages has no customer or merchant data.
  if (url.pathname === '/portal/theme.css' && !url.search) return ['GET','HEAD'].includes(request.method) ? portalStyle() : new Response(null, { status: 405, headers: { ...headers, allow: 'GET, HEAD' } })
  if (!['GET','HEAD'].includes(request.method) && !((/^\/portal\/(?:renewal|return)\/[\w-]+$/.test(url.pathname) || ['/portal/invoice-payment/start','/portal/invoice-payment/check','/portal/change.preview','/portal/change.request','/portal/payment-methods/action','/portal/payment-methods/action/reconcile','/portal/payment-methods/start','/portal/payment-methods/finish','/portal/payment-methods/reconcile','/portal/prepaid-refund.request','/portal/privacy','/portal/answer-proposal','/portal/prepaid-topup.accept','/portal/prepaid-topup.revoke'].includes(url.pathname)) && request.method === 'POST')) {
    if (request.body) await request.arrayBuffer()
    return new Response(null, { status: 405, headers: { ...headers, allow: 'GET, HEAD' } })
  }
  try {
    if(url.pathname.startsWith('/portal/invoice-payment/'))return await invoicePartialResponse(request,env)
    const isSetup=url.pathname.startsWith('/portal/payment-methods')
    const returned=isSetup && (!url.searchParams.has('session') || url.pathname.endsWith('/finish') || url.pathname.endsWith('/reconcile'))?await resolveSetupReturn(env,request):null
    const session = url.searchParams.has('session')?await customerSession(env, request):returned?.session??await customerSession(env,request)
    language = session.language
    const renewal = url.pathname.match(/^\/portal\/(renewal|return)\/([\w-]+)$/)
    if (renewal) {
      const returning=renewal[1]==='return',subscription=renewal[2],token=url.searchParams.get('session')!
      const link=(path:string)=>`${path}?session=${encodeURIComponent(token)}`
      if(request.method==='POST') {
        const result=await (returning?operatePortalWinback:operatePortalRenewal)(env,request,session,subscription,await Input.from(request))
        if(request.headers.get('content-type')?.startsWith('application/json'))return Response.json(result,{headers})
        return new Response(null,{status:303,headers:{...headers,location:link(returning?'/portal/changes':`/portal/renewal/${subscription}`)}})
      }
      if(request.headers.get('accept')?.includes('application/json'))return Response.json(await (returning?portalWinbackData:portalRenewalData)(env,session,subscription),{headers})
      const L=customerText(session.language,session.currency)
      const response=portalPage(L.t(returning?'return.offer.title':'renewal.manage.title'),await (returning?portalWinbackPage:portalRenewalPage)(env,session,subscription,link),{lang:L.tag,style:link('/portal/theme.css')})
      return new Response(request.method==='HEAD'?null:response.body,{headers:{...Object.fromEntries(response.headers),...headers,'referrer-policy':'strict-origin','content-security-policy':`default-src 'none'; style-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors ${session.audience==='embedded'?session.parent:"'none'"}; base-uri 'none'`}})
    }
    if(url.pathname==='/portal/change.preview'&&request.method==='POST') {
      const quote=await portalChangePreview(env,request,session,await Input.from(request))
      if(request.headers.get('content-type')?.startsWith('application/json'))return Response.json(quote,{headers})
      const token=url.searchParams.get('session')!,L=customerText(session.language,session.currency)
      const response=portalPage(L.t('portal.change.previewHeading'),portalChangePreviewPage(session,quote,`/portal/changes/${quote.subscription}?session=${encodeURIComponent(token)}`),{lang:L.tag,style:`/portal/theme.css?session=${encodeURIComponent(token)}`})
      return new Response(response.body,{headers:{...Object.fromEntries(response.headers),'content-security-policy':`default-src 'none'; style-src 'self'; font-src 'self'; frame-ancestors ${session.audience==='embedded'?session.parent:"'none'"}; base-uri 'none'; form-action 'none'`}})
    }
    if (url.pathname === '/portal/change.request' && request.method === 'POST') {
      const result = await requestPortalChange(env, request, session, await Input.from(request))
      if (request.headers.get('content-type')?.startsWith('application/json')) return Response.json(result, { headers })
      return new Response(null, { status: 303, headers: { ...headers, location: `/portal/changes/${result.subscription}?session=${encodeURIComponent(url.searchParams.get('session')!)}` } })
    }
    const changes = url.pathname.match(/^\/portal\/changes(?:\/([\w-]+))?$/)
    if (changes) {
      if (request.headers.get('accept')?.includes('application/json')) return Response.json(await portalChangeData(env, session, changes[1]), { headers })
      const L = customerText(session.language, session.currency), token = url.searchParams.get('session')!
      const link = (path: string) => `${path}?session=${encodeURIComponent(token)}`
      const response = portalPage(L.t('portal.change.heading'), await portalChangesPage(env, session, changes[1], link), { lang: L.tag, style: link('/portal/theme.css') })
      return new Response(request.method === 'HEAD' ? null : response.body, { headers: { ...Object.fromEntries(response.headers), ...headers, 'referrer-policy': 'strict-origin', 'content-security-policy': `default-src 'none'; style-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors ${session.audience === 'embedded' ? session.parent : "'none'"}; base-uri 'none'` } })
    }
    if(url.pathname.startsWith('/portal/payment-methods')&&session.audience!=='hosted')throw new NectarError('forbidden',403)
    if (['/portal/payment-methods/action','/portal/payment-methods/action/reconcile'].includes(url.pathname) && request.method==='POST') {
      if(request.headers.get('origin')!==session.origin)throw new NectarError('forbidden',403)
      const result=await operatePortalMethodAction(env,session,await Input.from(request),url.pathname.endsWith('/reconcile')?'reconcile':'confirm')
      if(request.headers.get('content-type')?.startsWith('application/json'))return Response.json(result,{headers})
      return new Response(null,{status:303,headers:{...headers,location:`/portal/payment-methods?session=${encodeURIComponent(url.searchParams.get('session')!)}`}})
    }
    if(url.pathname==='/portal/payment-methods/actions')return Response.json(await customerPortalMethodActions(env,session),{headers})
    if (['/portal/payment-methods/start','/portal/payment-methods/finish','/portal/payment-methods/reconcile'].includes(url.pathname) && request.method==='POST') {
      if(request.headers.get('origin')!==session.origin)throw new NectarError('forbidden',403)
      const operation=url.pathname.endsWith('/start')?'start':url.pathname.endsWith('/reconcile')?'reconcile':'finish'
      const result=await operateHostedSetup(env,session,await Input.from(request),operation,returned,cookie=>{headers['set-cookie']=cookie})
      if(['complete','failed'].includes(result.status))headers['set-cookie']=clearSetupReturnCookie
      if(request.headers.get('content-type')?.startsWith('application/json'))return Response.json(result,{headers})
      if(['complete','failed'].includes(result.status)&&!url.searchParams.has('session')) {
        const L=customerText(session.language,session.currency)
        const response=portalPage(L.t('checkout.heading'),await hostedSetupPage(env,session,path=>path,result.id),{lang:L.tag,style:'/portal/theme.css'})
        return new Response(response.body,{headers:{...Object.fromEntries(response.headers),...headers,'content-security-policy':"default-src 'none'; style-src 'self'; font-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'"}})
      }
      const local=url.searchParams.has('session')?`/portal/payment-methods?session=${encodeURIComponent(url.searchParams.get('session')!)}`:'/portal/payment-methods'
      return new Response(null,{status:303,headers:{...headers,location:'url' in result?result.url!:local}})
    }
    if(['/portal/prepaid-topup.accept','/portal/prepaid-topup.revoke'].includes(url.pathname)&&request.method==='POST'){
      const input=await Input.from(request)
      const result=url.pathname==='/portal/prepaid-topup.accept'?await acceptPrepaidTopupAuthorization(env,request,input):await revokePortalPrepaidTopupAuthorization(env,request,input)
      if(request.headers.get('content-type')?.startsWith('application/json'))return Response.json(result,{headers})
      return new Response(null,{status:303,headers:{...headers,location:`/portal/prepaid-topups/${result.id}?session=${encodeURIComponent(url.searchParams.get('session')!)}`}})
    }
    if(url.pathname==='/portal/prepaid-refund.request'&&request.method==='POST'){
      const result=await requestPortalPrepaidRefund(env,request,await Input.from(request))
      if(request.headers.get('content-type')?.startsWith('application/json'))return Response.json(result,{headers})
      return new Response(null,{status:303,headers:{...headers,location:`/portal/prepaid?session=${encodeURIComponent(url.searchParams.get('session')!)}`}})
    }
    if(url.pathname==='/portal/payment-methods') {
      const L=customerText(session.language,session.currency),token=url.searchParams.get('session')
      const link=(path:string)=>token?`${path}?session=${encodeURIComponent(token)}`:path
      const body=await hostedSetupPage(env,session,link,returned?.setup??url.searchParams.get('setup')??undefined)
      const response=portalPage(L.t('checkout.heading'),body,{lang:L.tag,style:'/portal/theme.css'})
      return new Response(request.method==='HEAD'?null:response.body,{headers:{...Object.fromEntries(response.headers),...headers,'referrer-policy':'strict-origin','content-security-policy':"default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; form-action 'self' https://checkout.stripe.com; frame-ancestors 'none'; base-uri 'none'"}})
    }
    const topupAuthorization=url.pathname.match(/^\/portal\/prepaid-topups\/([\w-]+)$/)?.[1]
    if(topupAuthorization&&!request.headers.get('accept')?.includes('text/html'))return Response.json(await portalPrepaidTopupAuthorization(env,request,topupAuthorization),{headers})
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
      const invoiceId=url.searchParams.get('invoice')
      if(invoiceId){const saved=await portalData(env,session,invoiceId);return portalStyle(saved.content!.branding.color)}
      return portalStyle(brand?.brand_color)
    }
    if(url.pathname==='/portal/prepaid/data')return Response.json(await portalPrepaidData(env,session),{headers})
    if(url.pathname==='/portal/prepaid.csv')return new Response(await portalPrepaidCsv(env,session),{headers:{...headers,'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename=prepaid.csv'}})
    const prepaidSource=url.pathname.match(/^\/portal\/prepaid\/(prepaid-[\w-]+)$/)?.[1]
    if(prepaidSource&&request.headers.get('accept')?.includes('application/json'))return Response.json(await portalPrepaidSource(env,session,prepaidSource),{headers})
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
    if (!['/portal/payment-methods','/portal','/portal/data','/portal/privacy','/portal/answers','/portal/upcoming','/portal/adjustments','/portal/prepaid'].includes(url.pathname) && !invoice && !proposal && !prepaidSource && !topupAuthorization) throw new NectarError('not_found', 404)
    const data = await portalData(env, session, invoice), L = customerText(data.customer.language,data.customer.currency)
    if (url.pathname === '/portal/data') return Response.json(data, { headers: { ...headers, 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" } })
    if(invoice&&url.searchParams.get('format')==='pdf')return new Response(request.method==='HEAD'?null:invoicePdf(data).buffer as ArrayBuffer,{headers:{...headers,'content-type':'application/pdf','content-disposition':'attachment; filename=invoice.pdf','content-security-policy':"default-src 'none'; frame-ancestors 'none'"}})
    if(invoice&&url.searchParams.get('format')==='logo')return new Response(request.method==='HEAD'?null:Uint8Array.from(atob(data.content!.branding.logo),c=>c.charCodeAt(0)),{headers:{...headers,'content-type':'image/jpeg'}})
    const token = url.searchParams.get('session')!
    const link = (path: string) => `${path}?session=${encodeURIComponent(token)}`
    const body = topupAuthorization?await portalTopupPage(env,request,session,topupAuthorization,link):url.pathname==='/portal/prepaid'?await portalPrepaidPage(env,session,link):prepaidSource?await portalPrepaidSourcePage(env,session,prepaidSource,link):url.pathname==='/portal/upcoming' ? await portalUpcomingPage(env,session,url,link) : url.pathname==='/portal/adjustments' ? await portalAdjustmentsPage(env,session,link) : proposal ? portalCreditProposalPage(session,await portalCreditProposal(env,session,proposal),link) : url.pathname === '/portal/answers' ? await portalAnswersPage(env,session,input,link) : url.pathname === '/portal/privacy' ? await portalPrivacy(env, session, link) : h`<header><h1>${L.t('portal.heading')}</h1><p>${data.customer.name}</p><p>${L.t('portal.readonly')}</p><a href="${link('/portal/payment-methods')}">${L.t('checkout.heading')}</a> · <a href="${link('/portal/privacy')}">${L.t('portal.privacy.heading')}</a> · <a href="${link('/portal/upcoming')}">${L.t('portal.upcoming.heading')}</a> · <a href="${link('/portal/adjustments')}">${L.t('portal.adjustments.heading')}</a> · <a href="${link('/portal/prepaid')}">${L.t('portal.prepaid.heading')}</a> · <a href="${link('/portal/changes')}">${L.t('portal.change.heading')}</a></header>
      ${invoice ? h`<p><a href="${link('/portal')}">${L.t('portal.back')}</a></p>` : ''}
      ${data.invoices.length ? await Promise.all(data.invoices.map(async row => h`<section class="card"><h2>${invoice ? row.number : h`<a href="${link(`/portal/invoices/${row.id}`)}">${row.number}</a>`}</h2>
        <dl><dt>${L.t('portal.issued')}</dt><dd>${L.day(row.issue_date)}</dd><dt>${L.t('portal.due')}</dt><dd>${L.day(row.due_date)}</dd>
        <dt>${L.t('portal.total')}</dt><dd>${L.money(row.total_cents)}</dd><dt>${L.t('portal.credited')}</dt><dd>${L.money(row.credited_cents)}</dd><dt>${L.t('portal.paid')}</dt><dd>${L.money(row.paid_cents)}</dd><dt>${L.t('portal.owed')}</dt><dd>${L.money(row.balance_cents)}</dd></dl>
        ${invoice ? h`${data.content!.branding.logo?h`<img src="${link(`/portal/invoices/${row.id}`)}&amp;format=logo" alt="${data.merchant?.legal_name}" width="96">`:''}<p><a href="${link(`/portal/invoices/${row.id}`)}&amp;format=pdf">${L.t('invoice.pdf')}</a></p><dl><dt>${L.t('invoice.terms')}</dt><dd>Net ${data.content!.paymentTermsDays??''}</dd><dt>${L.t('invoice.po')}</dt><dd>${data.content!.poNumber}</dd>${Object.entries(data.content!.customFields).map(([key,value])=>h`<dt>${key}</dt><dd>${String(value)}</dd>`)}</dl><p>${data.content!.memo}</p><p>${data.content!.branding.remitTo}</p>${!data.content!.hideUsageDetail?h`<p><a href="${link('/portal/answers')}&amp;invoice=${row.id}">${L.t('portal.answer.heading')}</a></p>`:''}<h3>${L.t('portal.lines')}</h3>${data.lines?.map(line => h`<article><p>${line.description} · ${L.money(line.amount_cents,row.currency)}</p>${line.quantity!==undefined?h`<details><summary>${L.t('invoice.calculation')}</summary>${customerLineFacts(line,L,row.currency).map(fact=>h`<p>${fact}</p>`)}</details>`:''}</article>`)}<p>${L.t('portal.subtotal')}: ${L.money(row.subtotal_cents)} · ${L.t('portal.tax')}: ${L.money(row.tax_cents)}</p>
          ${data.credits?.map(credit => h`<p>${credit.number} · ${L.money(credit.amount_cents)} · ${credit.reason==='unused_paid_credit'?L.t('portal.prepaid.entry.refund'):credit.reason}</p>`)}${data.payments?.map(payment => h`<p>${L.t('portal.payment')} · ${L.day(payment.received_on)} · ${L.money(payment.amount_cents)}</p>`)}${await invoicePartialPage(env,session,row.id,link)}<footer>${data.content!.branding.footer}</footer>` : ''}</section>`)) : h`<p>${L.t('portal.empty')}</p>`}`
    const response = portalPage(L.t('portal.heading'), body, { lang: L.tag, name: data.brand?.brand_name || data.merchant?.legal_name || '', style: link('/portal/theme.css')+(invoice?`&invoice=${invoice}`:'') })
    const resultHeaders = new Headers(response.headers)
    Object.entries(headers).forEach(([key,value]) => resultHeaders.set(key,value))
    // Match the ordinary erasure confirmation page: origin-only referrers let
    // native POST forms supply Origin without ever disclosing the session URL.
    if (invoice||topupAuthorization||['/portal/payment-methods','/portal/prepaid','/portal/privacy','/portal/answers','/portal/upcoming','/portal/adjustments'].includes(url.pathname)) resultHeaders.set('referrer-policy', 'strict-origin')
    resultHeaders.set('content-security-policy', `default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; form-action 'self' ${invoice||url.pathname==='/portal/payment-methods'?'https://checkout.stripe.com':''}; frame-ancestors ${session.audience === 'embedded' ? session.parent : "'none'"}; base-uri 'none'`)
    return new Response(request.method === 'HEAD' ? null : response.body, { headers: resultHeaders })
  } catch (error) {
    if (!(error instanceof NectarError)) throw error
    if((/^\/portal\/(?:renewal|return)\/[\w-]+$/.test(url.pathname)||['/portal/invoice-payment/start','/portal/invoice-payment/check','/portal/change.preview','/portal/change.request','/portal/payment-methods/action','/portal/payment-methods/action/reconcile','/portal/payment-methods/start','/portal/payment-methods/finish','/portal/payment-methods/reconcile','/portal/prepaid-refund.request','/portal/answer-proposal','/portal/prepaid-topup.accept','/portal/prepaid-topup.revoke'].includes(url.pathname)) && request.headers.get('content-type')?.startsWith('application/json')) return Response.json({error:error.code},{status:error.status,headers})
    const known = language !== null && ![401,403].includes(error.status)
    const L = customerText(known ? language : null)
    const title = L.t(known ? 'portal.request.unavailable' : 'portal.unavailable')
    const response = portalPage(title, h`<h1>${title}</h1><p>${L.t(known ? 'portal.request.unavailable.body' : 'portal.unavailable.body')}</p>`, { status: error.status, lang: L.tag })
    return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers: { ...Object.fromEntries(response.headers), ...headers, 'content-security-policy': "default-src 'none'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" } })
  }
}
