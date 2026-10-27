// Alert definitions belong to a human operator or a bound billing contact.
import type { Bindings } from '../auth.server'
import { actorLabel, requireCapability, requireOwner, type Actor } from './actor'
import { all, commit, guard, insist, newId, one, parseJson, stmt } from './core'
import { canonicalDecimal, cents, micros } from './decimal'
import type { Input } from './input'
import type { CustomerSession } from './portal-session'
import { clockInstant } from './clock'
import { observeUsageThresholds } from './usage-threshold-observer'

export async function boundThresholdContact(env: Bindings, session: CustomerSession) {
  insist(session.contactId, 'billing_contact_required', 403)
  const contact = await one(env, `SELECT c.* FROM nc_contacts c JOIN nc_customers customer ON customer.id=c.customer_id
    WHERE c.id=? AND c.customer_id=? AND c.role='billing' AND customer.erased_at IS NULL`, session.contactId, session.customer)
  insist(contact, 'billing_contact_required', 403)
  return contact
}
async function choices(env: Bindings, customer?: string) {
  const subscriptions = await all(env, `SELECT s.id,s.external_id,s.customer_id,c.name AS customer_name FROM nc_subscriptions s JOIN nc_customers c ON c.id=s.customer_id WHERE c.erased_at IS NULL${customer?' AND c.id=?':''} ORDER BY c.name,s.id`, ...(customer?[customer]:[]))
  const meters = await all(env, `SELECT DISTINCT m.id,m.code,m.name FROM nc_meters m JOIN nc_prices p ON p.meter_id=m.id JOIN nc_items i ON i.price_id=p.id JOIN nc_subscriptions s ON s.id=i.subscription_id JOIN nc_customers c ON c.id=s.customer_id WHERE c.erased_at IS NULL${customer?' AND c.id=?':''} ORDER BY m.name`, ...(customer?[customer]:[]))
  const contracts = await all(env, `SELECT k.id,k.subscription_id FROM nc_contracts k JOIN nc_subscriptions s ON s.id=k.subscription_id JOIN nc_customers c ON c.id=s.customer_id WHERE k.status='approved' AND c.erased_at IS NULL${customer?' AND c.id=?':''}`, ...(customer?[customer]:[]))
  return { subscriptions, meters, contracts }
}
export async function usageThresholdNotifications(env: Bindings, actor: Actor) {
  requireCapability(actor,'read')
  return all(env,`SELECT x.* FROM nc_usage_crossings x JOIN nc_customers c ON c.id=x.customer_id WHERE c.erased_at IS NULL ORDER BY x.created_at DESC,x.id LIMIT 100`)
}
export async function usageThresholds(env: Bindings, actor: Actor) {
  requireCapability(actor, 'read')
  return { ...await choices(env), definitions:await all(env, `SELECT t.* FROM nc_usage_thresholds t JOIN nc_customers c ON c.id=t.customer_id WHERE c.erased_at IS NULL ORDER BY t.created_at,t.id`),
    crossings:await usageThresholdNotifications(env,actor) }
}
export async function portalThresholds(env: Bindings, session: CustomerSession) {
  const contact=await boundThresholdContact(env,session)
  return { ...await choices(env,session.customer), definitions:await all(env,'SELECT * FROM nc_usage_thresholds WHERE customer_id=? AND contact_id=? AND created_by=? ORDER BY created_at,id',session.customer,contact.id,`customer:usage-alert:${contact.id}`),
    crossings:await all(env,'SELECT x.* FROM nc_usage_crossings x JOIN nc_usage_thresholds t ON t.id=x.threshold_id WHERE x.customer_id=? AND x.contact_id=? AND t.created_by=? ORDER BY x.created_at DESC,x.id LIMIT 100',session.customer,contact.id,`customer:usage-alert:${contact.id}`) }
}
async function configure(env: Bindings, actor: string, input: Input, session?: CustomerSession) {
  input.only(session?['id','subscription','kind','meter','threshold','name','enabled','confirm_mail','returnTo']:['id','subscription','kind','meter','contract','threshold','name','recipient','enabled','confirm_mail','returnTo'])
  const id=input.text('id',{optional:true,max:100}), old=id?await one(env,'SELECT * FROM nc_usage_thresholds WHERE id=?',id):null
  const contact=session?await boundThresholdContact(env,session):null
  if(id)insist(old&&(!session||old.customer_id===session.customer&&old.contact_id===contact!.id&&old.created_by===actor),'threshold_not_found',404)
  const subscription=input.text('subscription',{max:100})
  const sub=await one(env,'SELECT s.* FROM nc_subscriptions s JOIN nc_customers c ON c.id=s.customer_id WHERE s.id=? AND c.erased_at IS NULL',subscription)
  insist(sub&&(!session||sub.customer_id===session.customer),'subscription_not_found',404)
  if(old)insist(old.subscription_id===sub.id,'threshold_scope_immutable',409)
  const kind=input.text('kind',{max:20}), meter=input.text('meter',{optional:true,max:100})||null, contract=input.text('contract',{optional:true,max:100})||null
  insist(['usage','spend','commitment'].includes(kind)&&(!session||kind!=='commitment'),'invalid_threshold_kind')
  const threshold=canonicalDecimal(input.text('threshold',{max:30}),'threshold')
  insist(micros(threshold)>0n&&(kind!=='commitment'||micros(threshold)<=100_000_000n),'invalid_threshold')
  if(kind==='spend')cents(threshold,'threshold')
  insist((kind==='usage'?!!meter:true)&&(kind==='commitment'?!!contract:!contract),'invalid_threshold_scope')
  insist(!await one(env,`SELECT 1 FROM nc_items i JOIN nc_price_intervals b ON b.price_id=i.price_id WHERE i.subscription_id=? AND (b.interval_unit<>'month' OR b.interval_count<>1 OR b.billing_timing<>'arrears')`,sub.id),'threshold_interval_unsupported',409)
  insist(!await one(env,`SELECT 1 FROM nc_items i JOIN nc_prices p ON p.id=i.price_id JOIN nc_meters m ON m.id=p.meter_id WHERE i.subscription_id=? AND json_extract(m.metric_plan_json,'$.aggregation')='time_weighted'`,sub.id),'threshold_time_weighted_unsupported',409)
  if(meter){
    const selected=await one(env,'SELECT m.metric_plan_json FROM nc_items i JOIN nc_prices p ON p.id=i.price_id JOIN nc_meters m ON m.id=p.meter_id WHERE i.subscription_id=? AND p.meter_id=?',sub.id,meter)
    insist(selected,'meter_not_on_subscription')
    insist(parseJson<{aggregation?:string}>(selected.metric_plan_json,{}).aggregation!=='time_weighted','threshold_time_weighted_unsupported',409)
  }
  if(contract)insist(!meter&&await one(env,"SELECT 1 FROM nc_contracts WHERE id=? AND subscription_id=? AND status='approved'",contract,sub.id),'contract_not_on_subscription')
  const recipient=contact?.email??input.text('recipient',{max:254})
  const recipientContact=contact??await one(env,"SELECT * FROM nc_contacts WHERE customer_id=? AND email=? AND role='billing'",sub.customer_id,recipient)
  insist(recipientContact,'billing_contact_required',403)
  const enabled=input.has('enabled')?input.flag('enabled'):true
  insist(!enabled||input.flag('confirm_mail'),'threshold_email_consent_required')
  const name=input.text('name',{optional:true,max:120})||`${kind} alert`, next=id||newId(), revision=newId(), at=clockInstant(env)
  const count=await one<{n:number}>(env,'SELECT COUNT(*) n FROM nc_usage_thresholds WHERE customer_id=?',sub.customer_id)
  insist(old||count!.n<100,'threshold_limit',409)
  await commit(env,[guard(env,'customer_erased','EXISTS(SELECT 1 FROM nc_customers WHERE id=? AND erased_at IS NULL)',sub.customer_id),
    ...(session?[guard(env,'invalid_customer_session',`EXISTS(SELECT 1 FROM nc_portal_sessions s JOIN nc_portal_policy p ON p.singleton=1 AND p.revision=s.policy_revision JOIN nc_portal_session_contacts binding ON binding.session_id=s.id JOIN nc_contacts contact ON contact.id=binding.contact_id WHERE s.id=? AND s.customer_id=? AND s.revoked_at IS NULL AND s.expires_at>? AND contact.id=? AND contact.customer_id=s.customer_id AND contact.role='billing')`,session.jti,session.customer,at,contact!.id)]:[]),
    ...(old?[guard(env,'stale','EXISTS(SELECT 1 FROM nc_usage_thresholds WHERE id=? AND revision=?)',old.id,old.revision)]:[]),
    stmt(env,`INSERT INTO nc_usage_thresholds(id,customer_id,subscription_id,meter_id,contract_id,kind,threshold,name,recipient,contact_id,enabled,created_by,revision,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET meter_id=excluded.meter_id,contract_id=excluded.contract_id,kind=excluded.kind,threshold=excluded.threshold,name=excluded.name,recipient=excluded.recipient,contact_id=excluded.contact_id,enabled=excluded.enabled,revision=excluded.revision`,next,sub.customer_id,sub.id,meter,contract,kind,threshold,name,recipient,recipientContact.id,enabled?1:0,actor,revision,at)],
    {actor,action:'usage.threshold.configure',subject:next,detail:{customer:sub.customer_id,subscription:sub.id,kind,meter,contract,threshold,contact:recipientContact.id,enabled,consent:input.flag('confirm_mail')}})
  await observeUsageThresholds(env,[sub.customer_id])
  return {id:next}
}
export async function configureUsageThreshold(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor)
  return configure(env,actorLabel(actor),input)
}
export async function configurePortalThreshold(env: Bindings, session: CustomerSession, input: Input) {
  return configure(env,`customer:usage-alert:${session.contactId}`,input,session)
}
