// Each send requires a separate current owner confirmation of the frozen message.
import type { Bindings } from '../auth.server'
import { operatorMail } from '../mail.server.mjs'
import { actorLabel, type Actor } from './actor'
import { clockInstant } from './clock'
import { canonical, commit, fingerprint, guard, insist, newId, one, stmt, type Row } from './core'
import { cadenceSourceGuard, cadenceSourceSequence } from './cadence-policy'
import { dunningDue, dunningFence, dunningSeries, dunningSource } from './dunning-policy'
import { prepareHostedSetup } from './hosted-setup'
import { setupOwner, setupOwnerFence } from './hosted-setup-basis'
import { Input } from './input'
import { customerText } from './locale'
import { STEP_UP_MS } from './mfa'
import { issuePortalSession } from './portal-policy'
import { esc } from './ui/html'

export async function prepareDunningMail(env: Bindings,actor: Actor,input: Input) {
 const factor=await setupOwner(env,actor)
 input.only(['series','step','confirm','returnTo']);insist(input.flag('confirm'),'dunning_confirmation_required')
 const series=await dunningSeries(env,input.text('series',{max:100})),step=input.integer('step',{min:1,max:12})!
 let source=await dunningSource(env,series)
 insist(!source.stopped&&!source.held,'dunning_invoice_held',409)
 const due=dunningDue(series,step)
 insist(source.day===due,'dunning_not_due_today',409)
 insist(!await one(env,'SELECT 1 FROM nc_dunning_deliveries WHERE series_id=? AND step=?',series.id,step),'dunning_step_already_prepared',409)
 let setupId='',sessionId='',updateLink=''
 if(!series.invoice_only) {
  const binding=await one(env,'SELECT * FROM nc_stripe_customer_bindings WHERE customer_id=?',series.customer_id)
  insist(binding,'native_customer_binding_required',409)
  const setup=await prepareHostedSetup(env,actor,Input.of({customer:series.customer_id,binding:binding.id,method:'card',confirm:true}))
  const session=await issuePortalSession(env,actor,Input.of({customer:series.customer_id,origin:env.AUTH_ORIGIN,audience:'hosted'}))
  setupId=setup.id;sessionId=session.id
  updateLink=`${env.AUTH_ORIGIN}/portal/payment-methods?session=${encodeURIComponent(session.token)}&setup=${encodeURIComponent(setup.id)}`
 }
 const seq=await cadenceSourceSequence(env)
 source=await dunningSource(env,await dunningSeries(env,series.id))
 insist(!source.stopped&&!source.held&&source.day===due,'dunning_source_changed',409)
 const L=customerText(source.invoice.language,source.invoice.currency)
 const subject=L.t('dunning.subject',{invoice:source.invoice.number})
 const facts=L.t('dunning.body',{merchant:source.invoice.business.legal_name,invoice:source.invoice.number,amount:L.money(source.invoice.collectibleCents),date:L.day(due)})
 const body=`${facts}\n\n${series.invoice_only?L.t('dunning.invoice_only'):`${L.t('dunning.update',{link:updateLink})}\n${L.t('dunning.note')}`}`
 const html=`<html lang="${esc(L.tag)}"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font:16px/1.5 sans-serif;margin:24px;overflow-wrap:anywhere"><p>${esc(facts)}</p>${series.invoice_only?`<p>${esc(L.t('dunning.invoice_only'))}</p>`:`<p><a href="${esc(updateLink)}" style="display:inline-block;box-sizing:border-box;min-height:44px;padding:12px 18px;background:#245c46;color:#fff;border-radius:8px;text-decoration:none">${esc(L.t('dunning.update_label'))}</a></p><p>${esc(L.t('dunning.note'))}</p>`}</body></html>`
 const from=env.MAIL_FROM??'',provider=env.MAIL_PROVIDER??''
 const basis=canonical({source:source.basis,subject,body,html,from,provider,setup:setupId,session:sessionId})
 const hash=await fingerprint(basis),id=newId(),at=clockInstant(env),expiresAt=Math.min(at+STEP_UP_MS,factor.verifiedAt+STEP_UP_MS)
 await commit(env,[...setupOwnerFence(env,actor),dunningFence(env,series),cadenceSourceGuard(env,seq),
  guard(env,'dunning_step_already_prepared','NOT EXISTS(SELECT 1 FROM nc_dunning_deliveries WHERE series_id=? AND step=?)',series.id,step),
  stmt(env,`INSERT INTO nc_dunning_deliveries(id,series_id,invoice_id,customer_id,step,due_date,recipient,language,amount_cents,basis_hash,wording_version,prepared_by,prepared_at,expires_at,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared')`,id,series.id,series.invoice_id,series.customer_id,step,due,source.invoice.billing_email,L.tag,source.invoice.collectibleCents,hash,'dunning-1',actor.id,at,expiresAt),
  stmt(env,'INSERT INTO nc_dunning_mail_authority(id,customer_id,owner_session_id,portal_session_id,setup_id,source_json,subject,body,html,from_address,mail_provider) VALUES(?,?,?,?,?,?,?,?,?,?,?)',id,series.customer_id,actor.sessionId,sessionId,setupId,basis,subject,body,html,from,provider)],
  {actor:actorLabel(actor),action:'dunning.mail.prepare',subject:id,detail:{series:series.id,invoice:series.invoice_id,step,due,recipient:source.invoice.billing_email,amountCents:source.invoice.collectibleCents,wordingVersion:'dunning-1',basisHash:hash,expiresAt,factorVerifiedAt:factor.verifiedAt}})
 return {id,series:series.id,step,due,status:'prepared',basisHash:hash,recipient:source.invoice.billing_email,subject,body,expiresAt}
}

