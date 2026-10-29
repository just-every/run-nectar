// Real Worker, D1, owner and customer doors. Only Stripe's network edge is substituted.
import assert from 'node:assert/strict'
import { file } from './harness.mjs'
import { totp } from './mfa.mjs'

export function invoicePartialEdge() {
  const calls=[],sessions=new Map(),intents=new Map(),charges=new Map(),banks=new Map()
  let bankTime=Date.parse('2026-11-28T12:00:00Z'),bankLose=false,cardTime=Date.parse('2026-10-29T12:00:00Z')
  let lose=false,live=false,account='synthetic-nectar-partial-account',wrongProof=false,destination=null
  const list=data=>({object:'list',has_more:false,data})
  const fetch=async request=>{
    assert.equal(request.headers.get('authorization'),'Bearer synthetic-nectar-partial-key')
    const url=new URL(request.url),path=url.pathname.replace('/v1',''),body=request.method==='POST'?new URLSearchParams(await request.text()):null
    calls.push({path,method:request.method,body:body?Object.fromEntries(body):null})
    if(path==='/account')return Response.json({object:'account',id:account})
    if(path.startsWith('/mandates/')){const b=[...banks.values()].find(b=>b.mandateRef===path.split('/').at(-1));return Response.json({...b,object:'mandate',id:b?.mandateRef,status:'active',type:'multi_use',livemode:false,payment_method:b?.paymentMethodRef})}
    if(path.startsWith('/customers/')&&banks.has(path.split('/').at(-1))){const b=banks.get(path.split('/').at(-1));return Response.json({object:'customer',id:b.customerRef,livemode:live,invoice_settings:{default_payment_method:b.paymentMethodRef}})}
    if(path.startsWith('/payment_methods/')&&[...banks.values()].some(b=>b.paymentMethodRef===path.split('/').at(-1))){const b=[...banks.values()].find(b=>b.paymentMethodRef===path.split('/').at(-1));return Response.json({object:'payment_method',id:b.paymentMethodRef,customer:b.customerRef,livemode:false,type:'us_bank_account',us_bank_account:{bank_name:'Synthetic Community Bank',last4:'6789'}})}
    if(path.startsWith('/customers/'))return Response.json({object:'customer',id:path.split('/').at(-1),livemode:live,invoice_settings:{default_payment_method:null}})
    if(path.startsWith('/payment_methods/'))return Response.json({object:'payment_method',id:path.split('/').at(-1),livemode:false,type:'card',customer:null})
    if(path==='/checkout/sessions'&&body){
      for(const key of ['setup_future_usage','payment_intent_data[setup_future_usage]','customer_update','receipt_email','payment_intent_data[receipt_email]','payment_intent_data[off_session]'])assert.equal(body.get(key),null,'One-time Checkout neither saves nor selects a method nor authorizes future charges')
      assert.equal(body.get('payment_method_types[0]'),'card');assert.equal(body.get('mode'),'payment')
      assert.equal(body.get('saved_payment_method_options[payment_method_save]'),'disabled')
      assert.equal(body.get('line_items[0][price_data][unit_amount]'),'40000')
      for(const key of ['success_url','cancel_url']){const target=new URL(body.get(key));assert.equal(target.pathname,'/portal/invoice-payment/return');assert.equal(target.search,'','No customer session or return capability reaches Stripe')}
      const id=`synthetic-nectar-partial-session-${sessions.size+1}`
      const session={object:'checkout.session',id,mode:'payment',livemode:false,customer:body.get('customer'),currency:'usd',amount_total:40000,
        metadata:{nectar_invoice_partial:body.get('metadata[nectar_invoice_partial]')},status:'open',payment_status:'unpaid',payment_intent:null,url:destination??`https://checkout.stripe.com/c/pay/${id}#synthetic-nectar-checkout-fragment`,
        intentMetadata:Object.fromEntries([...body].filter(([key])=>key.startsWith('payment_intent_data[metadata][')).map(([key,value])=>[key.slice('payment_intent_data[metadata]['.length,-1),value]))}
      sessions.set(id,session)
      if(lose){lose=false;return new Response(null,{status:503})}
      return Response.json(session)
    }
    if(path==='/checkout/sessions')return Response.json(list([...sessions.values()].filter(s=>s.customer===url.searchParams.get('customer'))))
    if(path.startsWith('/checkout/sessions/'))return Response.json(sessions.get(path.split('/').at(-1)))
    if(path==='/payment_intents'&&body){
      const b=banks.get(body.get('customer'));assert.ok(b);assert.equal(body.get('payment_method'),b.paymentMethodRef);assert.equal(body.get('mandate'),b.mandateRef)
      assert.equal(body.get('payment_method_types[0]'),'us_bank_account');assert.equal(body.get('off_session'),'true');assert.equal(body.get('confirm'),'true')
      for(const key of ['setup_future_usage','receipt_email'])assert.equal(body.get(key),null)
      const id=`synthetic-nectar-schedule-intent-${intents.size+1}`,charge=`synthetic-nectar-schedule-charge-${intents.size+1}`
      const intent={object:'payment_intent',id,status:'processing',customer:b.customerRef,payment_method:b.paymentMethodRef,currency:'usd',amount:Number(body.get('amount')),amount_received:0,livemode:false,latest_charge:charge,
        metadata:Object.fromEntries([...body].filter(([key])=>key.startsWith('metadata[')).map(([key,value])=>[key.slice(9,-1),value]))}
      intents.set(id,intent);charges.set(charge,{object:'charge',id:charge,customer:b.customerRef,payment_method:b.paymentMethodRef,payment_intent:id,status:'pending',paid:false,captured:false,amount:intent.amount,amount_captured:0,amount_refunded:0,refunded:false,disputed:false,currency:'usd',livemode:false,created:bankTime/1000,balance_transaction:`synthetic-nectar-transaction-${id}`})
      if(bankLose){bankLose=false;return new Response(null,{status:503})}
      return Response.json(intent)
    }
    if(path==='/payment_intents/search')return Response.json({object:'search_result',has_more:false,data:[...intents.values()]})
    if(path==='/payment_intents')return Response.json(list([...intents.values()].filter(i=>i.customer===url.searchParams.get('customer'))))
    if(path.startsWith('/charges/'))return Response.json(charges.get(path.split('/').at(-1)))
    if(path.startsWith('/balance_transactions/')){const c=[...charges.values()].find(c=>c.balance_transaction===path.split('/').at(-1));return Response.json({object:'balance_transaction',id:c.balance_transaction,source:c.id,type:'payment',currency:'usd',amount:c.amount,status:c.available?'available':'pending',available_on:bankTime/1000})}
    if(path.startsWith('/payment_intents/')){const intent=structuredClone(intents.get(path.split('/').at(-1)));if(wrongProof)intent.customer='synthetic-nectar-foreign';return Response.json(intent)}
    if(path==='/charges')return Response.json(list([...charges.values()].filter(c=>c.payment_intent===url.searchParams.get('payment_intent'))))
    throw new Error(`Unexpected Stripe edge request ${request.method} ${path}`)
  }
  return {fetch,calls,sessions,intents,banks,
    bank(customerRef){const b={customerRef,paymentMethodRef:`synthetic-nectar-bank-${banks.size+1}`,mandateRef:`synthetic-nectar-mandate-${banks.size+1}`};banks.set(customerRef,b);return b},
    cardTime(value){cardTime=Date.parse(value)},bankTime(value){bankTime=Date.parse(value)},loseBank(){bankLose=true},
    settleBank(id,available=true){const i=intents.get(id),c=charges.get(i.latest_charge);Object.assign(i,{status:'succeeded',amount_received:i.amount});Object.assign(c,{status:'succeeded',paid:true,captured:true,amount_captured:i.amount,available})},
    refuseBank(id){const i=intents.get(id),c=charges.get(i.latest_charge);Object.assign(i,{status:'requires_payment_method',amount_received:0,last_payment_error:{code:'insufficient_funds'}});Object.assign(c,{status:'failed',paid:false,captured:false})},
    lose(){lose=true},setLive(value){live=value},setAccount(value){account=value},wrongProof(value){wrongProof=value},
    destination(value){destination=value},expire(id){sessions.get(id).status='expired'},
    complete(id){const s=sessions.get(id),intent=`synthetic-nectar-partial-intent-${id}`,charge=`synthetic-nectar-partial-charge-${id}`,method='synthetic-nectar-one-time-card'
      Object.assign(s,{status:'complete',payment_status:'paid',payment_intent:intent})
      intents.set(intent,{object:'payment_intent',id:intent,status:'succeeded',customer:s.customer,payment_method:method,currency:'usd',amount:40000,amount_received:40000,livemode:false,latest_charge:charge,metadata:s.intentMetadata})
      charges.set(charge,{object:'charge',id:charge,status:'succeeded',paid:true,captured:true,customer:s.customer,payment_method:method,payment_intent:intent,
        currency:'usd',amount:40000,amount_captured:40000,amount_refunded:0,refunded:false,disputed:false,created:cardTime/1000,livemode:false})
    }}
}
let edge
export const harnessOptions=()=>{edge=invoicePartialEdge();return {localTime:'2026-10-29T12:00:00Z',stripeFetch:edge.fetch,stripeSecret:'synthetic-nectar-partial-key'}}
export const getPartialEdge=()=>edge

