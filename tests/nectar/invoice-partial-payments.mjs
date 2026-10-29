// Real Worker, D1, owner and customer doors. Only Stripe's network edge is substituted.
import assert from 'node:assert/strict'
import { file } from './harness.mjs'
import { totp } from './mfa.mjs'

export function invoicePartialEdge() {
  const calls=[],sessions=new Map(),intents=new Map(),charges=new Map()
  let lose=false,live=false,account='synthetic-nectar-partial-account',wrongProof=false
  const list=data=>({object:'list',has_more:false,data})
  const fetch=async request=>{
    assert.equal(request.headers.get('authorization'),'Bearer synthetic-nectar-partial-key')
    const url=new URL(request.url),path=url.pathname.replace('/v1',''),body=request.method==='POST'?new URLSearchParams(await request.text()):null
    calls.push({path,method:request.method,body:body?Object.fromEntries(body):null})
    if(path==='/account')return Response.json({object:'account',id:account})
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
        metadata:{nectar_invoice_partial:body.get('metadata[nectar_invoice_partial]')},status:'open',payment_status:'unpaid',payment_intent:null,url:`https://checkout.stripe.com/c/pay/${id}`,
        intentMetadata:Object.fromEntries([...body].filter(([key])=>key.startsWith('payment_intent_data[metadata][')).map(([key,value])=>[key.slice('payment_intent_data[metadata]['.length,-1),value]))}
      sessions.set(id,session)
      if(lose){lose=false;return new Response(null,{status:503})}
      return Response.json(session)
    }
    if(path==='/checkout/sessions')return Response.json(list([...sessions.values()].filter(s=>s.customer===url.searchParams.get('customer'))))
    if(path.startsWith('/checkout/sessions/'))return Response.json(sessions.get(path.split('/').at(-1)))
    if(path.startsWith('/payment_intents/')){const intent=structuredClone(intents.get(path.split('/').at(-1)));if(wrongProof)intent.customer='synthetic-nectar-foreign';return Response.json(intent)}
    if(path==='/charges')return Response.json(list([...charges.values()].filter(c=>c.payment_intent===url.searchParams.get('payment_intent'))))
    throw new Error(`Unexpected Stripe edge request ${request.method} ${path}`)
  }
  return {fetch,calls,sessions,intents,lose(){lose=true},setLive(value){live=value},setAccount(value){account=value},wrongProof(value){wrongProof=value},
    expire(id){sessions.get(id).status='expired'},
    complete(id){const s=sessions.get(id),intent=`synthetic-nectar-partial-intent-${id}`,charge=`synthetic-nectar-partial-charge-${id}`,method='synthetic-nectar-one-time-card'
      Object.assign(s,{status:'complete',payment_status:'paid',payment_intent:intent})
      intents.set(intent,{object:'payment_intent',id:intent,status:'succeeded',customer:s.customer,payment_method:method,currency:'usd',amount:40000,amount_received:40000,livemode:false,latest_charge:charge,metadata:s.intentMetadata})
      charges.set(charge,{object:'charge',id:charge,status:'succeeded',paid:true,captured:true,customer:s.customer,payment_method:method,payment_intent:intent,
        currency:'usd',amount:40000,amount_captured:40000,amount_refunded:0,refunded:false,disputed:false,created:Date.parse('2026-10-29T12:00:00Z')/1000,livemode:false})
    }}
}
let edge
export const harnessOptions=()=>{edge=invoicePartialEdge();return {localTime:'2026-10-29T12:00:00Z',stripeFetch:edge.fetch,stripeSecret:'synthetic-nectar-partial-key'}}
export const getPartialEdge=()=>edge

