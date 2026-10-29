import assert from 'node:assert/strict'
import { file } from './harness.mjs'
import { totp } from './mfa.mjs'
import { assertNativeRecovery } from './retry-comparison-description.mjs'
import { assertRecoveryBuckets, assertRecoveryTotals } from './recovery-assertions.mjs'

export function nativeCollectionEdge() {
  const calls=[],intents=new Map(),charges=new Map(),keys=new Set(),customers=new Map(),accounts=new Map([[1,'synthetic-nectar-native-account-1'],[2,'synthetic-nectar-native-account-2']])
  let loseNext=false,loseBeforeNext=false,refusalNext=null,pendingNext=false,searchVisible=true,created=Date.parse('2026-10-22T10:00:00Z')/1000
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
        Object.assign(intent,{status:'requires_payment_method',payment_method:null,amount_received:0,latest_charge:null,last_payment_error:{code:typeof code==='string'?code:code.code,...(code.declineCode?{decline_code:code.declineCode}:{}),payment_method:{id:form.get('payment_method')}}})
        if(code.advice)charges.set(charge,{account,value:{object:'charge',id:charge,payment_intent:id,customer:intent.customer,status:'failed',paid:false,captured:false,outcome:{advice_code:'do_not_try_again'}}})
        intents.set(id,{account,value:intent})
        return Response.json({error:{type:'card_error',code,payment_intent:intent}},{status:402})
      }
      if(pendingNext){pendingNext=false;Object.assign(intent,{status:'processing',amount_received:0,latest_charge:null});intents.set(id,{account,value:intent});return Response.json(intent)}
      intents.set(id,{account,value:intent})
      charges.set(charge,{account,value:{object:'charge',id:charge,status:'succeeded',paid:true,captured:true,customer:intent.customer,payment_method:intent.payment_method,payment_intent:id,
        currency:'usd',amount:intent.amount,amount_captured:intent.amount,amount_refunded:0,refunded:false,disputed:false,created,livemode:false}})
      if(loseNext){loseNext=false;return new Response(null,{status:503})}
      return Response.json(intent)
    }
    if(method==='POST'&&/^\/payment_intents\/[^/]+\/confirm$/.test(path)){
      const row=intents.get(path.split('/')[2]);assert.ok(row&&row.account===account)
      const intent=row.value,key=request.headers.get('Idempotency-Key')
      assert.ok(key&&!keys.has(key),'Each recovery confirmation reaches the paid edge once');keys.add(key)
      assert.equal(intent.status,'requires_payment_method')
      for(const field of ['amount','currency','customer','receipt_email'])assert.equal(form.get(field),null,'Recovery cannot replace the original intent economics or request an email')
      assert.equal(form.get('payment_method'),intent.last_payment_error.payment_method.id)
      assert.equal(form.get('payment_method'),customers.get(intent.customer).method)
      assert.equal(form.get('off_session'),'true')
      const charge=`synthetic-nectar-recovery-charge-${calls.length}`
      if(refusalNext){
        const code=refusalNext;refusalNext=null
        Object.assign(intent,{status:'requires_payment_method',payment_method:null,amount_received:0,latest_charge:null,last_payment_error:{code,payment_method:{id:form.get('payment_method')}}})
        return Response.json({error:{type:'card_error',code,payment_intent:intent}},{status:402})
      }
      Object.assign(intent,{status:'succeeded',payment_method:form.get('payment_method'),amount_received:intent.amount,latest_charge:charge})
      delete intent.last_payment_error
      charges.set(charge,{account,value:{object:'charge',id:charge,status:'succeeded',paid:true,captured:true,customer:intent.customer,payment_method:intent.payment_method,payment_intent:intent.id,
        currency:intent.currency,amount:intent.amount,amount_captured:intent.amount,amount_refunded:0,refunded:false,disputed:false,created,livemode:false}})
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
  return {fetch,calls,customers,accounts,intents,charges,pendingPayment(){pendingNext=true},losePayment(){loseNext=true},loseBeforePayment(){loseBeforeNext=true},refuseNext(code,declineCode=null,advice=false){refusalNext=declineCode||advice?{code,declineCode,advice}:code},setSearchVisible(value){searchVisible=value},capturedAt(instant){created=Date.parse(instant)/1000}}
}

const edge=nativeCollectionEdge()

export const harnessOptions=()=>({stripeFetch:edge.fetch,stripeSecret:'synthetic-nectar-1',stripeSecondarySecret:'synthetic-nectar-2'})

