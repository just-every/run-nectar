// Signed Stripe deliveries enter the real Worker without a member session.
// Only the paid provider edge is simulated; no raw event becomes app evidence.
import assert from 'node:assert/strict'
import { createHmac,randomBytes } from 'node:crypto'
import { nativeCollectionEdge } from './native-collection.mjs'
import { totp } from './mfa.mjs'

const paymentWebhookSecret='synthetic-nectar-payment-event-secret',webhookSecret=randomBytes(32).toString('hex'),path='/api/nectar/stripe/card-events'
let edge
export const harnessOptions=()=>{
  const base=nativeCollectionEdge(),events=new Map(),calls=[]
  const method={object:'payment_method',id:'synthetic-nectar-native-card-1',customer:'synthetic-nectar-native-customer-1',type:'card',livemode:false,
    card:{brand:'visa',last4:'1111',exp_month:8,exp_year:2038}}
  const fetch=async request=>{
    const url=new URL(request.url);calls.push({path:url.pathname,method:request.method})
    if(url.pathname.startsWith('/v1/events/')){
      assert.equal(request.method,'GET');assert.equal(request.headers.get('authorization'),'Bearer synthetic-nectar-1')
      const event=events.get(url.pathname.split('/').at(-1));return event?Response.json(event):Response.json({},{status:404})
    }
    if(url.pathname===`/v1/payment_methods/${method.id}`)return Response.json(method)
    return base.fetch(request)
  }
  edge={...base,fetch,events,calls,method}
  return {localTime:'2026-10-22T10:00:00Z',stripeFetch:fetch,stripeSecret:'synthetic-nectar-1',stripeSecondarySecret:'synthetic-nectar-2',stripeWebhookSecret:webhookSecret,stripePaymentWebhookSecret:paymentWebhookSecret}
}

