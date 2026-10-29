// One money-safety journey through every shipped saved-card debit door. The
// Worker, D1, approvals and customer consent are real; only Stripe is substituted.
import assert from 'node:assert/strict'
import { nativeCollectionEdge } from './native-collection.mjs'
import { collectionCapture } from '../fixtures/stripe-collection-edge.mjs'
import { file } from './harness.mjs'
import { totp } from './mfa.mjs'

function prohibitionEdge() {
  const base=nativeCollectionEdge(),rules=new Map(),events=new Map(),invoices=new Map(),calls=[]
  let loseRefusal=false,mismatchRefusal=false
  const fetch=async request=>{
    const url=new URL(request.url),path=url.pathname.slice(3),method=request.method
    const form=method==='POST'?new URLSearchParams(await request.clone().text()):null
    calls.push({path,method,form:form?Object.fromEntries(form):null,account:request.headers.get('authorization')==='Bearer synthetic-nectar-2'?2:1})
    if(path.startsWith('/events/'))return Response.json(events.get(path.split('/').at(-1))??{})
    if(path==='/payment_intents/search'&&(url.searchParams.get('query')??'').includes('nectar_collection_key')) {
      const query=url.searchParams.get('query')
      return Response.json({object:'search_result',has_more:false,data:[...base.intents.values()].filter(row=>Object.values(row.value.metadata).filter(v=>typeof v==='string').some(v=>query.includes(v))).map(row=>row.value)})
    }
    if(path==='/invoice_payments')return Response.json({object:'list',data:[],has_more:false})
    if(path.startsWith('/invoices/')) {
      const row=invoices.get(path.split('/')[2]);assert.ok(row)
      if(form){
        if(path.endsWith('/pay')){assert.equal(form.get('paid_out_of_band'),'true');Object.assign(row,{status:'paid',amount_paid:row.total,amount_remaining:0,auto_advance:false,paid_out_of_band:true})}
        else {assert.equal(form.get('auto_advance'),'false');row.auto_advance=false}
      }
      return Response.json(row)
    }
    const response=await base.fetch(request)
    if(form&&(path==='/payment_intents'||/^\/payment_intents\/[^/]+\/confirm$/.test(path))&&response.ok) {
      const intent=await response.json(),code=rules.get(form.get('payment_method'))
      if(code) {
        const charge=base.charges.get(intent.latest_charge).value
        Object.assign(charge,{status:'failed',paid:false,captured:false,amount_captured:0})
        Object.assign(intent,{status:'requires_payment_method',payment_method:null,amount_received:0,
          last_payment_error:{code:'card_declined',decline_code:code,payment_method:{id:form.get('payment_method')}}})
        const embedded=structuredClone(intent)
        if(mismatchRefusal){mismatchRefusal=false;intent.customer='synthetic-nectar-foreign-intent-customer'}
        Object.assign(base.intents.get(intent.id).value,intent)
        if(loseRefusal){loseRefusal=false;return new Response(null,{status:503})}
        return Response.json({error:{payment_intent:embedded}},{status:402})
      }
      return Response.json(intent)
    }
    return response
  }
  return {...base,fetch,rules,events,invoices,traffic:calls,loseRefusal(){loseRefusal=true},mismatchRefusal(){mismatchRefusal=true},
    writes:()=>calls.filter(call=>call.method==='POST'&&(call.path==='/payment_intents'||call.path.endsWith('/confirm')))}
}
let edge
export const harnessOptions=()=>{edge=prohibitionEdge();return {localTime:'2026-10-22T10:00:00Z',stripeFetch:edge.fetch,stripeSecret:'synthetic-nectar-1',stripeSecondarySecret:'synthetic-nectar-2'}}

