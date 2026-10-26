import { authenticateRetryRecovery } from './retry-authentication'
import { clockInstant } from './clock'
import type { Bindings } from '../auth.server'
import { storedAutomaticCollection } from './automatic-collection-records'
import { NectarError, insist } from './core'
import { customerText } from './locale'
import { Input } from './input'
import { portalHeaders, portalPage } from './portal-page'
import { customerSession } from './portal-session'
import { acceptRetryMethodRecovery, recoveryText, retryMethodRecovery, retryMethodRecoveryView } from './retry-method-recovery'
import { h, hidden } from './ui/html'

export async function retryMethodRecoveryResponse(request:Request,env:Bindings):Promise<Response|null>{
 const url=new URL(request.url),match=url.pathname.match(/^\/portal\/retry-method-recoveries\/([\w-]+)(\/return)?$/),id=match?.[1]
 if(!id)return null
 const path=`/portal/retry-method-recoveries/${id}`,cookieName=`nectar_retry_${id}`
 if(match?.[2]){
  // Provider query parameters, including its client secret, never reach a page.
  return new Response(null,{status:303,headers:{...portalHeaders,location:path}})
 }
 if(!url.searchParams.has('session')){
  const tokens=(request.headers.get('cookie')??'').split(';').map(value=>value.trim()).filter(value=>value.startsWith(cookieName+'='))
  if(tokens.length===1){url.searchParams.set('session',tokens[0].slice(cookieName.length+1));request=new Request(url,request)}
 }
 let language:string|null=null
 try{
  const session=await customerSession(env,request);language=session.language
  insist(session.audience==='hosted'&&session.parent==='','hosted_session_required',403)
  const proposal=await retryMethodRecovery(env,id)
  insist(proposal.customer_id===session.customer,'retry_recovery_not_found',404)
  await storedAutomaticCollection(env,proposal.collection_id)
  if(request.method==='POST'){
   const input=await Input.from(request);insist(input.text('recovery',{max:100})===id,'retry_recovery_not_found',404)
   if(input.flag('authenticate')||input.flag('check')){
    const result=await authenticateRetryRecovery(env,request,input)
    const token=new URL(request.url).searchParams.get('session')!
    const cookie=`${cookieName}=${token}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0,Math.floor((session.exp-clockInstant(env))/1000))}${url.protocol==='https:'?'; Secure':''}`
    const headers={...portalHeaders,'set-cookie':cookie}
    if(request.headers.get('content-type')?.startsWith('application/json'))return Response.json(result,{headers})
    return new Response(null,{status:303,headers:{...headers,location:result.redirect??path}})
   }
   const result=await acceptRetryMethodRecovery(env,request,input)
   if(request.headers.get('content-type')?.startsWith('application/json'))return Response.json(result,{headers:portalHeaders})
   return new Response(null,{status:303,headers:{...portalHeaders,location:url.pathname+url.search}})
  }
  insist(['GET','HEAD'].includes(request.method),'method_not_allowed',405)
  const view=retryMethodRecoveryView(proposal),L=recoveryText(language,view.authentication),quote=view.quote
  const collection=await storedAutomaticCollection(env,proposal.collection_id),text=customerText(language)
  if(request.headers.get('accept')?.includes('application/json'))return new Response(request.method==='HEAD'?null:JSON.stringify({...view,paymentStatus:collection.status}),{headers:{...portalHeaders,'content-type':'application/json'}})
  const status=L[view.status as keyof typeof L]
  const response=portalPage(L.heading,h`<h1>${L.heading}</h1><section class="card"><p>${quote.wording}</p><p>${collection.status==='collected'?text.t('automatic.collected'):view.authentication&&view.status==='consumed'?text.t(collection.status==='refused'?'automatic.refused':'automatic.uncertain'):typeof status==='string'?status:L.unavailable}</p>
  ${view.authentication&&collection.status!=='collected'&&['active','consumed'].includes(view.status)?h`<form method="post" action="${url.pathname+url.search}">${hidden('recovery',id)}${hidden('quote_hash',view.quoteHash)}${hidden(view.status==='active'?'authenticate':'check','true')}<button type="submit">${text.t(view.status==='active'?'retry.authentication.continue':'retry.authentication.check')}</button></form>`:''}
  ${view.status==='awaiting_customer'?h`<form method="post" action="${url.pathname+url.search}">${hidden('recovery',id)}${hidden('quote_hash',view.quoteHash)}<label><input type="checkbox" name="accept" value="true" required> ${L.accept}</label><button type="submit">${L.confirm}</button></form>`:''}
  ${['awaiting_customer','pending_approval','active'].includes(view.status)?h`<form method="post" action="${url.pathname+url.search}">${hidden('recovery',id)}${hidden('quote_hash',view.quoteHash)}${hidden('withdraw','true')}<button type="submit">${L.withdraw}</button></form>`:''}</section>`,{lang:L.tag})
  return new Response(request.method==='HEAD'?null:response.body,{headers:{...Object.fromEntries(response.headers),...portalHeaders,'referrer-policy':'strict-origin','content-security-policy':"default-src 'none'; style-src 'self'; font-src 'self'; form-action 'self' https://hooks.stripe.com; frame-ancestors 'none'; base-uri 'none'"}})
 }catch(error){
  if(!(error instanceof NectarError))throw error
  if(request.headers.get('content-type')?.startsWith('application/json')||request.headers.get('accept')?.includes('application/json'))return Response.json({error:error.code},{status:error.status,headers:portalHeaders})
  const L=recoveryText(language),response=portalPage(L.unavailable,h`<h1>${L.unavailable}</h1><p>${customerText(language).t('portal.request.unavailable.body')}</p>`,{status:error.status,lang:L.tag})
  return new Response(request.method==='HEAD'?null:response.body,{status:error.status,headers:{...Object.fromEntries(response.headers),...portalHeaders}})
 }
}
