// Current feature decisions can change at a dated boundary without a write.
// Observe bounded pages and emit a typed state only when the decision changes.
import type { Bindings } from '../auth.server'
import type { Actor } from './actor'
import { all,commit,fingerprint,guard,NectarError,newId,one,parseJson,stmt,type Row } from './core'
import { clockInstant } from './clock'
import { entitlements } from './entitlements'
import { metadataFor,withMetadata } from './metadata'
const reader:Actor={id:'system:webhooks',kind:'agent',name:'Webhook state observer',email:'',role:null,sessionId:null,capabilities:new Set(['read'])}

async function eventMetadata(env: Bindings, customer: string, state: Row[]) {
  const ids=[...new Set(state.flatMap(f=>f.paths.map((p:Row)=>p.subscription)).filter(Boolean))] as string[]
  const subscriptions=await withMetadata(env,'subscription',ids.map(id=>({kind:'subscription',id})))
  const prices=await all(env,'SELECT DISTINCT i.price_id FROM nc_items i JOIN nc_subscriptions s ON s.id=i.subscription_id WHERE s.customer_id=? ORDER BY i.price_id',customer)
  return [{kind:'customer',id:customer,...await metadataFor(env,'customer',customer)},...subscriptions,{kind:'prices',objects:await withMetadata(env,'price',prices.map(p=>({kind:'price',id:p.price_id})))}]
}
export async function observeWebhookEntitlements(env: Bindings) {
  if(!await one(env,'SELECT 1 FROM nc_webhook_endpoints WHERE enabled=1'))return
  const cursor=(await one(env,'SELECT customer_id FROM nc_webhook_observation_cursor WHERE singleton=1'))!.customer_id
  const customers=await all(env,`SELECT c.id FROM nc_customers c WHERE c.id>? AND c.erased_at IS NULL AND c.status='active' AND
    (EXISTS(SELECT 1 FROM nc_webhook_entitlement_state old WHERE old.customer_id=c.id) OR EXISTS(SELECT 1 FROM nc_subscriptions s JOIN nc_items i ON i.subscription_id=s.id JOIN nc_prices p ON p.id=i.price_id JOIN nc_features f ON f.product_id=p.product_id WHERE s.customer_id=c.id)) ORDER BY c.id LIMIT 100`,cursor)
  for(const customer of customers){
    const generation=(await one(env,'SELECT value FROM nc_privacy_generation WHERE id=1'))!.value
    const decisions=await entitlements(env,reader,customer.id)
    const state=decisions.map(f=>({feature:f.feature,allowed:f.allowed,paths:f.paths.map((p:Row)=>({subscription:p.subscription,granted:p.granted,warning:p.warning??false,quota:p.quota?{meter:p.quota.meter,limit:p.quota.limit,policy:p.quota.policy,exhausted:p.quota.exhausted,period:p.quota.period}:null,paymentRestricted:p.payment?.restricted??false}))}))
    const basis=await fingerprint(state),old=await one(env,'SELECT basis,state_json FROM nc_webhook_entitlement_state WHERE customer_id=?',customer.id)
    if(old?.basis===basis)continue
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
        events.push(add('usage.threshold_crossed',{customer_id:customer.id,subscription_id:path.subscription,feature:feature.feature,quota:q?{meter:q.meter,used:q.used,limit:q.limit,remaining:q.remaining,policy:q.policy,exhausted:q.exhausted,period:q.period}:null}))
      }
    }
    try{
      await commit(env,[guard(env,'stale','(SELECT value FROM nc_privacy_generation WHERE id=1)=?',generation),...events,stmt(env,'INSERT INTO nc_webhook_entitlement_state(customer_id,basis,state_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(customer_id) DO UPDATE SET basis=excluded.basis,state_json=excluded.state_json,updated_at=excluded.updated_at',customer.id,basis,JSON.stringify(state),at)],{actor:'system:webhooks',action:'webhook.entitlement.observe',subject:customer.id,detail:{events:events.length}})
    }catch(error){if(!(error instanceof NectarError&&error.status===409))throw error}
  }
  await env.DB.prepare('UPDATE nc_webhook_observation_cursor SET customer_id=? WHERE singleton=1').bind(customers.length===100?customers.at(-1)!.id:'').run()
}
