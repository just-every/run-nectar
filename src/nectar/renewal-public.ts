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
  if(!term||!b||today(b.timezone)>=term.end_date){if(request.body)await request.arrayBuffer();return response('Link unavailable',h`<h1>This renewal link is no longer active</h1><p>It may have been replaced or the renewal was already cancelled. Contact the business for your current subscription status.</p>`,404)}
  if(request.method==='POST') {
    let form:FormData
    try{form=await request.formData()}catch{return response('Confirmation required',h`<h1>Use the cancellation confirmation form</h1>`,400)}
    if(form.get('confirm')!=='cancel')return response('Confirmation required',h`<h1>Confirm cancellation</h1><p>Use the Cancel renewal button.</p>`,400)
    await commit(env,[guard(env,'stale',"EXISTS(SELECT 1 FROM nc_renewal_terms WHERE id=? AND token_hash=? AND revision=? AND status='active' AND cancelled_at IS NULL)",term.id,hash,term.revision),stmt(env,'UPDATE nc_renewal_terms SET auto_renew=0,cancelled_at=?,token_hash=NULL,revision=? WHERE id=?',now(),newId(),term.id)],{actor:'customer:renewal-link',action:'subscription.renewal.cancel',subject:term.subscription_id,detail:{term:term.id,end:term.end_date}})
    return response('Renewal cancelled',h`<h1>Renewal cancelled</h1><p>Your subscription will end on ${term.end_date}. It will not renew. No call or further step is needed.</p>`)
  }
  return response('Manage renewal',h`<h1>Manage your renewal</h1><section class="card"><h2>Subscription renewal</h2><p>Current term ends ${term.end_date}. ${term.auto_renew?'It renews automatically unless you cancel.':'It will end without renewing.'}</p><p>Renewal price uplift: ${term.uplift_percent}%. Billing remains monthly. Your renewal email lists the charges.</p><form method="post" action="${url.pathname}"><input type="hidden" name="confirm" value="cancel"><button type="submit">Cancel renewal</button></form><p>No sign-in, call, chat, reason or save offer is required. Access continues until the term ends.</p></section>`)
}