export async function sendDunningMail(env: Bindings,actor: Actor,input: Input) {
 await setupOwner(env,actor);input.only(['delivery','basis_hash','confirm','returnTo']);insist(input.flag('confirm'),'dunning_confirmation_required')
 const seq=await cadenceSourceSequence(env)
 const row=await one(env,`SELECT d.*,a.owner_session_id,a.portal_session_id,a.setup_id,a.source_json,a.subject,a.body,a.html,a.from_address,a.mail_provider FROM nc_dunning_deliveries d JOIN nc_dunning_mail_authority a ON a.id=d.id WHERE d.id=?`,input.text('delivery',{max:100}))
 insist(row&&row.status==='prepared'&&row.owner_session_id===actor.sessionId,'dunning_already_claimed',409)
 insist(clockInstant(env)<row.expires_at,'dunning_preparation_expired',409)
 const series=await dunningSeries(env,row.series_id),source=await dunningSource(env,series)
 insist(!source.stopped&&!source.held&&source.day===row.due_date,'dunning_source_changed',409)
 const basis=canonical({source:source.basis,subject:row.subject,body:row.body,html:row.html,from:env.MAIL_FROM??'',provider:env.MAIL_PROVIDER??'',setup:row.setup_id,session:row.portal_session_id})
 insist(input.text('basis_hash',{max:100})===row.basis_hash&&await fingerprint(basis)===row.basis_hash&&basis===row.source_json,'dunning_source_changed',409)
 if(row.portal_session_id)insist(await one(env,`SELECT 1 FROM nc_portal_sessions p JOIN nc_hosted_setups h ON h.id=? JOIN nc_customers c ON c.id=p.customer_id
 WHERE p.id=? AND p.customer_id=? AND p.revoked_at IS NULL AND p.expires_at>? AND h.status='prepared' AND h.customer_revision=c.revision
 AND h.factor_verified_at>?`,row.setup_id,row.portal_session_id,row.customer_id,clockInstant(env),clockInstant(env)-STEP_UP_MS),'dunning_update_link_unavailable',409)
 await commit(env,[...setupOwnerFence(env,actor),dunningFence(env,series),cadenceSourceGuard(env,seq),
  guard(env,'dunning_already_claimed',"EXISTS(SELECT 1 FROM nc_dunning_deliveries WHERE id=? AND status='prepared' AND claimed_at IS NULL AND expires_at>?)",row.id,clockInstant(env)),
  stmt(env,"UPDATE nc_dunning_deliveries SET status='sending',claimed_at=? WHERE id=?",clockInstant(env),row.id)],
  {actor:actorLabel(actor),action:'dunning.mail.claim',subject:row.id,detail:{series:row.series_id,invoice:row.invoice_id,step:row.step,basisHash:row.basis_hash,deliveryId:`dunning-${row.id}`}})
 let status='failed',provider:string|null=null
 try {
  const mail=operatorMail(env)
  if(mail&&env.MAIL_FROM) {
   status='uncertain'
   const result=await mail.send({deliveryId:`dunning-${row.id}`,from:row.from_address,to:[row.recipient],subject:row.subject,text:row.body,html:row.html,headers:{'Auto-Submitted':'auto-generated'}})
   status=result.status==='development'?'suppressed':result.status;provider=result.providerMessageId??null
  }
 } catch { /* A claimed send never retries on an unknown provider result. */ }
 await commit(env,[guard(env,'dunning_outcome_changed',"EXISTS(SELECT 1 FROM nc_dunning_deliveries WHERE id=? AND status='sending')",row.id),
  stmt(env,'UPDATE nc_dunning_deliveries SET status=?,provider_ref=?,finished_at=? WHERE id=?',status,provider,clockInstant(env),row.id)],
  {actor:actorLabel(actor),action:'dunning.mail.outcome',subject:row.id,detail:{series:row.series_id,invoice:row.invoice_id,step:row.step,status,provider}})
 return {id:row.id,status,provider}
}

export async function dunningDeliveryView(env: Bindings,actor: Actor,row: Row,sourceBasis: string) {
 const authority=await one(env,'SELECT subject,body,source_json FROM nc_dunning_mail_authority WHERE id=? AND owner_session_id=?',row.id,actor.sessionId)
 return {...row,...(authority&&clockInstant(env)<row.expires_at?{subject:authority.subject,body:authority.body}:{}),historical:!authority,expired:clockInstant(env)>=row.expires_at,stale:!!authority&&JSON.parse(authority.source_json).source!==sourceBasis}
}