export async function cardLifecycleWebhookFlow(h,owner) {
  const api=(route,body,status)=>h.api(route,owner,body,status)
  const instant=Date.parse('2026-10-22T10:00:00Z'),seconds=Math.floor(instant/1000)
  await h.advanceClock(new Date(instant).toISOString())
  const factor=await api('mfa.totp.start',{})
  await api('mfa.totp.confirm',{factor:factor.factor,code:totp(factor.secret,instant)})
  const customer=(await api('customer.create',{external_id:'signed-card-primary',name:'Signed card primary',billing_email:'signed-primary@example.test'})).id
  const other=(await api('customer.create',{external_id:'signed-card-other',name:'Signed card other',billing_email:'signed-other@example.test'})).id
  await api('collection.customer.bind',{customer,account_ref:'synthetic-nectar-native-account-1',stripe_customer_ref:edge.method.customer,confirm:true})
  await api('collection.customer.bind',{customer:other,account_ref:'synthetic-nectar-native-account-1',stripe_customer_ref:'synthetic-nectar-native-customer-3',confirm:true})
  const signature=(text,time=seconds,secret=webhookSecret)=>`t=${time},v1=${createHmac('sha256',secret).update(`${time}.${text}`).digest('hex')}`
  const post=async(text,{time=seconds,signed=signature(text,time),status=200,headers={},cookie,method='POST'}={})=>{
    const response=await h.raw(path,{method,cookie,form:text,headers:{'content-type':'application/json','stripe-signature':signed,...headers}})
    const value=await response.json()
    assert.equal(response.status,status,`Signed card receiver: ${JSON.stringify(value)}`)
    return value
  }
  const event=(id='synthetic-signed-card-event',created=seconds)=>({object:'event',id,created,type:'payment_method.automatically_updated',livemode:false,
    data:{object:structuredClone(edge.method)}})
  const original=event();edge.events.set(original.id,structuredClone(original))
  // Delivered values differ from the provider's current values on purpose.
  original.data.object.card={brand:'visa',last4:'9999',exp_month:1,exp_year:2030}
  original.data.object.billing_details={email:'private-envelope@example.test'}
  const text=JSON.stringify(original,null,2),beforeCalls=edge.calls.length,beforeMail=h.mails.length
  delete h.vars.STRIPE_WEBHOOK_SECRET
  await h.advanceClock(new Date(instant).toISOString());await post(text,{status:503})
  h.vars.STRIPE_WEBHOOK_SECRET=webhookSecret;await h.advanceClock(new Date(instant).toISOString())
  await post(text,{signed:'',cookie:owner,status:401})
  await post(text,{signed:signature(text,seconds,paymentWebhookSecret),cookie:owner,status:401})
  await post(text+' ',{signed:signature(text),status:401})
  await post(text,{time:seconds-3600,status:401})
  await post(text,{time:seconds+3600,status:401})
  await post(text,{signed:`t=${seconds},t=${seconds},v1=${'0'.repeat(64)}`,status:401})
  await post(text,{headers:{'content-type':'text/plain'},status:415})
  await post(text,{method:'PUT',status:405})
  await post('{',{status:400})
  await post(JSON.stringify({...original,livemode:true}),{status:400})
  await post(JSON.stringify({...original,type:'payment_method.updated'}),{status:400})
  await post(JSON.stringify({...original,account:'synthetic-unconfigured-account'}),{status:409})
  await post(JSON.stringify({...original,data:{object:{...original.data.object,customer:'synthetic-unbound-customer'}}}),{status:409})
  const huge=JSON.stringify({...original,discarded:'x'.repeat(1024*1024)})
  // A direct Worker HTTP request avoids the local proxy's early-response upload
  // race while exercising the same public receiver and bounded-body refusal.
  const oversized=await h.dispatch(new Request(h.origin+path,{method:'POST',headers:{'content-type':'application/json','stripe-signature':signature(huge)},body:huge}))
  assert.equal(oversized.status,413)
  assert.equal((await oversized.json()).error,'card_event_too_large')
  assert.equal(edge.calls.length,beforeCalls,'Invalid delivery never reaches provider traffic')
  const read=async id=>(await api(`customers/${id??customer}`)).billingRecord.cardLifecycle
  assert.deepEqual(await read(),[])
  assert.deepEqual(await post(text),{received:true,replayed:false})
  const [saved]=await read()
  assert.deepEqual(saved.card,{brand:'visa',last4:'1111',expMonth:8,expYear:2038},'Only current provider facts reach the lifecycle record')
  assert.deepEqual(await read(other),[])
  const afterApply=edge.calls.length,audit=await api('audit')
  assert.deepEqual(await post(text),{received:true,replayed:true})
  assert.equal(edge.calls.length,afterApply)
  assert.deepEqual(await api('audit'),audit,'Replayed signature delivery creates no duplicate application or audit')
  const mismatched=event('synthetic-signed-mismatched-event');mismatched.data.object.customer='synthetic-nectar-native-customer-3'
  edge.events.set(mismatched.id,mismatched)
  await post(JSON.stringify({...original,id:mismatched.id}),{status:409})
  assert.deepEqual(await read(),[saved],'Signed envelope cannot substitute authority for a foreign provider event')
  const concurrent=event('synthetic-signed-concurrent-event',seconds+1);edge.events.set(concurrent.id,concurrent)
  const delivered=await Promise.all([post(JSON.stringify(concurrent)),post(JSON.stringify(concurrent))])
  assert.deepEqual(delivered.map(value=>value.replayed).sort(),[false,true])
  assert.equal(h.mails.length,beforeMail)
  assert.equal(edge.calls.filter(call=>call.method!=='GET').length,0,'Verified intake never sends a processor write')
  const snapshot=JSON.stringify([await read(),await api('audit')])
  assert.ok(!snapshot.includes('private-envelope@example.test')&&!snapshot.includes('9999'),'Raw webhook fields are excluded from saved projections')
  await h.advanceClock(new Date(instant+3600*1000).toISOString())
  await post(text,{status:401})
  console.log('PAY-005 signed Stripe intake, exact-byte verification, stale, tampered and foreign refusal, current provider facts and deduplicated delivery passed')
}
