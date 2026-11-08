import type { Bindings } from '../auth.server'
import { operatorMail } from '../mail.server.mjs'
import { actorLabel, requireOwner, type Actor } from './actor'
import { today } from './dates'
import { clockInstant } from './clock'
import { all, canonical, commit, fingerprint, guard, insist, newId, one, stmt } from './core'
import { cadenceSourceGuard, cadenceSourceSequence } from './cadence-policy'
import { collectibleInvoice } from './cadence-holds'
import { setupOwner, setupOwnerFence } from './hosted-setup-basis'
import { customerText, languageInput } from './locale'
import { STEP_UP_MS } from './mfa'
import type { Input } from './input'
import { esc } from './ui/html'

const kinds=['trial_ending','upcoming_renewal','payment_receipt','payment_failed','payment_method_required','authentication_required']
const facts=['invoice','merchant','amount','date']
const expand=(text:string,values:Record<string,string>)=>text.replace(/\{(\w+)\}/g,(_,key:string)=>values[key])

export async function billingNotices(env:Bindings,actor:Actor) {
 requireOwner(actor)
 return {settings:await all(env,'SELECT * FROM nc_billing_notice_settings ORDER BY kind'),
  deliveries:await all(env,`SELECT n.*,a.subject,a.body FROM nc_billing_notices n JOIN nc_customers c ON c.id=n.customer_id LEFT JOIN nc_billing_notice_authority a ON a.id=n.id
   WHERE c.status='active' AND c.erased_at IS NULL AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(n.id,n.customer_id,n.invoice_id)) ORDER BY n.prepared_at,n.id`)}
}

export async function configureBillingNotice(env:Bindings,actor:Actor,input:Input) {
 await setupOwner(env,actor)
 input.only(['kind','sender','revision','language','subject','body','confirm','returnTo'])
 insist(input.flag('confirm'),'notice_confirmation_required')
 const kind=input.text('kind'),sender=input.text('sender'),language=languageInput(input.text('language'))
 insist(kinds.includes(kind),'invalid_notice_kind')
 insist(['off','nectar','processor'].includes(sender),'invalid_notice_sender')
 const subject=input.text('subject',{max:200,optional:true}),body=input.text('body',{max:6000,optional:true})
 insist((!subject&&!body)||(subject&&body),'notice_template_pair_required')
 insist(!/[\r\n]/.test(subject),'invalid_notice_subject')
 for(const text of [subject,body])insist(!/[{}]/.test(text.replace(/\{(invoice|merchant|amount|date)\}/g,'')),'invalid_notice_placeholder')
 if(body)insist(facts.every(key=>body.includes(`{${key}}`)),'notice_facts_required')
 const row=(await one(env,'SELECT * FROM nc_billing_notice_settings WHERE kind=?',kind))!
 const revision=input.integer('revision',{max:Number.MAX_SAFE_INTEGER})
 insist(revision===row.revision,'notice_settings_changed',409)
 const templates=JSON.parse(row.templates_json)
 if(body)templates[language]={subject,body};else delete templates[language]
 await commit(env,[...setupOwnerFence(env,actor),
  guard(env,'notice_settings_changed','EXISTS(SELECT 1 FROM nc_billing_notice_settings WHERE kind=? AND revision=?)',kind,revision),
  stmt(env,'UPDATE nc_billing_notice_settings SET sender=?,templates_json=?,revision=revision+1 WHERE kind=?',sender,JSON.stringify(templates),kind)],
  {actor:actorLabel(actor),action:'billing.notice.configure',subject:kind,detail:{sender,language,subject,body,revision:Number(revision)+1}})
 return {kind,sender,revision:Number(revision)+1}
}

