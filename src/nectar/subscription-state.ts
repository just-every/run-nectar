// Observed native lifecycle facts confer no collection or dunning authority.
import { canRead, type Actor } from './actor'
import type { Bindings } from '../auth.server'
import { all, commit, guard, NectarError, newId, one, parseJson, stmt } from './core'
import { clockInstant } from './clock'
import { today } from './dates'
import { metadataFor, withMetadata } from './metadata'
import { entitlementState } from './entitlement-state'

export const subscriptionStateHistory = async (env: Bindings, subscription: string, actor: Actor) =>
  (await all(env,'SELECT * FROM nc_subscription_states WHERE subscription_id=? ORDER BY seq',subscription))
    .map(row=>({...row,cause:actor.kind==='member'&&actor.role==='owner'&&canRead(actor,'payments')&&canRead(actor,'invoices')?parseJson(row.cause_json,{}):{kind:parseJson<Record<string,unknown>>(row.cause_json,{}).kind,day:parseJson<Record<string,unknown>>(row.cause_json,{}).day},cause_json:undefined}))

/** Bounded scheduled observation, independent of outbound endpoint consent.
 * A retry rereads current facts; it cannot duplicate a committed transition. */
export async function observeSubscriptionStates(env: Bindings) {
  const business=await one(env,'SELECT timezone FROM nc_business LIMIT 1')
  if(!business)return
  const cursor=(await one(env,'SELECT subscription_id FROM nc_subscription_state_cursor WHERE singleton=1'))!.subscription_id
  const subs=await all(env,`SELECT s.* FROM nc_subscriptions s JOIN nc_customers c ON c.id=s.customer_id
    WHERE s.id>? AND s.origin='native' AND s.billing_mode='live' AND c.status='active' AND c.erased_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(s.id,c.id)) ORDER BY s.id LIMIT 100`,cursor)
  for(const sub of subs){
    const generation=(await one(env,'SELECT value FROM nc_privacy_generation WHERE id=1'))!.value
    const at=clockInstant(env),day=today(business.timezone,at),facts=await entitlementState(env,sub,day)
    const state=facts.lifecycle==='active' && ['past_due','unpaid'].includes(facts.payment.status)?facts.payment.status:facts.lifecycle
    const previous=await one(env,'SELECT id,state FROM nc_subscription_states WHERE subscription_id=? ORDER BY seq DESC LIMIT 1',sub.id)
    if(previous?.state===state)continue
    const kind=state==='past_due'?'payment_failed_or_overdue':state==='unpaid'?'dunning_unpaid':state==='active'&&previous&&['past_due','unpaid'].includes(previous.state)?'obligations_cleared':'schedule_or_lifecycle'
    const cause={kind,day,subscriptionRevision:sub.revision,payment:facts.payment,
      allocations:await all(env,'SELECT a.id,a.invoice_id,a.payment_id,a.amount_cents FROM nc_allocations a JOIN nc_invoices i ON i.id=a.invoice_id WHERE i.subscription_id=? ORDER BY a.id',sub.id),
      lifecycleEvents:(await all(env,'SELECT id,kind,effective_date,until_date,related_id FROM nc_subscription_lifecycle WHERE subscription_id=? ORDER BY seq',sub.id)),
      dunning:await all(env,"SELECT d.id,d.status,d.end_date FROM nc_dunning_series d JOIN nc_invoices i ON i.id=d.invoice_id WHERE i.subscription_id=? AND d.status='mark_unpaid' ORDER BY d.id",sub.id)}
    const metadata=[{kind:'customer',id:sub.customer_id,...await metadataFor(env,'customer',sub.customer_id)},{kind:'subscription',id:sub.id,...await metadataFor(env,'subscription',sub.id)},
      {kind:'prices',objects:await withMetadata(env,'price',await all(env,'SELECT DISTINCT price_id AS id FROM nc_items WHERE subscription_id=? ORDER BY price_id',sub.id))}]
    const id=newId(),data={id:sub.id,customer_id:sub.customer_id,billing_mode:sub.billing_mode,end_date:sub.end_date,state,previous_state:previous?.state??null,transition_id:id,cause}
    try{
      await commit(env,[
        guard(env,'stale','(SELECT value FROM nc_privacy_generation WHERE id=1)=?',generation),
        guard(env,'stale','(SELECT id FROM nc_subscription_states WHERE subscription_id=? ORDER BY seq DESC LIMIT 1) IS ?',sub.id,previous?.id??null),
        stmt(env,'INSERT INTO nc_subscription_states(id,subscription_id,customer_id,previous_state,state,cause_json,observed_at) VALUES(?,?,?,?,?,?,?)',id,sub.id,sub.customer_id,previous?.state??null,state,JSON.stringify(cause),at),
        stmt(env,`INSERT INTO nc_webhook_events(id,type,customer_id,subject,payload_json,created_at)
          SELECT ?,'subscription.updated',?,?,?,? WHERE EXISTS(SELECT 1 FROM nc_webhook_endpoints WHERE enabled=1)
          AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)`,newId(),sub.customer_id,sub.id,JSON.stringify({type:'subscription.updated',data,metadata}),at),
      ],{actor:'system:subscription-state',action:'subscription.state.observe',subject:sub.id,detail:data})
    }catch(error){if(!(error instanceof NectarError&&error.status===409))throw error}
  }
  await env.DB.prepare('UPDATE nc_subscription_state_cursor SET subscription_id=? WHERE singleton=1').bind(subs.length===100?subs.at(-1)!.id:'').run()
}
