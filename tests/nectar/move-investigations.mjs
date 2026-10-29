import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { file } from './harness.mjs'

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
    records.customers.push({id:id('customer'),name:`Synthetic comparison ${index}`,tax_exempt:'none'})
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
  assert.equal(scanned.compared,4)
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
  // Quantity and service-end corrections use their ordinary human doors.
  const quantitySub=await api(`subscriptions/${subscriptions[0].id}`)
  await h.api('change.prepare',agent,{subscription:quantitySub.id,item:quantitySub.items[0].id,quantity:3,effective_date:'2026-08-01'},403)
  const change=await api('change.prepare',{subscription:quantitySub.id,item:quantitySub.items[0].id,quantity:3,effective_date:'2026-08-01'})
  await api('change.decide',{change:change.change,decision:'approved'})
  await h.api('subscription.end',agent,{subscription:subscriptions[2].id,end_date:'2026-08-16'},403)
  await api('subscription.end',{subscription:subscriptions[2].id,end_date:'2026-08-16',reason:'Synthetic captured service end confirmed'})
  for(const row of cases) {
    const checked=await h.api('assurance.recheck',agent,{case:row.id})
    assert.equal(checked.status,'open')
    assert.equal(checked.evidence.mismatch,false,'ordinary authorized corrections reconcile every planted difference')
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

  // Erasure withdraws case evidence and replay cannot reconstruct it.
  const erasedCustomer=customers.find(row=>row.id===cases[0].customer_id)
  const request=await api('erasure.request',{customer:erasedCustomer.id})
  await api('erasure.verify',{request:request.id,reason:'Synthetic independent owner verification',evidence:file('synthetic-verification.txt','Synthetic identity verified independently','text/plain')})
  await api('erasure.approve',{request:request.id,confirm:true})
  await h.api(`assurance-cases/${cases[0].id}`,agent,undefined,404)
  await scan()
  assert.equal((await h.api('assurance-cases',agent)).some(row=>row.id===cases[0].id),false)
  await api('import.apply',{...files,fingerprint:preview.fingerprint},409)
  assert.equal((await h.api('assurance-cases',agent)).length,2)
  console.log('AGENT-005 uploaded comparisons, exact governed fixes, case custody and erasure passed')
}
