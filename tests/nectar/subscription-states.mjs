// Real scheduled Worker and public business doors; Stripe alone is simulated.
import assert from 'node:assert/strict'
import { nativeCollectionEdge } from './native-collection.mjs'
import { totp } from './mfa.mjs'
import { verify } from '../../examples/webhook-receiver/server.mjs'
let edge,secret,received=[]
export const harnessOptions=()=>{
 edge=nativeCollectionEdge();received=[]
 return {assets:true,localTime:'2026-08-30T10:00:00Z',stripeFetch:edge.fetch,stripeSecret:'synthetic-nectar-1',webhookFetch:async request=>{
  const text=await request.text()
  assert.ok(verify(text,request.headers.get('nectar-signature'),[secret],instant))
  received.push(JSON.parse(text));return new Response(null,{status:204})
 }}
}
let instant
export async function subscriptionStatesFlow(h,owner,{onState=async()=>{}}={}) {
 const api=(path,body,status)=>h.api(path,owner,body,status)
 instant=Date.parse('2026-08-30T10:00:00Z')
 await api('business.configure',{...await api('business'),timezone:'UTC'})
 const factor=await api('mfa.totp.start',{})
 const move=async value=>{instant=Date.parse(value);await h.advanceClock(value);edge.capturedAt(value);await api('mfa.verify',{code:totp(factor.secret,instant)})}
 await api('mfa.totp.confirm',{factor:factor.factor,code:totp(factor.secret,instant)})
 secret=(await api('webhook.register',{url:'https://receiver.nectar-app.com/states',consent:true})).secret
 const customer=(await api('customer.create',{external_id:'synthetic-nectar-state-1',name:'Synthetic state customer',billing_email:'states@example.test'})).id
 const other=(await api('customer.create',{external_id:'synthetic-nectar-state-2',name:'Synthetic isolated customer',billing_email:'other-states@example.test'})).id
 await api('collection.customer.bind',{customer,account_ref:'synthetic-nectar-native-account-1',stripe_customer_ref:'synthetic-nectar-native-customer-1',confirm:true})
 const product=(await api('product.create',{code:'synthetic-nectar-state-1',name:'Synthetic state service'})).id
 const price=(await api('price.create',{product,kind:'flat',unit_amount:'100',taxable:false})).id
 const subscription=(await api('subscription.create',{customer,start_date:'2026-08-30',anchor_day:1,trial_end:'2026-09-01',trial_payment:'card',price:[price]})).id
 const foreign=(await api('subscription.create',{customer:other,start_date:'2026-08-30',anchor_day:1,price:[price]})).id
 const read=async id=>(await api(`subscriptions/${id??subscription}`)).stateHistory
 const tick=async()=>{const response=await h.raw(`/cdn-cgi/local/scheduled?time=${instant}&cron=${encodeURIComponent('* * * * *')}`);assert.equal(response.status,200,await response.text())}
 const expected=[],frozen=[]
 const observe=async(state,kind)=>{
  await tick();expected.push(state)
  const history=await read()
  assert.deepEqual(history.map(row=>row.state),expected)
  assert.equal(history.at(-1).previous_state,expected.at(-2)??null)
  assert.equal(history.at(-1).cause.kind,kind)
  assert.equal(history.at(-1).cause.day,new Date(instant).toISOString().slice(0,10))
  assert.deepEqual(history.slice(0,-1),frozen)
  frozen.push(history.at(-1))
  const events=received.filter(event=>event.type==='subscription.updated'&&event.data.transition_id&&event.data.id===subscription)
  assert.deepEqual(events.map(event=>event.data.state),expected)
  assert.deepEqual(events.map(event=>event.data.transition_id),history.map(row=>row.id))
  assert.deepEqual(events.map(event=>event.data.cause),history.map(row=>row.cause))
  assert.equal(new Set(events.map(event=>event.id)).size,expected.length)
  await Promise.all([tick(),tick()]);assert.deepEqual(await read(),history)
  assert.equal(received.filter(event=>event.data.transition_id&&event.data.id===subscription).length,expected.length)
  await onState({state,subscription,history})
 }
 assert.deepEqual(await read(),[],'Reads cannot manufacture lifecycle history')
 await h.rejectAudit('subscription.state.observe')
 const failed=await h.raw(`/cdn-cgi/local/scheduled?time=${instant}&cron=${encodeURIComponent('* * * * *')}`)
 assert.equal(failed.status,500);assert.deepEqual(await read(),[],'Audit failure rolls back the state and event together')
 await h.rejectAudit()
 await observe('trialing','schedule_or_lifecycle')
 await move('2026-09-01T10:00:00Z');await observe('active','schedule_or_lifecycle')
 assert.equal((await h.raw(`/cdn-cgi/local/scheduled?time=${instant}&cron=${encodeURIComponent('0 14 * * *')}`)).status,200)
 await move('2026-10-22T10:00:00Z')
 const run=await api('billrun.prepare',{period:'2026-09'})
 const invoice=(await api(`runs/${run.id}`)).invoices.find(row=>row.subscription_id===subscription).id
 await api('portal.configure',{hosts:[h.origin],parents:[]})
 const prepared=await api('automatic.collection.prepare',{invoice,issue_date:'2026-10-22'})
 const session=await api('portal.session.issue',{customer,origin:h.origin,audience:'hosted'})
 assert.equal((await h.raw(`/portal/automatic-collections/${prepared.id}?session=${encodeURIComponent(session.token)}`,{body:{request:prepared.id,basis_hash:prepared.basis,accept:true}})).status,200)
 await api('automatic.collection.decide',{request:prepared.id,basis_hash:prepared.basis,decision:'approved',confirm:true,confirm_single:true})
 await api('invoice.approve',{invoice,acknowledge:true})
 edge.refuseNext('card_declined')
 await api('invoice.finalise',{invoice,issue_date:'2026-10-22'})
 await observe('past_due','payment_failed_or_overdue')
 assert.equal((await read()).at(-1).cause.payment.invoices[0].balanceCents,10000)
 assert.equal((await read()).at(-1).cause.payment.failures.length,1)
 const policy=await api('dunning.policy.create',{name:'Synthetic unpaid policy',scope:'default',scope_ref:'',offsets:'21',end_day:21,end_action:'mark_unpaid',confirm:true})
 const series=await api('dunning.enroll',{invoice,policy:policy.id,confirm:true})
 await api('dunning.end',{series:series.id,action:'mark_unpaid',confirm:true},409)
 await move('2026-11-12T10:00:00Z')
 await api('dunning.end',{series:series.id,action:'mark_unpaid',confirm:true})
 await observe('unpaid','dunning_unpaid')
 assert.deepEqual((await read()).at(-1).cause.dunning.map(row=>({id:row.id,status:row.status})),[{id:series.id,status:'mark_unpaid'}])
 const payment=await api('payment.record',{customer,amount:'100',received_on:'2026-11-12',method:'bank_transfer',reference:'synthetic-nectar-state-1'})
 await tick();assert.deepEqual(await read(),frozen,'Unallocated funds cannot restore the state')
 await api('payment.allocate',{payment:payment.payment,invoice,amount:'100'})
 await observe('active','obligations_cleared')
 assert.deepEqual((await read()).at(-1).cause.allocations.map(row=>({invoice:row.invoice_id,payment:row.payment_id,amount:row.amount_cents})),[{invoice,payment:payment.payment,amount:10000}])
 await api('subscription.pause',{subscription,revision:(await api(`subscriptions/${subscription}`)).revision,effective_date:'2026-11-13',resume_date:'2026-11-14',access:'suspend',reason:'Scheduled pause'})
 await move('2026-11-13T10:00:00Z');await observe('paused','schedule_or_lifecycle')
 await move('2026-11-14T10:00:00Z');await observe('active','schedule_or_lifecycle')
 await api('subscription.cancel',{subscription,revision:(await api(`subscriptions/${subscription}`)).revision,mode:'immediate',effective_date:'2026-11-15',reason:'Recorded end'})
 await move('2026-11-15T10:00:00Z');await observe('ended','schedule_or_lifecycle')
 assert.deepEqual((await read(foreign)).map(row=>row.state),['active'])
 assert.equal((await api(`invoices/${invoice}`)).balanceCents,0)
 await h.api(`subscriptions/${subscription}`,undefined,undefined,401)
 await api('access.give',{email:'state-reader@example.test',name:'State reader',role:'accountant'})
 const reader=await h.signIn('state-reader@example.test',{requested:true})
 const visible=(await h.api(`subscriptions/${subscription}`,reader)).stateHistory
 assert.deepEqual(visible.map(row=>row.state),expected)
 assert.ok(visible.every(row=>Object.keys(row.cause).sort().join(',')==='day,kind'),'Financial cause sources stay owner-only')
 assert.ok(!JSON.stringify(visible).includes(invoice))
 await api('access.give',{email:'state-sales@example.test',name:'State sales',role:'sales'})
 const sales=await h.signIn('state-sales@example.test',{requested:true})
 assert.equal((await h.api(`subscriptions/${subscription}`,sales)).stateHistory,null,'A subscription reader without billing access cannot read payment-derived states')
 await onState({state:'restricted-reader',subscription,actor:sales})
 console.log('subscriptionStatesFlow: scheduled trial, active, decline, unpaid, allocated recovery, pause, resume and end; immutable causes, signed per-step events, replay and atomic audit rollback')
}
