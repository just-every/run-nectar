import { prepareSaveOffer } from './retention-offers'
import { serviceEndSql } from './renewal-sql'
import type { Bindings } from '../auth.server'
import { requireRead, actorLabel, requireCapability, requireMember, requireOwner, type Actor } from './actor'
import { all, commit, guard, insist, newId, now, one, sha256Hex, stmt, type Row } from './core'
import { canonicalDecimal, micros } from './decimal'
import { addMonths,addMonthsClamped, requireDate } from './dates'
import { requireSubscription, notIssuedGuard } from './subscriptions'
import type { Input } from './input'

export function renewalSettings(input:Input,start:string) {
  const months=input.integer('months',{min:1,max:120})!,auto=input.flag('auto_renew'),days=input.integer('notice_days',{min:1,max:365})!,uplift=canonicalDecimal(input.text('uplift_percent',{max:24,optional:true})||'0')
  insist(micros(uplift)<=100_000_000n,'invalid_uplift_percent')
  insist(!auto||months<12||(days>=15&&days<=45),'annual_notice_must_be_15_to_45_days')
  return {start_date:start,end_date:addMonthsClamped(start,months),months,auto_renew:auto?1:0,notice_days:days,uplift_percent:uplift}
}
export async function termRecords(env:Bindings,actor:Actor,subscription:string) {
  requireRead(actor,'subscriptions')
  return {terms:await all(env,'SELECT id,start_date,end_date,months,auto_renew,notice_days,uplift_percent,status,prepared_by_id,prepared_by,decided_by,approval_mode,cycle,revision,cancelled_at,quote FROM nc_renewal_terms WHERE subscription_id=? ORDER BY created_at,id',subscription),events:await all(env,'SELECT * FROM nc_renewal_events WHERE subscription_id=? ORDER BY effective_date,id',subscription),notices:await all(env,'SELECT n.* FROM nc_renewal_notices n JOIN nc_renewal_terms t ON t.id=n.term_id WHERE t.subscription_id=? ORDER BY n.created_at,n.id',subscription)}
}
export async function prepareTerm(env:Bindings,actor:Actor,input:Input) {
  requireMember(actor,'approve')
  const sub=await requireSubscription(env,input.text('subscription',{max:100}));insist(sub.billing_mode==='live','subscription_not_live',409)
  const revision=input.text('revision',{max:100});insist(sub.revision===revision,'stale',409)
  const start=requireDate(input.text('term_start',{max:10}),'term_start');insist(start>=sub.start_date&&(sub.billing_anchor_date?addMonthsClamped(sub.billing_anchor_date,(Number(start.slice(0,4))-Number(sub.billing_anchor_date.slice(0,4)))*12+Number(start.slice(5,7))-Number(sub.billing_anchor_date.slice(5,7)))===start:Number(start.slice(8))===sub.anchor_day),'term_start_must_match_anchor')
  const settings=renewalSettings(input,start)
  const id=newId()
  await commit(env,[guard(env,'stale','EXISTS(SELECT 1 FROM nc_subscriptions WHERE id=? AND revision=?)',sub.id,revision),stmt(env,'INSERT INTO nc_renewal_terms(id,subscription_id,subscription_revision,start_date,end_date,months,auto_renew,notice_days,uplift_percent,prepared_by_id,prepared_by,created_at,revision,quote) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',id,sub.id,revision,settings.start_date,settings.end_date,settings.months,settings.auto_renew,settings.notice_days,settings.uplift_percent,actor.id,actorLabel(actor),now(),newId(),input.text('quote',{max:10000,optional:true}))],{actor:actorLabel(actor),action:'term.prepare',subject:id,detail:{subscription:sub.id,...settings}})
  return {id:sub.id,term:id,status:'pending'}
}
export async function decideTerm(env:Bindings,actor:Actor,input:Input) {
  requireMember(actor,'approve')
  const term=await one(env,'SELECT * FROM nc_renewal_terms WHERE id=?',input.text('term',{max:100}));insist(term,'term_not_found',404);insist(term.status==='pending','already_decided',409)
  const decision=input.text('decision',{max:10});insist(['approved','rejected'].includes(decision),'invalid_decision')
  const statements=[guard(env,'already_decided',"EXISTS(SELECT 1 FROM nc_renewal_terms WHERE id=? AND status='pending')",term.id)]
  let mode='two-person'
  if(decision==='approved') {
    const sub=await requireSubscription(env,term.subscription_id);insist(sub.revision===term.subscription_revision,'stale',409)
    const meterClash=`SELECT 1 FROM nc_items own JOIN nc_prices op ON op.id=own.price_id LEFT JOIN nc_meters om ON om.id=op.meter_id CROSS JOIN nc_items i JOIN nc_prices p ON p.id=i.price_id LEFT JOIN nc_meters m ON m.id=p.meter_id JOIN nc_subscriptions s ON s.id=i.subscription_id WHERE own.subscription_id=? AND s.customer_id=? AND s.id<>? AND COALESCE(m.source_meter_id,p.meter_id)=COALESCE(om.source_meter_id,op.meter_id) AND MAX(own.effective_from,i.effective_from,s.start_date,?)<MIN(COALESCE(own.effective_to,'9999-12-31'),COALESCE(i.effective_to,'9999-12-31'),${serviceEndSql()},?)`
    const meterParams=[sub.id,sub.customer_id,sub.id,term.start_date,term.auto_renew?'9999-12-31':term.end_date]
    insist(!await one(env,meterClash,...meterParams),'meter_already_billed',409)
    statements.push(guard(env,'meter_already_billed',`NOT EXISTS(${meterClash})`,...meterParams))
    const single=term.prepared_by_id===actor.id
    if(single){requireOwner(actor);insist(!await one(env,"SELECT 1 FROM nc_members WHERE status='active' AND role IN ('owner','finance') AND id<>?",actor.id),'second_approver_required',409);insist(input.flag('confirm_single'),'single_confirmation_required',409);mode='single-approver';statements.push(guard(env,'second_approver_required',"NOT EXISTS(SELECT 1 FROM nc_members WHERE status='active' AND role IN ('owner','finance') AND id<>?)",actor.id))}
    statements.push(guard(env,'stale','EXISTS(SELECT 1 FROM nc_subscriptions WHERE id=? AND revision=?)',sub.id,term.subscription_revision),notIssuedGuard(env,sub.id,term.end_date),guard(env,'preparer_inactive',"EXISTS(SELECT 1 FROM nc_members WHERE id=? AND status='active' AND role IN ('owner','finance'))",term.prepared_by_id),stmt(env,"UPDATE nc_renewal_terms SET status='superseded',token_hash=NULL WHERE subscription_id=? AND status='active'",sub.id),stmt(env,'UPDATE nc_subscriptions SET end_date=?,revision=?,updated_at=? WHERE id=?',term.end_date,newId(),now(),sub.id))
  }
  statements.push(stmt(env,'UPDATE nc_renewal_terms SET status=?,decided_by=?,decided_at=?,approval_mode=? WHERE id=?',decision==='approved'?'active':'rejected',actorLabel(actor),now(),mode,term.id))
  await commit(env,statements,{actor:actorLabel(actor),action:`term.${decision}`,subject:term.id,detail:{subscription:term.subscription_id,mode,preparedBy:term.prepared_by}})
  return {id:term.subscription_id,status:decision}
}
export async function newCancellationLink(env:Bindings,term:Row) {
  const token=Array.from(crypto.getRandomValues(new Uint8Array(32)),v=>v.toString(16).padStart(2,'0')).join('')
  return {token,hash:await sha256Hex(token),url:new URL(`/renewal/${token}`,env.AUTH_ORIGIN).href}
}
export async function issueCancellationLink(env:Bindings,actor:Actor,input:Input) {
  requireMember(actor,'approve')
  const term=await one(env,"SELECT * FROM nc_renewal_terms WHERE id=? AND status='active' AND cancelled_at IS NULL",input.text('term',{max:100}));insist(term,'term_not_found',404)
  const link=await newCancellationLink(env,term)
  await commit(env,[guard(env,'stale',"EXISTS(SELECT 1 FROM nc_renewal_terms WHERE id=? AND revision=? AND status='active' AND cancelled_at IS NULL)",term.id,term.revision),stmt(env,'UPDATE nc_renewal_terms SET token_hash=? WHERE id=?',link.hash,term.id)],{actor:actorLabel(actor),action:'term.link.rotate',subject:term.id})
  await prepareSaveOffer(env,term)
  return {id:term.subscription_id,cancelUrl:link.url}
}
