// Real Worker/auth/D1/receivables, fake only at Stripe's paid network edge.
import assert from 'node:assert/strict'
import { file } from './harness.mjs'
import { totp } from './mfa.mjs'

export function nativeCollectionEdge() {
  const calls=[],intents=new Map(),charges=new Map(),keys=new Set(),customers=new Map()
  let loseNext=false,created=Date.parse('2026-10-22T10:00:00Z')/1000
  for(let n=1;n<=4;n++)customers.set(`synthetic-nectar-native-customer-${n}`,{account:n===2?2:1,method:`synthetic-nectar-native-card-${n}`})
  const list=data=>({object:'list',has_more:false,data})
  const fetch=async request=>{
    const url=new URL(request.url),path=url.pathname.replace('/v1',''),method=request.method
    const account=request.headers.get('authorization')==='Bearer synthetic-nectar-1'?1:request.headers.get('authorization')==='Bearer synthetic-nectar-2'?2:0
    assert.ok(account,'Only explicit installation-held bindings reach the paid edge')
    const form=method==='POST'?new URLSearchParams(await request.text()):null
    calls.push({account,path,method,form:form?Object.fromEntries(form):null,key:request.headers.get('Idempotency-Key')})
    if(method==='GET'&&path==='/account')return Response.json({object:'account',id:`synthetic-nectar-native-account-${account}`})
    if(method==='GET'&&path.startsWith('/customers/')){
      const id=path.split('/').at(-1),customer=customers.get(id)
      if(!customer||customer.account!==account)return Response.json({},{status:404})
      return Response.json({object:'customer',id,livemode:false,invoice_settings:{default_payment_method:customer.method}})
    }
    if(method==='GET'&&path.startsWith('/payment_methods/')){
      const id=path.split('/').at(-1),entry=[...customers].find(([,value])=>value.account===account&&value.method===id)
      return entry?Response.json({object:'payment_method',id,customer:entry[0],type:'card',livemode:false,card:{brand:'visa',last4:'4242',exp_month:12,exp_year:2035}}):Response.json({},{status:404})
    }
    if(method==='POST'&&path==='/payment_intents'){
      assert.equal(form.get('receipt_email'),null,'Nectar never requests a Stripe receipt email')
      assert.equal(form.get('confirm'),'true');assert.equal(form.get('off_session'),'true')
      assert.equal(customers.get(form.get('customer'))?.account,account)
      assert.equal(customers.get(form.get('customer')).method,form.get('payment_method'))
      const key=request.headers.get('Idempotency-Key');assert.ok(key);assert.ok(!keys.has(key),'A claimed invoice never sends another create/confirm request');keys.add(key)
      const id=`synthetic-nectar-native-intent-${intents.size+1}`,charge=`synthetic-nectar-native-charge-${intents.size+1}`
      const intent={object:'payment_intent',id,status:'succeeded',customer:form.get('customer'),payment_method:form.get('payment_method'),currency:form.get('currency'),amount:Number(form.get('amount')),amount_received:Number(form.get('amount')),livemode:false,latest_charge:charge,
        metadata:Object.fromEntries([...form].filter(([name])=>name.startsWith('metadata[')).map(([name,value])=>[name.slice(9,-1),value]))}
      intents.set(id,{account,value:intent})
      charges.set(charge,{account,value:{object:'charge',id:charge,status:'succeeded',paid:true,captured:true,customer:intent.customer,payment_method:intent.payment_method,payment_intent:id,
        currency:'usd',amount:intent.amount,amount_captured:intent.amount,amount_refunded:0,refunded:false,disputed:false,created,livemode:false}})
      if(loseNext){loseNext=false;return new Response(null,{status:503})}
      return Response.json(intent)
    }
    if(method==='GET'&&path==='/payment_intents/search'){
      const query=url.searchParams.get('query')
      return Response.json({object:'search_result',has_more:false,data:[...intents.values()].filter(row=>row.account===account&&query.includes(row.value.metadata.nectar_native_collection_key)&&query.includes(row.value.metadata.nectar_native_collection_request)).map(row=>row.value)})
    }
    if(method==='GET'&&path.startsWith('/payment_intents/')){
      const row=intents.get(path.split('/').at(-1));return row?.account===account?Response.json(row.value):Response.json({},{status:404})
    }
    if(method==='GET'&&path==='/charges')return Response.json(list([...charges.values()].filter(row=>row.account===account&&row.value.payment_intent===url.searchParams.get('payment_intent')).map(row=>row.value)))
    throw new Error(`Unexpected native collection paid-edge request ${method} ${path}`)
  }
  return {fetch,calls,customers,intents,charges,losePayment(){loseNext=true},capturedAt(instant){created=Date.parse(instant)/1000}}
}

