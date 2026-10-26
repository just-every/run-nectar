import type { Bindings } from '../auth.server'
import { storedAutomaticCollection } from './automatic-collection-records'
import { NectarError, insist } from './core'
import { Input } from './input'
import { portalHeaders, portalPage } from './portal-page'
import { customerSession } from './portal-session'
import { acceptRetryMethodRecovery, recoveryText, retryMethodRecovery, retryMethodRecoveryView } from './retry-method-recovery'
import { h, hidden } from './ui/html'

export async function retryMethodRecoveryResponse(request:Request,env:Bindings):Promise<Response|null>{
 const url=new URL(request.url),id=url.pathname.match(/^\/portal\/retry-method-recoveries\/([\w-]+)$/)?.[1]
 if(!id)return null
 let language:string|null=null
 try{
  const session=await customerSession(env,request);language=session.language
  insist(session.audience==='hosted'&&session.parent==='','hosted_session_required',403)
  const proposal=await retryMethodRecovery(env,id)
  insist(proposal.customer_id===session.customer,'retry_recovery_not_found',404)
  await storedAutomaticCollection(env,proposal.collection_id)
  if(request.method==='POST'){
   const input=await Input.from(request);insist(input.text('recovery',{max:100})===id,'retry_recovery_not_found',404)
   const result=await acceptRetryMethodRecovery(env,request,input)
   if(request.headers.get('content-type')?.startsWith('application/json'))return Response.json(result,{headers:portalHeaders})
   return new Response(null,{status:303,headers:{...portalHeaders,location:url.pathname+url.search}})
  }
  insist(['GET','HEAD'].includes(request.method),'method_not_allowed',405)
  const view=retryMethodRecoveryView(proposal),L=recoveryText(language),quote=view.quote
  if(request.headers.get('accept')?.includes('application/json'))return new Response(request.method==='HEAD'?null:JSON.stringify(view),{headers:{...portalHeaders,'content-type':'application/json'}})
  const status=L[view.status as keyof typeof L]
  const response=portalPage(L.heading,h`<h1>${L.heading}</h1><section class="card"><p>${quote.wording}</p><p>${typeof status==='string'?status:L.unavailable}</p>
  ${view.status==='awaiting_customer'?h`<form method="post" action="${url.pathname+url.search}">${hidden('recovery',id)}${hidden('quote_hash',view.quoteHash)}<label><input type="checkbox" name="accept" value="true" required> ${L.accept}</label><button type="submit">${L.confirm}</button></form>`:''}
  ${['awaiting_customer','pending_approval','active'].includes(view.status)?h`<form method="post" action="${url.pathname+url.search}">${hidden('recovery',id)}${hidden('quote_hash',view.quoteHash)}${hidden('withdraw','true')}<button type="submit">${L.withdraw}</button></form>`:''}</section>`,{lang:L.tag})
  return new Response(request.method==='HEAD'?null:response.body,{headers:{...Object.fromEntries(response.headers),...portalHeaders,'content-security-policy':"default-src 'none'; style-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"}})
 }catch(error){
  if(!(error instanceof NectarError))throw error
  console.warn('retry method refusal',error.code)
  if(request.headers.get('content-type')?.startsWith('application/json')||request.headers.get('accept')?.includes('application/json'))return Response.json({error:error.code},{status:error.status,headers:portalHeaders})
  const L=recoveryText(language),response=portalPage(L.unavailable,h`<h1>${L.unavailable}</h1>`,{status:error.status,lang:L.tag})
  return new Response(request.method==='HEAD'?null:response.body,{status:error.status,headers:{...Object.fromEntries(response.headers),...portalHeaders}})
 }
}
