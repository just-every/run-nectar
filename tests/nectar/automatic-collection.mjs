// Public Worker and D1 flow. Only the Stripe network edge controls settlement.
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { nativeCollectionEdge } from './native-collection.mjs'
import { totp } from './mfa.mjs'
import { file } from './harness.mjs'

export function automaticEdge(){
 const base=nativeCollectionEdge(),bankCustomer='synthetic-nectar-native-customer-3',bankMethod='synthetic-nectar-automatic-bank-1',mandate='synthetic-nectar-automatic-mandate-1'
 base.customers.get(bankCustomer).method=bankMethod
 let available=false
 const events=new Map()
 const fetch=async request=>{
  const url=new URL(request.url),path=url.pathname
  if(path===`/v1/payment_methods/${bankMethod}`)return Response.json({object:'payment_method',id:bankMethod,type:'us_bank_account',customer:bankCustomer,livemode:false,us_bank_account:{bank_name:'Synthetic Community Bank',last4:'6789',account_type:'checking'}})
  if(path===`/v1/mandates/${mandate}`)return Response.json({object:'mandate',id:mandate,status:'active',type:'multi_use',livemode:false,payment_method:bankMethod})
  if(path.startsWith('/v1/events/'))return Response.json(events.get(path.split('/').at(-1))??{},{status:events.has(path.split('/').at(-1))?200:404})
  if(path.startsWith('/v1/charges/'))return Response.json([...base.charges.values()].find(row=>row.value.id===path.split('/').at(-1))?.value??{},{status:200})
  if(path.startsWith('/v1/balance_transactions/'))return Response.json({object:'balance_transaction',id:path.split('/').at(-1),type:'payment',status:available?'available':'pending',source:[...base.charges.values()].find(row=>row.value.payment_method===bankMethod)?.value.id,amount:10000,currency:'usd',available_on:Date.parse('2026-10-28T10:00:00Z')/1000})
  const response=await base.fetch(request)
  if(path==='/v1/payment_intents'&&request.method==='POST'&&response.ok){
   const intent=await response.json()
   if(intent.payment_method===bankMethod){
    const charge=base.charges.get(intent.latest_charge).value;charge.balance_transaction='synthetic-nectar-automatic-balance-1'
    Object.assign(intent,{status:'processing',amount_received:0});Object.assign(base.intents.get(intent.id).value,intent)
   }
   events.set(`synthetic-nectar-automatic-event-${base.intents.size}`,{object:'event',id:`synthetic-nectar-automatic-event-${base.intents.size}`,type:intent.status==='processing'?'payment_intent.processing':'payment_intent.succeeded',livemode:false,data:{object:structuredClone(intent)}})
   return Response.json(intent)
  }
  return response
 }
 return {...base,fetch,mandate,events,returnLastBank(){const intent=[...base.intents.values()].filter(row=>row.value.payment_method===bankMethod).at(-1).value;const charge=base.charges.get(intent.latest_charge).value;intent.status='requires_payment_method';intent.payment_method=null;intent.amount_received=0;intent.last_payment_error={code:'insufficient_funds',payment_method:{id:bankMethod}};charge.status='failed';charge.paid=false},settle(){available=true;for(const row of base.intents.values())if(row.value.payment_method===bankMethod&&row.value.status==='processing'){row.value.status='succeeded';row.value.amount_received=row.value.amount}},posts:()=>base.calls.filter(call=>call.path==='/payment_intents'&&call.method==='POST').length}
}
const webhookSecret='synthetic-nectar-payment-event-secret'
let edge
export const harnessOptions=()=>{edge=automaticEdge();return {localTime:'2026-10-22T10:00:00Z',stripeFetch:edge.fetch,stripeSecret:'synthetic-nectar-1',stripeSecondarySecret:'synthetic-nectar-2',stripeWebhookSecret:webhookSecret}}
export async function automaticCollectionFlow(h,owner,{onState=async()=>{},prepareCollection,acceptCollection,decideCollection}={}){
 const api=(path,body,status)=>h.api(path,owner,body,status)
 await api('business.configure',{...await api('business'),timezone:'UTC'})
 let instant=Date.parse('2026-10-22T10:00:00Z');await h.advanceClock(new Date(instant).toISOString())
 const factor=await api('mfa.totp.start',{});await api('mfa.totp.confirm',{factor:factor.factor,code:totp(factor.secret,instant)});await api('mfa.policy',{scope:'all'})
 const customers=[]
 for(const [n,language] of [[1,'en'],[3,'es-US'],[4,'en']]){
  const customer=(await api('customer.create',{external_id:`synthetic-nectar-automatic-${n}`,name:`Automatic customer ${n}`,billing_email:`automatic-${n}@example.test`,language})).id
  customers.push(customer)
  await api('collection.customer.bind',{customer,account_ref:'synthetic-nectar-native-account-1',stripe_customer_ref:`synthetic-nectar-native-customer-${n}`,confirm:true})
 }
 await api('portal.configure',{hosts:[h.origin],parents:[]})
 const session=async customer=>api('portal.session.issue',{customer,origin:h.origin,audience:'hosted'})
 const draft=async customer=>{
  const charge=await api('charge.add',{customer,amount:'100',description:'Automatic invoice service',effective_date:'2026-10-22',taxable:false})
  return (await api('invoice.manual',{customer,charges:[charge.charge],service_date:'2026-10-22'})).id
 }
 const approve=async(id,options={})=>{
  const prepared=await (prepareCollection??(input=>api('automatic.collection.prepare',input)))({invoice:id,issue_date:'2026-10-22',...options}),customer=prepared.customer,s=await session(customer)
  await onState({state:'awaiting_customer',invoice:id,customer,session:s,request:prepared})
  const target=`/portal/automatic-collections/${prepared.id}?session=${encodeURIComponent(s.token)}`
  assert.equal((await h.raw(`/portal/automatic-collections/${prepared.id}`,{body:{request:prepared.id,basis_hash:prepared.basis,accept:true}})).status,401)
  const before=edge.posts()
  const page=await h.raw(target);assert.equal(page.status,200);assert.ok((await page.text()).includes(prepared.quote.wording.replaceAll('&','&amp;')))
  assert.equal(edge.posts(),before,'Reading the customer authorization cannot debit')
  await h.raw(`/portal/automatic-collections/${prepared.id}?session=${encodeURIComponent((await session(customers.find(c=>c!==customer))).token)}`,{body:{request:prepared.id,basis_hash:prepared.basis,accept:true}}).then(r=>assert.equal(r.status,404))
  if(acceptCollection)await acceptCollection({target,prepared})
  else assert.equal((await h.raw(target,{body:{request:prepared.id,basis_hash:prepared.basis,accept:true}})).status,200)
  await api('automatic.collection.decide',{request:prepared.id,basis_hash:prepared.basis,decision:'approved',confirm:true},409)
  const active=await (decideCollection??(input=>api('automatic.collection.decide',input)))({request:prepared.id,basis_hash:prepared.basis,decision:'approved',confirm:true,confirm_single:true})
  assert.equal(active.approvalMode,'single-approver');assert.equal(edge.posts(),before)
  await onState({state:'active',invoice:id,customer,session:s,request:active})
  return {prepared,s}
 }
 const card=await draft(customers[0]),bank=await draft(customers[1]),send=await draft(customers[2]),cardAuth=await approve(card),bankAuth=await approve(bank,{mandate_ref:edge.mandate})
 for(const invoice of [card,bank,send]){await api('invoice.approve',{invoice,acknowledge:true});await api('invoice.finalise',{invoice,issue_date:'2026-10-22'})}
 assert.equal(edge.posts(),2,'Issue charges only explicitly authorized invoices')
 const cardView=await api(`invoices/${card}`),bankView=await api(`invoices/${bank}`),sendView=await api(`invoices/${send}`)
 assert.equal(cardView.paidCents,10000);assert.equal(cardView.balanceCents,0)
 assert.equal(bankView.paidCents,0);assert.equal(bankView.balanceCents,10000);assert.equal(sendView.paidCents,0)
 let rows=await api('automatic-collections');assert.equal(rows.find(r=>r.invoice===bank).status,'pending_settlement')
 await onState({state:'collected',invoice:card,customer:customers[0],session:cardAuth.s,request:rows.find(r=>r.invoice===card)})
 const bankBeforeVoid=await api('invoices/'+bank),bankPosts=edge.posts()
 for(const action of ['invoice.void.prepare','invoice.void'])assert.equal((await api(action,{invoice:bank,basis:bankBeforeVoid.source_fingerprint,reason:'Synthetic pending settlement correction',confirm:true},409)).error,'invoice_collection_unresolved')
 assert.deepEqual(await api('invoices/'+bank),bankBeforeVoid)
 assert.equal(edge.posts(),bankPosts,'Pending settlement void refusal sends no provider writes')
 await onState({state:'pending_settlement',invoice:bank,customer:customers[1],session:bankAuth.s,request:rows.find(r=>r.invoice===bank)})
 for(const invoice of [card,bank]){await api('invoice.finalise',{invoice},409);await api('collection.prepare',{invoice},409)}
 const cardRequest=rows.find(r=>r.invoice===card),bankRequest=rows.find(r=>r.invoice===bank)
 await api('automatic.collection.event',{request:cardRequest.id,event_ref:'synthetic-nectar-automatic-event-1'})
 assert.equal((await api('automatic.collection.event',{request:cardRequest.id,event_ref:'synthetic-nectar-automatic-event-1'})).replayed,true)
 await api('automatic.collection.event',{request:bankRequest.id,event_ref:'synthetic-nectar-automatic-event-2'})
 assert.equal((await api('invoices/'+bank)).paidCents,0)
 await api('automatic.collection.reconcile',{request:bankRequest.id});assert.equal(edge.posts(),2)
 const withdrawn=await draft(customers[2]),withdrawal=await api('automatic.collection.prepare',{invoice:withdrawn,issue_date:'2026-10-22'}),withdrawalSession=await session(customers[2])
 const withdrawalPath=`/portal/automatic-collections/${withdrawal.id}?session=${encodeURIComponent(withdrawalSession.token)}`
 assert.equal((await h.raw(withdrawalPath,{body:{request:withdrawal.id,withdraw:true}})).status,200)
 await api('invoice.approve',{invoice:withdrawn,acknowledge:true});await api('invoice.finalise',{invoice:withdrawn,issue_date:'2026-10-22'})
 assert.equal(edge.posts(),2,'Customer withdrawal leaves invoice owed without a provider write')
 await onState({state:'revoked',invoice:withdrawn,customer:customers[2],session:withdrawalSession,request:(await api('automatic-collections')).find(row=>row.id===withdrawal.id)})
 const uncertain=await draft(customers[2]);const unknown=await approve(uncertain)
 edge.losePayment();await api('invoice.approve',{invoice:uncertain,acknowledge:true});await api('invoice.finalise',{invoice:uncertain,issue_date:'2026-10-22'})
 assert.equal((await api('automatic-collections')).find(r=>r.invoice===uncertain).status,'uncertain');assert.equal(edge.posts(),3)
 const uncertainBeforeVoid=await api('invoices/'+uncertain)
 for(const action of ['invoice.void.prepare','invoice.void'])assert.equal((await api(action,{invoice:uncertain,basis:uncertainBeforeVoid.source_fingerprint,reason:'Synthetic uncertain automatic capture correction',confirm:true},409)).error,'invoice_collection_unresolved')
 assert.deepEqual(await api('invoices/'+uncertain),uncertainBeforeVoid)
 assert.equal(edge.posts(),3,'An uncertain automatic capture cannot be replaced by another provider write')
 await onState({state:'uncertain',invoice:uncertain,customer:customers[2],session:unknown.s,request:(await api('automatic-collections')).find(row=>row.id===unknown.prepared.id)})
 const paymentEvent=structuredClone(edge.events.get('synthetic-nectar-automatic-event-3'))
 const deliver=async(event,{status=200,secret=webhookSecret,time=Math.floor(instant/1000)}={})=>{
  const text=JSON.stringify(event),signature=createHmac('sha256',secret).update(`${time}.${text}`).digest('hex')
  const response=await h.raw('/api/nectar/stripe/payment-events',{form:text,headers:{'content-type':'application/json','stripe-signature':`t=${time},v1=${signature}`}})
  const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value
 }
 await deliver(paymentEvent,{secret:'synthetic-nectar-unrelated-secret',status:401})
 await deliver(paymentEvent,{time:Math.floor(instant/1000)-301,status:401})
 await deliver({...paymentEvent,livemode:true},{status:400})
 await deliver({...paymentEvent,account:'synthetic-nectar-native-account-2'},{status:409})
 await deliver({...paymentEvent,data:{object:{...paymentEvent.data.object,customer:'synthetic-nectar-unbound-customer'}}},{status:409})
 assert.equal((await api('invoices/'+uncertain)).paidCents,0,'Refused delivery cannot publish cash')
 const mismatch={...paymentEvent,id:'synthetic-nectar-foreign-provider-event'}
 edge.events.set(mismatch.id,{...mismatch,data:{object:{...paymentEvent.data.object,customer:'synthetic-nectar-unbound-customer'}}})
 await deliver(mismatch,{status:409})
 const observed=await Promise.all([deliver(paymentEvent),deliver(paymentEvent)])
 assert.deepEqual(observed.map(value=>value.replayed).sort(),[false,true])
 assert.ok(observed.every(value=>value.status==='collected'))
 const reconciledInvoice=await api('invoices/'+uncertain)
 assert.equal(reconciledInvoice.paidCents,10000);assert.equal(reconciledInvoice.allocations.length,1)
 const auditAfterDelivery=await api('audit')
 assert.deepEqual(await deliver(paymentEvent),{received:true,replayed:true,status:'collected'})
 assert.deepEqual(await api('audit'),auditAfterDelivery,'Duplicate event creates no financial or audit write')
 assert.equal(edge.posts(),3,'Signed recovery reads the provider without another charge')
 // Four business days: Thu issue, Friday, Monday, Tuesday and Wednesday settlement. Only provider facts settle cash.
 instant=Date.parse('2026-10-28T10:00:00Z');await h.advanceClock(new Date(instant).toISOString());edge.settle()
 assert.equal((await h.raw(`/cdn-cgi/local/scheduled?time=${instant}&cron=${encodeURIComponent('* * * * *')}`)).status,200)
 await api('mfa.verify',{code:totp(factor.secret,instant)})
 rows=await api('automatic-collections');const settled=rows.find(r=>r.invoice===bank)
 assert.equal(settled.status,'collected');assert.equal(settled.settledAt,instant);assert.equal(edge.posts(),3)
 const settledInvoice=await api('invoices/'+bank);assert.equal(settledInvoice.paidCents,10000);assert.equal(settledInvoice.allocations.length,1)
 const currentEvent=structuredClone(edge.events.get('synthetic-nectar-automatic-event-2'));currentEvent.id='synthetic-nectar-automatic-event-3';currentEvent.type='payment_intent.succeeded';currentEvent.data.object.status='succeeded';edge.events.set(currentEvent.id,currentEvent)
 for(const event of ['synthetic-nectar-automatic-event-3','synthetic-nectar-automatic-event-2','synthetic-nectar-automatic-event-3'])await api('automatic.collection.event',{request:settled.id,event_ref:event})
 assert.equal((await api('invoices/'+bank)).allocations.length,1);assert.equal(edge.posts(),3)
 await onState({state:'collected',invoice:bank,customer:customers[1],session:await session(customers[1]),request:settled})
 for(const [customer,invoice,request] of [[customers[0],card,cardRequest],[customers[1],bank,settled]]){
  const record=await api('customers/'+customer),source=record.billingRecord.automaticCollections.find(r=>r.id===request.id)
  assert.equal(source.paymentIntentRef,request.paymentIntentRef);assert.equal(source.payment,request.payment);assert.equal(source.amountCents,10000)
  assert.equal(record.billingRecord.receipts.filter(r=>r.payment===request.payment).length,1)
  assert.ok(record.billingRecord.auditEvents.some(a=>a.subject===request.id))
  assert.equal(record.billingRecord.automaticCollections.every(r=>r.customer===undefined),true)
  assert.ok((await api(`customers?search=${encodeURIComponent(request.paymentIntentRef)}`)).some(c=>c.id===customer))
 }
 await api('hierarchy.configure',{customer:customers[0],parent:customers[2],billing_mode:'separate',revision:0,consent:true})
 const family=await api('customers/'+customers[2]),child=family.childAccounts.find(row=>row.record.id===customers[0]).record
 assert.equal(child.billingRecord.automaticCollections.find(r=>r.id===cardRequest.id).payment,cardRequest.payment)
 assert.equal(child.ledger.paidCents,10000);assert.equal(family.ledger.paidCents,10000,'Parent retains only its own separate invoice payment')
 await onState({state:'child_composition',invoice:card,customer:customers[2],session:await session(customers[0]),request:cardRequest})
 edge.capturedAt(new Date(instant).toISOString())
 const returnedInvoice=await draft(customers[1]),returnAuthorization=await approve(returnedInvoice,{mandate_ref:edge.mandate,issue_date:'2026-10-28'})
 await api('invoice.approve',{invoice:returnedInvoice,acknowledge:true});await api('invoice.finalise',{invoice:returnedInvoice,issue_date:'2026-10-28'})
 edge.returnLastBank();const returned=await api('automatic.collection.reconcile',{request:returnAuthorization.prepared.id})
 assert.equal(returned.status,'returned');assert.equal((await api('invoices/'+returnedInvoice)).paidCents,0)
 await api('automatic.collection.reconcile',{request:returned.id});assert.equal(edge.posts(),4)
 await onState({state:'returned',invoice:returnedInvoice,customer:customers[1],session:returnAuthorization.s,request:returned})
 const full=await api('automatic-collections'),paged=[]
 let next=await api('automatic-collections?limit=2')
 for(let count=0;;count++){
  assert.ok(next.data.length<=2&&count<20);paged.push(...next.data)
  if(!next.next_cursor)break
  next=await api(`automatic-collections?limit=2&cursor=${encodeURIComponent(next.next_cursor)}`)
 }
 assert.deepEqual(paged.map(row=>row.id),full.map(row=>row.id),'Public automatic payment pages include each attempt once')
 const role=await api('role.define',{name:'Automatic customer reader',capabilities:['read.customers']})
 await api('access.give',{email:'automatic-reader@example.test',name:'Customer reader',role:'custom',custom_role:role.id})
 const reader=await h.signIn('automatic-reader@example.test',{requested:true}),readerFactor=await h.api('mfa.totp.start',reader,{})
 await h.api('mfa.totp.confirm',reader,{factor:readerFactor.factor,code:totp(readerFactor.secret,instant)})
 const restricted=await h.api(`customers/${customers[1]}`,reader)
 assert.equal(restricted.billingRecord.automaticCollections,null);assert.equal(restricted.billingRecord.receipts,null)
 assert.ok(restricted.billingRecord.auditEvents.every(event=>event.subject===customers[1]))
 assert.deepEqual(await h.api(`customers?search=${settled.paymentIntentRef}`,reader),[])
 const erased=await api('erasure.request',{customer:customers[1]});await api('erasure.verify',{request:erased.id,reason:'Independently verified test identity',evidence:file('identity.txt','Synthetic independent identity check','text/plain')});await api('erasure.approve',{request:erased.id,confirm:true})
 await api('automatic.collection.reconcile',{request:settled.id},404);assert.equal(edge.posts(),4)
 // A distinct finance member uses Base's native member role and retains exact consent.
 await api('access.give',{email:'synthetic-nectar-finance@example.test',name:'Independent finance',role:'finance'})
 const finance=await h.signIn('synthetic-nectar-finance@example.test',{requested:true}),financeFactor=await h.api('mfa.totp.start',finance,{})
 await h.api('mfa.totp.confirm',finance,{factor:financeFactor.factor,code:totp(financeFactor.secret,instant)})
 const independent=await draft(customers[2]);await api('invoice.approve',{invoice:independent,acknowledge:true})
 const exact=await api('automatic.collection.prepare',{invoice:independent,issue_date:'2026-10-28'}),capability=await session(customers[2])
 assert.equal((await h.raw(`/portal/automatic-collections/${exact.id}?session=${encodeURIComponent(capability.token)}`,{body:{request:exact.id,basis_hash:exact.basis,accept:true}})).status,200)
 await api('automatic.collection.decide',{request:exact.id,basis_hash:exact.basis,decision:'approved',confirm:true,confirm_single:true},409)
 const independentApproval=await h.api('automatic.collection.decide',finance,{request:exact.id,basis_hash:exact.basis,decision:'approved',confirm:true})
 assert.equal(independentApproval.approvalMode,'two-person')
 await api('invoice.finalise',{invoice:independent,issue_date:'2026-10-28'})
 const independentlyCollected=(await api('automatic-collections')).find(row=>row.id===exact.id)
 assert.equal(independentlyCollected.status,'collected');assert.equal(edge.posts(),5)
 assert.equal((await api(`invoices/${independent}`)).balanceCents,0)
 // An original card claim may settle after a definitive earlier refusal.
 // This is an observed provider result, never a new application charge.
 const lateInvoice=await draft(customers[0]),lateAuthority=await approve(lateInvoice,{issue_date:'2026-10-28'})
 edge.refuseNext('processing_error')
 await api('invoice.approve',{invoice:lateInvoice,acknowledge:true});await api('invoice.finalise',{invoice:lateInvoice,issue_date:'2026-10-28'})
 const refused=(await api('automatic-collections')).find(row=>row.id===lateAuthority.prepared.id)
 assert.equal(refused.status,'refused');assert.equal((await api('invoices/'+lateInvoice)).paidCents,0)
 const intent=edge.intents.get(refused.paymentIntentRef).value,method=refused.quote.method.paymentMethodRef
 const charge='synthetic-nectar-late-capture'
 Object.assign(intent,{status:'succeeded',payment_method:method,amount_received:10000,latest_charge:charge});delete intent.last_payment_error
 edge.charges.set(charge,{account:1,value:{object:'charge',id:charge,status:'succeeded',paid:true,captured:true,customer:intent.customer,payment_method:method,payment_intent:intent.id,currency:'usd',amount:10000,amount_captured:10000,amount_refunded:0,refunded:false,disputed:false,created:instant/1000,livemode:false}})
 const recoveredEvent={object:'event',id:'synthetic-nectar-late-recovery-event',type:'payment_intent.succeeded',livemode:false,data:{object:structuredClone(intent)}}
 edge.events.set(recoveredEvent.id,recoveredEvent)
 const beforeRecoveryPosts=edge.posts()
 assert.equal((await deliver(recoveredEvent)).status,'collected')
 const latePaid=await api('invoices/'+lateInvoice)
 assert.equal(latePaid.paidCents,10000);assert.equal(latePaid.balanceCents,0);assert.equal(latePaid.allocations.length,1)
 const oldEvent={object:'event',id:'synthetic-nectar-late-failure-event',type:'payment_intent.payment_failed',livemode:false,data:{object:{...intent,status:'requires_payment_method',amount_received:0}}}
 edge.events.set(oldEvent.id,oldEvent)
 assert.equal((await deliver(oldEvent)).status,'collected','Out-of-order failure cannot undo current captured cash')
 assert.deepEqual(await api('invoices/'+lateInvoice),latePaid)
 assert.equal(edge.posts(),beforeRecoveryPosts,'Late recovery sends no provider write')
 assert.equal((await api('recovery')).invoices.find(row=>row.invoice===lateInvoice).recoveredAmountCents,10000,'Recovery reporting agrees with allocated cash')
 console.log('automaticCollectionFlow: exact consent, approval, immediate card cash, pending ACH and four-business-day edge settlement, send-invoice wait, event and issue replay, once-only uncertainty recovery, source and receipt parity and erasure')
}
