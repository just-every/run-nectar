// Real Worker/auth/D1/receivables, fake only at Stripe's paid network edge.
import assert from 'node:assert/strict'
import { file } from './harness.mjs'
import { totp } from './mfa.mjs'

export function nativeCollectionEdge() {
  const calls=[],intents=new Map(),charges=new Map(),keys=new Set(),customers=new Map(),accounts=new Map([[1,'synthetic-nectar-native-account-1'],[2,'synthetic-nectar-native-account-2']])
  let loseNext=false,loseBeforeNext=false,refusalNext=null,searchVisible=true,created=Date.parse('2026-10-22T10:00:00Z')/1000
  for(let n=1;n<=4;n++)customers.set(`synthetic-nectar-native-customer-${n}`,{account:n===2?2:1,method:`synthetic-nectar-native-card-${n}`})
  const list=data=>({object:'list',has_more:false,data})
  const fetch=async request=>{
    const url=new URL(request.url),path=url.pathname.replace('/v1',''),method=request.method
    const account=request.headers.get('authorization')==='Bearer synthetic-nectar-1'?1:request.headers.get('authorization')==='Bearer synthetic-nectar-2'?2:0
    assert.ok(account,'Only explicit installation-held bindings reach the paid edge')
    const form=method==='POST'?new URLSearchParams(await request.text()):null
    calls.push({account,path,method,form:form?Object.fromEntries(form):null,key:request.headers.get('Idempotency-Key')})
    if(method==='GET'&&path==='/account')return Response.json({object:'account',id:accounts.get(account)})
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
      if(loseBeforeNext){loseBeforeNext=false;return new Response(null,{status:503})}
      const id=`synthetic-nectar-native-intent-${intents.size+1}`,charge=`synthetic-nectar-native-charge-${intents.size+1}`
      const intent={object:'payment_intent',id,created,status:'succeeded',customer:form.get('customer'),payment_method:form.get('payment_method'),currency:form.get('currency'),amount:Number(form.get('amount')),amount_received:Number(form.get('amount')),livemode:false,latest_charge:charge,
        metadata:Object.fromEntries([...form].filter(([name])=>name.startsWith('metadata[')).map(([name,value])=>[name.slice(9,-1),value]))}
      if(refusalNext){
        const code=refusalNext;refusalNext=null
        Object.assign(intent,{status:'requires_payment_method',payment_method:null,amount_received:0,latest_charge:null,last_payment_error:{code,payment_method:{id:form.get('payment_method')}}})
        intents.set(id,{account,value:intent})
        return Response.json({error:{type:'card_error',code,payment_intent:intent}},{status:402})
      }
      intents.set(id,{account,value:intent})
      charges.set(charge,{account,value:{object:'charge',id:charge,status:'succeeded',paid:true,captured:true,customer:intent.customer,payment_method:intent.payment_method,payment_intent:id,
        currency:'usd',amount:intent.amount,amount_captured:intent.amount,amount_refunded:0,refunded:false,disputed:false,created,livemode:false}})
      if(loseNext){loseNext=false;return new Response(null,{status:503})}
      return Response.json(intent)
    }
    if(method==='GET'&&path==='/payment_intents/search'){
      const query=url.searchParams.get('query')
      return Response.json({object:'search_result',has_more:false,data:[...intents.values()].filter(row=>searchVisible&&row.account===account&&query.includes(row.value.metadata.nectar_native_collection_key)&&query.includes(row.value.metadata.nectar_native_collection_request)).map(row=>row.value)})
    }
    if(method==='GET'&&path==='/payment_intents'){
      const customer=url.searchParams.get('customer'),from=Number(url.searchParams.get('created[gte]')),to=Number(url.searchParams.get('created[lte]'))
      assert.ok(customer&&url.searchParams.has('created[gte]')&&url.searchParams.has('created[lte]'),'Recovery independently lists the frozen customer and creation window')
      return Response.json(list([...intents.values()].filter(row=>row.account===account&&row.value.customer===customer&&row.value.created>=from&&row.value.created<=to).map(row=>row.value)))
    }
    if(method==='GET'&&path.startsWith('/payment_intents/')){
      const row=intents.get(path.split('/').at(-1));return row?.account===account?Response.json(row.value):Response.json({},{status:404})
    }
    if(method==='GET'&&path==='/charges')return Response.json(list([...charges.values()].filter(row=>row.account===account&&row.value.payment_intent===url.searchParams.get('payment_intent')).map(row=>row.value)))
    throw new Error(`Unexpected native collection paid-edge request ${method} ${path}`)
  }
  return {fetch,calls,customers,accounts,intents,charges,losePayment(){loseNext=true},loseBeforePayment(){loseBeforeNext=true},refuseNext(code){refusalNext=code},setSearchVisible(value){searchVisible=value},capturedAt(instant){created=Date.parse(instant)/1000}}
}