export async function nativeCollectionFlow(h,owner,{onState=async()=>{},confirm,prepareRecovery,confirmRecovery}={}) {
  const api=(path,body,status)=>h.api(path,owner,body,status)
  const confirmReview=confirm??(payload=>api('collection.confirm',payload))
  const reviewRecovery=prepareRecovery??(request=>api('collection.recovery.prepare',{request}))
  const recoverReview=confirmRecovery??(payload=>api('collection.recovery.confirm',payload))
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
  for(const who of [finance,credential,undefined])for(const action of ['collection.customer.bind','collection.prepare','collection.confirm','collection.reconcile','collection.recovery.prepare','collection.recovery.confirm'])await h.api(action,who,{},who?403:401)
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
  const voidBasis={invoice:unknown.id,basis:unknown.source_fingerprint,reason:'Synthetic unresolved capture correction',confirm:true}
  const voidRequest=await api('invoice.void.prepare',voidBasis)
  const beforeLostInvoice=await api(`invoices/${unknown.id}`)
  const beforeLostCustomer=await api(`customers/${customers[1]}`)
  assert.deepEqual(beforeLostCustomer.ledger.invoices.map(row=>row.id),[unknown.id])
  const uncertain=await api('collection.prepare',{invoice:unknown.id})
  await onState({label:'review',customer:customers[1],invoice:unknown.id,request:uncertain})
  edge.losePayment()
  const lost=await confirmReview(uncertain.instructions.confirm)
  assert.equal(lost.status,'uncertain')
  const captureWrites=edge.calls.filter(call=>call.method==='POST').length
  for(const action of ['invoice.void','invoice.void.prepare']) {
    const refused=await api(action,{...voidBasis,request:voidRequest.request},409)
    assert.equal(refused.error,'invoice_collection_unresolved','An unresolved captured card cannot be voided or reissued, including a request prepared before the capture')
  }
  assert.deepEqual(await api(`invoices/${unknown.id}`),beforeLostInvoice,'Refused voids create no credit or replacement and preserve reconciliation basis')
  assert.deepEqual((await api(`customers/${customers[1]}`)).ledger.invoices,beforeLostCustomer.ledger.invoices)
  assert.equal(edge.calls.filter(call=>call.method==='POST').length,captureWrites,'A refused void sends no provider write')
  assert.equal((await api('recovery')).invoices.some(r=>r.invoice===unknown.id),false,'An uncertain first attempt creates neither failed nor recovered cash')
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
  await api('invoice.void',{...voidBasis,request:voidRequest.request},409)
  await api('collection.prepare',{invoice:unknown.id},409)
  const processorCaptured=[...edge.charges.values()].reduce((sum,row)=>sum+row.value.amount_captured,0)
  const nativeRecorded=(await api('payments')).filter(row=>row.method==='card_external').reduce((sum,row)=>sum+row.amount_cents,0)
  assert.equal(processorCaptured,26500,'The two ordinary captures and the lost-response capture total exactly USD 265')
  assert.equal(nativeRecorded,processorCaptured,'Every processor capture is recorded once; void and reissue cannot hide an original capture or charge another USD 100')
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
    if(code==='authentication_required') {
      const safeReplacement=await api('invoice.void',{invoice:owed.id,basis:owed.source_fingerprint,reason:'Synthetic correction after definitive no-capture proof',confirm:true})
      assert.equal((await api(`invoices/${safeReplacement.id}`)).status,'draft','Definitive no-capture refusals remain ordinary unpaid invoices that can be corrected')
      assert.equal(edge.calls.filter(call=>call.method==='POST').length,beforePosts+1)
      assert.equal((await api(`invoices/${owed.id}`)).paidCents,0)
    }
  }
  // The authentication refusal prohibits the old saved method. Subsequent
  // independent scenarios use a newly supplied provider method.
  edge.customers.get('synthetic-nectar-native-customer-1').method='synthetic-nectar-native-replacement-1'
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
  for(const action of ['invoice.void.prepare','invoice.void'])assert.equal((await api(action,{invoice:missingInvoice.id,basis:missingInvoice.source_fingerprint,reason:'Synthetic unknown capture correction',confirm:true},409)).error,'invoice_collection_unresolved')
  assert.equal(edge.intents.size,beforeMissingIntents)
  assert.equal(edge.calls.filter(call=>call.method==='POST').length,beforeMissingReads)
  assert.deepEqual([(await api(`invoices/${missingInvoice.id}`)).paidCents,(await api(`invoices/${missingInvoice.id}`)).balanceCents],[0,10000])
  // A recorded dispute pauses collection of exactly its disputed amount; resolving it resumes only what the ordinary rules still allow.
  const postsNow=()=>edge.calls.filter(call=>call.method==='POST').length
  const partlyDisputed=await invoice(customers[0]),fullyDisputed=await invoice(customers[0]),lateDispute=await invoice(customers[0])
  const partial=await api('cadence.dispute',{invoice:partlyDisputed.id,line:partlyDisputed.lines[0].id,amount_cents:3000,reason:'Customer disputes part of the source charge'})
  const full=await api('cadence.dispute',{invoice:fullyDisputed.id,line:fullyDisputed.lines[0].id,amount_cents:10000,reason:'Customer disputes the whole source charge'})
  const disputeReview=await api('collection.prepare',{invoice:partlyDisputed.id})
  assert.equal(disputeReview.amount_cents,7000,'Only the undisputed amount is collectible')
  await onState({label:'review',customer:customers[0],invoice:partlyDisputed.id,request:disputeReview})
  const beforeFull=postsNow()
  assert.equal((await api('collection.prepare',{invoice:fullyDisputed.id},409)).error,'native_collection_paused_for_dispute')
  const reviewed=await api('collection.prepare',{invoice:lateDispute.id})
  await api('cadence.dispute',{invoice:lateDispute.id,line:lateDispute.lines[0].id,amount_cents:2000,reason:'Disputed after the review was prepared'})
  assert.equal((await api('collection.confirm',reviewed.instructions.confirm,409)).error,'native_collection_basis_changed','A dispute recorded after review pauses the pending charge')
  assert.equal(postsNow(),beforeFull,'A paused collection never reaches the provider')
  const partialResult=await confirmReview(disputeReview.instructions.confirm)
  assert.equal(partialResult.status,'collected')
  assert.equal(Number(edge.calls.filter(call=>call.method==='POST'&&call.path==='/payment_intents').at(-1).form.amount),7000,'The provider is charged the undisputed amount only')
  const settledPartial=await api(`invoices/${partlyDisputed.id}`)
  assert.deepEqual([settledPartial.paidCents,settledPartial.balanceCents],[7000,3000],'The disputed amount stays owed')
  for(const [before,after] of [[partlyDisputed,settledPartial],[fullyDisputed,await api(`invoices/${fullyDisputed.id}`)]])assert.deepEqual([after.calculation,after.lines,after.subtotal_cents,after.tax_cents,after.total_cents],[before.calculation,before.lines,before.subtotal_cents,before.tax_cents,before.total_cents],'A dispute changes no issued evidence, debt or tax')
  assert.equal((await api('collection.prepare',{invoice:partlyDisputed.id},409)).error,'native_collection_paused_for_dispute','The remaining disputed amount stays paused')
  await api('cadence.resolve',{dispute:partial.dispute,outcome:'Customer paid the disputed part through another method'})
  await api('cadence.resolve',{dispute:full.dispute,outcome:'Charge confirmed correct after review'})
  const resumed=await api('collection.prepare',{invoice:fullyDisputed.id})
  assert.equal(resumed.amount_cents,10000,'Resolution restores collection of the full owed balance')
  assert.equal((await api('collection.prepare',{invoice:partlyDisputed.id},409)).error,'native_collection_already_claimed','Resolution never lifts a broader existing stop')
  assert.equal((await api('collection.prepare',{invoice:lateDispute.id})).amount_cents,8000,'An open dispute still limits its own invoice')
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
  const recordedFailures=(await api('native-collections')).filter(r=>['declined','customer_action_required'].includes(r.status))
  let recoveryReport=await api('recovery')
  for(const failure of recordedFailures){const cohort=recoveryReport.invoices.find(i=>i.invoice===failure.invoice_id);assert.ok(cohort,'Every recorded native payment refusal joins recovery reporting');assert.equal(cohort.failedAmountCents,failure.amount_cents)}
  assert.equal(recoveryReport.totals.failedAmountCents,recordedFailures.reduce((sum,r)=>sum+r.amount_cents,0))
  const unattributedBefore=recoveryReport.byAttempt.find(b=>b.key==='unattributed')?.recoveredAmountCents??0
  const remaining=await Promise.all(recordedFailures.map(async failure=>({failure,invoice:await api(`invoices/${failure.invoice_id}`)})))
  const failure=remaining.find(r=>r.invoice.balanceCents===r.failure.amount_cents).failure,cash=await api('payment.record',{customer:failure.customer_id,amount:(failure.amount_cents/100).toFixed(2),received_on:'2026-10-22',method:'bank_transfer',reference:'synthetic-nectar-refusal-recovery'})
  await api('payment.allocate',{payment:cash.payment,invoice:failure.invoice_id,amount:(failure.amount_cents/100).toFixed(2)})
  recoveryReport=await api('recovery');assert.equal(recoveryReport.invoices.find(i=>i.invoice===failure.invoice_id).recoveredAmountCents,failure.amount_cents)
  assert.equal(recoveryReport.byAttempt.find(b=>b.key==='unattributed').recoveredAmountCents,unattributedBefore+failure.amount_cents,'Manual cash recovery is not attributed to a processor retry')
  // A smaller first failure survives later balance changes. Pre-failure cash,
  // credits and unallocated money cannot become recovery; later cash is capped.
  const recoveryInvoice=await invoice(customers[0])
  const beforeFailure=await api('payment.record',{customer:customers[0],amount:'20',received_on:'2026-10-22',method:'bank_transfer',reference:'synthetic-nectar-903'})
  await api('payment.allocate',{payment:beforeFailure.payment,invoice:recoveryInvoice.id,amount:'20'})
  instant+=1000;await h.advanceClock(new Date(instant).toISOString());edge.capturedAt(new Date(instant).toISOString())
  const heldRecovery=await api('cadence.dispute',{invoice:recoveryInvoice.id,line:recoveryInvoice.lines[0].id,amount_cents:5000,reason:'Synthetic disputed amount limits first collection'})
  const limitedReview=await api('collection.prepare',{invoice:recoveryInvoice.id})
  assert.equal(limitedReview.amount_cents,3000)
  edge.refuseNext('card_declined')
  const limitedFailure=await api('collection.confirm',limitedReview.instructions.confirm)
  assert.equal(limitedFailure.status,'declined')
  const firstFailedAt=instant
  const readCohort=async()=>{
    const report=await api('recovery'),row=report.invoices.find(r=>r.invoice===recoveryInvoice.id)
    assert.ok(row)
    assert.deepEqual([row.firstFailedAt,row.failedAmountCents],[firstFailedAt,3000])
    return {report,row}
  }
  let recoveryState=await readCohort()
  assert.equal(recoveryState.row.recoveredAmountCents,0,'Cash allocated before the first failure is excluded')
  await api('cadence.resolve',{dispute:heldRecovery.dispute,outcome:'Synthetic dispute resolved'})
  instant+=1000;await h.advanceClock(new Date(instant).toISOString())
  const partialCash=await api('payment.record',{customer:customers[0],amount:'10',received_on:'2026-10-22',method:'bank_transfer',reference:'synthetic-nectar-904'})
  assert.equal((await readCohort()).row.recoveredAmountCents,0,'Unallocated cash does not recover a failed invoice')
  await api('payment.allocate',{payment:partialCash.payment,invoice:recoveryInvoice.id,amount:'10'})
  recoveryState=await readCohort()
  assert.equal(recoveryState.row.recoveredAmountCents,1000)
  const partialRows=recoveryState.report.invoices.map(row=>({...row,recoveredAmountCents:row.invoice===recoveryInvoice.id?1000:row.recoveredAmountCents}))
  assertRecoveryTotals(recoveryState.report.totals,partialRows)
  await api('credit.issue',{invoice:recoveryInvoice.id,amount:'10',reason:'Synthetic credit is not recovered cash'})
  assert.equal((await readCohort()).row.recoveredAmountCents,1000,'Credits reduce debt without increasing recovered revenue')
  const pendingInvoice=await invoice(customers[0]),pendingReview=await api('collection.prepare',{invoice:pendingInvoice.id})
  let withoutPending=await api('recovery')
  assert.equal(withoutPending.invoices.some(row=>row.invoice===pendingInvoice.id),false,'A prepared pending collection is not a failed cohort or recovered cash')
  edge.pendingPayment()
  const processing=await api('collection.confirm',pendingReview.instructions.confirm)
  assert.equal(processing.status,'uncertain')
  for(const action of ['invoice.void.prepare','invoice.void'])assert.equal((await api(action,{invoice:pendingInvoice.id,basis:pendingInvoice.source_fingerprint,reason:'Synthetic processing capture correction',confirm:true},409)).error,'invoice_collection_unresolved')
  assert.deepEqual((await api('recovery')).totals,withoutPending.totals,'Provider processing and unresolved uncertainty create no recovered cash')
  const laterCash=await api('payment.record',{customer:customers[0],amount:'60',received_on:'2026-10-22',method:'bank_transfer',reference:'synthetic-nectar-905'})
  await api('payment.allocate',{payment:laterCash.payment,invoice:recoveryInvoice.id,amount:'60'})
  recoveryState=await readCohort()
  assert.equal((await api(`invoices/${recoveryInvoice.id}`)).paidCents,9000)
  assert.equal(recoveryState.row.recoveredAmountCents,3000,'Post-failure cash above the first failed amount is capped')
  assert.equal(recoveryState.row.recoveries.reduce((sum,row)=>sum+row.amountCents,0),3000)

  // The native trial scheduler and an issued prepaid purchase produce ordinary
  // refused collection evidence through their existing public doors.
  await h.api('mfa.verify',finance,{code:totp(financeFactor.secret,instant)})
  const prepaid=await api('prepaid.prepare',{subscription,mode:'grant',kind:'money',source:'purchase',amount:'40',effective_date:'2026-10-22',expires_date:'2027-10-22',priority:0,expiry_consent:true})
  await h.api('prepaid.decide',finance,{request:prepaid.request,decision:'approved'})
  const purchase=await api('prepaid.purchase.prepare',{intent:prepaid.request,issue_date:'2026-10-22'})
  await api('invoice.approve',{invoice:purchase.invoice,acknowledge:true})
  await api('invoice.finalise',{invoice:purchase.invoice,issue_date:'2026-10-22'})
  const purchaseReview=await api('collection.prepare',{invoice:purchase.invoice})
  edge.refuseNext('card_declined')
  assert.equal((await api('collection.confirm',purchaseReview.instructions.confirm)).status,'declined')
  assert.ok((await api(`invoices/${purchase.invoice}`)).lines.some(line=>line.kind==='prepaid_purchase'))
  assert.equal((await api('recovery')).invoices.find(row=>row.invoice===purchase.invoice).failedAmountCents,4000)
  const trialProduct=(await api('product.create',{code:'synthetic-nectar-906',name:'Synthetic trial recovery'})).id
  const trialPrice=(await api('price.create',{product:trialProduct,kind:'flat',unit_amount:'100',taxable:false,billing_timing:'advance'})).id
  const trialSub=(await api('subscription.create',{customer:customers[0],start_date:'2026-10-01',anchor_day:1,price:[trialPrice],trial_end:'2026-10-23',trial_payment:'card'})).id
  const trialReview=await api('trial.collection.prepare',{subscription:trialSub})
  const trialConsent=await api('trial.collection.confirm',trialReview.instructions.confirm)
  await h.api('trial.collection.approve',finance,{request:trialConsent.id,basis_hash:trialConsent.basis,decision:'approved'})
  instant=Date.parse('2026-10-23T10:00:00Z');await h.advanceClock(new Date(instant).toISOString());edge.capturedAt(new Date(instant).toISOString())
  edge.refuseNext('card_declined')
  assert.equal((await h.raw(`/cdn-cgi/local/scheduled?time=${instant}&cron=${encodeURIComponent('0 14 * * *')}`)).status,200)
  const trialResult=(await api(`trial-collections?subscription=${trialSub}`)).find(row=>row.id===trialConsent.id)
  assert.equal(trialResult.status,'declined')
  const finalReport=await api('recovery'),trialCohort=finalReport.invoices.find(row=>row.invoice===trialResult.invoice)
  assert.ok(trialCohort,'A native scheduled trial refusal enters recovery reporting')
  assert.deepEqual([trialCohort.firstFailedAt,trialCohort.failedAmountCents,trialCohort.recoveredAmountCents],[instant,trialReview.quote.amountCents,0])
  const finalFailures=(await api('native-collections')).filter(row=>['declined','customer_action_required'].includes(row.status))
  const expectedRows=[]
  for(const failure of finalFailures){
    const source=await api(`invoices/${failure.invoice_id}`)
    const allocations=source.allocations.filter(row=>row.allocated_at>=failure.reconciled_at).sort((a,b)=>a.allocated_at-b.allocated_at||a.id.localeCompare(b.id))
    let remainder=failure.amount_cents
    const recoveries=[]
    for(const allocation of allocations){const amountCents=Math.min(remainder,allocation.amount_cents);if(amountCents){recoveries.push({amountCents,attempt:null,step:null});remainder-=amountCents}}
    expectedRows.push({invoice:failure.invoice_id,currency:source.currency,declineCode:failure.error_code,failedAmountCents:failure.amount_cents,recoveredAmountCents:failure.amount_cents-remainder,attempts:[{attempt:1,step:null}],recoveries})
  }
  assert.deepEqual(finalReport.invoices.map(row=>row.invoice).sort(),expectedRows.map(row=>row.invoice).sort())
  assertRecoveryBuckets(finalReport,expectedRows)
  await api('mfa.verify',{code:totp(secret,instant)})
  edge.customers.get('synthetic-nectar-native-customer-1').method='synthetic-nectar-native-void-new-card'
  const unclaimed=await invoice(customers[0]),unclaimedReview=await api('collection.prepare',{invoice:unclaimed.id})
  const unclaimedPosts=postsNow()
  const replacement=await api('invoice.void',{invoice:unclaimed.id,basis:unclaimed.source_fingerprint,reason:'Synthetic correction before any provider claim',confirm:true})
  await api('collection.confirm',unclaimedReview.instructions.confirm,409)
  assert.equal(postsNow(),unclaimedPosts,'A review prepared before a successful void cannot later claim or capture the original')
  assert.equal((await api(`invoices/${replacement.id}`)).total_cents,10000)
  assert.equal((await api(`invoices/${unclaimed.id}`)).balanceCents,0)
  // Same-card recovery uses the original intent, a fresh review and one separate
  // confirmation. All setup and assertions use ordinary Worker and D1 doors.
  {
  const recoverySavedMethod=edge.customers.get('synthetic-nectar-native-customer-1').method
  const recoverySources=[]
  const refuseSource=async(code='processing_error',decline=null,customer=customers[0],advice=false)=>{
    const source=await invoice(customer),review=await api('collection.prepare',{invoice:source.id})
    edge.refuseNext(code,decline,advice)
    const failed=await api('collection.confirm',review.instructions.confirm)
    assert.equal(failed.status,code==='authentication_required'?'customer_action_required':'declined')
    recoverySources.push(failed)
    return {source,failed}
  }
  const success=await refuseSource(),lostRecovery=await refuseSource(),secondRefusal=await refuseSource(),staleRecovery=await refuseSource(),heldRecovery=await refuseSource(),erasedRecovery=await refuseSource('processing_error',null,customers[1])
  const hardStops=[]
  // Unknown reasons and explicit provider advice are also closed by default.
  for(const [code,decline,advice] of [['card_declined',null,false],['card_declined','stolen_card',false],['authentication_required',null,false],['processing_error',null,true]]){
    // A different synthetic card prevents a permanent hard decline on an earlier
    // source from authorizing or blocking the independently seeded next case.
    const saved=edge.customers.get('synthetic-nectar-native-customer-1')
    saved.method=`synthetic-nectar-safe-card-${recoverySources.length}`
    hardStops.push(await refuseSource(code,decline,customers[0],advice))
  }
  edge.customers.get('synthetic-nectar-native-customer-1').method=recoverySavedMethod
  const originalIntents=edge.intents.size,originalCreates=edge.calls.filter(c=>c.method==='POST'&&c.path==='/payment_intents').length
  // The published retry delay and configured count and window remain limits.
  await api('collection.recovery.prepare',{request:success.failed.id},409)
  instant+=4*3600000;await h.advanceClock(new Date(instant).toISOString());edge.capturedAt(new Date(instant).toISOString())
  const beforeStaleFactor=postsNow()
  await api('collection.recovery.prepare',{request:success.failed.id},403)
  await api('mfa.verify',{code:totp(secret,instant)})
  await api('retry.policy.configure',{max_attempts:1,window_days:14,confirm:true})
  await api('collection.recovery.prepare',{request:success.failed.id},409)
  await api('retry.policy.configure',{max_attempts:8,window_days:14,confirm:true})
  for(const {failed} of hardStops)await api('collection.recovery.prepare',{request:failed.id},409)
  assert.equal(postsNow(),beforeStaleFactor,'Expired factors, caps, unknown reasons, hard declines, authentication and provider advice never write Stripe')
  const frozenFirst=(await api('recovery')).invoices.find(r=>r.invoice===success.source.id)
  let good=await reviewRecovery(success.failed.id)
  const oldPolicyReview=good.instructions.reconfirm
  await api('retry.policy.configure',{max_attempts:4,window_days:7,confirm:true})
  await api('collection.recovery.confirm',oldPolicyReview,409)
  await api('retry.policy.configure',{max_attempts:8,window_days:14,confirm:true})
  await api('collection.recovery.confirm',oldPolicyReview,409)
  good=await reviewRecovery(success.failed.id)
  assert.equal(postsNow(),beforeStaleFactor,'Preparing recovery performs provider reads only')
  assert.equal(good.reconfirmation.firstFailedAt,success.failed.reconciled_at)
  assert.equal(good.reconfirmation.firstFailure.errorCode,'processing_error')
  await onState({label:'recovery-review',invoice:success.source.id,request:good})
  const payload=good.instructions.reconfirm
  assert.ok(payload)
  for(const changed of [{confirm:false},{basis_hash:'synthetic-nectar-stale-basis'},{amount_cents:9000},{account_ref:'synthetic-nectar-native-account-2'},{stripe_customer_ref:'synthetic-nectar-native-customer-4'},{payment_method_ref:'synthetic-nectar-native-other-card'}])await api('collection.recovery.confirm',{...payload,...changed},changed.confirm===false?400:409)
  const saved=edge.customers.get('synthetic-nectar-native-customer-1')
  saved.method='synthetic-nectar-native-changed-card'
  await api('collection.recovery.confirm',payload,409)
  saved.method=recoverySavedMethod
  edge.accounts.set(1,'synthetic-nectar-native-account-changed')
  await api('collection.recovery.confirm',payload,409)
  edge.accounts.set(1,'synthetic-nectar-native-account-1')
  assert.equal(postsNow(),beforeStaleFactor,'Changed review fields, saved card and provider account are refused before a provider write')
  let recoveredSame
  if(confirmRecovery)recoveredSame=await recoverReview(payload)
  else{
    const replies=await Promise.all([1,2].map(()=>h.raw('/api/nectar/collection.recovery.confirm',{cookie:owner,body:payload})))
    assert.deepEqual(replies.map(r=>r.status).sort(),[200,409],'Concurrent recovery confirmations claim exactly once')
    recoveredSame=await replies.find(r=>r.status===200).json()
  }
  assert.equal(recoveredSame.status,'collected')
  assert.equal(recoveredSame.payment_intent_ref,success.failed.payment_intent_ref)
  assert.deepEqual([(await api(`invoices/${success.source.id}`)).paidCents,(await api(`invoices/${success.source.id}`)).balanceCents],[10000,0])
  assert.equal((await api(`invoices/${success.source.id}`)).allocations.length,1)
  assert.equal((await api('payments')).filter(p=>p.id===recoveredSame.payment_id).length,1)
  const afterCapture=postsNow()
  await api('collection.recovery.confirm',payload,409)
  await api('collection.recovery.prepare',{request:success.failed.id},409)
  await api('collection.confirm',{...payload},400)
  assert.equal((await api('collection.reconcile',{request:success.failed.id})).payment_id,recoveredSame.payment_id)
  assert.equal(postsNow(),afterCapture,'Replay cannot charge again or allocate again')
  const recoveryReportAfterCapture=await api('recovery')
  assertNativeRecovery(recoveryReportAfterCapture,frozenFirst,10000)
  const addedRows=recoverySources.map(failed=>({invoice:failed.invoice_id,currency:'USD',declineCode:failed.proof.declineCode??failed.error_code,
    failedAmountCents:10000,recoveredAmountCents:failed.id===success.failed.id?10000:0,
    attempts:failed.id===success.failed.id?[{attempt:1,step:null},{attempt:2,step:null}]:[{attempt:1,step:null}],
    recoveries:failed.id===success.failed.id?[{amountCents:10000,attempt:2,step:null}]:[]}))
  assertRecoveryBuckets(recoveryReportAfterCapture,[...expectedRows,...addedRows])
  await onState({label:'recovery-collected',invoice:success.source.id,request:recoveredSame})
  const lostReview=await reviewRecovery(lostRecovery.failed.id)
  edge.losePayment()
  const lostAgain=await recoverReview(lostReview.instructions.reconfirm)
  assert.equal(lostAgain.status,'uncertain')
  assert.equal((await api(`invoices/${lostRecovery.source.id}`)).paidCents,0)
  const lostPosts=postsNow(),beforeRead=edge.calls.length
  await onState({label:'recovery-uncertain',invoice:lostRecovery.source.id,request:lostAgain})
  const readRecovery=await api('collection.reconcile',{request:lostAgain.id})
  assert.equal(readRecovery.status,'collected');assert.equal(readRecovery.payment_intent_ref,lostRecovery.failed.payment_intent_ref)
  assert.equal(postsNow(),lostPosts,'A lost reconfirmation response is reconciled only by reads')
  assert.ok(edge.calls.slice(beforeRead).filter(c=>c.method==='GET').length)
  assert.equal((await api(`invoices/${lostRecovery.source.id}`)).allocations.length,1)
  await api('collection.recovery.confirm',lostReview.instructions.reconfirm,409)
  const stale=await reviewRecovery(staleRecovery.failed.id)
  await api('credit.issue',{invoice:staleRecovery.source.id,amount:'1',reason:'Synthetic changed recovery amount'})
  await api('collection.recovery.confirm',stale.instructions.reconfirm,409)
  await api('collection.recovery.prepare',{request:staleRecovery.failed.id},409)
  const holdReview=await reviewRecovery(heldRecovery.failed.id)
  await api('cadence.dispute',{invoice:heldRecovery.source.id,line:heldRecovery.source.lines[0].id,amount_cents:1000,reason:'Synthetic recovery dispute'})
  await api('collection.recovery.confirm',holdReview.instructions.reconfirm,409)
  await api('collection.recovery.prepare',{request:heldRecovery.failed.id},409)
  const promised=await refuseSource()
  // Four elapsed hours and a current factor permit preparation, but a promise
  // recorded afterwards still stops the separate confirmation.
  instant+=4*3600000;await h.advanceClock(new Date(instant).toISOString());edge.capturedAt(new Date(instant).toISOString())
  await api('mfa.verify',{code:totp(secret,instant)})
  const promiseReview=await reviewRecovery(promised.failed.id)
  await api('cadence.promise',{invoice:promised.source.id,pay_date:'2026-10-24',note:'Synthetic dated customer promise'})
  await api('collection.recovery.confirm',promiseReview.instructions.reconfirm,409)
  await api('collection.recovery.prepare',{request:promised.failed.id},409)
  const staleCustomer=await reviewRecovery(erasedRecovery.failed.id)
  const c=await api(`customers/${customers[1]}`)
  await api('customer.update',{customer:c.id,revision:c.revision,name:'Synthetic revised recovery customer',billing_email:c.billing_email})
  await api('collection.recovery.confirm',staleCustomer.instructions.reconfirm,409)
  const eraseReview=await reviewRecovery(erasedRecovery.failed.id)
  const erase=await api('erasure.request',{customer:customers[1]})
  await api('erasure.verify',{request:erase.id,reason:'Synthetic independently verified identity',evidence:file('recovery-erasure.txt','Synthetic identity proof','text/plain')})
  await api('erasure.approve',{request:erase.id,confirm:true})
  await api('collection.recovery.confirm',eraseReview.instructions.reconfirm,404)
  await api('collection.recovery.prepare',{request:erasedRecovery.failed.id},404)
  const factor=await refuseSource()
  instant+=4*3600000;await h.advanceClock(new Date(instant).toISOString());edge.capturedAt(new Date(instant).toISOString())
  await api('mfa.verify',{code:totp(secret,instant)})
  const expires=await reviewRecovery(factor.failed.id),postExpiry=postsNow()
  instant+=16*60000;await h.advanceClock(new Date(instant).toISOString())
  await api('collection.recovery.confirm',expires.instructions.reconfirm,403)
  await api('mfa.verify',{code:totp(secret,instant)})
  await api('collection.recovery.confirm',expires.instructions.reconfirm,409)
  await api('retry.policy.configure',{max_attempts:1,window_days:14,confirm:true})
  await api('collection.recovery.prepare',{request:factor.failed.id},409)
  await api('retry.policy.configure',{max_attempts:8,window_days:14,confirm:true})
  assert.equal(postsNow(),postExpiry,'Expired preparation is not revived by a new factor')
  const refusalReview=await reviewRecovery(secondRefusal.failed.id)
  edge.refuseNext('authentication_required')
  const refusedAgain=await recoverReview(refusalReview.instructions.reconfirm)
  assert.equal(refusedAgain.status,'customer_action_required')
  assert.equal(refusedAgain.payment_intent_ref,secondRefusal.failed.payment_intent_ref)
  const retained=(await api('recovery')).invoices.find(r=>r.invoice===secondRefusal.source.id)
  assert.deepEqual([retained.firstFailedAt,retained.failedAmountCents,retained.declineCode,retained.recoveredAmountCents],[secondRefusal.failed.reconciled_at,10000,'processing_error',0])
  assert.deepEqual(retained.attempts.map(r=>[r.attempt,r.outcome]),[[1,'failed'],[2,'failed']])
  const attemptTwo=(await api('recovery')).byAttempt.find(r=>r.key==='2'&&r.currency==='USD')
  assert.deepEqual([attemptTwo.failedInvoices,attemptTwo.recoveredInvoices,attemptTwo.failedAmountCents,attemptTwo.recoveredAmountCents,attemptTwo.recoveryRate,attemptTwo.amountRecoveryRate],[3,2,30000,20000,2/3,2/3])
  assert.deepEqual([(await api(`invoices/${secondRefusal.source.id}`)).paidCents,(await api(`invoices/${secondRefusal.source.id}`)).balanceCents],[0,10000])
  const finalPosts=postsNow()
  await api('collection.recovery.prepare',{request:refusedAgain.id},409)
  await api('collection.recovery.confirm',refusalReview.instructions.reconfirm,409)
  assert.equal(postsNow(),finalPosts,'A refused recovery cannot be attempted a third time')
  await onState({label:'recovery-authentication-stop',invoice:secondRefusal.source.id,request:refusedAgain})
  instant+=15*86400000;await h.advanceClock(new Date(instant).toISOString())
  await api('mfa.verify',{code:totp(secret,instant)})
  assert.equal((await api('collection.recovery.prepare',{request:factor.failed.id},409)).error,'native_recovery_attempt_limit','The original failure window cannot be extended by a new preparation')
  assert.equal(postsNow(),finalPosts)
  assert.equal(edge.calls.filter(c=>c.method==='POST'&&c.path==='/payment_intents').length,originalCreates+2,'Only the two independently issued later test invoices create intents; recovery never does')
  assert.equal(edge.intents.size,originalIntents+2)
  assert.equal(edge.calls.filter(c=>c.method==='POST'&&c.path.endsWith('/confirm')).length,3,'Only the three explicitly confirmed recoveries reach the provider')
  console.log('Same-intent recovery: one allocation, immutable first failure and exact recovery rates; replay, changed sources, holds, erasure, stale factors and prohibited declines remain closed')
  }
  console.log('Native collection: two frozen accounts, exact current balances, explicit owner confirmation, captured proof, atomic payment/allocation, read-only search/list recovery, definitive declined/authentication outcomes, concurrent confirmation, no second intent and erasure/factor boundaries')
}