async function basis(env:Bindings,kind:string,invoiceId:string,eventKey?:string) {
 insist(['payment_receipt','payment_failed'].includes(kind),'notice_door_not_implemented',409)
 const invoice=await collectibleInvoice(env,invoiceId),customer=await one(env,'SELECT * FROM nc_customers WHERE id=?',invoice.customer_id)
 insist(customer?.status==='active'&&!customer.erased_at&&!await one(env,'SELECT 1 FROM nc_erased_records WHERE record_id IN(?,?)',invoiceId,customer.id),'notice_source_unavailable',409)
 const settings=(await one(env,'SELECT * FROM nc_billing_notice_settings WHERE kind=?',kind))!
 insist(settings.sender==='nectar','notice_sender_disabled',409)
 let key='',date='',amount=0,sourceEvent:unknown=null
 if(kind==='payment_receipt') {
  const payment=await one(env,`SELECT a.id,a.amount_cents,p.received_on FROM nc_allocations a JOIN nc_payments p ON p.id=a.payment_id
   WHERE a.invoice_id=? AND (? IS NULL OR a.id=?) ORDER BY a.allocated_at DESC,a.id DESC LIMIT 1`,invoiceId,eventKey??null,eventKey??null)
  insist(payment&&payment.amount_cents>0,'notice_payment_required',409)
  key=payment.id;date=payment.received_on;amount=payment.amount_cents;sourceEvent=payment
 } else {
  const failure=await one(env,`SELECT * FROM nc_retry_attempts WHERE invoice_id=? AND outcome='failed' ORDER BY attempt DESC LIMIT 1`,invoiceId)
  insist(failure&&!invoice.hold&&!invoice.disputes.length,'notice_failure_unavailable',409)
  // One failure notice per invoice: a new attempt never bypasses an uncertain send.
  key=invoiceId;date=today(invoice.business.timezone,failure.attempted_at);amount=invoice.collectibleCents;sourceEvent=failure
 }
 insist(!eventKey||eventKey===key,'notice_event_changed',409)
 insist(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.billing_email),'notice_recipient_required',409)
 const L=customerText(customer.language,invoice.currency)
 const values={invoice:invoice.number,merchant:invoice.business.legal_name,amount:L.money(amount),date:L.day(date)}
 const template=JSON.parse(settings.templates_json)[L.tag]
 const subject=template?expand(template.subject,values):L.t(`billing_notice.${kind}.subject`,values)
 const body=template?expand(template.body,values):L.t(`billing_notice.${kind}.body`,values)
 const source={kind,invoice:invoiceId,key,customer:customer.id,revision:customer.revision,recipient:customer.billing_email,language:L.tag,
  holdBasis:invoice.basis,sourceEvent,amount,date,settingsRevision:settings.revision,subject,body,from:env.MAIL_FROM??'',provider:env.MAIL_PROVIDER??'',
  mailBinding:await fingerprint([env.MAIL_PROVIDER??'',env.MAIL_FROM??'',env.MAIL_API_KEY??''])}
 return {source,basis:canonical(source)}
}

export async function prepareBillingNotice(env:Bindings,actor:Actor,input:Input) {
 const factor=await setupOwner(env,actor)
 input.only(['kind','invoice','event','confirm','returnTo']);insist(input.flag('confirm'),'notice_confirmation_required')
 const seq=await cadenceSourceSequence(env),kind=input.text('kind'),invoice=input.text('invoice',{max:100})
 const current=await basis(env,kind,invoice,input.text('event',{max:100,optional:true})||undefined)
 const s=current.source,id=newId(),at=clockInstant(env),expires= Math.min(at+STEP_UP_MS,factor.verifiedAt+STEP_UP_MS),hash=await fingerprint(current.basis)
 await commit(env,[...setupOwnerFence(env,actor),cadenceSourceGuard(env,seq),
  guard(env,'notice_already_prepared','NOT EXISTS(SELECT 1 FROM nc_billing_notices WHERE kind=? AND event_key=?)',kind,s.key),
  stmt(env,`INSERT INTO nc_billing_notices(id,kind,invoice_id,customer_id,event_key,recipient,language,amount_cents,basis_hash,status,prepared_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,'prepared',?,?)`,id,kind,invoice,s.customer,s.key,s.recipient,s.language,s.amount,hash,at,expires),
  stmt(env,'INSERT INTO nc_billing_notice_authority(id,customer_id,owner_session_id,basis_json,subject,body) VALUES(?,?,?,?,?,?)',id,s.customer,actor.sessionId,current.basis,s.subject,s.body)],
  {actor:actorLabel(actor),action:'billing.notice.prepare',subject:id,detail:{kind,invoice,event:s.key,wordingVersion:'billing-notice-1',recipient:s.recipient,language:s.language,amountCents:s.amount,approvedWording:{subject:s.subject,body:s.body},basisHash:hash,factorReference:factor.reference,factorVerifiedAt:factor.verifiedAt,expiresAt:expires}})
 return {id,basis:hash,subject:s.subject,body:s.body,recipient:s.recipient,amountCents:s.amount,language:s.language}
}

