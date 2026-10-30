import { jobNeedsAttention } from './job-outcome'
// CAT-012: terminal outcomes reserve one notice in the same database transaction.
import type { Bindings } from '../auth.server'
import { operatorMail } from '../mail.server.mjs'
import { actorLabel, requireOwner, type Actor } from './actor'
import { all, commit, guard, insist, NectarError, now, one, stmt, type Row } from './core'
import { decimalText } from './decimal'
import type { Input } from './input'
import { customerText, languageInput, languages } from './locale'
import { canReadPrepaidRefundPrivate } from './prepaid-refund-access'
import { esc } from './ui/html'

type Outcome = 'refunded' | 'failed'
type Template = { subject: string; body: string }
type Templates = Record<string, Record<Outcome, Template>>
const outcomes: Outcome[] = ['refunded','failed']
const senders = ['off','nectar','processor']
const placeholders = ['amount','units','purchase','credit']
const expand = (text:string, facts:Record<string,string>) => text.replace(/\{(\w+)\}/g,(_,key:string)=>facts[key])
function templates(stored:string):Templates {
  const saved=JSON.parse(stored) as Partial<Templates>
  return Object.fromEntries(languages().map(({value:tag})=>{
    const L=customerText(tag)
    return [tag,Object.fromEntries(outcomes.map(outcome=>[outcome,saved[tag]?.[outcome]??{
      subject:L.t(`refund.notice.${outcome}.subject`,{purchase:'{purchase}'}),
      body:L.t(`refund.notice.${outcome}.body`,Object.fromEntries(placeholders.map(key=>[key,`{${key}}`]))),
    }]))]
  })) as Templates
}
// Revalidate the live native owner session inside the settings write as well.
function ownerGuard(env:Bindings,actor:Actor){
  return guard(env,'forbidden',`EXISTS(SELECT 1 FROM oa_sessions s JOIN oa_operators o ON o.id=s.operator_id
    JOIN nc_members m ON m.id=? AND m.email=lower(o.email) WHERE s.id=? AND s.revoked_at IS NULL
    AND s.expires_at>CAST(strftime('%s','now') AS INTEGER)*1000 AND o.version=s.operator_version
    AND o.status='active' AND o.role='owner' AND m.status='active' AND m.role='owner')`,actor.id,actor.sessionId)
}
export async function configureRefundNotices(env:Bindings,actor:Actor,input:Input){
  requireOwner(actor)
  insist(await canReadPrepaidRefundPrivate(env,actor),'forbidden',403)
  const language=languageInput(input.text('language'))
  const row=(await one(env,'SELECT * FROM nc_prepaid_refund_mail_settings WHERE id=1'))!
  const revision=input.integer('revision',{max:Number.MAX_SAFE_INTEGER})
  insist(revision===row.revision,'refund_notice_settings_changed',409)
  const edited=templates(row.templates_json),settings:Record<string,string>={}
  for(const outcome of outcomes){
    const sender=input.text(`${outcome}_sender`)
    insist(senders.includes(sender),'invalid_refund_notice_sender')
    settings[outcome]=sender
    const subject=input.text(`${outcome}_subject`,{max:200}),body=input.text(`${outcome}_body`,{max:6000})
    insist(!/[\r\n]/.test(subject),'invalid_refund_notice_subject')
    for(const text of [subject,body]){
      const without=text.replace(/\{(\w+)\}/g,(_,key:string)=>{insist(placeholders.includes(key),'invalid_refund_notice_placeholder');return ''})
      insist(!/[{}]/.test(without),'invalid_refund_notice_placeholder')
    }
    // Facts cannot be removed by editing a template; the failed credit is an honest absence.
    insist(placeholders.every(key=>body.includes(`{${key}}`)),'refund_notice_facts_required')
    edited[language][outcome]={subject,body}
  }
  await commit(env,[ownerGuard(env,actor),guard(env,'refund_notice_settings_changed','EXISTS(SELECT 1 FROM nc_prepaid_refund_mail_settings WHERE id=1 AND revision=?)',revision),
    stmt(env,'UPDATE nc_prepaid_refund_mail_settings SET refunded_sender=?,failed_sender=?,templates_json=?,revision=revision+1,configured_by=?,configured_at=? WHERE id=1',settings.refunded,settings.failed,JSON.stringify(edited),actor.id,now())],
    {actor:actorLabel(actor),action:'prepaid.refund.notice.configure',subject:'prepaid-refund-notices',detail:{language,refundedSender:settings.refunded,failedSender:settings.failed,revision:Number(revision)+1,templates:edited[language]}})
  return refundNoticeSettings(env,actor)
}
export async function refundNoticeSettings(env:Bindings,actor:Actor){
  insist(await canReadPrepaidRefundPrivate(env,actor),'forbidden',403)
  const row=(await one(env,'SELECT * FROM nc_prepaid_refund_mail_settings WHERE id=1'))!
  // All delivery text and addresses are private; erased customers have no readable notice.
  const deliveries=await all(env,`SELECT m.refund_id AS refund,m.customer_id AS customer,m.kind AS outcome,m.source AS sender,m.status,m.language,m.recipient,m.mail_subject AS subject,m.mail_body AS body,
    m.provider_ref AS providerRef,m.created_at AS createdAt,m.updated_at AS updatedAt,r.amount_n AS amountN,r.amount_cents AS amountCents,
    i.number AS purchaseNumber,n.number AS creditNumber FROM nc_prepaid_refund_mail m JOIN nc_customers c ON c.id=m.customer_id
    JOIN nc_prepaid_refunds r ON r.id=m.refund_id JOIN nc_invoices i ON i.id=r.purchase_invoice_id LEFT JOIN nc_credit_notes n ON n.id=r.credit_id
    WHERE c.erased_at IS NULL ORDER BY m.created_at DESC,m.refund_id LIMIT 100`)
  return {refundedSender:row.refunded_sender as string,failedSender:row.failed_sender as string,templates:templates(row.templates_json),revision:Number(row.revision),configuredBy:row.configured_by,configuredAt:row.configured_at,deliveries}
}
function message(row:Row){
  const L=customerText(row.customer_language),chosen=templates(row.templates_json)[L.tag][row.outcome as Outcome]
  const units=row.grant_kind==='money'?L.money(row.amount_n):L.t('refund.notice.units',{
    quantity:L.percent(decimalText(BigInt(row.amount_n))),unit:row.unit_label||L.t('refund.notice.unit')})
  const facts={amount:L.money(row.amount_cents),units,purchase:String(row.purchase_number),credit:row.outcome==='refunded'?String(row.credit_number):L.t('refund.notice.no_credit')}
  insist(row.purchase_number&& (row.outcome!=='refunded'||row.credit_number),'refund_notice_facts_missing',409)
  return {subject:expand(chosen.subject,facts),body:expand(chosen.body,facts),language:L.tag}
}
export async function deliverPrepaidRefundNotice(env:Bindings,id:string){
  const row=await one(env,`SELECT m.*,m.kind AS outcome,r.amount_n,r.amount_cents,c.billing_email,c.language AS customer_language,
    i.number AS purchase_number,n.number AS credit_number,g.kind AS grant_kind,u.unit_label
    FROM nc_prepaid_refund_mail m JOIN nc_prepaid_refunds r ON r.id=m.refund_id JOIN nc_customers c ON c.id=m.customer_id
    JOIN nc_invoices i ON i.id=r.purchase_invoice_id JOIN nc_prepaid_grants g ON g.id=r.grant_id
    LEFT JOIN nc_meters u ON u.id=g.meter_id LEFT JOIN nc_credit_notes n ON n.id=r.credit_id
    WHERE m.refund_id=? AND m.status='pending' AND r.status=m.kind AND c.erased_at IS NULL`,id)
  if(!row)return
  const settings=(await one(env,'SELECT * FROM nc_prepaid_refund_mail_settings WHERE id=1'))!,sender=settings[`${row.outcome}_sender`]
  if(sender!=='nectar'){
    await commit(env,[stmt(env,"UPDATE nc_prepaid_refund_mail SET status=?,updated_at=? WHERE refund_id=? AND status='pending'",sender,now(),id)],{actor:'system:prepaid-refund',action:'prepaid.refund.notice.suppress',subject:id,detail:{sender}})
    return {status:sender as string}
  }
  const prepared=message(row)
  try{
    await commit(env,[guard(env,'refund_notice_claimed',`EXISTS(SELECT 1 FROM nc_prepaid_refund_mail m JOIN nc_prepaid_refunds r ON r.id=m.refund_id
      JOIN nc_customers c ON c.id=m.customer_id JOIN nc_prepaid_refund_mail_settings s ON s.id=1
      WHERE m.refund_id=? AND m.status='pending' AND r.status=m.kind AND c.erased_at IS NULL AND c.billing_email=?
      AND c.language=? AND s.revision=? AND CASE m.kind WHEN 'refunded' THEN s.refunded_sender ELSE s.failed_sender END='nectar')`,id,row.billing_email,row.customer_language,settings.revision),
      stmt(env,"UPDATE nc_prepaid_refund_mail SET status='sending',recipient=?,mail_subject=?,mail_body=?,language=?,updated_at=? WHERE refund_id=?",row.billing_email,prepared.subject,prepared.body,prepared.language,now(),id)],
      {actor:'system:prepaid-refund',action:'prepaid.refund.notice.claim',subject:id,detail:{outcome:row.outcome}})
  }catch(error){if(error instanceof NectarError&&error.code==='refund_notice_claimed')return;throw error}
  // No entry point retries sending, failed or uncertain mail, including after a crash.
  let status='failed',provider:string|null=null
  try{
    const mail=operatorMail(env)
    const live=await one(env,`SELECT 1 FROM nc_prepaid_refund_mail m JOIN nc_customers c ON c.id=m.customer_id
      JOIN nc_prepaid_refund_mail_settings s ON s.id=1 WHERE m.refund_id=? AND m.status='sending' AND c.erased_at IS NULL
      AND CASE m.kind WHEN 'refunded' THEN s.refunded_sender ELSE s.failed_sender END='nectar'`,id)
    if(!live)return
    if(mail&&env.MAIL_FROM&&row.billing_email){
      status='uncertain'
      const result=await mail.send({deliveryId:`prepaid-refund-${id}`,from:env.MAIL_FROM,to:[row.billing_email],subject:prepared.subject,
        text:prepared.body,html:`<pre>${esc(prepared.body)}</pre>`,headers:{'Auto-Submitted':'auto-generated'}})
      status=result.status==='accepted'?'accepted':result.status==='development'?'suppressed':['failed','rejected','rate_limited'].includes(result.status)?'failed':'uncertain'
      provider=result.providerMessageId??null
    }
  }catch{/* Network entry cannot establish non-acceptance. */}
  // Erasure may have cleared the message while the provider was answering.
  await commit(env,[stmt(env,`UPDATE nc_prepaid_refund_mail SET status=?,provider_ref=?,updated_at=? WHERE refund_id=? AND status='sending'
    AND EXISTS(SELECT 1 FROM nc_customers c WHERE c.id=nc_prepaid_refund_mail.customer_id AND c.erased_at IS NULL)`,status,provider,now(),id)],
    {actor:'system:prepaid-refund',action:'prepaid.refund.notice.outcome',subject:id,detail:{status}})
  return {status,providerRef:provider}
}

/** Recover reservations never claimed; a claimed attempt is never selected again. */
export async function deliverPendingPrepaidRefundNotices(env:Bindings){
  let failed = false
  for(const row of await all(env,"SELECT refund_id FROM nc_prepaid_refund_mail m JOIN nc_customers c ON c.id=m.customer_id WHERE m.status='pending' AND c.erased_at IS NULL ORDER BY m.created_at,m.refund_id LIMIT 100")) {
    const result = await deliverPrepaidRefundNotice(env,row.refund_id)
    failed ||= jobNeedsAttention(result?.status)
  }
  return { status: failed ? 'failed' : 'completed' }
}
