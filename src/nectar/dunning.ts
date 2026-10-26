import type { Bindings } from '../auth.server'
import { actorLabel, requireOwner, type Actor } from './actor'
import { all, commit, guard, insist, one, stmt, type Row } from './core'
import { clockInstant } from './clock'
import { addDays } from './dates'
import { cadenceSourceGuard, cadenceSourceSequence } from './cadence-policy'
import { dunningDue, dunningFence, dunningPolicyList, dunningSeries, dunningSource } from './dunning-policy'
import { dunningDeliveryView } from './dunning-mail'
import { setupOwner, setupOwnerFence } from './hosted-setup-basis'
import type { Input } from './input'

export async function dunningReport(env: Bindings,actor: Actor) {
 requireOwner(actor)
 const series: (Row & {steps:{step:number;due:string;dueToday:boolean}[];deliveries:Row[]})[]=[]
 for(const entry of await all(env,`SELECT s.id FROM nc_dunning_series s JOIN nc_customers c ON c.id=s.customer_id WHERE c.status='active' AND c.erased_at IS NULL AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(s.id,s.invoice_id,s.customer_id)) ORDER BY s.created_at,s.id`)) {
  const row=await dunningSeries(env,entry.id),source=await dunningSource(env,row)
  const deliveries=await all(env,'SELECT * FROM nc_dunning_deliveries WHERE series_id=? ORDER BY step',row.id)
  const offsets=JSON.parse(row.offsets_json) as number[]
  series.push({...row,status:source.invoice.balance_cents<=0?'settled':!row.authorized&&row.status==='active'?'historical':row.status,balanceCents:source.invoice.balance_cents,held:source.held,
   subscription:source.invoice.subscription_id,invoiceNumber:source.invoice.number,customerName:source.invoice.customer_name,
   steps:offsets.map((_,i)=>({step:i+1,due:dunningDue(row,i+1),dueToday:dunningDue(row,i+1)===source.day})),
   endDue:addDays(row.first_failed_date,row.end_day),day:source.day,
   deliveries:await Promise.all(deliveries.map(d=>dunningDeliveryView(env,actor,d)))})
 }
 return {policies:await dunningPolicyList(env),series,mode:'owner-confirmed'}
}

export async function endDunning(env: Bindings,actor: Actor,input: Input) {
 await setupOwner(env,actor);input.only(['series','action','confirm','returnTo']);insist(input.flag('confirm'),'dunning_confirmation_required')
 const seq=await cadenceSourceSequence(env),row=await dunningSeries(env,input.text('series',{max:100})),source=await dunningSource(env,row)
 insist(!source.stopped&&!source.held,'dunning_invoice_held',409)
 insist(source.day>=addDays(row.first_failed_date,row.end_day),'dunning_end_not_due',409)
 insist(input.text('action')===row.end_action,'dunning_action_changed',409)
 let cancellation:string|null=null
 if(row.end_action==='cancel') {
  const transition=await one(env,`SELECT l.id FROM nc_subscription_lifecycle l WHERE l.subscription_id=? AND l.kind='cancel' AND l.effective_date>=? AND l.effective_date<=? AND NOT EXISTS(SELECT 1 FROM nc_subscription_lifecycle r WHERE r.related_id=l.id) ORDER BY l.seq DESC LIMIT 1`,source.invoice.subscription_id,addDays(row.first_failed_date,row.end_day),source.day)
  insist(transition,'dunning_cancellation_review_required',409);cancellation=transition.id
 }
 const at=clockInstant(env)
 await commit(env,[...setupOwnerFence(env,actor),dunningFence(env,row),cadenceSourceGuard(env,seq),
  ...(cancellation?[guard(env,'dunning_cancellation_changed',`EXISTS(SELECT 1 FROM nc_subscription_lifecycle l WHERE l.id=? AND l.kind='cancel' AND NOT EXISTS(SELECT 1 FROM nc_subscription_lifecycle r WHERE r.related_id=l.id))`,cancellation)]:[]),
  stmt(env,"UPDATE nc_dunning_series SET status=?,ended_at=?,end_date=? WHERE id=?",row.end_action,at,source.day,row.id)],
  {actor:actorLabel(actor),action:'dunning.end.confirm',subject:row.id,detail:{invoice:row.invoice_id,policy:row.policy_id,action:row.end_action,cancellation,date:source.day,balanceCents:source.invoice.balance_cents}})
 return {id:row.id,status:row.end_action}
}

export async function revokeDunning(env: Bindings,actor: Actor,input: Input) {
 await setupOwner(env,actor);input.only(['series','confirm','returnTo']);insist(input.flag('confirm'),'dunning_confirmation_required')
 const row=await dunningSeries(env,input.text('series',{max:100}))
 insist(row.status==='active'&&row.authorized,'dunning_not_active',409)
 const at=clockInstant(env)
 await commit(env,[...setupOwnerFence(env,actor),dunningFence(env,row),
  stmt(env,'UPDATE nc_portal_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE id IN(SELECT a.portal_session_id FROM nc_dunning_mail_authority a JOIN nc_dunning_deliveries d ON d.id=a.id WHERE d.series_id=?)',at,row.id),
  stmt(env,'DELETE FROM nc_dunning_authority WHERE id=?',row.id),
  stmt(env,"UPDATE nc_dunning_series SET status='withdrawn',ended_at=?,end_date=? WHERE id=?",at,(await dunningSource(env,row)).day,row.id)],
  {actor:actorLabel(actor),action:'dunning.withdraw',subject:row.id,detail:{invoice:row.invoice_id}})
 return {id:row.id,status:'withdrawn'}
}