export async function sendBillingNotice(env:Bindings,actor:Actor,input:Input) {
 await setupOwner(env,actor)
 input.only(['notice','basis_hash','confirm','returnTo']);insist(input.flag('confirm'),'notice_confirmation_required')
 const seq=await cadenceSourceSequence(env),row=await one(env,`SELECT n.*,a.owner_session_id,a.basis_json,a.subject,a.body FROM nc_billing_notices n JOIN nc_billing_notice_authority a ON a.id=n.id WHERE n.id=?`,input.text('notice',{max:100}))
 insist(row&&row.status==='prepared'&&row.owner_session_id===actor.sessionId,'notice_already_claimed',409)
 insist(clockInstant(env)<row.expires_at,'notice_preparation_expired',409)
 const current=await basis(env,row.kind,row.invoice_id,row.event_key)
 insist(input.text('basis_hash')===row.basis_hash&&current.basis===row.basis_json&&await fingerprint(current.basis)===row.basis_hash,'notice_source_changed',409)
 await commit(env,[...setupOwnerFence(env,actor),cadenceSourceGuard(env,seq),
  guard(env,'notice_already_claimed',"EXISTS(SELECT 1 FROM nc_billing_notices WHERE id=? AND status='prepared' AND claimed_at IS NULL AND expires_at>?)",row.id,clockInstant(env)),
  stmt(env,"UPDATE nc_billing_notices SET status='sending',claimed_at=? WHERE id=?",clockInstant(env),row.id)],
  {actor:actorLabel(actor),action:'billing.notice.claim',subject:row.id,detail:{kind:row.kind,invoice:row.invoice_id,basisHash:row.basis_hash,deliveryId:`billing-notice-${row.id}`}})
 let status='failed',provider:string|null=null
 try {
  const mail=operatorMail(env)
  if(mail&&env.MAIL_FROM) {
   status='uncertain'
   const result=await mail.send({deliveryId:`billing-notice-${row.id}`,from:env.MAIL_FROM,to:[row.recipient],subject:row.subject,text:row.body,
    html:`<html lang="${esc(row.language)}"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font:16px/1.5 sans-serif;margin:24px;overflow-wrap:anywhere"><p style="white-space:pre-wrap">${esc(row.body)}</p></body></html>`,headers:{'Auto-Submitted':'auto-generated'}})
   status=result.status==='development'?'suppressed':result.status;provider=result.providerMessageId??null
  }
 }catch { /* A lost provider response cannot authorize another send. */ }
 await commit(env,[guard(env,'notice_outcome_changed',"EXISTS(SELECT 1 FROM nc_billing_notices WHERE id=? AND status='sending')",row.id),
  stmt(env,'UPDATE nc_billing_notices SET status=?,provider_ref=?,finished_at=? WHERE id=?',status,provider,clockInstant(env),row.id)],
  {actor:actorLabel(actor),action:'billing.notice.outcome',subject:row.id,detail:{kind:row.kind,status,provider}})
 return {id:row.id,status,provider}
}
