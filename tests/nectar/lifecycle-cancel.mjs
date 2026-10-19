import assert from 'node:assert/strict'
import { applyPolicy } from './policy-helper.mjs'

export async function cancellationFlow(h,owner,prices) {
  const originalLimit=(await h.api('policies/current',owner)).creditLimitCents
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'flat_rate',tax_rate:'10',tax_note:'Cancellation tax follows signed lines'})
  await h.api('tax.review',owner,{revision:(await h.api('business',owner)).revision})
  const make=async (code,plan=prices)=>{
    const customer=(await h.api('customer.create',owner,{external_id:`SUB003-${code}`,name:`Juniper ${code}`,billing_email:'billing@juniper.example'})).id
    const subscription=(await h.api('subscription.create',owner,{customer,start_date:'2026-06-01',anchor_day:1,price:plan,quantity:['','2','']})).id
    return {customer,subscription}
  }
  const get=id=>h.api(`subscriptions/${id}`,owner)
  const preview=(id,month='2026-06')=>h.api(`subscriptions/${id}/upcoming?period=${month}`,owner)
  const cancel=async (id,fields={},status=200)=>h.api('subscription.cancel',owner,{subscription:id,revision:(await get(id)).revision,mode:'immediate',effective_date:'2026-06-16',reason:'Project ended',...fields},status)
  const invoice=async customer=>{
    const run=(await h.api('billrun.prepare',owner,{period:'2026-06'})).id
    return (await h.api(`runs/${run}`,owner)).invoices.find(i=>i.customer_id===customer)
  }
  const a=await make('CREDIT')
  const discount=await h.api('amendment.propose',owner,{subscription:a.subscription,kind:'discount_percent',value:'10',effective_from:'2026-06-01',note:'Contract discount'})
  await h.api('amendment.decide',owner,{amendment:discount.amendment,decision:'approved'})
  await h.api('usage.submit',owner,{events:[
    {event_id:'sub003-cancel-before',customer:'SUB003-CREDIT',meter:'sub003-calls',quantity:'2.25',occurred_at:'2026-06-15T23:59:59-07:00'},
    {event_id:'sub003-cancel-after',customer:'SUB003-CREDIT',meter:'sub003-calls',quantity:'90',occurred_at:'2026-06-16T00:00:00-07:00'},
  ]})
  await applyPolicy(h,owner,'credit.policy',{two_person_above:'100'})
  await cancel(a.subscription)
  const p=await preview(a.subscription)
  assert.equal(p.calculation.totalCents,18909,'SUB-003 15/30 service days: $372 × 50% × 90%, plus $4.50 usage and $17.19 tax')
  const credits=p.calculation.lines.filter(l=>l.kind==='cancellation_credit')
  assert.equal(credits.reduce((n,l)=>n+l.amountCents,0),-16740,'SUB-003 explicit signed unused-service credit includes the contract discount')
  assert.ok(credits.every(l=>l.evidence.transitions.length===1 && l.evidence.gross.length && l.evidence.earned.length))
  assert.equal((await h.api(`entitlements/${a.customer}?feature=sub003-access&date=2026-06-16`,owner)).allowed,false)
  await h.api('access.give',owner,{email:'sub003-finance@example.test',name:'Juniper Finance',role:'finance'})
  const finance=await h.signIn('sub003-finance@example.test',{requested:true})
  const draft=await invoice(a.customer)
  await h.api('invoice.approve',owner,{invoice:draft.id,acknowledge:true},409)
  await h.api('invoice.approve',finance,{invoice:draft.id,acknowledge:true})
  await h.api('invoice.finalise',owner,{invoice:draft.id,issue_date:'2026-07-01'},409)
  await h.api('invoice.finalise',finance,{invoice:draft.id,issue_date:'2026-07-01'})
  const issued=await h.api(`invoices/${draft.id}`,owner)
  assert.equal(issued.total_cents,18909)
  const recurring=await h.api(`reports/mrr?period=2026-06&customer=${a.customer}`,owner)
  assert.equal(recurring.totalCents,17190,'SUB-003 billed MRR includes the negative recurring-service credit')
  for(const line of issued.lines.filter(l=>l.kind==='cancellation_credit')) {
    const drill=await h.api(`invoices/${issued.id}/lines/${line.id}`,owner)
    assert.equal(drill.line.amount_cents,line.amount_cents)
    assert.deepEqual(drill.line.evidence,line.evidence)
  }
  await cancel(a.subscription,{},409)
  assert.deepEqual((await h.api(`invoices/${issued.id}`,owner)).calculation,issued.calculation,'SUB-003 duplicate cancellation leaves issued evidence unchanged')
  const term=await make('TERM',[prices[0]])
  const ended=await cancel(term.subscription,{mode:'term_end',effective_date:'2026-06-16',reason:'Do not renew'})
  assert.equal(ended.endDate,'2026-07-01','SUB-003 monthly term-end uses the next anchor boundary')
  const termBill=await preview(term.subscription)
  assert.equal(termBill.calculation.totalCents,34100)
  assert.ok(!termBill.calculation.lines.some(l=>l.kind==='cancellation_credit'))
  assert.equal((await h.api(`entitlements/${term.customer}?feature=sub003-access&date=2026-06-30`,owner)).allowed,true)
  assert.equal((await h.api(`entitlements/${term.customer}?feature=sub003-access&date=2026-07-01`,owner)).allowed,false)
  await h.api(`subscriptions/${term.subscription}/upcoming?period=2026-07`,owner,undefined,409)
  const termDraft=await invoice(term.customer)
  await h.api('invoice.approve',owner,{invoice:termDraft.id,acknowledge:true})
  await h.api('invoice.finalise',owner,{invoice:termDraft.id,issue_date:'2026-07-01'})

  await applyPolicy(h,owner,'lifecycle.policy',{credit_unused:true,reactivation_days:3})
  const back=await make('BACK')
  await cancel(back.subscription)
  // A policy change must not extend an already-canceled subscription's window.
  await applyPolicy(h,owner,'lifecycle.policy',{credit_unused:false,reactivation_days:30})
  await h.api('subscription.reactivate',owner,{subscription:back.subscription,revision:(await get(back.subscription)).revision,effective_date:'2026-06-20',reason:'Too late for its saved window'},409)
  const rival=(await h.api('subscription.create',owner,{customer:back.customer,start_date:'2026-06-17',anchor_day:1,price:[prices[2]],quantity:['']})).id
  await h.api('subscription.reactivate',owner,{subscription:back.subscription,revision:(await get(back.subscription)).revision,effective_date:'2026-06-19',reason:'Meter was reused'},409)
  await cancel(rival,{effective_date:'2026-06-18'})
  const revision=(await get(back.subscription)).revision
  await h.api('subscription.reactivate',owner,{subscription:back.subscription,revision,effective_date:'2026-06-19',reason:'Research restarted'})
  const reactivated=await get(back.subscription)
  assert.equal(reactivated.end_date,null)
  assert.deepEqual(reactivated.lifecycle.map(e=>e.kind),['cancel','reactivate'])
  assert.equal(reactivated.lifecycle[1].related_id,reactivated.lifecycle[0].id)
  assert.equal((await h.api(`entitlements/${back.customer}?feature=sub003-access&date=2026-06-18`,owner)).allowed,false)
  assert.equal((await h.api(`entitlements/${back.customer}?feature=sub003-access&date=2026-06-19`,owner)).allowed,true)
  assert.equal((await preview(back.subscription)).calculation.totalCents,36828,'SUB-003 reactivation bills 27/30 service days with tax; cancellation gap stays uncharged')
  await h.api('subscription.reactivate',owner,{subscription:back.subscription,revision,effective_date:'2026-06-19',reason:'Duplicate'},409)
  const noCredit=await make('NO-CREDIT',[prices[0]])
  await cancel(noCredit.subscription)
  const retained=await preview(noCredit.subscription)
  assert.equal(retained.calculation.totalCents,34100,'SUB-003 explicit no-credit policy retains final-period recurring charges')
  assert.ok(!retained.calculation.lines.some(l=>l.kind==='cancellation_credit'))
  const cross=await make('CROSS-MONTH',[prices[0]])
  await cancel(cross.subscription,{effective_date:'2026-06-25'})
  await h.api('subscription.reactivate',owner,{subscription:cross.subscription,revision:(await get(cross.subscription)).revision,effective_date:'2026-07-11',reason:'New month restart'})
  assert.equal((await preview(cross.subscription,'2026-07')).calculation.totalCents,23100,'SUB-003 a no-credit cancellation does not bill the canceled gap in a later reactivation month')
  for(const action of ['subscription.cancel','subscription.reactivate','lifecycle.policy']) await h.api(action,undefined,{},401)
  const reader=await h.signIn('sub003-reader@example.test')
  const agent={bearer:(await h.api('credential.issue',owner,{name:'Cancellation observer',scopes:['prepare']})).key}
  for(const actor of [reader,agent]) for(const action of ['subscription.cancel','subscription.reactivate','lifecycle.policy']) await h.api(action,actor,{},403)
  await h.api('lifecycle.policy',finance,{credit_unused:true,reactivation_days:30},403)
  const exportResponse=await h.raw('/app/exports/subscriptions.csv',{cookie:owner})
  assert.equal(exportResponse.status,200)
  const exported=await exportResponse.text()
  assert.ok(exported.includes('Research restarted') && exported.includes('Project ended'),'SUB-003 CSV custody retains reasons and reactivation history')
  const audit=await h.api('audit',owner)
  for(const action of ['subscription.cancel','subscription.reactivate']) assert.ok(audit.some(e=>e.action===action),'SUB-003 audit names each transition')
  await applyPolicy(h,owner,'lifecycle.policy',{credit_unused:true,reactivation_days:30})
  await applyPolicy(h,owner,'credit.policy',{two_person_above:originalLimit===null?'':(originalLimit/100).toFixed(2)})
  console.log('SUB-003 cancellation credit/tax, two-person approval, term-end, reactivation window/conflict, no-credit policy and custody passed')
}
