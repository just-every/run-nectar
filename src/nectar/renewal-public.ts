import { cancelRenewal, renewalManagement } from './renewal-management'
import { clockInstant } from './clock'
import { NectarError } from './core'
import { acceptSave } from './retention-offers'
// The token authorizes only ending this term's next renewal. GET is read-only.
import type { Bindings } from '../auth.server'
import { business } from './business'
import { one, sha256Hex } from './core'
import { today } from './dates'
import { h, page } from './ui/html'
import { customerText } from './locale'
export async function renewalPublic(request:Request,env:Bindings):Promise<Response|null> {
  const url=new URL(request.url),token=url.pathname.match(/^\/renewal\/([a-f0-9]{64})$/)?.[1]
  if(!url.pathname.startsWith('/renewal/'))return null
  const response=(title:string,body:ReturnType<typeof h>,status=200)=>page(title,null,body,{status,showNav:false,lang:L.tag})
  // Until a live token names the customer, the page is in the default language.
  let L=customerText(null)
  if(!['GET','HEAD','POST'].includes(request.method))return new Response(null,{status:405,headers:{allow:'GET, HEAD, POST'}})
  if(request.method==='POST'&&request.headers.get('origin')!==env.AUTH_ORIGIN){await request.arrayBuffer();return response(L.t('public.forbidden'),h`<h1>${L.t('public.forbidden')}</h1>`,403)}
  const hash=token?await sha256Hex(token):'',term=token?await one(env,"SELECT t.*,c.language FROM nc_renewal_terms t JOIN nc_subscriptions s ON s.id=t.subscription_id JOIN nc_customers c ON c.id=s.customer_id WHERE t.token_hash=? AND t.status='active' AND t.cancelled_at IS NULL",hash):null,b=await business(env)
  if(!term||!b||today(b.timezone,clockInstant(env))>=term.end_date){if(request.body)await request.arrayBuffer();return response(L.t('renewal.unavailable.title'),h`<h1>${L.t('renewal.unavailable.heading')}</h1><p>${L.t('renewal.unavailable.body')}</p>`,404)}
  L=customerText(term.language)
  if(request.method==='POST') {
    let form:FormData
    try{form=await request.formData()}catch{return response(L.t('renewal.confirm.title'),h`<h1>${L.t('renewal.confirm.form')}</h1>`,400)}
    const reasonValue=form.get('reason')
    if(reasonValue!==null&&(typeof reasonValue!=='string'||reasonValue.length>500))return response(L.t('renewal.reason_long.title'),h`<h1>${L.t('renewal.reason_long.heading')}</h1>`,400)
    const reason=String(reasonValue??'').trim()||'not supplied'
    if(form.get('confirm')==='save'){try{const saved=await acceptSave(env,term,String(form.get('offer')??''),reason);return response(L.t('renewal.continued.title'),h`<h1>${L.t('renewal.continued.title')}</h1><p>${saved.kind==='downgrade'?L.t('renewal.continued.downgrade',{from:L.day(saved.from)}):L.t(saved.kind==='pause'?'renewal.continued.pause':'renewal.continued.discount',{from:L.day(saved.from),to:L.day(saved.to)})} ${L.t('renewal.continued.tail')}</p>`)}catch(error){if(!(error instanceof NectarError))throw error;return response(L.t('renewal.changed.title'),h`<h1>${L.t('renewal.changed.heading')}</h1><p>${L.t('renewal.changed.body')}</p>`,error.status)}}
    if(form.get('confirm')!=='cancel')return response(L.t('renewal.confirm.title'),h`<h1>${L.t('renewal.confirm.heading')}</h1><p>${L.t('renewal.confirm.button')}</p>`,400)
    await cancelRenewal(env,term,reason)
    return response(L.t('renewal.cancelled.title'),h`<h1>${L.t('renewal.cancelled.title')}</h1><p>${L.t('renewal.cancelled.body',{date:L.day(term.end_date)})}</p>`)
  }
  return response(L.t('renewal.manage.title'),await renewalManagement(env,term,url.pathname,L),200)
}