import { nativeCollectionEdge } from './native-collection.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { receiver, verify } from '../../examples/webhook-receiver/server.mjs'

const lifecycleEdge=nativeCollectionEdge()

let stripeEvents=new Map(),stripeEventRequests=[],stripeCustomerDeleted=false

let receive,online=false,clock=Date.now(),secrets=[],requests=[],received=[],directory

export const harnessOptions=()=>({stripeFetch:async request=>{
  const url=new URL(request.url)
  if(url.pathname.startsWith('/v1/events/')){stripeEventRequests.push({method:request.method,path:url.pathname});const event=stripeEvents.get(url.pathname.split('/').pop());return event?Response.json(event):Response.json({error:{code:'resource_missing'}},{status:404})}
  if(url.pathname==='/v1/customers/cus_NcAtlasFreight01')return Response.json(stripeCustomerDeleted?{id:'cus_NcAtlasFreight01',object:'customer',deleted:true}:{id:'cus_NcAtlasFreight01',object:'customer',livemode:false})
  return lifecycleEdge.fetch(request)
},stripeSecret:'synthetic-nectar-1',webhookFetch:async request=>{
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
    await h.page(`/app/webhooks/${paid.id}`,finance)
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
    // Existing GOV-001 explicitly assigns webhook administration to developers.
    await api('access.give',{email:'webhook-developer@example.test',name:'Webhook developer',role:'developer'})
    const developer=await h.signIn('webhook-developer@example.test',{requested:true})
    await h.api('notification.preferences',developer,{webhook_failure:true})
    const managed=await h.api('webhook.register',developer,{url:'https://developer.nectar-app.com/events',consent:true})
    assert.ok(managed.secret);await h.page('/app/webhooks',developer)
    const newKey=await h.api('webhook.rotate',developer,{endpoint:managed.id,revision:1,overlap_seconds:0});assert.ok(newKey.secret)
    await h.api('webhooks',developer)
    const newCustomer=await api('customer.create',{external_id:'synthetic-nectar-webhook-developer',name:'Developer monitor',billing_email:'developer-monitor@example.test'})
    await h.api('webhook.dispatch',developer,{})
    const managedDelivery=(await h.api('webhooks',developer)).deliveries.find(d=>d.endpoint_id===managed.id&&d.subject===newCustomer.id)
    assert.ok((await h.api('notifications',developer)).deliveries.some(d=>d.subject===managedDelivery.id&&d.status==='accepted'))
    await h.api('webhook.replay',developer,{delivery:managedDelivery.id})
    await h.api('webhook.disable',developer,{endpoint:managed.id})
    await h.api('credit.issue',developer,{},403)
    await onState({label:'developer-admin',delivery:managedDelivery.id,finance:developer})
    const deactivated=(await api('members')).find(m=>m.email==='webhook-developer@example.test')
    await api('access.end',{member:deactivated.id})
    await h.api('webhooks',developer,undefined,401)
    await api('access.give',{email:'webhook-developer@example.test',name:'Former webhook developer',role:'accountant'})
    const formerDeveloper=await h.signIn('webhook-developer@example.test')
    await h.api('webhooks',formerDeveloper,undefined,403);await h.api('webhook.register',formerDeveloper,{},403)
    const beforeRevoked=h.mails.length
    await api('customer.create',{external_id:'synthetic-nectar-webhook-developer-revoked',name:'Revoked developer',billing_email:'revoked-developer@example.test'})
    await dispatch();assert.equal(h.mails.length,beforeRevoked,'removing developer authority stops the next failure alert')
    console.log('webhooksFlow: consent, atomic snapshots, retries, receiver HMAC/dedupe, rotation, replay and authorized failure custody passed')
    return {customer,subscription,invoice,delivery:paid.id}
  }finally{await rm(directory,{recursive:true,force:true})}
}
