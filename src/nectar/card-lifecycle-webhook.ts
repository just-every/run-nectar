// Installation-secret Stripe delivery authenticates an observation only.
// Payload card facts never become source evidence; the account's API does.
import { timingSafeEqual } from 'node:crypto'
import type { Bindings } from '../auth.server'
import { applyCardLifecycleEvent } from './card-lifecycle'
import { clockInstant } from './clock'
import { all, insist, NectarError, type Row } from './core'
import { NativeStripeError, providerReference } from './payments/stripe'

const PATH='/api/nectar/stripe/card-events',MAX_BYTES=128*1024,WINDOW_SECONDS=300
const headers={'cache-control':'no-store','x-content-type-options':'nosniff'}
const json=(body:unknown,status=200,extra:Record<string,string>={})=>Response.json(body,{status,headers:{...headers,...extra}})

export async function boundedBody(request:Request) {
  const length=request.headers.get('content-length')
  insist(length===null || /^\d+$/.test(length),'card_event_length_invalid',400)
  if(length!==null && Number(length)>MAX_BYTES)throw new NectarError('card_event_too_large',413)
  const reader=request.body?.getReader()
  insist(reader,'card_event_body_required',400)
  const chunks:Uint8Array[]=[],bodyLimit=MAX_BYTES
  let size=0
  try{
    for(;;){
      const part=await reader.read();if(part.done)break
      size+=part.value.byteLength
      if(size>bodyLimit)throw new NectarError('card_event_too_large',413)
      chunks.push(part.value)
    }
  }finally{reader.releaseLock()}
  const bytes=new Uint8Array(size)
  let offset=0
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength}
  return bytes
}

export async function verifySignature(request:Request,secret:string,bytes:Uint8Array,now:number) {
  const header=request.headers.get('stripe-signature')??''
  insist(header.length>0 && header.length<=8192,'card_event_signature_invalid',401)
  const parts=header.split(',').map(value=>value.trim()),times=parts.filter(part=>part.startsWith('t=')),signatures=parts.filter(part=>part.startsWith('v1='))
  insist(times.length===1 && /^t=\d{1,12}$/.test(times[0]) && signatures.length>0 && signatures.length<=16
    && signatures.every(part=>/^v1=[a-fA-F0-9]{64}$/.test(part)),'card_event_signature_invalid',401)
  const timestamp=times[0].slice(2),seconds=Number(timestamp)
  insist(Number.isSafeInteger(seconds) && Math.abs(Math.floor(now/1000)-seconds)<=WINDOW_SECONDS,'card_event_signature_stale',401)
  const prefix=new TextEncoder().encode(`${timestamp}.`),signed=new Uint8Array(prefix.byteLength+bytes.byteLength)
  signed.set(prefix);signed.set(bytes,prefix.byteLength)
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign'])
  const expected=new Uint8Array(await crypto.subtle.sign('HMAC',key,signed))
  let valid=false
  for(const signature of signatures){
    const supplied=Uint8Array.from(signature.slice(3).match(/../g)!,pair=>Number.parseInt(pair,16))
    valid=timingSafeEqual(expected,supplied)||valid
  }
  insist(valid,'card_event_signature_invalid',401)
}

export async function cardLifecycleWebhook(request:Request,env:Bindings&{STRIPE_WEBHOOK_SECRET?:string}):Promise<Response|null> {
  if(new URL(request.url).pathname!==PATH)return null
  if(request.method!=='POST')return json({error:'method_not_allowed'},405,{allow:'POST'})
  const secret=env.STRIPE_WEBHOOK_SECRET
  if(typeof secret!=='string' || !secret.trim())return json({error:'card_event_intake_not_configured'},503)
  if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')return json({error:'card_event_json_required'},415)
  if(request.headers.has('content-encoding') && request.headers.get('content-encoding')!=='identity')return json({error:'card_event_encoding_unsupported'},415)
  try{
    const bytes=await boundedBody(request)
    await verifySignature(request,secret,bytes,clockInstant(env))
    let event:Row
    try{event=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{throw new NectarError('card_event_json_invalid',400)}
    const object=event?.data?.object
    insist(event && typeof event==='object' && !Array.isArray(event) && event.object==='event' && event.livemode===false
      && event.type==='payment_method.automatically_updated' && object?.object==='payment_method'
      && typeof event.id==='string' && typeof object.id==='string' && typeof object.customer==='string','card_event_envelope_invalid',400)
    const eventRef=providerReference(event.id),customerRef=providerReference(object.customer)
    providerReference(object.id)
    const accountRef=event.account===undefined?null:providerReference(event.account)
    const bindings=await all(env,`SELECT b.id FROM nc_stripe_customer_bindings b JOIN nc_customers c ON c.id=b.customer_id
      WHERE b.stripe_customer_ref=? AND (? IS NULL OR b.account_ref=?) AND c.status='active' AND c.erased_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(b.id,c.id)) LIMIT 2`,customerRef,accountRef,accountRef)
    insist(bindings.length===1,'card_event_binding_unknown',409)
    const result=await applyCardLifecycleEvent(env,bindings[0].id,eventRef)
    return json({received:true,replayed:result.replayed===true})
  }catch(error){
    if(error instanceof NectarError)return json({error:error.code},error.status)
    if(error instanceof NativeStripeError)return json({error:'card_event_provider_unavailable'},502)
    return json({error:'card_event_processing_failed'},500)
  }
}
