import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { file } from './harness.mjs'
import { totp } from './mfa.mjs'

let provider
export function harnessOptions() {
  provider={inventory:true,events:new Map(),calls:[]}
  return {stripeSecret:'synthetic-nectar-1',stripeFetch:async request=>{
    const url=new URL(request.url),path=url.pathname.slice(3)
    provider.calls.push({path,method:request.method})
    assert.equal(request.method,'GET','investigation preparation only reads the processor edge')
    const customer='synthetic-nectar-customer-1',method='synthetic-nectar-method-1'
    const card={id:method,object:'payment_method',customer,livemode:false,type:'card',card:{brand:'visa',last4:'4242',exp_month:12,exp_year:2035}}
    if(path==='/account')return Response.json({id:'synthetic-nectar-source-account-1',object:'account'})
    if(path===`/customers/${customer}`)return Response.json({id:customer,object:'customer',livemode:false,invoice_settings:{default_payment_method:method}})
    if(path===`/payment_methods/${method}`)return Response.json(card)
    if(path==='/payment_methods')return Response.json({object:'list',has_more:false,data:url.searchParams.get('type')==='card'&&provider.inventory?[card]:[]})
    if(path.startsWith('/events/'))return Response.json(provider.events.get(path.slice('/events/'.length)))
    throw new Error('Unexpected synthetic processor path')
  }}
}


