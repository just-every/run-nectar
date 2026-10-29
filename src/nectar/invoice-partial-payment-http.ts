import type { Bindings } from '../auth.server'
import { clockInstant } from './clock'
import { insist, one, sha256Hex } from './core'
import { Input } from './input'
import { customerText } from './locale'
import { b64url } from './mfa-crypto'
import { portalHeaders, portalPage } from './portal-page'
import { customerSession, type CustomerSession } from './portal-session'
import { partialCustomerView } from './invoice-partial-payment-page'
import { partialPaymentRow, startInvoicePartial, reconcilePartial } from './invoice-partial-payments'
import { h, hidden } from './ui/html'

const cookieName='nectar_invoice_partial_return',attributes='Path=/portal/invoice-payment; Secure; HttpOnly; SameSite=Lax'
async function returnedSession(env: Bindings,request: Request) {
  const cookies=(request.headers.get('cookie')??'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(cookieName+'='))
  insist(cookies.length===1,'invalid_customer_session',401)
  const token=cookies[0].slice(cookieName.length+1)
  insist(/^[A-Za-z0-9_-]{43}$/.test(token),'invalid_customer_session',401)
  const hash=await sha256Hex(token),at=clockInstant(env)
  const r=await one(env,`SELECT r.request_id,p.*,c.language,c.currency FROM nc_invoice_partial_returns r
    JOIN nc_portal_sessions p ON p.id=r.portal_session_id AND p.customer_id=r.customer_id
    JOIN nc_portal_policy policy ON policy.singleton=1 AND policy.revision=p.policy_revision
    JOIN nc_customers c ON c.id=p.customer_id
    WHERE r.id=? AND r.consumed_at IS NULL AND r.expires_at>? AND r.expires_at<=p.expires_at
    AND p.origin=? AND p.audience='hosted' AND p.revoked_at IS NULL AND p.expires_at>? AND c.erased_at IS NULL AND c.status='active'
    AND NOT EXISTS(SELECT 1 FROM nc_dunning_mail_authority a JOIN nc_dunning_deliveries d ON d.id=a.id WHERE a.portal_session_id=p.id AND d.expires_at<=?)
    AND NOT EXISTS(SELECT 1 FROM nc_card_expiry_notice_authority a JOIN nc_card_expiry_notices n ON n.id=a.id WHERE a.portal_session_id=p.id AND n.expires_at<=?)`,hash,at,new URL(request.url).origin,at,at,at)
  insist(r,'invalid_customer_session',401)
  const session:CustomerSession={v:1,iss:env.AUTH_ORIGIN,jti:r.id,customer:r.customer_id,origin:r.origin,audience:r.audience,parent:r.parent_origin,iat:r.issued_at,exp:r.expires_at,language:r.language,currency:r.currency}
  return {session,hash,requestId:r.request_id}
}
export async function invoicePartialResponse(request: Request,env: Bindings): Promise<Response|null> {
  const url=new URL(request.url)
  if(!url.pathname.startsWith('/portal/invoice-payment/'))return null
  const headers:Record<string,string>={...portalHeaders}
  insist(['GET','HEAD','POST'].includes(request.method),'method_not_allowed',405)
  const returned=url.searchParams.has('session')?null:await returnedSession(env,request)
  const session=returned?.session??await customerSession(env,request),L=customerText(session.language)
  insist(session.audience==='hosted','forbidden',403)
  if(request.method==='POST'){
    insist(request.headers.get('origin')===session.origin,'forbidden',403)
    const input=await Input.from(request),id=input.text('request',{max:100}),row=await partialPaymentRow(env,id)
    insist(row.customer_id===session.customer&&(!returned||returned.requestId===row.id),'invoice_partial_not_found',404)
    if(url.pathname.endsWith('/start')){
      insist(!returned,'forbidden',403)
      const token=b64url(crypto.getRandomValues(new Uint8Array(32))),expiry=Math.min(session.exp,clockInstant(env)+900000)
      const result=await startInvoicePartial(env,session,row,input,await sha256Hex(token),expiry)
      headers['set-cookie']=`${cookieName}=${token}; ${attributes}; Max-Age=${Math.floor((expiry-clockInstant(env))/1000)}`
      if(request.headers.get('content-type')?.startsWith('application/json'))return Response.json(result,{headers})
      return new Response(null,{status:303,headers:{...headers,location:result.url??'/portal/invoice-payment/return'}})
    }
    insist(url.pathname.endsWith('/check'),'not_found',404)
    input.only(['request'])
    const result=await reconcilePartial(env,row,undefined,session,returned?.hash)
    if(['collected','expired'].includes(result.status))headers['set-cookie']=`${cookieName}=; ${attributes}; Max-Age=0`
    if(request.headers.get('content-type')?.startsWith('application/json'))return Response.json(partialCustomerView(result),{headers})
    const response=portalPage(L.t('partial.title'),h`<h1>${L.t('partial.title')}</h1><p>${L.t(`partial.status.${result.status}`)}</p><p>${L.t('partial.amount')}: ${L.money(result.amount_cents)}</p>`,{lang:L.tag})
    return new Response(response.body,{headers:{...Object.fromEntries(response.headers),...headers}})
  }
  insist(url.pathname==='/portal/invoice-payment/return'&&returned,'not_found',404)
  const row=await partialPaymentRow(env,returned.requestId)
  insist(row.customer_id===session.customer,'invalid_customer_session',401)
  // Returning from the processor alone changes no local money or authority.
  const response=portalPage(L.t('partial.title'),h`<h1>${L.t('partial.title')}</h1><p>${L.t('partial.amount')}: ${L.money(row.amount_cents)}</p><p>${L.t('partial.return')}</p>
    <form method="post" action="/portal/invoice-payment/check">${hidden('request',row.id)}<button type="submit">${L.t('partial.check')}</button></form>`,{lang:L.tag})
  return new Response(request.method==='HEAD'?null:response.body,{headers:{...Object.fromEntries(response.headers),'referrer-policy':'strict-origin','content-security-policy':"default-src 'none'; style-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"}})
}
