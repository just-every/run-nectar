// Current feature decisions can change at a dated boundary without a write.
// Observe bounded pages and emit a typed state only when the decision changes.
import type { Bindings } from '../auth.server'
import type { Actor } from './actor'
import { all,commit,fingerprint,guard,NectarError,newId,one,parseJson,stmt,type Row } from './core'
import { clockInstant } from './clock'
import { sweepDue } from './observation-gate'
import { entitlements } from './entitlements'
import { metadataFor,withMetadata } from './metadata'
const reader:Actor={id:'system:webhooks',kind:'agent',name:'Webhook state observer',email:'',role:null,sessionId:null,capabilities:new Set(['read'])}

async function eventMetadata(env: Bindings, customer: string, state: Row[]) {
  const ids=[...new Set(state.flatMap(f=>f.paths.map((p:Row)=>p.subscription)).filter(Boolean))] as string[]
  const subscriptions=await withMetadata(env,'subscription',ids.map(id=>({kind:'subscription',id})))
  const prices=await all(env,'SELECT DISTINCT i.price_id FROM nc_items i JOIN nc_subscriptions s ON s.id=i.subscription_id WHERE s.customer_id=? ORDER BY i.price_id',customer)
  return [{kind:'customer',id:customer,...await metadataFor(env,'customer',customer)},...subscriptions,{kind:'prices',objects:await withMetadata(env,'price',prices.map(p=>({kind:'price',id:p.price_id})))}]
}
// Customers whose decisions are observed: those with a stored state or any feature.
const population=`(EXISTS(SELECT 1 FROM nc_webhook_entitlement_state old WHERE old.customer_id=c.id) OR EXISTS(SELECT 1 FROM nc_subscriptions s JOIN nc_items i ON i.subscription_id=s.id JOIN nc_prices p ON p.id=i.price_id JOIN nc_features f ON f.product_id=p.product_id WHERE s.customer_id=c.id))`
async function observeCustomer(env: Bindings, customer: Row) {
    const generation=(await one(env,'SELECT value FROM nc_privacy_generation WHERE id=1'))!.value
    const decisions=await entitlements(env,reader,customer.id)
    const state=decisions.map(f=>({feature:f.feature,allowed:f.allowed,paths:f.paths.map((p:Row)=>({subscription:p.subscription,granted:p.granted,numericLimit:p.numericLimit??null,lifecycle:p.state?.lifecycle??null,paymentState:p.state?.payment?.status??null,warning:p.warning??false,quota:p.quota?{meter:p.quota.meter,limit:p.quota.limit,policy:p.quota.policy,exhausted:p.quota.exhausted,period:p.quota.period}:null,paymentRestricted:p.payment?.restricted??false}))}))
    const basis=await fingerprint(state),old=await one(env,'SELECT basis,state_json FROM nc_webhook_entitlement_state WHERE customer_id=?',customer.id)
    if(old?.basis===basis)return
    const previous=parseJson<Row[]>(old?.state_json,[]),at=clockInstant(env),metadata=await eventMetadata(env,customer.id,state)
    const add=(type:string,data:unknown)=>stmt(env,'INSERT INTO nc_webhook_events(id,type,customer_id,subject,payload_json,created_at) VALUES(?,?,?,?,?,?)',newId(),type,customer.id,customer.id,JSON.stringify({type,data,metadata}),at)
    const events=[add('entitlements.updated',{customer_id:customer.id,features:state})]
    // Existing ENT-002 limits are present public thresholds. New independent
    // usage/spend thresholds and invoices remain USE-005's obligation.
    for(const feature of state)for(const path of feature.paths){
      const before=previous.find(f=>f.feature===feature.feature)?.paths.find((p:Row)=>p.subscription===path.subscription)
      if(path.quota?.exhausted&&before?.quota&&!before.quota.exhausted&&before.quota.period.start===path.quota.period.start){
        const source=decisions.find(f=>f.feature===feature.feature)?.paths.find(p=>p.subscription===path.subscription) as Row|undefined
        const q=source?.quota
        // A recorded crossing survives policy revisions and a later decrease.
        // This is the existing quota event, once per subscription, feature,
        // meter and actual billing period; no historical event is sent.
        const crossed=q&&await one(env,`SELECT id FROM nc_webhook_events WHERE type='usage.threshold_crossed' AND customer_id=?
          AND json_extract(payload_json,'$.data.subscription_id')=? AND json_extract(payload_json,'$.data.feature')=?
          AND json_extract(payload_json,'$.data.quota.meter')=? AND json_extract(payload_json,'$.data.quota.period.start')=? LIMIT 1`,
          customer.id,path.subscription,feature.feature,q.meter,q.period.start)
        if(q&&!crossed)events.push(add('usage.threshold_crossed',{customer_id:customer.id,subscription_id:path.subscription,feature:feature.feature,quota:{meter:q.meter,used:q.used,limit:q.limit,remaining:q.remaining,policy:q.policy,exhausted:q.exhausted,period:q.period}}))
      }
    }
    try{
      await commit(env,[guard(env,'stale','(SELECT value FROM nc_privacy_generation WHERE id=1)=?',generation),guard(env,'stale','(SELECT basis FROM nc_webhook_entitlement_state WHERE customer_id=?) IS ?',customer.id,old?.basis??null),...events,stmt(env,'INSERT INTO nc_webhook_entitlement_state(customer_id,basis,state_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(customer_id) DO UPDATE SET basis=excluded.basis,state_json=excluded.state_json,updated_at=excluded.updated_at',customer.id,basis,JSON.stringify(state),at)],{actor:'system:webhooks',action:'webhook.entitlement.observe',subject:customer.id,detail:{events:events.length}})
    }catch(error){if(!(error instanceof NectarError&&error.status===409))throw error}
}