// One journey through uploaded capture, case, governed correction and privacy doors.
export async function moveInvestigationsFlow(h,owner,{onState=async()=>{}}={}) {
  const api=(path,body,status)=>h.api(path,owner,body,status)
  await api('business.configure',{...(await api('business')),timezone:'UTC'})
  await h.advanceClock('2026-10-25T12:00:00Z')
  const stamp=day=>Date.parse(`${day}T12:00:00Z`)/1000,list=data=>({object:'list',has_more:false,data})
  const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`:JSON.stringify(value)
  const privateMarker='synthetic-nectar-private-original-31',records={customers:[],products:[],prices:[],subscriptions:[],invoices:[]}
  for(let index=1;index<=4;index++) {
    const id=kind=>`synthetic-nectar-${kind}-${index}`
    const price={id:id('price'),object:'price',product:id('product'),type:'recurring',currency:'usd',unit_amount:index===2?2000:2500,recurring:{interval:'month',interval_count:1,usage_type:'licensed'},metadata:{nectar_kind:'seat'}}
    records.customers.push({id:id('customer'),name:`Synthetic comparison ${index}`,email:h.vars.OWNER_EMAIL.replace('owner',`synthetic-nectar-${index}`),tax_exempt:'none',...(index===1?{invoice_settings:{default_payment_method:'synthetic-nectar-method-1'}}:{})})
    records.products.push({id:id('product'),name:`Synthetic comparison product ${index}`,active:true})
    records.prices.push(price)
    records.subscriptions.push({id:id('subscription'),object:'subscription',customer:id('customer'),status:'active',start_date:stamp('2026-07-01'),billing_cycle_anchor:stamp('2026-07-01'),items:list([{id:id('item'),price,quantity:2}])})
    const amount=index===1?7500:index===3?2419:5000
    records.invoices.push({id:id('invoice'),object:'invoice',number:`SYNTHETIC-${index}`,customer:id('customer'),subscription:id('subscription'),status:'paid',currency:'usd',period_start:stamp('2026-08-01'),period_end:stamp('2026-09-01'),created:stamp('2026-09-01'),total:amount,tax:0,amount_paid:amount,amount_remaining:0,metadata:{private:privateMarker},lines:list([{id:id('line'),description:privateMarker,amount,quantity:index===1?3:2,price:{...price,unit_amount:2500},period:{start:stamp('2026-08-01'),end:stamp(index===3?'2026-08-16':'2026-09-01')},type:'subscription',subscription:id('subscription')}])})
  }
  const capture=Object.fromEntries(Object.entries(records).map(([name,data])=>[name,list(data)]))
  capture.manifest={source:'stripe',files:Object.fromEntries(Object.entries(records).map(([name,data])=>[name,{count:data.length,has_more:false}]))}
  const bytes=JSON.stringify(capture.invoices),artifactHash=createHash('sha256').update(bytes).digest('hex')
  const files=Object.fromEntries(Object.entries(capture).map(([name,value])=>[name,file(`${name}.json`,JSON.stringify(value),'application/json')]))
  const preview=await api('import.preview',files)
  assert.deepEqual(preview.rejected,[])
  const imported=await api('import.apply',{...files,fingerprint:preview.fingerprint})
  assert.equal((await api('import.apply',{...files,fingerprint:preview.fingerprint})).job,imported.job)
  const ownerId=(await api('me')).id,key=await api('credential.issue',{name:'Synthetic move investigator',scopes:['prepare']}),agent={bearer:key.key}
  const scan=(who=agent,status=200)=>h.api('move.investigate',who,{owner:ownerId},status)
  const customers=await api('customers'),subscriptions=[]
  for(let index=1;index<=4;index++)subscriptions.push((await api(`customers/${customers.find(row=>row.external_id===`synthetic-nectar-customer-${index}`).id}`)).subscriptions[0])
  const moneyBefore=await Promise.all(customers.map(customer=>api(`customers/${customer.id}`).then(row=>row.ledger)))
  const runsBefore=await api('runs')
  await h.rejectAudit('assurance.scan');await scan(agent,500)
  assert.deepEqual(await h.api('assurance-cases',agent),[])
  await h.rejectAudit(null)
  const scanned=await scan()
  assert.equal(scanned.compared,8)
  assert.equal(scanned.opened.length,3,'three independently planted differences, with no case for the clean control')
  assert.deepEqual((await scan()).opened,[])
  const concurrent=await Promise.all([1,2].map(()=>h.raw('/api/nectar/move.investigate',{...agent,body:{owner:ownerId}})))
  assert.ok(concurrent.every(response=>[200,409].includes(response.status)))
  const cases=(await h.api('assurance-cases',agent)).sort((a,b)=>a.evidence.invoiceReference.localeCompare(b.evidence.invoiceReference))
  assert.equal(cases.length,3)
  const read=row=>h.api(`assurance-cases/${row.id}`,agent)
  const expected=[{quantity:[3,2],amountCents:[7500,5000]},{unitAmount:['25.00','20.00'],amountCents:[5000,4000]},{to:['2026-08-16','2026-09-01'],amountCents:[2419,5000]}]
  for(const [index,row] of cases.entries()) {
    assert.equal(row.owner_id,ownerId)
    assert.deepEqual(Object.fromEntries(row.evidence.differences.map(item=>[item.field,[item.captured,item.engine]])),expected[index])
    assert.deepEqual(row.evidence.citation,{job:imported.job,artifactHash,sourceHash:createHash('sha256').update(canonical(records.invoices[index])).digest('hex'),row:index+1})
    assert.match(row.evidence.citation.sourceHash,/^[a-f0-9]{64}$/)
    assert.equal(row.evidence.comparisons[0].captured.line,`synthetic-nectar-line-${index+1}`)
    assert.equal(row.evidence.comparisons[0].engine.item,(await api(`subscriptions/${subscriptions[index].id}`)).items[0].id)
    await api('assurance.approve',{case:row.id,basis:row.basis_hash},409)
    await h.api('assurance.approve',agent,{case:row.id,basis:row.basis_hash},403)
  }
  const noOriginal=value=>assert.ok(!JSON.stringify(value).includes(privateMarker),'investigation projections never expose raw captured prose')
  noOriginal(cases)
  const originals=(await api('imports')).find(row=>row.id===imported.job).originalFiles
  assert.ok(originals.length>0)
  assert.equal((await h.raw(`/app/import/${imported.job}/originals/${originals[0].id}`,agent)).status,403)
  assert.deepEqual(await api('runs'),runsBefore,'scans prepare and issue no invoice')
  assert.deepEqual(await Promise.all(customers.map(customer=>api(`customers/${customer.id}`).then(row=>row.ledger))),moneyBefore,'scans move no money')
  await onState({label:'three-differences',path:'/app/import/investigations',cases})

  // A saved proposal cannot survive a source edit or the loss of its proposer or assignee.
  const proposal=async(who=agent)=>h.api('proposal.create',who,{assurance_case:cases[1].id,kind:'amendment',title:'Synthetic exact captured price correction',payload:{subscription:subscriptions[1].id,kind:'price_override',price:(await api(`subscriptions/${subscriptions[1].id}`)).items[0].price_id,value:'25',effective_from:'2026-08-01'},evidence:{clauses:[{quote:'Synthetic signed pricing permits twenty five dollars per seat'}]}})
  const pending=await proposal(),changed=await api('amendment.propose',{subscription:subscriptions[1].id,kind:'fixed_credit',value:'1',effective_from:'2026-10-01',note:'Synthetic later approved term'})
  await api('amendment.decide',{amendment:changed.amendment,decision:'approved'})
  assert.equal((await read(cases[1])).stale,true)
  assert.equal((await api(`proposals/${pending.id}`)).stale,true)
  await api('proposal.decide',{proposal:pending.id,decision:'approved'},409)
  await h.api('assurance.recheck',agent,{case:cases[1].id})
  const revokedPending=await proposal()
  await api('credential.revoke',{key:key.id})
  await scan(agent,401)
  assert.equal((await api('proposal.decide',{proposal:revokedPending.id,decision:'approved'},409)).error,'assurance_proposer_unavailable')
  const fresh=await api('credential.issue',{name:'Synthetic replacement investigator',scopes:['prepare']})
  agent.bearer=fresh.key
  const email=h.vars.OWNER_EMAIL.replace('owner','synthetic-nectar-assignee')
  const assignee=(await api('access.give',{email,name:'Synthetic case assignee',role:'finance'})).id
  await api('assurance.assign',{case:cases[1].id,owner:assignee})
  const unavailable=await proposal()
  await api('access.end',{member:assignee})
  assert.equal((await api('proposal.decide',{proposal:unavailable.id,decision:'approved'},409)).error,'assurance_owner_unavailable')
  await h.api('assurance.recheck',agent,{case:cases[1].id},409)
  await api('assurance.assign',{case:cases[1].id,owner:ownerId})
  const correction=await proposal()
  const before=await api(`subscriptions/${subscriptions[1].id}`)
  await h.rejectAudit('proposal.approve');await api('proposal.decide',{proposal:correction.id,decision:'approved'},500)
  assert.deepEqual(await api(`subscriptions/${subscriptions[1].id}`),before)
  await h.rejectAudit(null)
  await api('proposal.decide',{proposal:correction.id,decision:'approved'})
  assert.equal((await read(cases[1])).status,'open','proposal approval is not case closure')
  await api('proposal.decide',{proposal:correction.id,decision:'approved'},409)
  // Quantity and a captured partial-service pause use their ordinary human doors.
  const quantitySub=await api(`subscriptions/${subscriptions[0].id}`)
  await h.api('change.prepare',agent,{subscription:quantitySub.id,item:quantitySub.items[0].id,quantity:3,effective_date:'2026-08-01'},403)
  const change=await api('change.prepare',{subscription:quantitySub.id,item:quantitySub.items[0].id,quantity:3,effective_date:'2026-08-01'})
  await api('change.decide',{change:change.change,decision:'approved'})
  const partialSub=await api(`subscriptions/${subscriptions[2].id}`)
  const pause={subscription:partialSub.id,revision:partialSub.revision,effective_date:'2026-08-16',resume_date:'2026-09-01',access:'retain',reason:'Synthetic captured partial-service pause confirmed'}
  await h.api('subscription.pause',agent,pause,403)
  await api('subscription.pause',pause)
  for(const row of cases) {
    const checked=await h.api('assurance.recheck',agent,{case:row.id})
    assert.equal(checked.status,'open')
    assert.equal(checked.evidence.mismatch,false,`ordinary authorized corrections reconcile every planted difference: ${JSON.stringify(checked.evidence.differences)}`)
    await api('assurance.approve',{case:row.id,basis:row.basis_hash},409)
    const confirmed=await h.submit('assurance.approve',owner,{case:row.id,basis:checked.evidence.basis},'/app/import/investigations')
    assert.equal(confirmed.searchParams.get('error'),null)
    await h.rejectAudit('assurance.recheck');await h.api('assurance.recheck',agent,{case:row.id},500)
    assert.equal((await read(row)).status,'open')
    await h.rejectAudit(null)
    assert.equal((await h.api('assurance.recheck',agent,{case:row.id})).status,'resolved')
    assert.ok((await read(row)).observations.some(observation=>observation.evidence.mismatch),'original discrepancy remains immutable')
  }
  await onState({label:'resolved-comparisons',path:'/app/import/investigations',cases})
  assert.deepEqual(await api('runs'),runsBefore)
  assert.equal((await api('shadow')).length,4,'investigation and corrections grant no cutover authority')
  noOriginal(await h.page('/app/import/investigations',owner))

  // An exact owner review retains a plan and processor references without activating a cutover.
  const subId=subscriptions[0].id,rollbackPath=`move-rollbacks/${subId}`
  const plan={subscription:subId,cutover_start:'2026-11-01',processor_ref:'synthetic-nectar-source-account-1',instructions:'Keep source billing in place until a person verifies the last source period. If cutover fails, stop new billing and have the owner reconcile both processors before any manual recovery.'}
  await h.api('move.rollback.prepare',agent,plan,403)
  await h.api(rollbackPath,agent,undefined,403)
  await h.rejectAudit('move.rollback.prepare');await api('move.rollback.prepare',plan,500)
  assert.deepEqual(await api(rollbackPath),[])
  await h.rejectAudit(null)
  const prepared=await api('move.rollback.prepare',plan)
  assert.equal((await api('move.rollback.prepare',plan)).id,prepared.id)
  assert.equal(prepared.instructions,plan.instructions)
  assert.equal(prepared.executionAuthority,false)
  assert.equal(prepared.stale,false)
  assert.deepEqual(prepared.snapshot.references.invoices,['synthetic-nectar-invoice-1'])
  assert.equal(prepared.snapshot.references.customer,'synthetic-nectar-customer-1')
  assert.equal(prepared.snapshot.references.subscription,'synthetic-nectar-subscription-1')
  const confirmation={request:prepared.id,basis:prepared.basis_hash,confirm:true}
  await api('move.rollback.confirm',{...confirmation,confirm:false},400)
  await api('move.rollback.confirm',{...confirmation,basis:'synthetic-nectar-stale-basis'},409)
  await h.api('move.rollback.confirm',agent,confirmation,403)
  await h.rejectAudit('move.rollback.confirm');await api('move.rollback.confirm',confirmation,500)
  assert.equal((await api(rollbackPath))[0].confirmed_at,null)
  await h.rejectAudit(null)
  const confirmed=await api('move.rollback.confirm',confirmation)
  assert.equal(confirmed.confirmed_by,ownerId)
  assert.ok(confirmed.confirmed_at)
  assert.equal((await api('move.rollback.confirm',confirmation)).confirmed_at,confirmed.confirmed_at)
  assert.equal((await api(rollbackPath)).length,1)
  assert.equal((await api('shadow')).length,4,'a reviewed plan still grants no cutover or billing authority')
  await api('import.job',{job:imported.job,action:'undo'},409)

  // A changed customer opens a source-cited case without copying their contact into agent evidence.
  const originalCustomer=await api(`customers/${cases[0].customer_id}`)
  const customerUpdate={customer:originalCustomer.id,revision:originalCustomer.revision,name:originalCustomer.name,billing_email:originalCustomer.billing_email,address:'Synthetic changed address',tax_exempt:originalCustomer.tax_exempt}
  await h.api('customer.update',agent,customerUpdate,403)
  await api('customer.update',customerUpdate)
  assert.equal((await api(rollbackPath))[0].stale,true)
  await api('move.rollback.confirm',confirmation,409)
  const changedScan=await scan()
  assert.equal(changedScan.opened.length,1)
  const customerCase=(await h.api('assurance-cases',agent)).find(row=>row.evidence.category==='customer')
  assert.deepEqual(customerCase.evidence.differences,[{field:'address',captured:'Captured value',engine:'Changed value'}])
  assert.deepEqual(customerCase.evidence.citation,{job:imported.job,artifactHash:createHash('sha256').update(JSON.stringify(capture.customers)).digest('hex'),sourceHash:createHash('sha256').update(canonical(records.customers[0])).digest('hex'),row:1})
  assert.ok(!JSON.stringify(customerCase).includes(customerUpdate.address))
  assert.ok(!JSON.stringify(customerCase).includes(originalCustomer.billing_email))
  assert.equal((await scan()).opened.length,0)
  await api('assurance.approve',{case:customerCase.id,basis:customerCase.basis_hash},409)
  const mismatchPlan=await api('move.rollback.prepare',plan)
  const mismatchConfirmation={request:mismatchPlan.id,basis:mismatchPlan.basis_hash,confirm:true}
  await api('move.rollback.confirm',mismatchConfirmation,409)
  await api('move.rollback.confirm',{...mismatchConfirmation,acknowledge_discrepancies:true})
  await onState({label:'customer-difference',path:'/app/import/investigations',cases:[...cases,customerCase]})
  const changedCustomer=await api(`customers/${originalCustomer.id}`)
  await api('customer.update',{...customerUpdate,revision:changedCustomer.revision,address:originalCustomer.address})
  const checkedCustomer=await h.api('assurance.recheck',agent,{case:customerCase.id})
  assert.equal(checkedCustomer.evidence.mismatch,false)
  await api('assurance.approve',{case:customerCase.id,basis:checkedCustomer.evidence.basis})
  assert.equal((await h.api('assurance.recheck',agent,{case:customerCase.id})).status,'resolved')
  assert.equal((await read(customerCase)).observations.length,3)
  // The captured default is compared to an independently refreshed, binding-valid inventory.
  await api('collection.customer.bind',{customer:originalCustomer.id,account_ref:plan.processor_ref,stripe_customer_ref:records.customers[0].id,confirm:true})
  await api('customer.payment_methods.refresh',{customer:originalCustomer.id})
  const cleanMethodScan=await scan()
  assert.equal(cleanMethodScan.opened.length,0)
  assert.equal(cleanMethodScan.compared,9)
  provider.inventory=false
  await api('customer.payment_methods.refresh',{customer:originalCustomer.id})
  assert.equal((await scan()).opened.length,1)
  const methodCase=(await h.api('assurance-cases',agent)).find(row=>row.evidence.category==='payment-method')
  assert.deepEqual(methodCase.evidence.differences,[{field:'savedMethod',captured:'synthetic-nectar-method-1',engine:null}])
  assert.equal(methodCase.evidence.coverage,'captured-default-membership-only')
  assert.equal(methodCase.evidence.citation.sourceHash,customerCase.evidence.citation.sourceHash)
  await api('assurance.approve',{case:methodCase.id,basis:methodCase.basis_hash},409)
  await onState({label:'method-difference',path:'/app/import/investigations',cases:[...cases,customerCase,methodCase]})
  provider.inventory=true
  await api('customer.payment_methods.refresh',{customer:originalCustomer.id})
  assert.equal((await h.api(`assurance-cases/${methodCase.id}`,agent)).stale,true)
  const methodChecked=await h.api('assurance.recheck',agent,{case:methodCase.id})
  assert.equal(methodChecked.evidence.mismatch,false)
  await api('assurance.approve',{case:methodCase.id,basis:methodChecked.evidence.basis})
  assert.equal((await h.api('assurance.recheck',agent,{case:methodCase.id})).status,'resolved')

  // Only authenticated source events enter the comparison; old arrival order cannot replace the latest event.
  await api('webhook.register',{url:'https://receiver.nectar-app.com/webhooks',consent:true})
  const created=Math.floor(Date.now()/1000)+10
  const sourceEvent=(id,quantity,time)=>({id,object:'event',type:'customer.subscription.updated',livemode:false,created:time,data:{object:{id:records.subscriptions[0].id,object:'subscription',customer:records.customers[0].id,status:'active',items:list([{id:'synthetic-nectar-item-1',price:'synthetic-nectar-price-1',quantity}]),description:privateMarker}}})
  const consume=async event=>{
    provider.events.set(event.id,event)
    return api('webhook.stripe.consume',{customer:originalCustomer.id,account_ref:plan.processor_ref,event_ref:event.id,consent:true})
  }
  await consume(sourceEvent('synthetic-nectar-event-2',4,created))
  assert.equal((await scan()).opened.length,1)
  const eventCase=(await h.api('assurance-cases',agent)).find(row=>row.evidence.category==='webhook')
  assert.deepEqual(eventCase.evidence.differences,[{field:'eventItems',captured:[{price_ref:'synthetic-nectar-price-1',quantity:4}],engine:[{price_ref:'synthetic-nectar-price-1',quantity:3}]}])
  assert.deepEqual(eventCase.evidence.citation,{event:'synthetic-nectar-event-2',account:plan.processor_ref,capturedAt:created*1000})
  noOriginal(eventCase)
  await consume(sourceEvent('synthetic-nectar-event-1',3,created-1))
  assert.equal((await h.api(`assurance-cases/${eventCase.id}`,agent)).stale,false)
  assert.equal((await scan()).opened.length,0)
  await api('assurance.approve',{case:eventCase.id,basis:eventCase.basis_hash},409)
  await onState({label:'event-difference',path:'/app/import/investigations',cases:[...cases,customerCase,methodCase,eventCase]})
  const quantityNow=await api(`subscriptions/${subId}`),liveItem=quantityNow.items.find(row=>row.effective_to===null)
  const eventFix=await api('change.prepare',{subscription:subId,item:liveItem.id,quantity:4,effective_date:'2026-10-01'})
  await api('change.decide',{change:eventFix.change,decision:'approved'})
  const eventChecked=await h.api('assurance.recheck',agent,{case:eventCase.id})
  assert.equal(eventChecked.evidence.mismatch,false)
  await api('assurance.approve',{case:eventCase.id,basis:eventChecked.evidence.basis})
  assert.equal((await h.api('assurance.recheck',agent,{case:eventCase.id})).status,'resolved')
  const scans=(await h.api('assurance-cases',agent)).length
  assert.equal((await scan()).opened.length,0)
  assert.equal((await h.api('assurance-cases',agent)).length,scans)
  assert.ok(provider.calls.every(call=>call.method==='GET'),'no scan or review can write a processor object')
  assert.deepEqual(await Promise.all(customers.map(customer=>api(`customers/${customer.id}`).then(row=>row.ledger))),moneyBefore)

  const freshPlan=await api('move.rollback.prepare',plan)
  const concurrentReviews=await Promise.all([1,2].map(()=>h.raw('/api/nectar/move.rollback.confirm',{cookie:owner,body:{request:freshPlan.id,basis:freshPlan.basis_hash,confirm:true}})))
  assert.ok(concurrentReviews.every(response=>[200,409].includes(response.status)))
  assert.equal((await api(rollbackPath)).filter(row=>row.id===freshPlan.id&&row.confirmed_at).length,1)
  const confirmedAudits=(await api('audit')).filter(row=>row.action==='move.rollback.confirm'&&row.subject===freshPlan.id)
  assert.equal(confirmedAudits.length,1,'concurrent confirmation retains one audited review')
  assert.deepEqual(await api('runs'),runsBefore)
  noOriginal(await api(rollbackPath))
  const reviewAssignee=(await api('access.give',{email:h.vars.OWNER_EMAIL.replace('owner','synthetic-nectar-review-assignee'),name:'Synthetic review assignee',role:'finance'})).id
  await api('assurance.assign',{case:cases[0].id,owner:reviewAssignee})
  const assignedPlan=await api('move.rollback.prepare',plan)
  await api('access.end',{member:reviewAssignee})
  assert.equal((await api(rollbackPath)).find(row=>row.id===assignedPlan.id).stale,true)
  assert.equal((await api('move.rollback.confirm',{request:assignedPlan.id,basis:assignedPlan.basis_hash,confirm:true},409)).error,'assurance_owner_unavailable')
  assert.equal((await api('move.rollback.prepare',plan,409)).error,'assurance_owner_unavailable')
  await api('assurance.assign',{case:cases[0].id,owner:ownerId})
  const unsupportedEvent=sourceEvent('synthetic-nectar-event-3',4,created+1)
  unsupportedEvent.data.object.status='paused'
  await consume(unsupportedEvent)
  assert.equal((await h.api(`assurance-cases/${eventCase.id}`,agent)).stale,true,'a newer unsupported source cannot leave an older explanation current')
  await h.api('assurance.recheck',agent,{case:eventCase.id},409)
  await api('assurance.approve',{case:eventCase.id,basis:eventChecked.evidence.basis},409)

  // Review authority also expires with the owner's ordinary MFA factor.
  const factorTime=Date.parse('2026-10-25T12:00:00Z')
  const factor=await api('mfa.totp.start',{label:'Synthetic review authenticator'})
  await api('mfa.totp.confirm',{factor:factor.factor,code:totp(factor.secret,factorTime)})
  await api('mfa.policy',{scope:'roles',roles:['owner']})
  const stepUpPlan=await api('move.rollback.prepare',plan)
  const stepUpConfirmation={request:stepUpPlan.id,basis:stepUpPlan.basis_hash,confirm:true}
  await h.advanceClock('2026-10-25T12:20:00Z')
  assert.equal((await api('move.rollback.confirm',stepUpConfirmation,403)).error,'mfa_step_up_required')
  assert.equal((await api('move.rollback.prepare',plan,403)).error,'mfa_step_up_required')
  assert.equal((await api(rollbackPath)).find(row=>row.id===stepUpPlan.id).confirmed_at,null)
  await api('mfa.verify',{code:totp(factor.secret,factorTime+20*60*1000)})
  assert.ok((await api('move.rollback.confirm',stepUpConfirmation)).confirmed_at)
  await api('mfa.policy',{scope:'off'})

  // Erasure withdraws case evidence and replay cannot reconstruct it.
  const erasedCustomer=customers.find(row=>row.id===cases[0].customer_id)
  const request=await api('erasure.request',{customer:erasedCustomer.id})
  await api('erasure.verify',{request:request.id,reason:'Synthetic independent owner verification',evidence:file('synthetic-verification.txt','Synthetic identity verified independently','text/plain')})
  await api('erasure.approve',{request:request.id,confirm:true})
  await h.api(`assurance-cases/${cases[0].id}`,agent,undefined,404)
  await h.api(`assurance-cases/${customerCase.id}`,agent,undefined,404)
  await h.api(`assurance-cases/${methodCase.id}`,agent,undefined,404)
  await h.api(`assurance-cases/${eventCase.id}`,agent,undefined,404)
  await api('webhook.stripe.consume',{customer:originalCustomer.id,account_ref:plan.processor_ref,event_ref:'synthetic-nectar-event-2',consent:true},409)
  await api('customer.payment_methods.refresh',{customer:originalCustomer.id},404)
  assert.deepEqual(await api(rollbackPath),[])
  await api('move.rollback.confirm',{request:freshPlan.id,basis:freshPlan.basis_hash,confirm:true},404)
  await api('move.rollback.prepare',plan,409)
  await scan()
  assert.equal((await h.api('assurance-cases',agent)).some(row=>row.id===cases[0].id),false)
  assert.equal((await api('import.preview',files,409)).error,'erased_import_source')
  assert.equal((await api('import.apply',{...files,fingerprint:preview.fingerprint},409)).error,'erased_import_source')
  assert.equal((await h.api('assurance-cases',agent)).length,2)
  console.log('AGENT-005 uploaded comparisons, exact governed fixes, case custody and erasure passed')
}
