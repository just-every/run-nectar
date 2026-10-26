import { issuePaymentLinkCancellation } from './payment-links-renewals'
import type { Bindings } from '../auth.server'
import { NectarError, one, parseJson } from './core'
import { Input } from './input'
import { customerText, languages } from './locale'
import { portalHeaders, portalPage } from './portal-page'
import { h, hidden } from './ui/html'
import { linkTerms, requireActivePaymentLink } from './payment-links'
import { attemptCookie, beginPaymentLink, newPaymentLinkToken, paymentLinkAttempt, paymentLinkAttemptView, paymentLinkOffer } from './payment-links-state'
import { createPaymentLinkCustomer, operatePaymentLink } from './payment-links-provider'

export async function paymentLinksResponse(request: Request, env: Bindings): Promise<Response|null> {
  const url=new URL(request.url)
  if(!url.pathname.startsWith('/pay-links/'))return null
  const headers:Record<string,string>={...portalHeaders,'referrer-policy':'strict-origin',
    'content-security-policy':"default-src 'none'; style-src 'self'; font-src 'self'; form-action 'self' https://checkout.stripe.com; frame-ancestors 'none'; base-uri 'none'"}
  let language: string|null=null
  const json=request.headers.get('accept')?.includes('application/json')||request.headers.get('content-type')?.startsWith('application/json')
  try {
    const origin=new URL(env.AUTH_ORIGIN).origin
    if(url.origin!==origin)throw new NectarError('forbidden',403)
    if(!['GET','HEAD','POST'].includes(request.method))return new Response(null,{status:405,headers:{...headers,allow:'GET, HEAD, POST'}})
    if(request.method==='POST'&&request.headers.get('origin')!==origin)throw new NectarError('forbidden',403)
    const attemptPath=url.pathname.match(/^\/pay-links\/attempts\/([\w-]+)(?:\/(continue|reconcile|finish|cancellation))?$/)
    if(attemptPath) {
      const [,id,operation]=attemptPath
      const row=await paymentLinkAttempt(env,request,id);language=row.language
      if(request.method==='POST') {
        if(!operation)throw new NectarError('not_found',404)
        const input=await Input.from(request);input.only(['confirm']);if(!input.flag('confirm'))throw new NectarError('payment_link_confirmation_required')
        const source=await one(env,'SELECT * FROM nc_payment_links WHERE id=?',row.link_id)
        if(!source)throw new NectarError('payment_link_unavailable',404)
        if(operation==='cancellation'){
          const result=await issuePaymentLinkCancellation(env,source,row)
          return json?Response.json(result,{headers}):new Response(null,{status:303,headers:{...headers,location:result.cancelUrl}})
        }
        const link=linkTerms(source).kind==='one_time'&&['open','captured','recording_invoice','complete'].includes(row.status)&&operation!=='continue'?source:await requireActivePaymentLink(env,row.link_id)
        const result=await operatePaymentLink(env,link,row,origin,operation as 'continue'|'reconcile'|'finish')
        if(json)return Response.json(result,{headers})
        return new Response(null,{status:303,headers:{...headers,location:'url' in result?String(result.url):`/pay-links/attempts/${id}`}})
      }
      if(operation)throw new NectarError('not_found',404)
      if(json)return Response.json(paymentLinkAttemptView(row),{headers})
      const L=customerText(language),link=await one(env,'SELECT * FROM nc_payment_links WHERE id=?',row.link_id),oneTime=link&&linkTerms(link).kind==='one_time'
      const complete=row.status==='complete',expired=row.status==='expired',consent=parseJson<Record<string,any>>(row.consent_json,{})
      const receipt=row.payment_id?await one(env,'SELECT r.number,p.amount_cents,p.received_on FROM nc_payment_receipts r JOIN nc_payments p ON p.id=r.payment_id WHERE p.id=? AND p.customer_id=?',row.payment_id,row.customer_id):null
      const action=row.status==='customer_ready'?'continue':['creating_customer','creating_checkout','updating_default'].includes(row.status)?'reconcile':'finish'
      const response=portalPage(L.t(oneTime?'paymentLink.oneTime.heading':'paymentLink.heading'),h`<header><h1>${L.t(oneTime?'paymentLink.oneTime.heading':'paymentLink.heading')}</h1><p>${link?.name}</p></header><section class="card"><h2>${L.t(complete?(oneTime?'paymentLink.oneTime.complete':'paymentLink.complete'):oneTime&&row.payment_id?'paymentLink.oneTime.recording':expired?'paymentLink.expired':'paymentLink.pending')}</h2>${complete||receipt?h`<dl><dt>${L.t(oneTime?'paymentLink.oneTime.total':'paymentLink.monthlyTotal')}</dt><dd>${L.money(consent.monthlyTotal)}</dd>${receipt?h`<dt>${L.t('paymentLink.receipt')}</dt><dd>${receipt.number}</dd><dt>${L.t('portal.payment')}</dt><dd>${L.money(receipt.amount_cents)} · ${L.day(receipt.received_on)}</dd>`:''}${!oneTime&&consent.termEnd?h`<dt>${L.t('paymentLink.termEnd')}</dt><dd>${L.day(consent.termEnd)}</dd>`:''}${row.trial_end?h`<dt>${L.t('paymentLink.trialEnds')}</dt><dd>${L.day(row.trial_end)}</dd>`:''}</dl>`:''}<p>${L.t(oneTime?'paymentLink.oneTime.noRecurring':'paymentLink.noDebit')}</p>
        ${!complete&&!expired?h`<form method="post" action="/pay-links/attempts/${id}/${action}">${hidden('confirm','true')}<button>${L.t(action==='reconcile'?'paymentLink.reconcile':action==='continue'?'paymentLink.continue':'paymentLink.finish')}</button></form>${row.status==='open'?h`<form method="post" action="/pay-links/attempts/${id}/continue">${hidden('confirm','true')}<button>${L.t('paymentLink.continue')}</button></form>`:''}`:''}
      ${complete&&!oneTime?h`<form method="post" action="/pay-links/attempts/${id}/cancellation">${hidden('confirm','true')}<button>${L.t('paymentLink.manage')}</button></form>`:''}</section>`,{lang:L.tag,style:'/portal/theme.css'})
      return new Response(request.method==='HEAD'?null:response.body,{headers:{...Object.fromEntries(response.headers),...headers}})
    }
    const match=url.pathname.match(/^\/pay-links\/([\w-]+)(?:\/(start))?$/)
    if(!match)throw new NectarError('not_found',404)
    const link=await requireActivePaymentLink(env,match[1])
    if(request.method==='POST') {
      if(!match[2])throw new NectarError('not_found',404)
      const input=await Input.from(request),created=await beginPaymentLink(env,link,input);language=created.row.language
      headers['set-cookie']=attemptCookie(created.row.id,created.token,url.protocol==='https:')
      // Cookie custody survives either lost provider response. Only this initial
      // invocation creates the provider customer; recovery is always GET-only.
      let result:Record<string,unknown>=paymentLinkAttemptView(created.row)
      try {
        if(!created.replayed) {
          const ready=await createPaymentLinkCustomer(env,link,created.row)
          result=await operatePaymentLink(env,link,ready,origin,'continue')
        }
      } catch(error) {
        result={...result,status:'uncertain',error:error instanceof NectarError?error.code:'payment_link_uncertain'}
      }
      if(json)return Response.json({...result,returnPath:`/pay-links/attempts/${created.row.id}`},{status:201,headers})
      return new Response(null,{status:303,headers:{...headers,location:typeof result.url==='string'?result.url:`/pay-links/attempts/${created.row.id}`}})
    }
    if(match[2])throw new NectarError('not_found',404)
    language=url.searchParams.get('language')??'en'
    const offer=await paymentLinkOffer(env,link,language),L=customerText(offer.language),oneTime=offer.terms.kind==='one_time'
    if(link.max_uses!==null&&link.used_count+link.reserved_count>=link.max_uses)throw new NectarError('payment_link_exhausted',409)
    const attemptToken=newPaymentLinkToken()
    if(json)return Response.json({id:link.id,name:link.name,terms:offer.terms,start:offer.start,trialEnd:offer.trialEnd,language:offer.language,offerHash:offer.hash,attemptToken},{headers})
    const response=portalPage(L.t('paymentLink.heading'),h`<header><h1>${link.name}</h1><p>${offer.terms.merchant}</p></header>
      <form method="get"><label>${L.t('paymentLink.language')}<select name="language">${languages().map(locale=>h`<option value="${locale.value}"${locale.value===L.tag?' selected':''}>${locale.label}</option>`)}</select></label><button>${L.t('paymentLink.chooseLanguage')}</button></form>
      <section class="card"><h2>${L.t('paymentLink.termsHeading')}</h2>${oneTime?h`<p>${offer.terms.oneTime!.description}</p>`:h`<ul>${offer.terms.items.map(item=>h`<li>${item.description} · ${item.quantity} × ${L.amount(item.unitAmount)} · ${L.t(item.timing==='advance'?'paymentLink.advance':'paymentLink.arrears')}</li>`)}</ul>`}
      <dl><dt>${L.t(oneTime?'paymentLink.oneTime.subtotal':'paymentLink.monthlySubtotal')}</dt><dd>${L.money(offer.terms.subtotalCents)}</dd><dt>${L.t(oneTime?'paymentLink.oneTime.tax':'paymentLink.tax')}</dt><dd>${L.money(offer.terms.taxCents)}</dd><dt>${L.t(oneTime?'paymentLink.oneTime.total':'paymentLink.monthlyTotal')}</dt><dd>${L.money(offer.terms.totalCents)}</dd><dt>${L.t('paymentLink.today')}</dt><dd>${L.money(oneTime?offer.terms.totalCents:0)}</dd><dt>${L.t('paymentLink.starts')}</dt><dd>${L.day(offer.start)}</dd>${offer.termEnd?h`<dt>${L.t('paymentLink.termEnd')}</dt><dd>${L.day(offer.termEnd)}</dd><dt>${L.t('paymentLink.renewal')}</dt><dd>${L.t(offer.terms.renewal?.auto_renew?'paymentLink.renews':'paymentLink.ends',{months:offer.terms.renewal?.months,percent:L.percent(offer.terms.renewal?.uplift_percent??'0'),days:offer.terms.renewal?.notice_days})}</dd>`:''}${offer.trialEnd?h`<dt>${L.t('paymentLink.trialEnds')}</dt><dd>${L.day(offer.trialEnd)}</dd>`:''}</dl><p>${L.t('paymentLink.taxPolicy',{jurisdiction:offer.terms.tax.jurisdiction,rate:L.percent(offer.terms.tax.rate)})}</p>
      ${offer.terms.promotion?h`<p>${L.t('paymentLink.promotion',{code:offer.terms.promotion.code,value:offer.terms.promotion.kind==='percent'?`${L.percent(offer.terms.promotion.value)}%`:L.amount(offer.terms.promotion.value),duration:L.t(`paymentLink.promotion.${offer.terms.promotion.duration}`,{months:offer.terms.promotion.months}),products:offer.terms.items.filter(item=>!parseJson<string[]>(offer.terms.promotion!.products_json,[]).length||parseJson<string[]>(offer.terms.promotion!.products_json,[]).includes(item.product)).map(item=>item.description).join(', ')})}</p>`:''}
      <p>${L.t(oneTime?'paymentLink.oneTime.terms':'paymentLink.terms')}</p><p>${L.t(oneTime?'paymentLink.oneTime.noRecurring':'paymentLink.noDebit')}</p>
      <form method="post" action="/pay-links/${link.id}/start">${hidden('language',L.tag)}${hidden('offer_hash',offer.hash)}${hidden('attempt_token',attemptToken)}<p><label>${L.t('paymentLink.name')}<input name="name" required maxlength="160" autocomplete="name"></label></p><p><label>${L.t('paymentLink.email')}<input name="billing_email" type="email" required maxlength="200" autocomplete="email"></label></p><p><label>${L.t('paymentLink.address')}<textarea name="address" required maxlength="400" autocomplete="street-address"></textarea></label></p>
      <p><label><input type="checkbox" name="confirm" required> ${L.t(oneTime?'paymentLink.oneTime.pay':'paymentLink.save')}</label></p>${!oneTime?h`<p><label><input type="checkbox" name="make_default"> ${L.t('paymentLink.default')}</label></p>`:''}<button>${L.t('paymentLink.continue')}</button></form></section>`,{lang:L.tag,name:offer.terms.merchant,style:'/portal/theme.css'})
    return new Response(request.method==='HEAD'?null:response.body,{headers:{...Object.fromEntries(response.headers),...headers}})
  } catch(error) {
    const known=error instanceof NectarError
    const status=known?error.status:503
    if(json)return Response.json({error:known?error.code:'payment_link_uncertain'},{status,headers})
    const L=customerText([401,403,404].includes(status)?null:language)
    const response=portalPage(L.t('paymentLink.unavailable'),h`<h1>${L.t('paymentLink.unavailable')}</h1><p>${L.t('paymentLink.unavailableBody')}</p>`,{lang:L.tag,status,style:'/portal/theme.css'})
    return new Response(request.method==='HEAD'?null:response.body,{status,headers:{...Object.fromEntries(response.headers),...headers}})
  }
}