// Who changed since the feed position: customers named by an audit subject (the
// customer, one of its subscriptions or invoices) or by a usage event. Subjects
// that name no customer (catalogue and policy edits) wait for the next sweep.
const feedPosition = async (env: Bindings) => (await one(env, 'SELECT COALESCE(MAX(seq),0) a,(SELECT COALESCE(MAX(rowid),0) FROM nc_usage_events) u FROM nc_audit'))!
async function dirtyCustomers(env: Bindings, auditSeq: number, usageRowid: number) {
  const audit = await feedPosition(env)
  // A position ahead of the ledger means the ledger was restored: examine everyone.
  if (audit.a < auditSeq || audit.u < usageRowid) return { audit: audit.a as number, usage: audit.u as number, customers: [] as string[], overflow: true }
  if (audit.a === auditSeq && audit.u === usageRowid) return { audit: audit.a as number, usage: audit.u as number, customers: [] as string[], overflow: false }
  const named = await all(env, `SELECT DISTINCT COALESCE(c.id,s.customer_id,i.customer_id) id FROM (SELECT DISTINCT subject FROM nc_audit WHERE seq>? AND seq<=? AND actor<>'system:webhooks' LIMIT 200) a
    LEFT JOIN nc_customers c ON c.id=a.subject LEFT JOIN nc_subscriptions s ON s.id=a.subject LEFT JOIN nc_invoices i ON i.id=a.subject`, auditSeq, audit.a)
  const used = await all(env, 'SELECT DISTINCT customer_id id FROM nc_usage_events WHERE rowid>? AND rowid<=? LIMIT 200', usageRowid, audit.u)
  const ids = [...new Set([...named, ...used].map(row => row.id).filter(Boolean))] as string[]
  return { audit: audit.a as number, usage: audit.u as number, customers: ids, overflow: ids.length > 100 }
}

export async function observeWebhookEntitlements(env: Bindings) {
  if(!await one(env,'SELECT 1 FROM nc_webhook_endpoints WHERE enabled=1'))return
  const at=clockInstant(env),zone=(await one(env,'SELECT timezone FROM nc_business WHERE singleton=1'))?.timezone??'UTC'
  const gate=(await one(env,'SELECT customer_id,swept_at,sweep_at,audit_seq,usage_rowid FROM nc_webhook_observation_cursor WHERE singleton=1'))!
  const cursor=gate.customer_id as string
  let sweepAt=gate.sweep_at as number|null,audit=gate.audit_seq as number|null,usage=gate.usage_rowid as number|null
  if(cursor===''){
    // Only dated facts and unattributed edits need a full pass; a change to one
    // customer's records re-evaluates that customer in the minute it happens.
    let sweep=sweepDue(at,gate.swept_at,zone)||audit==null||usage==null
    if(!sweep){
      const feed=await dirtyCustomers(env,audit!,usage!)
      if(feed.overflow)sweep=true
      else{
        if(feed.customers.length){
          for(const customer of await all(env,`SELECT c.id FROM nc_customers c WHERE c.id IN (SELECT value FROM json_each(?)) AND c.erased_at IS NULL AND c.status='active' AND ${population} ORDER BY c.id`,JSON.stringify(feed.customers)))await observeCustomer(env,customer)
        }
        if(feed.audit!==audit||feed.usage!==usage)await env.DB.prepare('UPDATE nc_webhook_observation_cursor SET audit_seq=?,usage_rowid=? WHERE singleton=1').bind(feed.audit,feed.usage).run()
        return
      }
    }
    // The feed position is taken before the first customer is read, so a change
    // that lands during the sweep is examined by the minute after it.
    const feed=await feedPosition(env)
    sweepAt=at;audit=feed.a;usage=feed.u
  }
  const customers=await all(env,`SELECT c.id FROM nc_customers c WHERE c.id>? AND c.erased_at IS NULL AND c.status='active' AND ${population} ORDER BY c.id LIMIT 100`,cursor)
  for(const customer of customers)await observeCustomer(env,customer)
  const more=customers.length===100
  await env.DB.prepare(`UPDATE nc_webhook_observation_cursor SET customer_id=?,sweep_at=?,audit_seq=?,usage_rowid=?,swept_at=${more?'swept_at':'?'} WHERE singleton=1`).bind(...[more?customers.at(-1)!.id:'',sweepAt,audit,usage,...(more?[]:[sweepAt])]).run()
}