export async function cardProhibitionFamiliesFlow(h,owner) {
  const api=(path,body,status)=>h.api(path,owner,body,status)
  await api('business.configure',{...await api('business'),timezone:'UTC'})
  await api('portal.configure',{hosts:[h.origin],parents:[]})
  const factor=await api('mfa.totp.start',{})
  let at=Date.parse('2026-10-22T10:00:00Z'),index=0
  await api('mfa.totp.confirm',{factor:factor.factor,code:totp(factor.secret,at)})
  // Derive test addresses from the harness; no mailbox or provider key is held.
  const financeAddress=h.vars.OWNER_EMAIL.replace('owner','synthetic-nectar-finance')
  await api('access.give',{email:financeAddress,name:'Independent payment approver',role:'finance'})
  const finance=await h.signIn(financeAddress,{requested:true}),financeFactor=await h.api('mfa.totp.start',finance,{})
  await h.api('mfa.totp.confirm',finance,{factor:financeFactor.factor,code:totp(financeFactor.secret,at)})
  await api('mfa.policy',{scope:'roles',roles:['owner']})
  const move=async instant=>{at=instant;edge.capturedAt(new Date(at).toISOString());await h.advanceClock(new Date(at).toISOString());await api('mfa.verify',{code:totp(factor.secret,at)});await h.api('mfa.verify',finance,{code:totp(financeFactor.secret,at)})}
  const day=()=>new Date(at).toISOString().slice(0,10)
  const tick=async(daily=false)=>{const r=await h.raw(`/cdn-cgi/local/scheduled?time=${at}&cron=${encodeURIComponent(daily?'0 14 * * *':'* * * * *')}`);assert.equal(r.status,200,await r.text())}
  const product=(await api('product.create',{code:'synthetic-nectar-prohibition',name:'Saved card safety service'})).id
  const price=(await api('price.create',{product,kind:'flat',unit_amount:'100',taxable:false,billing_timing:'advance'})).id
  const secondary=(await api('entity.create',{revision:(await api('business')).revision,legal_name:'Independent secondary entity',address:'2 Synthetic Way',ein:'12-3456789',invoice_prefix:'SECOND',invoice_number_width:4,payment_terms_days:30,processor_account_ref:'synthetic-nectar-native-account-2',ledger_company_ref:'synthetic-nectar-ledger-2',tax_registration:'Synthetic tax registration'})).id
  const invoice=async(row,issued=true)=>{
    const charge=await api('charge.add',{customer:row.customer,amount:'100',description:'Saved card safety service',effective_date:day(),taxable:false})
    const id=(await api('invoice.manual',{customer:row.customer,charges:[charge.charge],service_date:day()})).id
    if(issued){await api('invoice.approve',{invoice:id,acknowledge:true});await api('invoice.finalise',{invoice:id,issue_date:day()})}
    return id
  }
  const native=async row=>api('collection.prepare',{invoice:await invoice(row)})
  const automatic=async(row,retries=false)=>{
    const id=await invoice(row,false),request=await api('automatic.collection.prepare',{invoice:id,issue_date:day(),enable_retries:retries})
    const session=await api('portal.session.issue',{customer:row.customer,origin:h.origin,audience:'hosted'})
    const response=await h.raw(`/portal/automatic-collections/${request.id}?session=${encodeURIComponent(session.token)}`,{body:{request:request.id,basis_hash:request.basis,accept:true}})
    assert.equal(response.status,200,await response.text())
    await h.api('automatic.collection.decide',finance,{request:request.id,basis_hash:request.basis,decision:'approved',confirm:true})
    return {id,request}
  }
  const issue=async prepared=>{await api('invoice.approve',{invoice:prepared.id,acknowledge:true});await api('invoice.finalise',{invoice:prepared.id,issue_date:day()})}
  const trial=async(row,end)=>{
    const subscription=(await api('subscription.create',{customer:row.customer,start_date:day().slice(0,7)+'-01',price:[price],trial_end:end,trial_payment:'card'})).id
    const request=await api('trial.collection.prepare',{subscription})
    await api('trial.collection.confirm',request.instructions.confirm)
    await h.api('trial.collection.approve',finance,{request:request.id,basis_hash:request.basis,decision:'approved'})
    return {subscription,request}
  }
  const topup=async row=>{
    const subscription=(await api('subscription.create',{customer:row.customer,start_date:day(),price:[price]})).id
    const request=await api('prepaid.prepare',{subscription,mode:'consent',kind:'money',source:'purchase',amount:'100',threshold:'10',effective_date:day(),expires_date:'2027-12-31',priority:10,expiry_consent:true,funding_consent:true})
    await h.api('prepaid.decide',finance,{request:request.request,decision:'approved'})
    const fields={consent:request.request,period_cap:'100',start_date:day(),end_date:'2027-12-01',account_ref:row.account}
    const authorization=await api('prepaid.topup.prepare',fields),session=await api('portal.session.issue',{customer:row.customer,origin:h.origin,audience:'hosted'})
    const response=await h.raw(`/portal/prepaid-topup.accept?session=${encodeURIComponent(session.token)}`,{body:{authorization:authorization.id,basis_hash:authorization.basis,accept:true}})
    assert.equal(response.status,200,await response.text())
    await h.api('prepaid.topup.decide',finance,{authorization:authorization.id,basis_hash:authorization.basis,decision:'approved'})
    return {subscription,fields,authorization}
  }
  const lifecycle=async row=>(await api(`customers/${row.customer}`)).billingRecord.cardLifecycle
  const prohibited=async(path,body)=>{
    const result=await api(path,body,409)
    assert.ok(['payment_method_unusable','precondition_failed'].includes(result.error),`${path}: the method refusal must reach its read or transactional fence`)
  }
  const refused=async(row,code)=>{
    const records=await lifecycle(row),record=records.find(r=>r.methodRef===row.method)
    assert.ok(record,`${row.family}: identity-matched ${code} must persist a prohibition`)
    assert.deepEqual([record.usable,record.unusableReason,record.accountRef,record.customerRef],[false,code,row.account,row.provider])
    const customer=await api(`customers/${row.customer}`)
    assert.ok(customer.billingRecord.cardLifecycle.some(r=>r.methodRef===row.method&&!r.usable),'Customer composition exposes the same prohibition')
  }
  for(const code of ['stolen_card','lost_card'])for(const family of ['native','reconfirmation','automatic','retry','trial','topup','imported']) {
    index++;console.log('PROHIBITION',code,family)
    await move(Date.parse('2026-10-22T10:00:00Z')+index*3*86400000)
    const provider=`synthetic-nectar-prohibited-customer-${index}`,method=`synthetic-nectar-prohibited-method-${index}`
    const row={family,provider,method,account:'synthetic-nectar-native-account-1'}
    edge.customers.set(provider,{account:1,method})
    let documents
    if(family==='imported') {
      const rename=value=>typeof value==='string'?value.replaceAll('synthetic-nectar-',`synthetic-nectar-import-${index}-`):Array.isArray(value)?value.map(rename):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,rename(v)])):value
      const capture=rename(collectionCapture()),originalCustomer=capture.customers.data[0].id
      capture.invoices.data.push({...structuredClone(capture.invoices.data.find(row=>row.status==='open')),id:`synthetic-nectar-replacement-control-${index}`,number:`REPLACEMENT-${index}`})
      capture.manifest.files.invoices.count=capture.invoices.data.length
      row.provider=originalCustomer;edge.customers.delete(provider);edge.customers.set(originalCustomer,{account:1,method})
      for(const item of capture.invoices.data){item.default_payment_method=method;edge.invoices.set(item.id,structuredClone(item))}
      const files=Object.fromEntries(Object.entries(capture).map(([name,value])=>[name,file(`${name}.json`,JSON.stringify(value),'application/json')]))
      const preview=await api('import.preview',files);assert.deepEqual(preview.rejected,[])
      await api('import.apply',{...files,fingerprint:preview.fingerprint})
      row.customer=(await api('customers')).find(c=>c.external_id===originalCustomer).id
      await api('customer.entity',{revision:(await api('business')).revision,customer:row.customer,entity:secondary,confirm:true})
      documents=(await api(`customers/${row.customer}`)).incumbentHistory.documents.filter(d=>d.status==='open')
    } else row.customer=(await api('customer.create',{external_id:provider,name:`Saved card ${family} ${code}`,billing_email:h.vars.OWNER_EMAIL.replace('owner',provider)})).id
    let binding=family==='imported'?null:await api('collection.customer.bind',{customer:row.customer,account_ref:row.account,stripe_customer_ref:row.provider,confirm:true})
    // Imported execution already freezes its own exact provider tuple; it need
    // not have passed through native collection's association door before.
    let waiting=family==='imported'?null:await native(row)
    const freshInvoice=family==='imported'?null:await invoice(row)
    let prepared,pending,recovery
    if(family==='native')prepared=await native(row)
    if(family==='reconfirmation') {
      prepared=await native(row);edge.rules.set(method,'processing_error')
      assert.equal((await api('collection.confirm',waiting.instructions.confirm)).status,'declined')
      assert.equal((await api('collection.confirm',prepared.instructions.confirm)).status,'declined')
      edge.rules.delete(method);await move(at+4*3600000)
      recovery=await api('collection.recovery.prepare',{request:prepared.id})
      pending=await api('collection.recovery.prepare',{request:waiting.id})
    }
    if(family==='automatic'||family==='retry') {
      prepared=await automatic(row,family==='retry');pending=await automatic(row,family==='retry')
      if(family==='retry') {
        edge.rules.set(method,'processing_error');await issue(prepared);await issue(pending)
        edge.rules.delete(method);await move(at+4*3600000)
      }
    }
    if(family==='trial') {
      const end=new Date(at+86400000).toISOString().slice(0,10),next=new Date(at+2*86400000).toISOString().slice(0,10)
      prepared=await trial(row,end);pending=await trial(row,next)
    }
    if(family==='topup'){prepared=await topup(row);pending=await topup(row)}
    if(family==='imported') {
      prepared=await api('imported.collection.prepare',{invoice:documents[0].id})
      pending=await api('imported.collection.prepare',{invoice:documents[1].id})
    }
    edge.rules.set(method,code)
    if(family==='imported'){
      // An error payload is not proof. Its matching embedded object cannot
      // override the wrong customer returned by the current authenticated read.
      const mismatched=await api('imported.collection.prepare',{invoice:documents[3].id})
      edge.mismatchRefusal()
      assert.equal((await api('imported.collection.execute',mismatched.instructions.execute)).status,'uncertain')
      assert.deepEqual(await lifecycle(row),[],'Mismatched provider identity grants no prohibition')
    }
    const mails=h.mails.length,before=edge.writes().length
    if(family==='native')assert.equal((await api('collection.confirm',prepared.instructions.confirm)).status,'declined')
    if(family==='reconfirmation')assert.equal((await api('collection.recovery.confirm',recovery.instructions.reconfirm)).status,'declined')
    if(family==='automatic')await issue(prepared)
    if(family==='retry')await tick()
    if(family==='trial'){await move(at+86400000);await tick(true)}
    if(family==='topup')assert.equal((await api('prepaid.topup.run',{authorization:prepared.authorization.id})).status,'declined')
    if(family==='imported'){
      if(code==='lost_card')edge.loseRefusal()
      const outcome=await api('imported.collection.execute',prepared.instructions.execute)
      if(code==='lost_card'){
        assert.equal(outcome.status,'uncertain')
        assert.equal((await api('imported.collection.reconcile',{request:prepared.id})).status,'failed')
      }else assert.equal(outcome.status,'failed')
    }
    assert.equal(edge.writes().length,before+1,`${family}: the original authorized refusal reaches Stripe once`)
    await refused(row,code)
    binding??={id:(await lifecycle(row)).find(record=>record.methodRef===method).binding}
    edge.rules.delete(method)
    const blockedWrites=edge.writes().length,blockedPayments=await api('payments')
    if(family==='imported')await api('collection.prepare',{invoice:await invoice(row)},409)
    else await prohibited('collection.prepare',{invoice:freshInvoice})
    const attempts=await Promise.all([1,2].map(()=>h.raw(`/api/nectar/${family==='imported'?'imported.collection.execute':'collection.confirm'}`,{cookie:owner,body:family==='imported'?pending.instructions.execute:waiting.instructions.confirm})))
    assert.deepEqual(attempts.map(r=>r.status),[409,409])
    if(family!=='reconfirmation')for(const response of attempts)assert.equal((await response.json()).error,'precondition_failed','Concurrent pending work reaches its transactional fence')
    if(family==='reconfirmation'){await api('collection.recovery.prepare',{request:prepared.id},409);await prohibited('collection.recovery.confirm',pending.instructions.reconfirm)}
    if(family==='automatic'||family==='retry') {
      if(family==='automatic')await issue(pending)
      const fresh=await invoice(row,false)
      await prohibited('automatic.collection.prepare',{invoice:fresh,issue_date:day()})
    }
    if(family==='trial') {
      await prohibited('trial.collection.prepare',{subscription:pending.subscription})
      await move(at+86400000);await tick(true)
    }
    if(family==='topup') {
      await prohibited('prepaid.topup.prepare',pending.fields)
      await prohibited('prepaid.topup.run',{authorization:pending.authorization.id})
    }
    if(family==='imported') {
      await prohibited('imported.collection.prepare',{invoice:documents[2].id})
      await prohibited('imported.collection.execute',pending.instructions.execute)
      await api('imported.collection.reconcile',{request:prepared.id})
    }
    // Repeated current provider updater observations must retain the prohibition.
    for(let observation=0;observation<2;observation++) {
      const event=`synthetic-nectar-prohibition-event-${index}-${observation}`
      edge.events.set(event,{object:'event',id:event,type:'payment_method.automatically_updated',livemode:false,created:Math.floor(at/1000),data:{object:{object:'payment_method',id:method,customer:row.provider,type:'card',livemode:false,card:{brand:'visa',last4:'4242',exp_month:12,exp_year:2035}}}})
      await api('card.lifecycle.consume',{binding:binding.id,event_ref:event,confirm:true})
      await api('card.lifecycle.consume',{binding:binding.id,event_ref:event,confirm:true})
    }
    await refused(row,code)
    await tick();await tick()
    assert.equal(edge.writes().length,blockedWrites,`${family}: prohibited work creates and confirms no PaymentIntent`)
    assert.deepEqual(await api('payments'),blockedPayments,'Refusal creates no payment or allocation')
    if(waiting){const waitingInvoice=await api(`invoices/${waiting.invoice_id}`)
      assert.equal(waitingInvoice.paidCents,0);assert.equal(waitingInvoice.allocations.length,0)}
    assert.equal((await api(`customers/${row.customer}`)).billingRecord.receipts.length,0,'No captured receipt is invented')
    assert.equal(h.mails.length,mails,'The safety fence grants no outbound authority')
    // A new, separately reviewed collection can use the replacement, while an
    // ordinary later provider observation of the old card cannot restore it.
    edge.customers.get(row.provider).method=`${method}-replacement`
    if(family==='imported') {
      edge.invoices.get(documents[2].provider_ref).default_payment_method=`${method}-replacement`
      const replacement=await api('imported.collection.prepare',{invoice:documents[2].id})
      const captured=await api('imported.collection.execute',replacement.instructions.execute)
      assert.equal(captured.status,'uncertain');assert.ok(captured.charge_ref)
      assert.equal((await api('imported.collection.finalize',{request:captured.id,confirm:true})).status,'collected')
      assert.equal((await api(`customers/${row.customer}`)).importedCollections.find(r=>r.id===captured.id).amount_cents,11000)
      edge.customers.get(row.provider).method=method
      await prohibited('imported.collection.execute',pending.instructions.execute)
    } else {
      const replacementInvoice=freshInvoice??await invoice(row)
      const replacement=await api('collection.prepare',{invoice:replacementInvoice})
      assert.equal((await api('collection.confirm',replacement.instructions.confirm)).status,'collected')
      assert.equal((await api(`invoices/${replacementInvoice}`)).paidCents,10000)
      edge.customers.get(row.provider).method=method
      await prohibited('collection.prepare',{invoice:await invoice(row)})
    }
    await refused(row,code)
    // A successful replacement does not rehabilitate the earlier method, even
    // when Stripe selects it again and the owner refreshes its exact binding.
    const afterReplacementWrites=edge.writes().length,afterReplacementPayments=await api('payments')
    if(family!=='imported')await api('collection.customer.bind',{customer:row.customer,account_ref:row.account,stripe_customer_ref:row.provider,confirm:true})
    const observed=`synthetic-nectar-prohibition-replacement-event-${index}`
    edge.events.set(observed,{object:'event',id:observed,type:'payment_method.automatically_updated',livemode:false,created:Math.floor(at/1000),data:{object:{object:'payment_method',id:method,customer:row.provider,type:'card',livemode:false,card:{brand:'visa',last4:'4242',exp_month:12,exp_year:2035}}}})
    await api('card.lifecycle.consume',{binding:binding.id,event_ref:observed,confirm:true})
    if(family==='reconfirmation')await prohibited('collection.recovery.confirm',pending.instructions.reconfirm)
    else if(family==='imported')await prohibited('imported.collection.execute',pending.instructions.execute)
    else await api('collection.confirm',waiting.instructions.confirm,409)
    if(family==='topup')await prohibited('prepaid.topup.run',{authorization:pending.authorization.id})
    if(family==='automatic'||family==='retry')await tick()
    if(family==='trial')await tick(true)
    if(family==='imported')await prohibited('imported.collection.prepare',{invoice:documents[4].id})
    else await prohibited('collection.prepare',{invoice:await invoice(row)})
    await refused(row,code)
    assert.equal(edge.writes().length,afterReplacementWrites,`${family}: replacement and repeated provider observations never revive old prepared work`)
    assert.deepEqual(await api('payments'),afterReplacementPayments,'The old method creates no further payment or allocation after replacement')
    // Equal method references on a different customer, and on a different
    // account, remain independently collectible under explicit new authority.
    for(const account of [1,2]) {
      const external=`synthetic-nectar-control-${index}-${account}`
      const controlProvider=account===1?external:row.provider,prior=edge.customers.get(controlProvider)
      edge.customers.set(controlProvider,{account,method})
      const control={customer:(await api('customer.create',{external_id:external,name:'Independent authorized customer',billing_email:h.vars.OWNER_EMAIL.replace('owner',external)})).id}
      if(account===2)await api('customer.entity',{revision:(await api('business')).revision,customer:control.customer,entity:secondary,confirm:true})
      // Equal opaque ids resolve within the selected processor account. For
      // the same account, a separate customer owns its own method observation.
      if(account===1)edge.customers.get(row.provider).method=`${method}-unselected`
      await api('collection.customer.bind',{customer:control.customer,account_ref:`synthetic-nectar-native-account-${account}`,stripe_customer_ref:controlProvider,confirm:true})
      const request=await native(control)
      assert.equal((await api('collection.confirm',request.instructions.confirm)).status,'collected')
      if(account===1)edge.customers.get(row.provider).method=method
      if(prior)edge.customers.set(controlProvider,prior)
    }
    await refused(row,code)
    console.log('PROHIBITION PASSED',code,family)
  }
}