// Public-door automatic-collection checks share this retained journey module.
const automaticCollectionJourneys = await (async () => {
// Public Worker and D1 flow. Only the Stripe network edge controls settlement.
const { default: assert } = await import('node:assert/strict')
const { totp } = await import('./mfa.mjs')
const { file } = await import('./harness.mjs')

function automaticEdge(){
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
let edge
const harnessOptions=()=>{edge=automaticEdge();return {localTime:'2026-10-22T10:00:00Z',stripeFetch:edge.fetch,stripeSecret:'synthetic-nectar-1',stripeSecondarySecret:'synthetic-nectar-2'}}
async function automaticCollectionFlow(h,owner,{onState=async()=>{},prepareCollection,acceptCollection,decideCollection}={}){
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
 assert.equal((await api('automatic.collection.reconcile',{request:unknown.prepared.id})).status,'collected');assert.equal(edge.posts(),3)
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
 console.log('automaticCollectionFlow: exact consent, approval, immediate card cash, pending ACH and four-business-day edge settlement, send-invoice wait, event and issue replay, once-only uncertainty recovery, source and receipt parity and erasure')
}

return { automaticEdge, harnessOptions, automaticCollectionFlow }
})()
export const { automaticEdge, harnessOptions: automaticHarnessOptions, automaticCollectionFlow } = automaticCollectionJourneys