export async function seedPartialInvoice(h,owner,customer,{issue=true,amount='1000',issueDate='2026-09-01',description='Synthetic partial invoice service'}={}) {
  const charge=await h.api('charge.add',owner,{customer,amount,description,effective_date:'2026-09-01',taxable:false})
  const draft=await h.api('invoice.manual',owner,{customer,charges:[charge.charge],service_date:'2026-09-01'})
  if(issue){await h.api('invoice.approve',owner,{invoice:draft.id,acknowledge:true});await h.api('invoice.finalise',owner,{invoice:draft.id,issue_date:issueDate})}
  return h.api(`invoices/${draft.id}`,owner)
}
export async function invoicePartialPaymentsFlow(h,owner,{interaction={},onState=async()=>{}}={}) {
  const api=(path,body,status)=>h.api(path,owner,body,status),instant=Date.parse('2026-10-29T12:00:00Z')
  await h.advanceClock(new Date(instant).toISOString())
  const identity=await api('me'),customers=[]
  for(let n=1;n<=3;n++)customers.push((await api('customer.create',{external_id:`synthetic-nectar-partial-${n}`,name:`Synthetic partial customer ${n}`,billing_email:identity.email,language:n===2?'es-US':'en'})).id)
  const first=await seedPartialInvoice(h,owner,customers[0]),second=await seedPartialInvoice(h,owner,customers[1]),unknown=await seedPartialInvoice(h,owner,customers[2]),draft=await seedPartialInvoice(h,owner,customers[0],{issue:false})
  await api('portal.configure',{hosts:[h.origin],parents:[]})
  const issue=customer=>api('portal.session.issue',{customer,origin:h.origin,audience:'hosted'}),session=await issue(customers[0]),foreign=await issue(customers[1])
  const request=async(path,s,body,status=200,options={})=>{
    const response=await h.raw(`${path}?session=${encodeURIComponent(s.token)}`,{body,...options})
    const text=await response.text();assert.equal(response.status,status,`${path}: ${response.status} ${text.slice(0,400)}`);return {response,data:response.headers.get('content-type')?.includes('application/json')?JSON.parse(text):text}
  }
  const prepare=invoice=>api('invoice.partial.prepare',{invoice,amount_cents:40000})
  await api('invoice.partial.prepare',{invoice:first.id,amount_cents:40000},403)
  const factor=await api('mfa.totp.start',{});await api('mfa.totp.confirm',{factor:factor.factor,code:totp(factor.secret,instant)})
  for(let n=1;n<=3;n++)await api('collection.customer.bind',{customer:customers[n-1],account_ref:'synthetic-nectar-partial-account',stripe_customer_ref:`synthetic-nectar-partial-customer-${n}`,confirm:true})
  await h.api('invoice.partial.prepare',undefined,{},401)
  const agent={bearer:(await api('credential.issue',{name:'Synthetic partial observer',scopes:['prepare']})).key}
  for(const action of ['invoice.partial.prepare','invoice.partial.confirm','invoice.partial.revoke','invoice.partial.reconcile','invoice.partial.schedule.prepare','invoice.partial.schedule.execute'])await h.api(action,agent,{},403)
  await h.api('invoice-partial-payments',agent,undefined,403)
  await api('invoice.partial.prepare',{invoice:draft.id,amount_cents:40000},409)
  await api('invoice.partial.prepare',{invoice:first.id,amount_cents:100000},409)
  edge.setLive(true);await api('invoice.partial.prepare',{invoice:first.id,amount_cents:40000},409);edge.setLive(false)
  const prepared=await (interaction.prepare?.({invoice:first.id})??prepare(first.id))
  const competing=await prepare(first.id)
  for(const changed of [{amount_cents:40001},{balance_cents:99999},{account_ref:'synthetic-nectar-other-account'},{customer:customers[1]},{invoice:second.id},{stripe_customer_ref:'synthetic-nectar-other-customer'}])await api('invoice.partial.confirm',{...prepared.confirm,...changed},409)
  await h.rejectAudit('invoice.partial.approve');await api('invoice.partial.confirm',prepared.confirm,500);await h.rejectAudit(null)
  assert.equal((await api('invoice-partial-payments')).find(r=>r.id===prepared.id).status,'prepared','Audit failure rolls back reservation and approval')
  const approved=await (interaction.confirm?.({prepared})??api('invoice.partial.confirm',prepared.confirm))
  await api('invoice.partial.confirm',competing.confirm,409)
  await api('invoice.partial.confirm',prepared.confirm,409)
  await api('collection.prepare',{invoice:first.id},409)
  await api('invoice.partial.prepare',{invoice:first.id,amount_cents:40000},409)
  await api('credit.issue',{invoice:first.id,amount:'1',reason:'Competing credit'},409)
  await api('invoice.void',{invoice:first.id,basis:first.source_fingerprint,reason:'Competing void',confirm:true},409)
  const cash=await api('payment.record',{customer:customers[0],amount:'1',received_on:'2026-10-29',method:'bank_transfer',reference:'synthetic-nectar-competing-cash'})
  await api('payment.allocate',{invoice:first.id,payment:cash.payment,amount:'1'},409)
  const payload={request:prepared.id,basis_hash:prepared.basisHash,accept:true}
  await request('/portal/invoice-payment/start',foreign,payload,404)
  await request('/portal/invoice-payment/start',session,{...payload,accept:false},400)
  await request('/portal/invoice-payment/start',session,payload,403,{headers:{origin:'https://synthetic.invalid'}})
  const original=await api(`invoices/${first.id}`)
  await onState({label:'approved-en',invoice:first.id,session,request:approved})
  const beforeWrites=edge.calls.filter(c=>c.method==='POST').length
  let started,cookie
  if(interaction.accept){({started,cookie}=await interaction.accept({invoice:first.id,session,payload}))}
  else {
    const both=await Promise.all([h.raw(`/portal/invoice-payment/start?session=${session.token}`,{body:payload}),h.raw(`/portal/invoice-payment/start?session=${session.token}`,{body:payload})])
    assert.deepEqual(both.map(r=>r.status).sort(),[200,409],'Concurrent acceptance creates only one checkout')
    const response=both.find(r=>r.status===200);started=await response.json();cookie=response.headers.get('set-cookie').split(';')[0]
    await Promise.all(both.filter(r=>r!==response).map(r=>r.text()))
  }
  assert.equal(started.status,'open');assert.equal(edge.calls.filter(c=>c.method==='POST').length,beforeWrites+1)
  const checkout=[...edge.sessions.keys()].at(-1)
  const returnPage=await h.raw('/portal/invoice-payment/return',{cookie});assert.equal(returnPage.status,200);await returnPage.text()
  assert.equal((await api(`invoices/${first.id}`)).paidCents,0,'GET return never records cash')
  await request('/portal/invoice-payment/check',session,{request:prepared.id},409)
  await onState({label:'awaiting-payment',invoice:first.id,session,request:approved})
  edge.complete(checkout)
  edge.setAccount('synthetic-nectar-foreign-account')
  await request('/portal/invoice-payment/check',session,{request:prepared.id},409)
  edge.setAccount('synthetic-nectar-partial-account');edge.wrongProof(true)
  await request('/portal/invoice-payment/check',session,{request:prepared.id},409);edge.wrongProof(false)
  await h.rejectAudit('invoice.partial.collected');await request('/portal/invoice-payment/check',session,{request:prepared.id},500);await h.rejectAudit(null)
  assert.equal((await api(`invoices/${first.id}`)).paidCents,0,'Financial audit failure rolls back cash, receipt, allocation and reservation release')
  await api('credit.issue',{invoice:first.id,amount:'1',reason:'Still reserved after failed audit'},409)
  let completed
  if(interaction.check)completed=await interaction.check({invoice:first.id,session,request:prepared.id})
  else completed=(await request('/portal/invoice-payment/check',session,{request:prepared.id})).data
  assert.equal(completed.status,'collected')
  const consumedReturn=await h.raw('/portal/invoice-payment/return',{cookie});assert.equal(consumedReturn.status,401);await consumedReturn.text()
  await request('/portal/invoice-payment/check',session,{request:prepared.id})
  await api('invoice.partial.reconcile',{request:prepared.id})
  await request('/portal/invoice-payment/start',session,payload,409)
  assert.equal(edge.calls.filter(c=>c.method==='POST').length,beforeWrites+1,'Replay and reconciliation never repeat the provider write')
  const invoice=await api(`invoices/${first.id}`),customer=await api(`customers/${customers[0]}`),payments=await api('payments')
  assert.deepEqual([invoice.total_cents,invoice.paidCents,invoice.balanceCents],[100000,40000,60000])
  assert.deepEqual([customer.ledger.invoicedCents,customer.ledger.paidCents,customer.ledger.balanceCents],[100000,40000,60000])
  assert.equal(invoice.allocations.length,1);assert.equal(payments.filter(p=>p.id===completed.payment).length,1)
  const receipt=await api(`payments/${completed.payment}/receipt`)
  assert.ok(receipt.number);assert.equal(receipt.amountCents,40000)
  assert.deepEqual(invoice.calculation,original.calculation,'Issued calculation is immutable')
  for(const key of ['number','total_cents','source_fingerprint','billing_route_json'])assert.equal(invoice[key],original[key],'Issued invoice evidence stays unchanged')
  const report=await api('reports/collections?period=2026-10');assert.equal(report.totalCents,40100,'Report includes exact captured cash plus independently recorded unallocated cash')
  const reminder=await api('reminder.prepare',{customer:customers[0]}),notices=await api('notices')
  assert.equal(notices.find(r=>r.id===reminder.id).balance_cents,60000,'The existing reminder pursues only the remainder')
  await onState({label:'captured-en',invoice:first.id,session,request:completed})

  // A lost Checkout response is never retried. Read-only lookup can recover
  // the original captured result, or release only a definitive expired result.
  const spanish=await prepare(second.id);await api('invoice.partial.confirm',spanish.confirm)
  await onState({label:'approved-es',invoice:second.id,session:foreign,request:spanish})
  edge.lose()
  const lost=(await request('/portal/invoice-payment/start',foreign,{request:spanish.id,basis_hash:spanish.basisHash,accept:true})).data
  assert.equal(lost.status,'uncertain');const lostSession=[...edge.sessions.keys()].at(-1)
  await request('/portal/invoice-payment/check',foreign,{request:spanish.id},409)
  await api('invoice.partial.revoke',{request:spanish.id},409)
  edge.complete(lostSession)
  assert.equal((await api('invoice.partial.reconcile',{request:spanish.id})).status,'collected')
  assert.equal((await api(`invoices/${second.id}`)).balanceCents,60000)
  await onState({label:'captured-es',invoice:second.id,session:foreign,request:spanish})

  const uncertain=await prepare(unknown.id);await api('invoice.partial.confirm',uncertain.confirm)
  const third=await issue(customers[2]);edge.lose()
  await request('/portal/invoice-payment/start',third,{request:uncertain.id,basis_hash:uncertain.basisHash,accept:true})
  const expiredSession=[...edge.sessions.keys()].at(-1),writes=edge.calls.filter(c=>c.method==='POST').length
  await api('invoice.partial.reconcile',{request:uncertain.id},409)
  edge.expire(expiredSession);assert.equal((await api('invoice.partial.reconcile',{request:uncertain.id})).status,'expired')
  assert.equal(edge.calls.filter(c=>c.method==='POST').length,writes)
  await api('credit.issue',{invoice:unknown.id,amount:'1',reason:'Allowed after definitive expiration'})
  await onState({label:'expired',invoice:unknown.id,session:third,request:uncertain})

  const badDestination=await prepare(unknown.id);await api('invoice.partial.confirm',badDestination.confirm)
  edge.destination('https://synthetic.invalid/foreign-checkout')
  const refusedDestination=(await request('/portal/invoice-payment/start',third,{request:badDestination.id,basis_hash:badDestination.basisHash,accept:true})).data
  assert.equal(refusedDestination.status,'uncertain');assert.equal(refusedDestination.url,undefined,'A foreign provider destination is never handed to the customer')
  edge.destination(null)
  await api('credit.issue',{invoice:unknown.id,amount:'1',reason:'Foreign destination retains unresolved reservation'},409)
  edge.expire([...edge.sessions.keys()].at(-1))
  assert.equal((await api('invoice.partial.reconcile',{request:badDestination.id})).status,'expired')
  const revoked=await prepare(unknown.id);await api('invoice.partial.confirm',revoked.confirm)
  await api('portal.session.revoke',{session:third.id})
  await request('/portal/invoice-payment/start',third,{request:revoked.id,basis_hash:revoked.basisHash,accept:true},401)
  await api('invoice.partial.revoke',{request:revoked.id})
  const disputed=await seedPartialInvoice(h,owner,customers[2])
  await api('cadence.dispute',{invoice:disputed.id,line:disputed.lines[0].id,amount_cents:1,reason:'Synthetic contested invoice'})
  await api('invoice.partial.prepare',{invoice:disputed.id,amount_cents:40000},409)
  const stale=await prepare(unknown.id)
  await api('credit.issue',{invoice:unknown.id,amount:'1',reason:'Changes the prepared balance'})
  await api('invoice.partial.confirm',stale.confirm,409)
  const staleFactor=await prepare(unknown.id)
  const expiringApproval=await prepare(unknown.id);await api('invoice.partial.confirm',expiringApproval.confirm)
  await h.advanceClock('2026-10-29T12:16:00Z')
  await api('invoice.partial.confirm',staleFactor.confirm,403)
  await request('/portal/invoice-payment/start',session,payload,401)
  const lateCustomer=await issue(customers[2])
  await request('/portal/invoice-payment/start',lateCustomer,{request:expiringApproval.id,basis_hash:expiringApproval.basisHash,accept:true},409)
  await api('mfa.verify',{code:totp(factor.secret,instant+16*60000)})
  await api('invoice.partial.revoke',{request:expiringApproval.id})
  const activeErasure=await prepare(unknown.id);await api('invoice.partial.confirm',activeErasure.confirm)
  const erasureSession=await issue(customers[2]);edge.lose()
  await request('/portal/invoice-payment/start',erasureSession,{request:activeErasure.id,basis_hash:activeErasure.basisHash,accept:true})
  const erasedCheckout=[...edge.sessions.keys()].at(-1),writesBeforeErasure=edge.calls.filter(c=>c.method==='POST').length
  const eraseRequest=await api('erasure.request',{customer:customers[2]})
  await api('erasure.verify',{request:eraseRequest.id,reason:'Independently verified synthetic owner',evidence:file('owner-proof.txt','Synthetic independent ownership verification','text/plain')})
  await api('erasure.approve',{request:eraseRequest.id,confirm:true})
  edge.complete(erasedCheckout)
  await api('invoice.partial.reconcile',{request:activeErasure.id},404)
  await request('/portal/invoice-payment/check',erasureSession,{request:activeErasure.id},401)
  assert.equal(edge.calls.filter(c=>c.method==='POST').length,writesBeforeErasure,'Erasure and replayed captured evidence cannot restore collection authority')
  await api('invoice.partial.confirm',staleFactor.confirm,404)
  const key=(await api('credentials')).find(k=>k.name==='Synthetic partial observer');await api('credential.revoke',{key:key.id})
  await h.api('invoice-partial-payments',agent,undefined,401)
  assert.ok(!(await api('invoice-partial-payments')).some(r=>r.customer===customers[2]),'Erasure withdraws partial-payment customer access and operational authority')
  console.log('Partial invoice payment: exact once-only captured cash, current remainder, source and authority refusals, audit rollback, read-only uncertain recovery and erasure passed')
  await invoiceScheduledRemainderFlow(h,owner,{edge,secret:factor.secret,onState,interaction})
  return {customers,first:first.id,second:second.id,completed,prepared,secret:factor.secret}
}