const edge=nativeCollectionEdge()
export const harnessOptions=()=>({stripeFetch:edge.fetch,stripeSecret:'synthetic-nectar-1',stripeSecondarySecret:'synthetic-nectar-2'})

export async function nativeCollectionFlow(h,owner,{onState=async()=>{},confirm}={}) {
  const api=(path,body,status)=>h.api(path,owner,body,status)
  const confirmReview=confirm??(payload=>api('collection.confirm',payload))
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
  await api('collection.confirm',{...prepared.instructions.confirm,stripe_customer_ref:'synthetic-nectar-native-customer-4'},409)
  await api('collection.confirm',{...prepared.instructions.confirm,payment_method_ref:'synthetic-nectar-native-card-4'},409)
  const savedMethod=edge.customers.get('synthetic-nectar-native-customer-1').method
  edge.customers.get('synthetic-nectar-native-customer-1').method='synthetic-nectar-native-card-replacement'
  await api('collection.confirm',prepared.instructions.confirm,409)
  edge.customers.get('synthetic-nectar-native-customer-1').method=savedMethod
  edge.accounts.set(1,'synthetic-nectar-native-account-replaced')
  await api('collection.confirm',prepared.instructions.confirm,409)
  edge.accounts.set(1,'synthetic-nectar-native-account-1')
  assert.equal(edge.calls.filter(call=>call.method==='POST').length,confirmations)
  await onState({label:'review',customer:customers[0],invoice:first.id,request:prepared})
  const mailCount=h.mails.length
  let result
  if(confirm) result=await confirmReview(prepared.instructions.confirm)
  else {
    const concurrent=await Promise.all([1,2].map(()=>h.raw('/api/nectar/collection.confirm',{cookie:owner,body:prepared.instructions.confirm})))
    assert.deepEqual(concurrent.map(response=>response.status).sort(),[200,409],'Concurrent owner confirmations produce exactly one durable claim')
    result=await concurrent.find(response=>response.status===200).json()
  }
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
  await onState({label:'review',customer:customers[0],invoice:changed.id,request:fresh})
  const changedResult=await confirmReview(fresh.instructions.confirm)
  assert.equal(changedResult.status,'collected')
  await onState({label:'collected',customer:customers[0],invoice:changed.id,request:changedResult})
  const uncertain=await api('collection.prepare',{invoice:unknown.id})
  await onState({label:'review',customer:customers[1],invoice:unknown.id,request:uncertain})
  edge.losePayment()
  const lost=await confirmReview(uncertain.instructions.confirm)
  assert.equal(lost.status,'uncertain')
  await onState({label:'uncertain',customer:customers[1],invoice:unknown.id,request:lost})
  assert.equal((await api(`invoices/${unknown.id}`)).paidCents,0,'A lost provider response never fabricates payment evidence')
  const posts=edge.calls.filter(call=>call.method==='POST').length
  edge.setSearchVisible(false)
  const recoveryStart=edge.calls.length
  const recovered=await api('collection.reconcile',{request:lost.id})
  assert.ok(edge.calls.slice(recoveryStart).some(call=>call.path==='/payment_intents/search'))
  assert.ok(edge.calls.slice(recoveryStart).some(call=>call.path==='/payment_intents'&&call.method==='GET'),'An eventually consistent search miss is independently reconciled by customer/time-window list')
  edge.setSearchVisible(true)
  assert.equal(recovered.status,'collected');assert.ok(recovered.charge_ref)
  assert.equal((await api(`invoices/${unknown.id}`)).paidCents,10000)
  assert.equal(edge.calls.filter(call=>call.method==='POST').length,posts,'Recovery only reads provider evidence')
  assert.equal((await api('collection.reconcile',{request:lost.id})).payment_id,recovered.payment_id)
  await api('collection.confirm',uncertain.instructions.confirm,409)
  assert.deepEqual(edge.calls.filter(call=>call.path==='/payment_intents'&&call.method==='POST').map(call=>[call.account,Number(call.form.amount)]),[[1,7500],[1,9000],[2,10000]],'Each issued invoice charges its own frozen Stripe account exactly once')
  assert.equal((await api('reports/collections?period=2026-10')).totalCents,36500,'Native processor receipts join ordinary collection reports once')
  await onState({label:'reconciled',customer:customers[1],invoice:unknown.id,request:recovered})
  for(const [code,status] of [['card_declined','declined'],['authentication_required','customer_action_required']]){
    const refusedInvoice=await invoice(customers[0]),review=await api('collection.prepare',{invoice:refusedInvoice.id})
    const beforePosts=edge.calls.filter(call=>call.method==='POST').length,beforeIntents=edge.intents.size
    await onState({label:'review',customer:customers[0],invoice:refusedInvoice.id,request:review})
    edge.refuseNext(code)
    const refused=await confirmReview(review.instructions.confirm)
    assert.equal(refused.status,status);assert.equal(refused.error_code,code);assert.ok(refused.payment_intent_ref)
    assert.equal(refused.payment_id,null)
    await onState({label:status,customer:customers[0],invoice:refusedInvoice.id,request:refused})
    const owed=await api(`invoices/${refusedInvoice.id}`)
    assert.deepEqual([owed.paidCents,owed.balanceCents],[0,10000],'A definitive provider refusal leaves the invoice owed')
    await api('collection.confirm',review.instructions.confirm,409)
    await api('collection.prepare',{invoice:refusedInvoice.id},409)
    assert.equal((await api('collection.reconcile',{request:refused.id})).status,status)
    assert.equal(edge.intents.size,beforeIntents+1)
    assert.equal(edge.calls.filter(call=>call.method==='POST').length,beforePosts+1,'Definitive refusal replay never creates a second PaymentIntent')
  }
  // Native failure and financial recovery feed the same entitlement answer.
  const feature='synthetic-nectar-native-access'
  const product=(await api('product.create',{code:feature,name:'Native payment access'})).id
  const price=(await api('price.create',{product,kind:'flat',unit_amount:'10',taxable:false})).id
  await api('feature.grant',{product,feature})
  const preparedPolicy=await api('feature.policy',{product,feature,quota_policy:'soft',numeric_limit:'25',grace_days:0})
  const financeFactor=await h.api('mfa.totp.start',finance,{})
  await h.api('mfa.totp.confirm',finance,{factor:financeFactor.factor,code:totp(financeFactor.secret,instant)})
  await h.api('policy.decide',finance,{request:preparedPolicy.request,decision:'approved'})
  const subscription=(await api('subscription.create',{customer:customers[0],price:[price],start_date:'2026-09-01',anchor_day:1})).id
  const run=await api('billrun.prepare',{period:'2026-09'})
  const service=(await api(`runs/${run.id}`)).invoices.find(row=>row.subscription_id===subscription)
  assert.ok(service)
  await api('invoice.approve',{invoice:service.id,acknowledge:true})
  await api('invoice.finalise',{invoice:service.id,issue_date:'2026-10-01'})
  const access=()=>api(`entitlements/${customers[0]}?feature=${feature}`)
  assert.equal((await access()).paths[0].state.payment.status,'current')
  const review=await api('collection.prepare',{invoice:service.id})
  edge.refuseNext('card_declined')
  const failureStart=performance.now()
  assert.equal((await confirmReview(review.instructions.confirm)).status,'declined')
  const failed=await access(),failurePath=failed.paths.find(row=>row.subscription===subscription)
  assert.equal(failurePath.state.payment.status,'past_due')
  assert.ok(failurePath.state.payment.failures.some(row=>row.invoice===service.id&&row.status==='declined'))
  assert.ok(performance.now()-failureStart<5000,'A recorded native failure is visible within five seconds')
  assert.equal(failed.allowed,true,'A failure cannot bypass the independently approved invoice grace boundary')
  const recovery=await api('payment.record',{customer:customers[0],amount:'10',received_on:'2026-10-22',method:'bank_transfer',reference:'synthetic-nectar-native-recovery'})
  assert.equal((await access()).paths[0].state.payment.status,'past_due','Unallocated money does not clear the payment state')
  await api('payment.allocate',{payment:recovery.payment,invoice:service.id,amount:'10'})
  const restored=await access()
  assert.equal(restored.paths[0].state.payment.status,'current')
  assert.deepEqual(restored.paths[0].state.payment.failures,[])
  assert.equal(restored.paths[0].numericLimit,'25.00')
  const missingInvoice=await invoice(customers[0]),missingReview=await api('collection.prepare',{invoice:missingInvoice.id})
  const beforeMissingIntents=edge.intents.size
  edge.loseBeforePayment()
  const missing=await api('collection.confirm',missingReview.instructions.confirm)
  assert.equal(missing.status,'uncertain')
  const beforeMissingReads=edge.calls.filter(call=>call.method==='POST').length
  assert.equal((await api('collection.reconcile',{request:missing.id})).status,'uncertain','Search and list not-found never turn an unknown outcome into permission to charge again')
  await api('collection.confirm',missingReview.instructions.confirm,409)
  await api('collection.prepare',{invoice:missingInvoice.id},409)
  assert.equal(edge.intents.size,beforeMissingIntents)
  assert.equal(edge.calls.filter(call=>call.method==='POST').length,beforeMissingReads)
  assert.deepEqual([(await api(`invoices/${missingInvoice.id}`)).paidCents,(await api(`invoices/${missingInvoice.id}`)).balanceCents],[0,10000])
  const customerInvoice=await invoice(customers[0]),customerReview=await api('collection.prepare',{invoice:customerInvoice.id})
  const customer=await api(`customers/${customers[0]}`),beforeCustomerChange=edge.calls.length
  await api('customer.update',{customer:customer.id,revision:customer.revision,name:'Native collection customer updated',billing_email:customer.billing_email})
  await api('collection.confirm',customerReview.instructions.confirm,409)
  assert.equal(edge.calls.length,beforeCustomerChange,'Customer revision changes invalidate the review before Stripe is read')
  const factorReview=await api('collection.prepare',{invoice:customerInvoice.id})
  const erasedPending=await api('collection.prepare',{invoice:erasedInvoice.id})
  const erasure=await api('erasure.request',{customer:customers[2]})
  await api('erasure.verify',{request:erasure.id,reason:'Customer identity independently verified',evidence:file('native-owner.txt','Synthetic independently checked identity','text/plain')})
  await api('erasure.approve',{request:erasure.id,confirm:true})
  await api('collection.confirm',erasedPending.instructions.confirm,404)
  await api('collection.prepare',{invoice:erasedInvoice.id},409)
  const beforeExpired=edge.calls.length
  instant+=16*60*1000;await h.advanceClock(new Date(instant).toISOString())
  assert.equal((await api('collection.prepare',{invoice:changed.id},403)).error,'mfa_step_up_required')
  assert.equal((await api('collection.confirm',factorReview.instructions.confirm,403)).error,'mfa_step_up_required')
  assert.equal((await api('collection.reconcile',{request:missing.id},403)).error,'mfa_step_up_required')
  assert.ok(Array.isArray(await api('native-collections')),'Owner read access remains available without a fresh factor')
  assert.equal(edge.calls.length,beforeExpired,'Stale owner factor is refused before reading Stripe')
  await api('mfa.verify',{code:totp(secret,instant)})
  assert.equal((await api('collection.reconcile',{request:result.id})).status,'collected')
  console.log('Native collection: two frozen accounts, exact current balances, explicit owner confirmation, captured proof, atomic payment/allocation, read-only search/list recovery, definitive declined/authentication outcomes, concurrent confirmation, no second intent and erasure/factor boundaries')
}
