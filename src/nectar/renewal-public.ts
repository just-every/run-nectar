import { clockInstant } from './clock'
import { NectarError } from './core'
import { savedOffer,declineSaveStatements,acceptSave } from './retention-offers'
import { parseJson,type Row } from './core'
// The token authorizes only ending this term's next renewal. GET is read-only.
import type { Bindings } from '../auth.server'
import { business } from './business'
import { commit, guard, newId, now, one, sha256Hex, stmt } from './core'
import { today } from './dates'
import { h, page } from './ui/html'
export async function renewalPublic(request:Request,env:Bindings):Promise<Response|null> {
  const url=new URL(request.url),token=url.pathname.match(/^\/renewal\/([a-f0-9]{64})$/)?.[1]
  if(!url.pathname.startsWith('/renewal/'))return null
  const response=(title:string,body:ReturnType<typeof h>,status=200)=>page(title,null,body,{status,showNav:false})
  if(!['GET','HEAD','POST'].includes(request.method))return new Response(null,{status:405,headers:{allow:'GET, HEAD, POST'}})
  if(request.method==='POST'&&request.headers.get('origin')!==env.AUTH_ORIGIN){await request.arrayBuffer();return response('Forbidden',h`<h1>Forbidden</h1>`,403)}
  const hash=token?await sha256Hex(token):'',term=token?await one(env,"SELECT * FROM nc_renewal_terms WHERE token_hash=? AND status='active' AND cancelled_at IS NULL",hash):null,b=await business(env)
  if(!term||!b||today(b.timezone,clockInstant(env))>=term.end_date){if(request.body)await request.arrayBuffer();return response('Link unavailable',h`<h1>This renewal link is no longer active</h1><p>It may have been replaced or the renewal was already cancelled. Contact the business for your current subscription status.</p>`,404)}
  if(request.method==='POST') {
    let form:FormData
    try{form=await request.formData()}catch{return response('Confirmation required',h`<h1>Use the cancellation confirmation form</h1>`,400)}
    const reasonValue=form.get('reason')
    if(reasonValue!==null&&(typeof reasonValue!=='string'||reasonValue.length>500))return response('Reason too long',h`<h1>Keep the optional reason within 500 characters</h1>`,400)
    const reason=String(reasonValue??'').trim()||'not supplied'
    if(form.get('confirm')==='save'){try{const saved=await acceptSave(env,term,String(form.get('offer')??''),reason);return response('Subscription continued',h`<h1>Subscription continued</h1><p>${saved.kind==='downgrade'?`Your downgrade applies from ${saved.from}; existing item end dates stay in place.`:`Your ${saved.kind} save applies from ${saved.from} until ${saved.to}, exclusive.`} Renewal remains enabled. No further step is needed.</p>`)}catch(error){if(!(error instanceof NectarError))throw error;return response('Offer changed',h`<h1>The offer changed</h1><p>No save was applied. Reopen your current cancellation link to cancel without accepting an offer.</p>`,error.status)}}
    if(form.get('confirm')!=='cancel')return response('Confirmation required',h`<h1>Confirm cancellation</h1><p>Use the Cancel renewal button.</p>`,400)
    const declined=await declineSaveStatements(env,term,reason)
    await commit(env,[...declined,guard(env,'stale',"EXISTS(SELECT 1 FROM nc_renewal_terms WHERE id=? AND token_hash=? AND revision=? AND status='active' AND cancelled_at IS NULL)",term.id,hash,term.revision),stmt(env,'UPDATE nc_renewal_terms SET auto_renew=0,cancelled_at=?,token_hash=NULL,revision=? WHERE id=?',now(),newId(),term.id)],{actor:'customer:renewal-link',action:'subscription.renewal.cancel',subject:term.subscription_id,detail:{term:term.id,end:term.end_date,reason}})
    return response('Renewal cancelled',h`<h1>Renewal cancelled</h1><p>Your subscription will end on ${term.end_date}. It will not renew. No call or further step is needed.</p>`)
  }
  const offer=await savedOffer(env,term),save=offer?parseJson<Row>(offer.terms_json,{}):null
  return response('Manage renewal',h`<h1>Manage your renewal</h1><section class="card"><h2>Subscription renewal</h2><p>Current term ends ${term.end_date}. ${term.auto_renew?'It renews automatically unless you cancel.':'It will end without renewing.'}</p><p>Renewal price uplift: ${term.uplift_percent}%. Billing remains monthly. Your renewal email lists the charges.</p><form method="post" action="${url.pathname}">${save?h`<input type="hidden" name="offer" value="${offer!.id}"><p>Optional save: ${save.kind==='discount'?`${save.percent}% off fixed and seat charges for ${save.months} monthly periods`:save.kind==='pause'?`Pause charges and access until ${save.to}`:`Downgrade to ${save.targetLabel}`}. ${save.kind==='downgrade'?`From ${save.from}; existing item end dates stay in place.`:`Effective ${save.from} to ${save.to}, exclusive.`} Usage is excluded from discounts.</p>`:''}<label>Reason (optional)<input name="reason" maxlength="500"></label><button type="submit" name="confirm" value="cancel">Cancel renewal</button>${save?h`<button class="secondary" type="submit" name="confirm" value="save">Accept optional save</button>`:''}</form><p>No sign-in, call, chat, reason or save offer is required. Access continues until the term ends.</p></section>`)
}