export async function seedPartialInvoice(h,owner,customer,{issue=true,amount='1000'}={}) {
  const charge=await h.api('charge.add',owner,{customer,amount,description:'Synthetic partial invoice service',effective_date:'2026-09-01',taxable:false})
  const draft=await h.api('invoice.manual',owner,{customer,charges:[charge.charge],service_date:'2026-09-01'})
  if(issue){await h.api('invoice.approve',owner,{invoice:draft.id,acknowledge:true});await h.api('invoice.finalise',owner,{invoice:draft.id,issue_date:'2026-09-01'})}
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
  for(const action of ['invoice.partial.prepare','invoice.partial.confirm','invoice.partial.revoke','invoice.partial.reconcile'])await h.api(action,agent,{},403)
  await h.api('invoice-partial-payments',agent,undefined,403)
  await api('invoice.partial.prepare',{invoice:draft.id,amount_cents:40000},409)
  await api('invoice.partial.prepare',{invoice:first.id,amount_cents:100000},409)
  edge.setLive(true);await api('invoice.partial.prepare',{invoice:first.id,amount_cents:40000},409);edge.setLive(false)
  const prepared=await (interaction.prepare?.({invoice:first.id})??prepare(first.id))
  for(const changed of [{amount_cents:40001},{balance_cents:99999},{account_ref:'synthetic-nectar-other-account'},{customer:customers[1]},{invoice:second.id},{stripe_customer_ref:'synthetic-nectar-other-customer'}])await api('invoice.partial.confirm',{...prepared.confirm,...changed},409)
  await h.rejectAudit('invoice.partial.approve');await api('invoice.partial.confirm',prepared.confirm,500);await h.rejectAudit(null)
  assert.equal((await api('invoice-partial-payments')).find(r=>r.id===prepared.id).status,'prepared','Audit failure rolls back reservation and approval')
  const approved=await (interaction.confirm?.({prepared})??api('invoice.partial.confirm',prepared.confirm))
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
  edge.complete(checkout);edge.wrongProof(true)
  await request('/portal/invoice-payment/check',session,{request:prepared.id},409);edge.wrongProof(false)
  await h.rejectAudit('invoice.partial.collected');await request('/portal/invoice-payment/check',session,{request:prepared.id},500);await h.rejectAudit(null)
  assert.equal((await api(`invoices/${first.id}`)).paidCents,0,'Financial audit failure rolls back cash, receipt, allocation and reservation release')
  await api('credit.issue',{invoice:first.id,amount:'1',reason:'Still reserved after failed audit'},409)
  let completed
  if(interaction.check)completed=await interaction.check({invoice:first.id,session,request:prepared.id})
  else completed=(await request('/portal/invoice-payment/check',session,{request:prepared.id})).data
  assert.equal(completed.status,'collected')
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

  const revoked=await prepare(unknown.id);await api('invoice.partial.confirm',revoked.confirm)
  await api('portal.session.revoke',{session:third.id})
  await request('/portal/invoice-payment/start',third,{request:revoked.id,basis_hash:revoked.basisHash,accept:true},401)
  await api('invoice.partial.revoke',{request:revoked.id})
  const stale=await prepare(unknown.id)
  await api('credit.issue',{invoice:unknown.id,amount:'1',reason:'Changes the prepared balance'})
  await api('invoice.partial.confirm',stale.confirm,409)
  const staleFactor=await prepare(unknown.id)
  await h.advanceClock('2026-10-29T12:16:00Z')
  await api('invoice.partial.confirm',staleFactor.confirm,403)
  await request('/portal/invoice-payment/start',session,payload,401)
  await api('mfa.verify',{code:totp(factor.secret,instant+16*60000)})
  const eraseRequest=await api('erasure.request',{customer:customers[2]})
  await api('erasure.verify',{request:eraseRequest.id,reason:'Independently verified synthetic owner',evidence:file('owner-proof.txt','Synthetic independent ownership verification','text/plain')})
  await api('erasure.approve',{request:eraseRequest.id,confirm:true})
  await api('invoice.partial.confirm',staleFactor.confirm,404)
  assert.ok(!(await api('invoice-partial-payments')).some(r=>r.customer===customers[2]),'Erasure withdraws partial-payment customer access and operational authority')
  return {customers,first:first.id,second:second.id,completed,prepared,secret:factor.secret}
}
