import { nativeCollectionEdge } from './native-collection.mjs'
import { applyPolicy } from './policy-helper.mjs'
import assert from 'node:assert/strict'
import { mkdtemp,rm,readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { receiver,verify } from '../../examples/webhook-receiver/server.mjs'
const lifecycleEdge=nativeCollectionEdge()
let receive,online=false,clock=Date.now(),secrets=[],requests=[],received=[],directory
export const harnessOptions=()=>({stripeFetch:lifecycleEdge.fetch,stripeSecret:'synthetic-nectar-1',webhookFetch:async request=>{
  const body=await request.text();requests.push({body,header:request.headers.get('nectar-signature')})
  return online?receive(new Request(request.url,{method:'POST',headers:request.headers,body})):new Response(null,{status:503})
}})
export async function webhooksFlow(h,owner,{onState=async()=>{},register}={}){
  directory=await mkdtemp(join(tmpdir(),'nectar-receiver-'))
  receive=receiver({secrets:()=>secrets,stateFile:join(directory,'receipts.json'),clock:()=>clock,onEvent:async e=>received.push(e)})
  online=false;requests=[];received=[]
  const api=(path,body,status)=>h.api(path,owner,body,status)
  const tick=async ms=>{clock+=ms;await h.advanceClock(new Date(clock).toISOString())}
  const dispatch=()=>api('webhook.dispatch',{})
  try{
    await tick(0)
    await api('access.give',{email:'webhook-finance@example.test',name:'Webhook finance',role:'finance'})
    await api('access.give',{email:'webhook-accountant@example.test',name:'Webhook accountant',role:'accountant'})
    const finance=await h.signIn('webhook-finance@example.test',{requested:true}),accountant=await h.signIn('webhook-accountant@example.test',{requested:true})
    const agent={bearer:(await api('credential.issue',{name:'Webhook observer',scopes:['prepare']})).key}
    for(const who of [finance,accountant,agent])for(const action of ['webhook.register','webhook.rotate','webhook.disable','webhook.replay','webhook.dispatch'])await h.api(action,who,{},403)
    for(const url of ['http://receiver.nectar-app.com','https://127.0.0.1/a','https://localhost/a','https://receiver.nectar-app.com:444/a','https://user:pass@receiver.nectar-app.com/a','https://metadata.google.internal/a'])await api('webhook.register',{url,consent:true},400)
    await api('webhook.register',{url:'https://receiver.nectar-app.com/webhooks'},400)
    await onState({label:'empty'})
    const endpoint=await (register?register({url:'https://receiver.nectar-app.com/webhooks',consent:true}):api('webhook.register',{url:'https://receiver.nectar-app.com/webhooks',consent:true}));secrets=[endpoint.secret]
    assert.ok(endpoint.secret.length>30)
    assert.ok(!JSON.stringify(await api('webhooks')).includes(endpoint.secret),'secret is never readable again')
    assert.ok(!JSON.stringify(await api('audit')).includes(endpoint.secret),'secret never appears in audit')
    for(const who of [owner,finance,accountant])await h.api('notification.preferences',who,{webhook_failure:true})
    // Owner deliberately opts out: only authorized, subscribed finance receives failures.
    await api('notification.preferences',{})
    const customer=(await api('customer.create',{external_id:'synthetic-nectar-webhook-1',name:'Webhook account',billing_email:'webhook@example.test'})).id
    const product=(await api('product.create',{code:'synthetic-nectar-webhook-1',name:'Webhook service'})).id
    const price=(await api('price.create',{product,kind:'flat',unit_amount:'100',taxable:false})).id
    const subscription=(await api('subscription.create',{customer,start_date:'2026-09-01',price:[price]})).id
    const annotate=async(kind,record,value,revision=0)=>api('metadata.write',{kind,record,revision,metadata:{app_account_id:value}})
    for(const [kind,id]of [['customer',customer],['subscription',subscription],['price',price]])await annotate(kind,id,`synthetic-nectar-${kind}`)
    const run=await api('billrun.prepare',{period:'2026-09'}),invoice=(await api(`runs/${run.id}`)).invoices.find(i=>i.customer_id===customer).id
    await api('invoice.approve',{invoice,acknowledge:true});await api('invoice.finalise',{invoice,issue_date:'2026-10-01'})
    const credit=(await api('credit.issue',{invoice,amount:'10',reason:'Private narrative must stay private'})).credit
    const payment=(await api('payment.record',{customer,amount:'90',received_on:'2026-10-02',method:'bank_transfer',reference:'synthetic-nectar-webhook-1'})).payment
    for(const [kind,id]of [['invoice',invoice],['payment',payment],['credit-note',credit]])await annotate(kind,id,`synthetic-nectar-${kind}`)
    await api('payment.allocate',{payment,invoice,amount:'90'})
    const log=await api('webhooks'),paid=log.deliveries.find(d=>d.type==='invoice.paid')
    assert.ok(paid)
    const snapshot=(await api(`webhooks/${paid.id}`)).event.payload_json
    const payload=JSON.parse(snapshot)
    for(const kind of ['customer','subscription','invoice','payment'])assert.equal(payload.metadata.find(m=>m.kind===kind).metadata.app_account_id,`synthetic-nectar-${kind}`)
    assert.equal(payload.metadata.find(m=>m.kind==='credit-notes').objects[0].metadata.app_account_id,'synthetic-nectar-credit-note')
    assert.equal(payload.metadata.find(m=>m.kind==='prices').objects[0].metadata.app_account_id,'synthetic-nectar-price')
    assert.ok(!snapshot.includes('Private narrative'))
    for(const [kind,id]of [['customer',customer],['subscription',subscription],['invoice',invoice],['payment',payment],['price',price]])await annotate(kind,id,'replaced',1)
    assert.equal((await api(`webhooks/${paid.id}`)).event.payload_json,snapshot,'event-time metadata is frozen')
    const before=h.mails.length
    await tick(60000)
    const scheduled=await h.raw(`/cdn-cgi/local/scheduled?time=${clock}&cron=${encodeURIComponent('* * * * *')}`)
    assert.equal(scheduled.status,200,await scheduled.text())
    assert.ok(requests.length>=6)
    assert.ok((await api('webhooks')).deliveries.every(d=>d.status==='pending'&&d.attempts===1))
    const mails=h.mails.slice(before)
    assert.ok(mails.length>0)
    assert.ok(mails.every(m=>[m.to].flat().join(',')==='webhook-finance@example.test'),'opt-out and unauthorized roles receive none')
    const detail=await h.api(`webhooks/${paid.id}`,finance)
    assert.equal(detail.status,'pending');assert.equal(detail.event,undefined);assert.equal(detail.payload_json,undefined)
    assert.ok(!JSON.stringify(detail).includes(customer),'finance sees only typed delivery custody')
    assert.match(await h.page(`/app/webhooks/${paid.id}`,finance),/Webhook delivery/)
    await h.api(`webhooks/${paid.id}`,agent,undefined,403)
    assert.ok(mails.some(m=>`${m.text} ${m.html}`.includes(`/app/webhooks/${paid.id}`)))
    await onState({label:'failed',delivery:paid.id,finance})
    await Promise.all([dispatch(),dispatch()])
    assert.equal(requests.length,log.deliveries.length,'not due, no extra send')
    await tick(3600000);online=true
    const rotated=await api('webhook.rotate',{endpoint:endpoint.id,revision:1,overlap_seconds:3600})
    // Receiver still knows only the old secret; the overlap signature works.
    await Promise.all([dispatch(),dispatch()])
    assert.ok((await api('webhooks')).deliveries.every(d=>d.status==='delivered'&&d.attempts===2))
    assert.equal(received.length,log.deliveries.length)
    for(const r of requests.slice(-log.deliveries.length))assert.ok(verify(r.body,r.header,[endpoint.secret],clock))
    const paidRequest=requests.find(r=>JSON.parse(r.body).id===paid.event_id)
    assert.equal(verify(paidRequest.body+'x',paidRequest.header,[endpoint.secret],clock),false)
    assert.equal((await receive(new Request('https://receiver.nectar-app.com/webhooks',{method:'POST',headers:{'nectar-signature':requests.at(-1).header},body:requests.at(-1).body+'x'}))).status,401,'receiving app refuses a forged request before receipt')
    assert.equal(verify(paidRequest.body,paidRequest.header,['synthetic-nectar-forged'],clock),false)
    assert.equal(verify(paidRequest.body,paidRequest.header,[endpoint.secret],clock+301000),false)
    const accepted=received.length
    await api('webhook.replay',{delivery:paid.id});await dispatch()
    assert.equal(received.length,accepted,'manual replay deduplicates by event id')
    assert.equal(JSON.parse(requests.at(-1).body).id,paid.event_id)
    await tick(3601000);secrets=[rotated.secret]
    await api('webhook.replay',{delivery:paid.id});await dispatch()
    assert.equal(requests.at(-1).header.split(',').length,2,'expired old signature is gone')
    assert.ok(verify(requests.at(-1).body,requests.at(-1).header,[rotated.secret],clock))
    assert.equal(verify(requests.at(-1).body,requests.at(-1).header,[endpoint.secret],clock),false)
    await onState({label:'delivered',delivery:paid.id,finance})
    // A permanently refused endpoint remains retryable through the 72-hour boundary.
    online=false;await api('webhook.replay',{delivery:paid.id});await dispatch()
    const failed=(await api('webhooks')).deliveries.find(d=>d.id===paid.id)
    await tick(71*3600000);await dispatch()
    assert.equal((await api(`webhooks/${paid.id}`)).status,'pending')
    await tick(3600000);await dispatch()
    assert.equal((await api(`webhooks/${paid.id}`)).status,'exhausted')
    assert.equal(failed.deadline-failed.updated_at,259200000)
    await api('webhook.disable',{endpoint:endpoint.id})
    await api('webhook.replay',{delivery:paid.id},409)
    const count=requests.length;await api('customer.update',{customer,name:'Changed after disabling',billing_email:'webhook@example.test',revision:(await api(`customers/${customer}`)).revision})
    await dispatch();assert.equal(requests.length,count)
    // Each new failed delivery keeps the provider's actual outcome, never mailbox delivery.
    await api('webhook.register',{url:'https://receiver.nectar-app.com/webhooks',consent:true})
    for(const [status,outcome]of [[400,'rejected'],[500,'uncertain']]){
      h.mailResponses.push({status,body:{name:'synthetic-nectar-refusal'}})
      const created=await api('customer.create',{external_id:`synthetic-nectar-webhook-mail-${status}`,name:'Failure custody',billing_email:'custody@example.test'})
      await dispatch()
      const event=(await api('webhooks')).deliveries.find(d=>d.subject===created.id)
      const notice=(await h.api('notifications',finance)).deliveries.find(d=>d.subject===event.id)
      assert.equal(notice.status,outcome);assert.equal(notice.provider_ref,null)
    }
    const member=(await api('members')).find(m=>m.email==='webhook-finance@example.test')
    await api('access.end',{member:member.id})
    const mailCount=h.mails.length
    await api('customer.create',{external_id:'synthetic-nectar-webhook-revoked',name:'Revoked recipient',billing_email:'revoked@example.test'})
    await dispatch();assert.equal(h.mails.length,mailCount,'removed authority and unsuccessful sends are not retried')
    assert.ok(JSON.parse(await readFile(join(directory,'receipts.json'),'utf8'))[paid.event_id])
    console.log('webhooksFlow: consent, atomic snapshots, retries, receiver HMAC/dedupe, rotation, replay and authorized failure custody passed')
    return {customer,subscription,invoice,delivery:paid.id}
  }finally{await rm(directory,{recursive:true,force:true})}
}

// DEV-001: existing native lifecycle doors, dated changes and current quota
// thresholds produce received, signed typed facts without private narratives.
export async function webhookLifecycleFlow(h,owner,{onState=async()=>{}}={}) {
  const api=(path,body,status)=>h.api(path,owner,body,status)
  directory=await mkdtemp(join(tmpdir(),'nectar-lifecycle-receiver-'))
  clock=Date.parse('2026-10-22T10:00:00Z');await h.advanceClock(new Date(clock).toISOString())
  online=true;requests=[];received=[]
  try{
    const endpoint=await api('webhook.register',{url:'https://receiver.nectar-app.com/webhooks',consent:true});secrets=[endpoint.secret]
    receive=receiver({secrets:()=>secrets,stateFile:join(directory,'receipts.json'),clock:()=>clock,onEvent:async e=>received.push(e)})
    const customer=(await api('customer.create',{external_id:'synthetic-nectar-webhook-lifecycle',name:'Lifecycle account',billing_email:'lifecycle@example.test'})).id
    const product=(await api('product.create',{code:'synthetic-nectar-webhook-lifecycle',name:'Lifecycle service'})).id
    const price=(await api('price.create',{product,kind:'flat',unit_amount:'100',taxable:false})).id
    for(const [kind,record]of [['customer',customer],['price',price]])await api('metadata.write',{kind,record,revision:0,metadata:{app_account_id:`synthetic-nectar-${kind}`}})
    const subscription=(await api('subscription.create',{customer,start_date:'2026-10-01',price:[price]})).id
    const created=(await api('webhooks')).deliveries.find(d=>d.type==='subscription.created')
    const payload=JSON.parse((await api(`webhooks/${created.id}`)).event.payload_json)
    assert.equal(payload.metadata.find(m=>m.kind==='prices').objects[0].metadata.app_account_id,'synthetic-nectar-price','creation snapshot includes price metadata after item insertion in the same transaction')
    assert.equal(payload.metadata.find(m=>m.kind==='customer').metadata.app_account_id,'synthetic-nectar-customer')
    await api('feature.grant',{product,feature:'api-access',note:'Private feature narrative excluded'})
    const dispatch=async()=>{await api('webhook.dispatch',{});assert.ok(requests.every(r=>verify(r.body,r.header,secrets,JSON.parse(r.header.split(',')[0].slice(2))*1000)))}
    // Row events use their wall clock; advance the disposable clock beyond it.
    clock=Math.max(clock,Date.now()+60000);await h.advanceClock(new Date(clock).toISOString());await dispatch()
    const entitlementEvents=()=>received.filter(e=>e.type==='entitlements.updated'&&e.data.customer_id===customer)
    assert.equal(entitlementEvents().at(-1).data.features.find(f=>f.feature==='api-access').allowed,true)
    const date=new Date(clock).toISOString().slice(0,10)
    const tomorrow=new Date(Date.parse(date)+86400000).toISOString().slice(0,10),resume=new Date(Date.parse(date)+3*86400000).toISOString().slice(0,10)
    const sub=await api(`subscriptions/${subscription}`)
    await api('subscription.pause',{subscription,revision:sub.revision,effective_date:tomorrow,resume_date:resume,access:'suspend',reason:'Private lifecycle narrative excluded'})
    await dispatch()
    assert.ok((await api('webhooks')).deliveries.some(d=>d.type==='subscription.lifecycle_changed'))
    clock=Date.parse(tomorrow+'T12:00:00Z');await h.advanceClock(new Date(clock).toISOString());await dispatch()
    assert.equal(entitlementEvents().at(-1).data.features[0].allowed,false,'a dated pause emits the actual changed entitlement without another domain write')
    await onState({label:'entitlements-paused'})
    const pausedCount=entitlementEvents().length;await dispatch();assert.equal(entitlementEvents().length,pausedCount,'unchanged state does not duplicate the event')
    clock=Date.parse(resume+'T12:00:00Z');await h.advanceClock(new Date(clock).toISOString());await dispatch()
    assert.equal(entitlementEvents().at(-1).data.features[0].allowed,true,'dated resume emits restored access')
    const charge=(await api('charge.add',{customer,amount:'50',description:'Lifecycle payment fixture',effective_date:date,taxable:false})).charge
    const invoice=(await api('invoice.manual',{customer,charges:[charge],service_date:date})).id
    await api('invoice.approve',{invoice,acknowledge:true});await api('invoice.finalise',{invoice,issue_date:date})
    await api('collection.customer.bind',{customer,account_ref:'synthetic-nectar-native-account-1',stripe_customer_ref:'synthetic-nectar-native-customer-1',confirm:true})
    const collection=await api('collection.prepare',{invoice});lifecycleEdge.refuseNext('card_declined')
    await api('collection.confirm',collection.instructions.confirm)
    await api('credit.issue',{invoice,amount:'10',reason:'Private credit narrative excluded'})
    const payment=(await api('payment.record',{customer,amount:'40',received_on:date,method:'bank_transfer',reference:'synthetic-nectar-lifecycle-settlement'})).payment
    await api('payment.allocate',{payment,invoice,amount:'40'})
    clock=Math.max(clock,Date.now()+60000);await h.advanceClock(new Date(clock).toISOString());await dispatch()
    assert.ok(received.some(e=>e.type==='payment_method.observed'&&e.data.payment_method_ref==='synthetic-nectar-native-card-1'))
    assert.ok(received.some(e=>e.type==='payment.failed'&&e.data.status==='declined'))
    assert.equal(received.filter(e=>e.type==='invoice.paid'&&e.data.invoice_id===invoice).length,1)
    await dispatch();assert.equal(received.filter(e=>e.type==='invoice.paid'&&e.data.invoice_id===invoice).length,1)
    await onState({label:'payment-failed-and-settled'})
    assert.ok(!JSON.stringify(received).includes('Private lifecycle narrative'))
    assert.ok(!JSON.stringify(received).includes('Private credit narrative'))
    assert.ok(!JSON.stringify(received).includes('Private feature narrative'))
    // Existing governed ENT-002 quota crossing has one threshold event.
    const qc=(await api('customer.create',{external_id:'synthetic-nectar-webhook-quota',name:'Quota account',billing_email:'quota@example.test'})).id
    const meter=(await api('meter.create',{code:'synthetic-nectar-webhook-quota',name:'Quota calls',unit_label:'calls'})).id
    const qp=(await api('product.create',{code:'synthetic-nectar-webhook-quota',name:'Quota service'})).id
    const priceQ=(await api('price.create',{product:qp,kind:'unit',unit_amount:'1',meter,taxable:false})).id
    await api('feature.grant',{product:qp,feature:'quota-api'})
    await api('subscription.create',{customer:qc,start_date:'2026-10-01',price:[priceQ]})
    await applyPolicy(h,owner,'feature.policy',{product:qp,feature:'quota-api',meter,quota:'10',quota_policy:'hard'})
    await dispatch()
    await api('usage.submit',{events:[{event_id:'synthetic-nectar-webhook-quota-1',customer:'synthetic-nectar-webhook-quota',meter:'synthetic-nectar-webhook-quota',quantity:'10',occurred_at:new Date(clock).toISOString()}]})
    await dispatch()
    const crossed=received.filter(e=>e.type==='usage.threshold_crossed'&&e.data.customer_id===qc)
    assert.equal(crossed.length,1);assert.equal(crossed[0].data.quota.limit,'10.00');assert.equal(crossed[0].data.quota.used,'10')
    assert.equal(crossed[0].data.quota.eventIds,undefined,'threshold payload does not expose a raw event list')
    await dispatch();assert.equal(received.filter(e=>e.type==='usage.threshold_crossed'&&e.data.customer_id===qc).length,1)
    await onState({label:'quota-crossing',delivery:(await api('webhooks')).deliveries.find(d=>d.type==='usage.threshold_crossed').id})
    console.log('webhookLifecycleFlow: complete native creation metadata, dated entitlements, quota crossings, observed cards, payment failure and once-only settlement passed')
  }finally{await rm(directory,{recursive:true,force:true})}
}