// The retained safety floor permits dated instructions, with no unattended
// submission. Exercise the actual human and customer doors, including money
// refusal and erasure, beside the two-payment business outcome.
export async function invoiceScheduledRemainderFlow(h,owner,{edge,secret,onState=async()=>{},interaction={}}) {
  const api=(path,body,status)=>h.api(path,owner,body,status),start='2026-10-29T12:17:00Z',due='2026-11-28',when='2026-11-28T12:00:00Z'
  await h.advanceClock(start);edge.cardTime(start)
  await api('mfa.verify',{code:totp(secret,Date.parse(start))})
  const identity=await api('me'),scenarios=[]
  const make=async(label,{partial=false,language='en'}={})=>{
    const customer=(await api('customer.create',{external_id:`synthetic-nectar-scheduled-${label}`,name:`Synthetic dated customer ${label}`,billing_email:identity.email.replace(/^[^@]+/,`synthetic-nectar-dated-${label}`),language})).id
    const invoice=await seedPartialInvoice(h,owner,customer,{issueDate:'2026-10-29',description:`Synthetic dated service ${label}`})
    const ref=`synthetic-nectar-dated-customer-${label}`
    await api('collection.customer.bind',{customer,account_ref:'synthetic-nectar-partial-account',stripe_customer_ref:ref,confirm:true})
    const session=await api('portal.session.issue',{customer,origin:h.origin,audience:'hosted'})
    if(partial){
      const p=await api('invoice.partial.prepare',{invoice:invoice.id,amount_cents:40000});await api('invoice.partial.confirm',p.confirm)
      const started=await h.raw(`/portal/invoice-payment/start?session=${session.token}`,{body:{request:p.id,basis_hash:p.basisHash,accept:true}})
      assert.equal(started.status,200);await started.json();edge.complete([...edge.sessions.keys()].at(-1))
      assert.equal((await api('invoice.partial.reconcile',{request:p.id})).status,'collected')
      assert.equal((await api(`invoices/${invoice.id}`)).balanceCents,60000)
    }
    const bank=edge.bank(ref)
    const body={invoice:invoice.id,scheduled_on:due,mandate_ref:bank.mandateRef}
    const preparation=label==='en'&&interaction.schedulePrepare?await interaction.schedulePrepare({invoice:invoice.id,body}):await api('invoice.partial.schedule.prepare',body)
    return {label,customer,invoice:invoice.id,session,preparation,bank,body}
  }
  const customerPost=async(s,path,body,status=200)=>{
    const response=await h.raw(`/portal/invoice-payment/${path}?session=${s.session.token}`,{body}),text=await response.text()
    assert.equal(response.status,status,`${path}: ${text.slice(0,400)}`)
    return response.headers.get('content-type')?.includes('application/json')?JSON.parse(text):text
  }
  const accept=async(s)=>{
    await api('invoice.partial.confirm',s.preparation.confirm)
    if(s.label==='en'&&interaction.scheduleAccept)await interaction.scheduleAccept(s)
    else if(s.label==='es'){
      const responses=await Promise.all([1,2].map(()=>h.raw(`/portal/invoice-payment/schedule?session=${s.session.token}`,{body:{request:s.preparation.id,basis_hash:s.preparation.basisHash,accept:true}})))
      assert.deepEqual(responses.map(r=>r.status).sort(),[200,409],'Concurrent customer acceptance retains one dated instruction')
      await Promise.all(responses.map(r=>r.text()))
    }else await customerPost(s,'schedule',{request:s.preparation.id,basis_hash:s.preparation.basisHash,accept:true})
    const row=(await api('invoice-partial-payments')).find(r=>r.id===s.preparation.id);assert.equal(row.status,'open');assert.equal(row.claimedAt,null)
    return row
  }
  const executeBody=s=>({request:s.preparation.id,basis_hash:s.preparation.basisHash,scheduled_on:due,amount_cents:s.preparation.amountCents,payment_method_ref:s.bank.paymentMethodRef,confirm:true})
  for(const [label,language] of [['en','en'],['es','es-US']]){
    const s=await make(label,{partial:true,language});scenarios.push(s)
    for(const date of ['2026-10-28','2026-11-29'])await api('invoice.partial.schedule.prepare',{...s.body,scheduled_on:date},409)
    await api('invoice.partial.confirm',{...s.preparation.confirm,scheduled_on:'2026-11-27'},409)
    await api('invoice.partial.confirm',{...s.preparation.confirm,payment_method_ref:'synthetic-nectar-foreign-bank'},409)
    await accept(s)
    await customerPost(s,'schedule',{request:s.preparation.id,basis_hash:s.preparation.basisHash,accept:true},409)
    await api('invoice.partial.schedule.execute',executeBody(s),409)
    await api('collection.prepare',{invoice:s.invoice},409)
    await api('credit.issue',{invoice:s.invoice,amount:'1',reason:'Reserved dated payment'},409)
    await onState({label:`schedule-accepted-${label}`,invoice:s.invoice,session:s.session,request:s.preparation})
  }
  const refusal=await make('refusal');await accept(refusal)
  const revoked=await make('revoked');await accept(revoked)
  const withdrawn=await make('withdrawn');await accept(withdrawn)
  await customerPost(withdrawn,'withdraw',{request:withdrawn.preparation.id,withdraw:true})
  await api('credit.issue',{invoice:withdrawn.invoice,amount:'1',reason:'Customer withdrew before debit'})
  const stale=await make('stale');await api('credit.issue',{invoice:stale.invoice,amount:'1',reason:'Changed prepared invoice'})
  await api('invoice.partial.confirm',stale.preparation.confirm,409)
  const methodChanged=await make('method');await accept(methodChanged)
  const disputed=await make('dispute');await accept(disputed)
  const erased=await make('erased');await accept(erased)
  const erasure=await api('erasure.request',{customer:erased.customer})
  await api('erasure.verify',{request:erasure.id,reason:'Independently verified synthetic dated instruction',evidence:file('synthetic-owner.txt','Synthetic ownership verification','text/plain')})
  await api('erasure.approve',{request:erasure.id,confirm:true})
  await api('invoice.partial.schedule.execute',executeBody(erased),404)
  const foreign=await h.raw(`/portal/invoice-payment/withdraw?session=${scenarios[1].session.token}`,{body:{request:scenarios[0].preparation.id,withdraw:true}})
  assert.equal(foreign.status,404);await foreign.text()
  const writes=edge.calls.filter(c=>c.method==='POST').length
  await h.advanceClock(when);edge.bankTime(when)
  await api('invoice.partial.schedule.execute',executeBody(scenarios[0]),403,'Expired fresh factor cannot submit')
  await api('mfa.verify',{code:totp(secret,Date.parse(when))})
  await api('portal.session.revoke',{session:revoked.session.id})
  await api('invoice.partial.schedule.execute',executeBody(revoked),409)
  await api('invoice.partial.schedule.execute',executeBody(withdrawn),409)
  const priorMethod=methodChanged.bank.paymentMethodRef;methodChanged.bank.paymentMethodRef='synthetic-nectar-changed-bank'
  await api('invoice.partial.schedule.execute',{...executeBody(methodChanged),payment_method_ref:priorMethod},409)
  methodChanged.bank.paymentMethodRef=priorMethod
  const invoice=await api(`invoices/${disputed.invoice}`)
  await api('cadence.dispute',{invoice:disputed.invoice,line:invoice.lines[0].id,amount_cents:1,reason:'Dated instruction source disputed'})
  await api('invoice.partial.schedule.execute',executeBody(disputed),409)
  // Ordinary scheduled ticks have no authority over these instructions.
  const tick=await h.raw('/cdn-cgi/local/scheduled?cron=*+*+*+*+*');assert.equal(tick.status,200);await tick.text()
  assert.equal(edge.calls.filter(c=>c.method==='POST').length,writes,'Refusals and scheduled ticks submit no payment')
  edge.setAccount('synthetic-nectar-wrong-dated-account');await api('invoice.partial.schedule.execute',executeBody(scenarios[0]),409);edge.setAccount('synthetic-nectar-partial-account')
  await h.rejectAudit('invoice.schedule.claim');await api('invoice.partial.schedule.execute',executeBody(scenarios[0]),500);await h.rejectAudit(null)
  assert.equal(edge.calls.filter(c=>c.method==='POST').length,writes,'Claim audit rollback precedes any provider write')
  await api('invoice.partial.schedule.execute',executeBody(refusal))
  const refusedIntent=[...edge.intents.values()].find(i=>i.metadata.nectar_native_collection_request===refusal.preparation.id)
  edge.refuseBank(refusedIntent.id)
  assert.equal((await api('invoice.partial.reconcile',{request:refusal.preparation.id})).status,'expired')
  assert.equal((await api(`invoices/${refusal.invoice}`)).paidCents,0,'Definitive refusal records no cash')
  await api('credit.issue',{invoice:refusal.invoice,amount:'1',reason:'Definitive no-cash refusal released the reservation'})
  for(const s of scenarios){
    const original=await api(`invoices/${s.invoice}`)
    // Acceptance endures only as its exact dated instruction. Ordinary expired
    // customer sessions gain no page or mutation access from that instruction.
    const expired=await h.raw(`/portal/invoices/${s.invoice}?session=${s.session.token}`);assert.equal(expired.status,401);await expired.text()
    await customerPost(s,'schedule',{request:s.preparation.id,basis_hash:s.preparation.basisHash,accept:true},401)
    s.session=await api('portal.session.issue',{customer:s.customer,origin:h.origin,audience:'hosted'})
    if(s.label==='es')edge.loseBank()
    if(s.label==='en'&&interaction.scheduleExecute)await interaction.scheduleExecute(s,executeBody(s))
    else {
      const attempts=await Promise.all([h.raw('/api/nectar/invoice.partial.schedule.execute',{cookie:owner,body:executeBody(s)}),h.raw('/api/nectar/invoice.partial.schedule.execute',{cookie:owner,body:executeBody(s)})])
      assert.deepEqual(attempts.map(r=>r.status).sort(),[200,409],'Concurrent submission claims the accepted instruction once')
      for(const response of attempts)await response.text()
    }
    await api('invoice.partial.schedule.execute',executeBody(s),409)
    const intent=[...edge.intents.values()].find(i=>i.metadata.nectar_native_collection_request===s.preparation.id)
    assert.ok(intent);assert.equal(intent.amount,60000)
    const pending=await api('invoice.partial.reconcile',{request:s.preparation.id});assert.equal(pending.status,'open')
    assert.equal((await api(`invoices/${s.invoice}`)).balanceCents,60000,'Pending ACH is not cash')
    await onState({label:`schedule-pending-${s.label}`,invoice:s.invoice,session:s.session,request:pending})
    edge.settleBank(intent.id,false)
    await api('invoice.partial.reconcile',{request:s.preparation.id},409)
    assert.equal((await api(`invoices/${s.invoice}`)).balanceCents,60000,'Captured but unavailable ACH funds remain pending')
    edge.settleBank(intent.id)
    await h.rejectAudit('invoice.schedule.collected');await api('invoice.partial.reconcile',{request:s.preparation.id},500);await h.rejectAudit(null)
    assert.equal((await api(`invoices/${s.invoice}`)).balanceCents,60000,'Settlement audit rolls back cash and allocation')
    const settled=await api('invoice.partial.reconcile',{request:s.preparation.id});assert.equal(settled.status,'collected')
    const after=await api(`invoices/${s.invoice}`),customer=await api(`customers/${s.customer}`)
    assert.deepEqual([after.total_cents,after.paidCents,after.balanceCents,after.allocations.length],[100000,100000,0,2])
    assert.deepEqual([customer.ledger.invoicedCents,customer.ledger.paidCents,customer.ledger.balanceCents],[100000,100000,0])
    assert.equal((await api(`payments/${settled.payment}/receipt`)).amountCents,60000)
    for(const key of ['number','total_cents','source_fingerprint','billing_route_json','calculation'])assert.deepEqual(after[key],original[key])
    await api('invoice.partial.reconcile',{request:s.preparation.id})
    assert.equal((await api(`invoices/${s.invoice}`)).allocations.length,2)
    await onState({label:`schedule-paid-${s.label}`,invoice:s.invoice,session:s.session,request:settled})
  }
  assert.equal(edge.calls.filter(c=>c.method==='POST').length,writes+3,'Exactly one provider write for each dated payment, including lost-response recovery')
  assert.equal((await api('reports/collections?period=2026-11')).totalCents,120000)
  await h.advanceClock('2026-11-29T12:00:00Z')
  for(const s of scenarios)await api('reminder.prepare',{customer:s.customer},409)
  await api('mfa.verify',{code:totp(secret,Date.parse('2026-11-29T12:00:00Z'))})
  await api('invoice.partial.schedule.execute',executeBody(methodChanged),409,'No missed-date catch-up')
  console.log('Dated ACH instructions: separate consent, exact-date human submission, two payments, pending funds, read-only recovery, settlement, reminder suppression and unsafe-path refusals passed')
}