const edge=nativeCollectionEdge()
export const harnessOptions=()=>({stripeFetch:edge.fetch,stripeSecret:'synthetic-nectar-1',stripeSecondarySecret:'synthetic-nectar-2'})

export async function nativeCollectionFlow(h,owner,{onState=async()=>{}}={}) {
  const api=(path,body,status)=>h.api(path,owner,body,status)
  let instant=Date.parse('2026-10-22T10:00:00Z')
  await h.advanceClock(new Date(instant).toISOString())
  await api('business.configure',{...await api('business'),timezone:'UTC'})
  const revision=async()=>(await api('business')).revision
  const mutate=async(action,body)=>api(action,{revision:await revision(),...body})
  const entities=[],customers=[]
  for(let n=1;n<=3;n++){
    const customer=(await api('customer.create',{external_id:`synthetic-nectar-native-${n}`,name:`Native collection ${n}`,billing_email:`native-${n}@example.test`})).id
    customers.push(customer)
    if(n<=2)entities.push((await mutate('entity.create',{legal_name:`Native entity ${n}`,address:`${n} Synthetic Way`,ein:`${10+n}-3456789`,invoice_prefix:`NATIVE${n}`,invoice_number_width:4,
      payment_terms_days:30,processor_account_ref:`synthetic-nectar-native-account-${n}`,ledger_company_ref:`synthetic-nectar-native-ledger-${n}`,tax_registration:'Synthetic tax registration'})).id)
    await mutate('customer.entity',{customer,entity:entities[n===2?1:0],confirm:true})
  }
  const invoice=async(customer,issue=true)=>{
    const charge=await api('charge.add',{customer,amount:'100',description:'Native collection source',effective_date:'2026-10-20',taxable:false})
    const draft=await api('invoice.manual',{customer,charges:[charge.charge],service_date:'2026-10-20'})
    if(issue){await api('invoice.approve',{invoice:draft.id,acknowledge:true});await api('invoice.finalise',{invoice:draft.id,issue_date:'2026-10-20'})}
    return await api(`invoices/${draft.id}`)
  }
  const first=await invoice(customers[0]),unknown=await invoice(customers[1]),changed=await invoice(customers[0]),paid=await invoice(customers[0]),erasedInvoice=await invoice(customers[2]),draft=await invoice(customers[0],false)
  await api('access.give',{email:'native-finance@example.test',name:'Native finance',role:'finance'})
  const finance=await h.signIn('native-finance@example.test',{requested:true})
  const credential={bearer:(await api('credential.issue',{name:'Native observer',scopes:['prepare']})).key}
  for(const who of [finance,credential,undefined])for(const action of ['collection.customer.bind','collection.prepare','collection.confirm','collection.reconcile'])await h.api(action,who,{},who?403:401)
  const started=await api('mfa.totp.start',{}),secret=started.secret
  await api('mfa.totp.confirm',{factor:started.factor,code:totp(secret,instant)})
  await api('mfa.policy',{scope:'all'})
  for(let n=1;n<=3;n++)await api('collection.customer.bind',{customer:customers[n-1],account_ref:`synthetic-nectar-native-account-${n===2?2:1}`,stripe_customer_ref:`synthetic-nectar-native-customer-${n}`,confirm:true})
  await api('collection.customer.bind',{customer:customers[0],account_ref:'synthetic-nectar-native-account-2',stripe_customer_ref:'synthetic-nectar-native-customer-2',confirm:true},409)
  await api('collection.customer.bind',{customer:customers[2],account_ref:'synthetic-nectar-native-account-1',stripe_customer_ref:'synthetic-nectar-native-customer-1',confirm:true},409)
  await api('collection.prepare',{invoice:draft.id},409)
  const external=await api('payment.record',{customer:customers[0],amount:'100',received_on:'2026-10-22',method:'bank_transfer',reference:'synthetic-nectar-already-paid'})
  await api('payment.allocate',{payment:external.payment,invoice:paid.id,amount:'100'})
  await api('collection.prepare',{invoice:paid.id},409)
  await api('credit.issue',{invoice:first.id,amount:'25',reason:'Approved pre-collection adjustment'})
  const prepared=await api('collection.prepare',{invoice:first.id}),competing=await api('collection.prepare',{invoice:first.id})
  assert.equal(prepared.amount_cents,7500,'Review binds current owed balance, rather than original invoice total')
  assert.equal(prepared.review.accountRef,JSON.parse(first.billing_route_json).processorAccountRef)
  const confirmations=edge.calls.filter(call=>call.method==='POST').length
  await api('collection.confirm',{...prepared.instructions.confirm,confirm:false},400)
  await api('collection.confirm',{...prepared.instructions.confirm,amount_cents:10000},409)
  await api('collection.confirm',{...prepared.instructions.confirm,account_ref:'synthetic-nectar-native-account-2'},409)
  assert.equal(edge.calls.filter(call=>call.method==='POST').length,confirmations)
  await onState({label:'review',customer:customers[0],invoice:first.id,request:prepared})
  const mailCount=h.mails.length
  const result=await api('collection.confirm',prepared.instructions.confirm)
  assert.equal(result.status,'collected');assert.ok(result.payment_id);assert.ok(result.allocation_id)
  const collected=await api(`invoices/${first.id}`)
  assert.deepEqual([collected.paidCents,collected.creditedCents,collected.balanceCents],[7500,2500,0])
  assert.deepEqual(collected.calculation,first.calculation,'Collection never rewrites issued calculation evidence')
  assert.equal(collected.billing_route_json,first.billing_route_json)
  const records=await api('payments')
  assert.equal(records.filter(row=>row.id===result.payment_id).length,1)
  await api('collection.confirm',prepared.instructions.confirm,409)
  await api('collection.confirm',competing.instructions.confirm,409)
  const settled=await api('collection.reconcile',{request:result.id})
  assert.equal(settled.payment_id,result.payment_id)
  assert.equal(edge.calls.filter(call=>call.method==='POST').length,confirmations+1)
  assert.equal(h.mails.length,mailCount,'Manual collection sends no automatic Nectar receipt or notification')
  await onState({label:'collected',customer:customers[0],invoice:first.id,request:result})
  const stale=await api('collection.prepare',{invoice:changed.id})
  await api('credit.issue',{invoice:changed.id,amount:'10',reason:'Review amount changed'})
  await api('collection.confirm',stale.instructions.confirm,409)
  const fresh=await api('collection.prepare',{invoice:changed.id})
  assert.equal(fresh.amount_cents,9000)
  assert.equal((await api('collection.confirm',fresh.instructions.confirm)).status,'collected')
  const uncertain=await api('collection.prepare',{invoice:unknown.id})
  edge.losePayment()
  const lost=await api('collection.confirm',uncertain.instructions.confirm)
  assert.equal(lost.status,'uncertain')
  assert.equal((await api(`invoices/${unknown.id}`)).paidCents,0,'A lost provider response never fabricates payment evidence')
  const posts=edge.calls.filter(call=>call.method==='POST').length
  const recovered=await api('collection.reconcile',{request:lost.id})
  assert.equal(recovered.status,'collected');assert.ok(recovered.charge_ref)
  assert.equal((await api(`invoices/${unknown.id}`)).paidCents,10000)
  assert.equal(edge.calls.filter(call=>call.method==='POST').length,posts,'Recovery only reads provider evidence')
  assert.equal((await api('collection.reconcile',{request:lost.id})).payment_id,recovered.payment_id)
  await api('collection.confirm',uncertain.instructions.confirm,409)
  assert.deepEqual(edge.calls.filter(call=>call.path==='/payment_intents'&&call.method==='POST').map(call=>[call.account,Number(call.form.amount)]),[[1,7500],[1,9000],[2,10000]],'Each issued invoice charges its own frozen Stripe account exactly once')
  assert.equal((await api('reports/collections?period=2026-10')).totalCents,36500,'Native processor receipts join ordinary collection reports once')
  await onState({label:'reconciled',customer:customers[1],invoice:unknown.id,request:recovered})
  const erasedPending=await api('collection.prepare',{invoice:erasedInvoice.id})
  const erasure=await api('erasure.request',{customer:customers[2]})
  await api('erasure.verify',{request:erasure.id,reason:'Customer identity independently verified',evidence:file('native-owner.txt','Synthetic independently checked identity','text/plain')})
  await api('erasure.approve',{request:erasure.id,confirm:true})
  await api('collection.confirm',erasedPending.instructions.confirm,404)
  await api('collection.prepare',{invoice:erasedInvoice.id},409)
  const beforeExpired=edge.calls.length
  instant+=16*60*1000;await h.advanceClock(new Date(instant).toISOString())
  assert.equal((await api('collection.prepare',{invoice:changed.id},403)).error,'mfa_step_up_required')
  assert.equal(edge.calls.length,beforeExpired,'Stale owner factor is refused before reading Stripe')
  await api('mfa.verify',{code:totp(secret,instant)})
  assert.equal((await api('collection.reconcile',{request:result.id})).status,'collected')
  console.log('Native collection: two frozen accounts, exact current balances, explicit owner confirmation, captured proof, atomic payment/allocation, read-only recovery, no second charge and erasure/factor boundaries')
}
