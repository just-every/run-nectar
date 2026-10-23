import assert from 'node:assert/strict'
import { cancellationFlow } from './lifecycle-cancel.mjs'
import { applyPolicy } from './policy-helper.mjs'

// SUB-003: exercise lifecycle through the same HTTP commands, form and views
// used by an operator. No direct SQL or injected application state.
export async function lifecycleFlow(h, owner) {
  const previous=await h.api('business',owner)
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Lifecycle service-period example'})
  await h.api('tax.review',owner,{revision:(await h.api('business',owner)).revision})
  const customer = (await h.api('customer.create', owner, { external_id:'SUB003-PAUSE', name:'Juniper Analytics', billing_email:'billing@juniper.example' })).id
  const meter = (await h.api('meter.create', owner, { code:'sub003-calls', name:'Analysis calls', unit_label:'calls' })).id
  const prices = []
  let product
  for (const [code,kind,amount] of [['platform','flat','310'],['seats','seat','31'],['calls','unit','2']]) {
    const p = (await h.api('product.create', owner, {code:`sub003-${code}`,name:`Juniper ${code}`})).id
    if (kind === 'flat') product = p
    prices.push((await h.api('price.create', owner, {product:p,kind,unit_amount:amount,taxable:true,...(kind === 'unit' ? {meter} : {})})).id)
  }
  await h.api('feature.grant',owner,{product,feature:'sub003-access'})
  const subscription=(await h.api('subscription.create',owner,{customer,start_date:'2026-01-01',anchor_day:1,price:prices,quantity:['','2','']})).id
  const detail=()=>h.api(`subscriptions/${subscription}`,owner)
  const preview=month=>h.api(`subscriptions/${subscription}/upcoming?period=${month}`,owner)
  const entitlement=date=>h.api(`entitlements/${customer}?feature=sub003-access&date=${date}`,owner)
  const before=await preview('2026-02')
  assert.equal(before.calculation.totalCents,37200,'SUB-003 normal full period bills platform plus two seats')
  const initial=await detail()
  const saved=await h.submit('subscription.pause',owner,{subscription,revision:initial.revision,effective_date:'2026-02-01',resume_date:'2026-04-01',access:'suspend',reason:'Seasonal research pause'},`/app/subscriptions/${subscription}`)
  assert.equal(saved.searchParams.has('error'),false,'SUB-003 ordinary pause form succeeds')
  for (const [id,date] of [['before','2026-01-31T23:59:59-08:00'],['start','2026-02-01T00:00:00-08:00'],['end','2026-03-31T23:59:59-07:00'],['resume','2026-04-01T00:00:00-07:00']])
    await h.api('usage.submit',owner,{events:[{event_id:`sub003-${id}`,customer:'SUB003-PAUSE',meter:'sub003-calls',quantity:'3.25',occurred_at:date}]})
  // A pending charge and contract credit survive the no-charge period.
  await h.api('charge.add',owner,{customer,subscription,amount:'25',description:'Deferred onboarding',effective_date:'2026-02-15'})
  const credit=await h.api('amendment.propose',owner,{subscription,kind:'fixed_credit',value:'10',effective_from:'2026-02-15',note:'Launch credit'})
  await h.api('amendment.decide',owner,{amendment:credit.amendment,decision:'approved'})
  for(const month of ['2026-02','2026-03']) {
    const p=await preview(month)
    assert.equal(p.calculation.totalCents,0,'SUB-003 two paused months charge nothing for paused service or usage')
    assert.ok(p.calculation.lines.some(l=>l.kind==='paused_usage' && l.amountCents===0),'SUB-003 paused usage remains auditable at zero')
    const run=(await h.api('billrun.prepare',owner,{period:month})).id
    const invoice=(await h.api(`runs/${run}`,owner)).invoices.find(i=>i.customer_id===customer)
    await h.api('invoice.approve',owner,{invoice:invoice.id,fingerprint:invoice.source_fingerprint,acknowledge:true})
    await h.api('invoice.finalise',owner,{invoice:invoice.id,issue_date:month==='2026-02'?'2026-03-01':'2026-04-01'})
    assert.equal((await h.api(`invoices/${invoice.id}`,owner)).status,'issued')
  }
  assert.equal((await entitlement('2026-01-31')).allowed,true)
  assert.equal((await entitlement('2026-02-01')).allowed,false)
  assert.equal((await entitlement('2026-03-31')).allowed,false)
  assert.equal((await entitlement('2026-04-01')).allowed,true,'SUB-003 scheduled resume restores entitlements on the date boundary')
  const resumed=await preview('2026-04')
  assert.equal(resumed.calculation.totalCents,40000,'SUB-003 resume restores $372 recurring, $6.50 usage, deferred $6.50 late usage/$25 fee and $10 credit')
  assert.ok(resumed.calculation.inputs.lifecycle.length)
  const aprilRun=(await h.api('billrun.prepare',owner,{period:'2026-04'})).id
  const april=(await h.api(`runs/${aprilRun}`,owner)).invoices.find(i=>i.customer_id===customer)
  await h.api('invoice.approve',owner,{invoice:april.id,acknowledge:true})
  await h.api('invoice.finalise',owner,{invoice:april.id,issue_date:'2026-05-01'})
  const state=await detail()
  assert.equal(state.lifecycle.length,1)
  assert.equal(state.lifecycle[0].reason,'Seasonal research pause')
  assert.ok(state.lifecycle[0].author && state.lifecycle[0].created_at)
  await h.api('subscription.pause',owner,{subscription,revision:initial.revision,effective_date:'2026-05-01',resume_date:'2026-06-01',access:'retain',reason:'Stale attempt'},409)
  await h.api('subscription.pause',owner,{subscription,revision:state.revision,effective_date:'2026-03-01',resume_date:'2026-05-01',access:'retain',reason:'Overlap'},409)
  await h.api('subscription.pause',owner,{subscription,revision:state.revision,effective_date:'2026-01-10',resume_date:'2026-01-09',access:'retain',reason:'Reversed'},400)
  const early=(await h.api('subscription.pause',owner,{subscription,revision:state.revision,effective_date:'2026-05-01',resume_date:'2026-07-01',access:'retain',reason:'Keep read access'})).transition
  assert.equal((await entitlement('2026-05-15')).allowed,true,'SUB-003 retain policy preserves plan access while billing pauses')
  await h.api('subscription.resume',owner,{subscription,revision:(await detail()).revision,pause:early,effective_date:'2026-05-16',reason:'Project resumed early'})
  assert.equal((await preview('2026-05')).calculation.totalCents,19200,'SUB-003 early resume bills exactly 16 of 31 days at the original per-line rounding')
  assert.deepEqual((await detail()).lifecycle.map(e=>e.kind),['pause','pause','resume'])
  const issued=(await h.api(`customers/${customer}`,owner)).ledger.invoices[0]
  const frozen=await h.api(`invoices/${issued.id}`,owner)
  await h.api('subscription.pause',owner,{subscription,revision:(await detail()).revision,effective_date:'2026-02-02',resume_date:'2026-02-03',access:'retain',reason:'Cannot change issued evidence'},409)
  assert.deepEqual((await h.api(`invoices/${issued.id}`,owner)).calculation,frozen.calculation)
  await h.api('access.give',owner,{email:'sub003-reader@example.test',name:'Lifecycle Accountant',role:'accountant'})
  const reader=await h.signIn('sub003-reader@example.test',{requested:true})
  const agent={bearer:(await h.api('credential.issue',owner,{name:'Lifecycle observer',scopes:['prepare']})).key}
  for(const actor of [reader,agent,undefined]) {
    const status=actor?403:401
    for(const action of ['subscription.pause','subscription.resume']) await h.api(action,actor,{},status)
  }
  assert.equal((await h.api(`subscriptions/${subscription}`,reader)).lifecycle.length,3)
  const customerHistory=(await h.api(`customers/${customer}`,reader)).billingRecord.subscriptionHistory.find(row=>row.id===subscription)
  assert.deepEqual(customerHistory.events,(await detail()).lifecycle,'Customer record composes the complete nonempty lifecycle source')
  assert.deepEqual(customerHistory.record.items,(await detail()).items)
  assert.ok(!(await h.page(`/app/subscriptions/${subscription}`,reader)).includes('action="/app/do/subscription.pause"'))
  const audit=await h.api('audit',owner)
  assert.ok(audit.some(e=>e.subject===subscription && e.action==='subscription.pause'),'SUB-003 lifecycle changes are audited')
  console.log('SUB-003 two-month pause, dated/early resume, no-charge usage, retained/suspended access and immutable history passed')
  await cancellationFlow(h,owner,prices)
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:previous.tax_jurisdiction,tax_mode:previous.tax_mode,tax_rate:previous.tax_rate,tax_note:previous.tax_note})
  await h.api('tax.review',owner,{revision:(await h.api('business',owner)).revision})
  return {customer,subscription,owner,prices}
}
