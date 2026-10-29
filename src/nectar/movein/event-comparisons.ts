// Latest authenticated test-shadow subscription items versus native dated inputs.
// Other event kinds remain outside this comparison; it never dispatches an event.
import type { Bindings } from '../../auth.server'
import { all, fingerprint, parseJson, type Row } from '../core'
import { localDate } from '../dates'
import { requireBusiness } from '../business'

export async function moveEventEvidence(env:Bindings):Promise<Row[]> {
  const business=await requireBusiness(env)
  // The retained event projection owns customer_id, while the binding proves
  // its current processor account and source-customer identity independently.
  const events=await all(env,`SELECT e.id,e.payload_json,s.id AS subscription,s.customer_id FROM nc_webhook_stripe_receipts r
    JOIN nc_webhook_events e ON e.id=r.event_id AND e.customer_id=r.customer_id
    JOIN nc_subscriptions s ON s.id=json_extract(e.payload_json,'$.data.subscription_id') AND s.customer_id=r.customer_id
    JOIN nc_customers c ON c.id=s.customer_id
    JOIN nc_stripe_customer_bindings b ON b.customer_id=c.id AND b.account_ref=r.account_ref AND b.stripe_customer_ref=c.provider_ref
    WHERE c.erased_at IS NULL AND s.billing_mode='shadow' AND s.origin='import'
      AND NOT EXISTS(SELECT 1 FROM nc_erased_records x WHERE x.record_id IN (c.id,b.id)) ORDER BY e.id`)
  const latest=new Map<string,Row>()
  for(const event of events) {
    const data=parseJson<Row>(event.payload_json,{}).data
    if(!data || data.custody!=='stripe-test-shadow-event' || !String(data.source?.event_type).startsWith('customer.subscription.') || !Number.isSafeInteger(data.source.created_at))continue
    const key=`${event.subscription}:${data.source.account_ref}`,prior=latest.get(key)
    if(!prior || data.source.created_at>prior.data.source.created_at) latest.set(key,{...event,data,ambiguous:false})
    else if(data.source.created_at===prior.data.source.created_at && JSON.stringify([data.status,data.items])!==JSON.stringify([prior.data.status,prior.data.items])) prior.ambiguous=true
  }
  const results:Row[]=[]
  for(const [key,event] of latest) {
    const data=event.data
    if(event.ambiguous || data.status!=='active' || !['customer.subscription.created','customer.subscription.updated'].includes(data.source.event_type) || !Array.isArray(data.items))continue
    const day=localDate(data.source.created_at,business.timezone)
    const itemRows=await all(env,`SELECT p.provider_ref AS price_ref,i.quantity FROM nc_items i JOIN nc_prices p ON p.id=i.price_id
      WHERE i.subscription_id=? AND i.effective_from<=? AND (i.effective_to IS NULL OR i.effective_to>?) ORDER BY p.provider_ref,i.id`,event.subscription,day,day)
    const items=itemRows.map(item=>({price_ref:item.price_ref,quantity:Number(item.quantity)}))
    const captured=data.items.map((item:Row)=>({price_ref:item.price_ref,quantity:item.quantity})).sort((a:Row,b:Row)=>String(a.price_ref).localeCompare(String(b.price_ref)))
    // Duplicate prices and missing quantities are ambiguous, never asserted equal.
    if(captured.some((item:Row)=>!Number.isSafeInteger(item.quantity)) || new Set(captured.map((item:Row)=>item.price_ref)).size!==captured.length || new Set(items.map(item=>item.price_ref)).size!==items.length)continue
    const mismatch=JSON.stringify(captured)!==JSON.stringify(items)
    const proof={kind:'move_comparison',category:'webhook',source:`move-event:${key}`,customer:event.customer_id,subscription:event.subscription,
      invoiceReference:data.source.event_ref,comparisons:[],differences:mismatch?[{field:'eventItems',captured,engine:items}]:[],mismatch,
      coverage:'latest-active-subscription-items-only',citation:{event:data.source.event_ref,account:data.source.account_ref,capturedAt:data.source.created_at},
      captureBasis:await fingerprint(data),engineBasis:await fingerprint(items)}
    results.push({...proof,basis:await fingerprint(proof)})
  }
  return results
}
