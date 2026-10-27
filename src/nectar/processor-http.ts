import type { Bindings } from '../auth.server'
import { boundedBody, verifySignature } from './card-lifecycle-webhook'
import { clockInstant } from './clock'
import { insist, NectarError, type Row } from './core'
import { applyProcessorEvent } from './processor-events'
import { NativeStripeError, providerReference } from './payments/stripe'
export async function processorWebhook(request:Request,env:Bindings&{STRIPE_WEBHOOK_SECRET?:string}):Promise<Response|null> {
 if(new URL(request.url).pathname!=='/api/nectar/stripe/payment-events')return null
 const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}})
 if(request.method!=='POST')return new Response(null,{status:405,headers:{allow:'POST'}})
 if(!env.STRIPE_WEBHOOK_SECRET?.trim())return json({error:'processor_webhook_not_configured'},503)
 try {
  insist(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()==='application/json','processor_json_required',415)
  insist(!request.headers.has('content-encoding')||request.headers.get('content-encoding')==='identity','processor_encoding_unsupported',415)
  const bytes=await boundedBody(request)
  await verifySignature(request,env.STRIPE_WEBHOOK_SECRET,bytes,clockInstant(env))
  let event:Row
  try{event=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{throw new NectarError('processor_json_invalid',400)}
  insist(event&&event.object==='event'&&event.livemode===false,'processor_event_invalid',400)
  const result=await applyProcessorEvent(env,event.account===undefined?null:providerReference(event.account),providerReference(event.id))
  return json({received:true,...result})
 }catch(error){
  if(error instanceof NectarError)return json({error:error.code},error.status)
  if(error instanceof NativeStripeError)return json({error:'processor_provider_unavailable'},502)
  return json({error:'processor_processing_failed'},500)
 }
}
