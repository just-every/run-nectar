import type { Bindings } from '../auth.server'
import { acceptAutomaticCollection,withdrawAutomaticCollection } from './automatic-collection'
import { automaticQuote, storedAutomaticCollection } from './automatic-collection-records'
import { NectarError, insist } from './core'
import { Input } from './input'
import { customerText } from './locale'
import { portalHeaders, portalPage } from './portal-page'
import { customerSession } from './portal-session'
import { h,hidden } from './ui/html'
export async function automaticCollectionResponse(request:Request,env:Bindings){
 const url=new URL(request.url),id=url.pathname.match(/^\/portal\/automatic-collections\/([\w-]+)$/)?.[1]
 if(!id)return null
 let language:string|null=null
 try{
  const session=await customerSession(env,request);language=session.language
  insist(session.audience==='hosted','forbidden',403)
  const row=await storedAutomaticCollection(env,id);insist(row.customer_id===session.customer,'automatic_collection_not_found',404)
  if(request.method==='POST'){
   const input=await Input.from(request);insist(input.text('request',{max:100})===id,'automatic_collection_not_found',404)
   const result=input.flag('withdraw')?await withdrawAutomaticCollection(env,request,input):await acceptAutomaticCollection(env,request,input)
   if(request.headers.get('content-type')?.startsWith('application/json'))return Response.json(result,{headers:portalHeaders})
   return new Response(null,{status:303,headers:{...portalHeaders,location:url.pathname+url.search}})
  }
  insist(['GET','HEAD'].includes(request.method),'method_not_allowed',405)
  const q=automaticQuote(row),L=customerText(language)
  const text=q.wording
  const response=portalPage(L.t('automatic.heading'),h`<h1>${L.t('automatic.heading')}</h1><section class="card"><p>${text}</p><p>${L.t('automatic.status')}: ${L.t(`automatic.${!row.authorized&&!row.claimed_at?'historical':row.status}`)}</p>${row.authorized&&row.status==='awaiting_customer'?h`<form method="post" action="${url.pathname+url.search}">${hidden('request',id)}${hidden('basis_hash',row.basis_hash)}<label><input type="checkbox" name="accept" value="true" required> ${L.t('automatic.accept')}</label><button type="submit">${L.t('automatic.confirm')}</button></form>`:''}${(['awaiting_customer','pending_approval','active'].includes(row.status)||!!q.retryPolicy&&['refused','returned'].includes(row.status))?h`<form method="post" action="${url.pathname+url.search}">${hidden('request',id)}${hidden('withdraw','true')}<button type="submit">${L.t('automatic.withdraw')}</button></form>`:''}</section>`,{lang:L.tag,style:'/portal/theme.css'})
  const headers=new Headers(response.headers);Object.entries(portalHeaders).forEach(([key,value])=>headers.set(key,value));headers.set('referrer-policy','strict-origin')
  return new Response(request.method==='HEAD'?null:response.body,{headers})
 }catch(error){
  if(!(error instanceof NectarError))throw error
  if(request.headers.get('content-type')?.startsWith('application/json'))return Response.json({error:error.code},{status:error.status,headers:portalHeaders})
  const L=customerText(language),response=portalPage(L.t('portal.request.unavailable'),h`<h1>${L.t('portal.request.unavailable')}</h1><p>${L.t('portal.request.unavailable.body')}</p>`,{status:error.status,lang:L.tag})
  return new Response(response.body,{status:error.status,headers:{...Object.fromEntries(response.headers),...portalHeaders}})
 }
}
