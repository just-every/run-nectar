// Signed observations reconcile existing test-mode claims through provider reads.
import type { Bindings } from '../auth.server'
import { applyAutomaticEvent } from './automatic-collection-events'
import { boundedBody, verifySignature } from './card-lifecycle-webhook'
import { clockInstant } from './clock'
import { all, insist, NectarError, type Row } from './core'
import { NativeStripeError, providerReference } from './payments/stripe'

const path='/api/nectar/stripe/payment-events'
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}})
export async function automaticCollectionWebhook(request:Request,env:Bindings):Promise<Response|null>{
 if(new URL(request.url).pathname!==path)return null
 if(request.method!=='POST')return json({error:'method_not_allowed'},405)
 if(!env.STRIPE_PAYMENT_WEBHOOK_SECRET?.trim())return json({error:'payment_event_intake_not_configured'},503)
 try{
  insist(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()==='application/json','payment_event_json_required',415)
  insist(!request.headers.has('content-encoding')||request.headers.get('content-encoding')==='identity','payment_event_encoding_unsupported',415)
  const bytes=await boundedBody(request)
  await verifySignature(request,env.STRIPE_PAYMENT_WEBHOOK_SECRET,bytes,clockInstant(env))
  let event:Row
  try{event=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{throw new NectarError('payment_event_json_invalid',400)}
  const object=event?.data?.object
  insist(event?.object==='event'&&event.livemode===false&&['payment_intent.processing','payment_intent.succeeded','payment_intent.payment_failed'].includes(event.type)
   &&object?.object==='payment_intent','payment_event_envelope_invalid',400)
  const eventRef=providerReference(event.id),intentRef=providerReference(object.id),customerRef=providerReference(object.customer)
  const account=event.account===undefined?null:providerReference(event.account)
  const rows=await all(env,`SELECT a.id FROM nc_automatic_collections a JOIN nc_automatic_collection_authorizations z ON z.id=a.id AND z.basis_hash=a.basis_hash JOIN nc_customers c ON c.id=a.customer_id
   JOIN nc_stripe_customer_bindings b ON b.customer_id=c.id AND b.account_ref=a.account_ref AND b.stripe_customer_ref=a.stripe_customer_ref
   WHERE (a.payment_intent_ref=? OR (a.payment_intent_ref IS NULL AND a.id=? AND a.claimed_at IS NOT NULL)) AND a.stripe_customer_ref=? AND (? IS NULL OR a.account_ref=?) AND c.status='active' AND c.erased_at IS NULL
   AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(a.id,a.invoice_id,c.id,b.id)) LIMIT 2`,intentRef,typeof object.metadata?.nectar_native_collection_request==='string'?object.metadata.nectar_native_collection_request:'',customerRef,account,account)
  insist(rows.length===1,'payment_event_claim_unknown',409)
  const result=await applyAutomaticEvent(env,rows[0].id,eventRef,'system:payment-events')
  return json({received:true,replayed:result.replayed,status:result.status})
 }catch(error){
  if(error instanceof NectarError)return json({error:error.code},error.status)
  if(error instanceof NativeStripeError)return json({error:'payment_event_provider_unavailable'},502)
  return json({error:'payment_event_processing_failed'},500)
 }
}
