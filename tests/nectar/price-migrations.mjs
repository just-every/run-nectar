import assert from 'node:assert/strict'
import { publishPrice } from './price-helper.mjs'
import { applyPolicy } from './policy-helper.mjs'

// CAT-007: chosen cohorts migrate at their own resolved monthly boundaries.
export async function priceMigrations(h,owner) {
  const previous=await h.api('business',owner)
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Catalogue migration examples'})
  await h.api('tax.review',owner,{revision:(await h.api('business',owner)).revision})
  await h.api('access.give',owner,{email:'cat007-finance@example.test',name:'Cohort Finance',role:'finance'})
  const finance=await h.signIn('cat007-finance@example.test',{requested:true})
  const agent={bearer:(await h.api('credential.issue',owner,{name:'Cohort planner',scopes:['prepare']})).key}
  const customer=(await h.api('customer.create',owner,{external_id:'CAT007-MONTHLY',name:'Maple Analytics',billing_email:'billing@maple.example'})).id
  const product=(await h.api('product.create',owner,{code:'cat007-platform',name:'Maple platform'})).id
  const old=(await h.api('price.create',owner,{product,kind:'flat',unit_amount:'499',taxable:false})).id
  const target=(await publishPrice(h,owner,{product,kind:'flat',unit_amount:'549',taxable:false})).id
  const create=async(day,external_id)=> (await h.api('subscription.create',owner,{customer,external_id,start_date:`2026-01-${String(day).padStart(2,'0')}`,anchor_day:day,price:[old]})).id
  const a=await create(1,'Maple-first'),b=await create(15,'Maple-midmonth'),grandfathered=await create(1,'Maple-held')
  const get=id=>h.api(`subscriptions/${id}`,owner)
  const proposal=id=>h.api(`proposals/${id}`,owner)
  const decision=(id,who,status=200,value='approved')=>h.api('proposal.decide',who,{proposal:id,decision:value},status)
  const snapshots=await Promise.all([a,b,grandfathered].map(get))
  const pricesBefore=(await h.api('catalog',owner)).prices
  const payload={target_price:target,effective_date:'2026-06-10',timing:'renewal',subscriptions:[a,b],resolved_dates:{[a]:'1900-01-01'}}
  const prepared=(await h.api('proposal.create',owner,{kind:'price_change',title:'Maple monthly renewal cohort',payload})).id
  const view=await proposal(prepared)
  assert.deepEqual(view.impact.map(e=>[e.subscription,e.effective_date]),[[a,'2026-07-01'],[b,'2026-06-15']],'CAT-007 each subscription resolves its own next renewal')
  assert.deepEqual(view.payload.resolved_dates,{[a]:'2026-07-01',[b]:'2026-06-15'})
  for(const entry of view.impact) assert.deepEqual(entry.periods.map(p=>[p.before.totalCents,p.after.totalCents]),[[49900,54900],[49900,54900]],'CAT-007 exact $499 to $549 preview includes the next invoice and following period')
  assert.deepEqual(await Promise.all([a,b,grandfathered].map(get)),snapshots,'CAT-007 preparation changes no subscription')
  await decision(prepared,owner,409)
  await decision(prepared,agent,403)
  const competing=(await h.api('proposal.create',finance,{kind:'price_change',title:'Competing cohort',payload})).id
  await decision(prepared,finance)
  await decision(prepared,finance,409)
  await decision(competing,owner,409)
  assert.deepEqual((await h.api('catalog',owner)).prices,pricesBefore,'CAT-007 exact-target migrations create no flattened or duplicate price')
  for(const [id,date] of [[a,'2026-07-01'],[b,'2026-06-15']]) {
    const sub=await get(id)
    assert.equal(sub.items.find(i=>i.price_id===old).effective_to,date)
    assert.equal(sub.items.find(i=>i.price_id===target).effective_from,date)
  }
  assert.deepEqual(await get(grandfathered),snapshots[2],'CAT-007 excluded cohort retains its price, dates and revision')
  const issued=[]
  for(const [month,expect] of [['2026-06',[49900,54900,49900]],['2026-07',[54900,54900,49900]]]) {
    await h.api('billrun.prepare',owner,{period:month})
    for(const [index,id] of [a,b,grandfathered].entries()) {
      const inv=(await get(id)).invoices.find(i=>i.period_start.startsWith(month))
      assert.equal(inv.total_cents,expect[index],'CAT-007 billed old/new/held amounts agree at each renewal')
      await h.api('invoice.approve',owner,{invoice:inv.id,acknowledge:true})
      await h.api('invoice.finalise',owner,{invoice:inv.id,issue_date:month==='2026-06'?'2026-07-16':'2026-08-16'})
      issued.push(await h.api(`invoices/${inv.id}`,owner))
    }
  }
  const exact=(await h.api('proposal.create',finance,{kind:'price_change',title:'Boundary renewal reference',payload:{target_price:old,effective_date:'2026-09-15',timing:'renewal',subscriptions:[b]}})).id
  assert.equal((await proposal(exact)).impact[0].effective_date,'2026-09-15','CAT-007 a reference exactly on renewal is inclusive')
  await decision(exact,owner)
  for(const original of issued) assert.deepEqual(await h.api(`invoices/${original.id}`,owner),original,'CAT-007 later scheduling preserves all issued evidence')
  await h.api('proposal.create',owner,{kind:'price_change',title:'Duplicate ids',payload:{...payload,subscriptions:[a,a]}},400)
  await h.api('proposal.create',owner,{kind:'price_change',title:'Unknown timing',payload:{...payload,timing:'eventually'}},400)
  // A target carrying a real quantity model must keep that model in preview/issue.
  const seatsProduct=(await h.api('product.create',owner,{code:'cat007-seats',name:'Maple seats'})).id
  const simple=(await h.api('price.create',owner,{product:seatsProduct,kind:'seat',unit_amount:'10',taxable:false})).id
  const tiered=(await publishPrice(h,owner,{product:seatsProduct,kind:'seat',taxable:false,pricing_model:'graduated',tiers:[{up_to:'5',unit_amount:'8',flat_amount:'0'},{up_to:null,unit_amount:'6',flat_amount:'0'}]})).id
  const modeled=(await h.api('subscription.create',owner,{customer,start_date:'2026-01-01',price:[simple],quantity:['7']})).id
  const tierProposal=(await h.api('proposal.create',agent,{kind:'price_change',title:'Tiered renewal',payload:{target_price:tiered,effective_date:'2026-08-01',timing:'renewal',subscriptions:[modeled]}})).id
  const tierImpact=(await proposal(tierProposal)).impact[0]
  assert.equal(tierImpact.periods[0].after.totalCents,5200,'CAT-007 existing graduated target rates 5×$8 + 2×$6')
  await decision(tierProposal,owner)
  await h.api('billrun.prepare',owner,{period:'2026-08'})
  const ti=(await get(modeled)).invoices.find(i=>i.period_start==='2026-08-01')
  assert.equal(ti.total_cents,5200)
  await h.api('invoice.approve',owner,{invoice:ti.id,acknowledge:true})
  await h.api('invoice.finalise',owner,{invoice:ti.id,issue_date:'2026-09-01'})
  const tierInvoice=await h.api(`invoices/${ti.id}`,owner)
  assert.equal(tierInvoice.lines[0].evidence.pricingModel,'graduated')
  for(const [model,terms,expected] of [
    ['volume',{tiers:[{up_to:'5',unit_amount:'8'},{up_to:null,unit_amount:'6'}]},4200],
    ['package',{package_size:'3',tiers:[{up_to:null,unit_amount:'12'}]},3600],
    ['stair_step',{tiers:[{up_to:'5',flat_amount:'30'},{up_to:null,flat_amount:'50'}]},5000],
  ]) {
    const next=(await publishPrice(h,owner,{product:seatsProduct,kind:'seat',taxable:false,pricing_model:model,...terms})).id
    const plan=(await h.api('proposal.create',agent,{kind:'price_change',title:`${model} target`,payload:{target_price:next,effective_date:'2026-09-01',subscriptions:[modeled]}})).id
    assert.equal((await proposal(plan)).impact[0].periods[0].after.totalCents,expected,`CAT-007 ${model} target retains its full pricing semantics`)
    await decision(plan,owner)
    assert.equal((await h.api(`subscriptions/${modeled}/upcoming?period=2026-09`,owner)).calculation.totalCents,expected)
  }
  assert.deepEqual(await h.api(`invoices/${ti.id}`,owner),tierInvoice,'CAT-007 repeated model migrations leave the issued graduated invoice unchanged')
  const immediate=(await h.api('subscription.create',owner,{customer,start_date:'2026-09-01',price:[old]})).id
  const nowPlan=(await h.api('proposal.create',agent,{kind:'price_change',title:'First-day change',payload:{target_price:target,effective_date:'2026-09-01',subscriptions:[immediate]}})).id
  await decision(nowPlan,owner)
  assert.deepEqual((await get(immediate)).items.map(i=>[i.price_id,i.effective_from,i.effective_to]),[[target,'2026-09-01',null]],'CAT-007 an unissued first-day change never creates a zero-length item')
  const duplicateItems=(await h.api('subscription.create',owner,{customer,start_date:'2026-09-01',price:[old,old]})).id
  const allItems=(await h.api('proposal.create',agent,{kind:'price_change',title:'Every matching plan item',payload:{target_price:target,effective_date:'2026-09-01',subscriptions:[duplicateItems]}})).id
  assert.equal((await proposal(allItems)).impact[0].periods[0].after.totalCents,109800,'CAT-007 preview migrates both matching items of one subscription')
  await decision(allItems,owner)
  assert.equal((await get(duplicateItems)).items.filter(i=>i.price_id===target).length,2)
  const stream=(await h.api('meter.create',owner,{code:'cat007-calls',name:'Maple calls',unit_label:'calls'})).id
  const streamProduct=(await h.api('product.create',owner,{code:'cat007-calls',name:'Maple metered calls'})).id
  const streamOld=(await h.api('price.create',owner,{product:streamProduct,kind:'unit',meter:stream,unit_amount:'2',taxable:false})).id
  const streamNew=(await publishPrice(h,owner,{product:streamProduct,kind:'unit',meter:stream,unit_amount:'3',taxable:false})).id
  const metered=(await h.api('subscription.create',owner,{customer,start_date:'2026-09-01',price:[streamOld]})).id
  const meterPayload={target_price:streamNew,effective_date:'2026-09-01',subscriptions:[metered]}
  const stale=(await h.api('proposal.create',agent,{kind:'price_change',title:'Metered preview before usage',payload:meterPayload})).id
  await h.api('usage.submit',owner,{events:[{event_id:'cat007-usage',customer:'CAT007-MONTHLY',meter:'cat007-calls',quantity:'6',occurred_at:'2026-09-05T12:00:00-07:00'}]})
  await decision(stale,owner,409)
  assert.equal((await get(metered)).items[0].price_id,streamOld,'CAT-007 changed usage invalidates the saved price-impact approval')
  const fresh=(await h.api('proposal.create',agent,{kind:'price_change',title:'Metered current preview',payload:meterPayload})).id
  assert.equal((await proposal(fresh)).impact[0].periods[0].after.totalCents,1800)
  await decision(fresh,owner)
  await h.api('billrun.prepare',owner,{period:'2026-09'})
  const meteredInvoice=(await get(metered)).invoices.find(i=>i.period_start==='2026-09-01')
  assert.equal(meteredInvoice.total_cents,1800)
  await h.api('invoice.approve',owner,{invoice:meteredInvoice.id,acknowledge:true})
  await h.api('invoice.finalise',owner,{invoice:meteredInvoice.id,issue_date:'2026-10-01'})
  const wrongProduct=(await publishPrice(h,owner,{product,kind:'seat',unit_amount:'9',taxable:false})).id
  await h.api('proposal.create',owner,{kind:'price_change',title:'Kind mismatch',payload:{target_price:wrongProduct,effective_date:'2026-09-01',subscriptions:[a]}},400)
  const retired=(await publishPrice(h,owner,{product:seatsProduct,kind:'seat',unit_amount:'12',taxable:false})).id
  await h.api('price.retire',owner,{price:retired})
  await h.api('proposal.create',owner,{kind:'price_change',title:'Retired target',payload:{target_price:retired,effective_date:'2026-09-01',subscriptions:[modeled]}},409)
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:previous.tax_jurisdiction,tax_mode:previous.tax_mode,tax_rate:previous.tax_rate,tax_note:previous.tax_note})
  await h.api('tax.review',owner,{revision:(await h.api('business',owner)).revision})
  await intervalPriceCohorts(h, owner, finance)
  console.log('CAT-007 renewal/dated cohorts, exact-target models, held cohort, next invoices and governed stale/duplicate refusals passed')
}

async function intervalPriceCohorts(h, owner, finance) {
  const cases = [
    { name: 'annual', interval: 'annual', timing: 'advance', start: '2030-01-01', reference: '2030-06-10', renewal: '2031-01-01', due: '2031-01', old: '1000', next: '1200', cents: 120000 },
    { name: 'quarter', interval: 'quarterly', timing: 'arrears', start: '2030-01-01', reference: '2030-02-10', renewal: '2030-04-01', due: '2030-07', old: '90', next: '120', cents: 12000 },
    { name: 'week', interval: 'weekly', timing: 'arrears', start: '2030-01-01', reference: '2030-01-02', renewal: '2030-01-08', due: '2030-01', old: '7', next: '14', cents: 1400 },
  ]
  for (const row of cases) {
    const customer = (await h.api('customer.create', owner, { external_id: `synthetic-nectar-cohort-${row.name}`, name: `Interval ${row.name}`, billing_email: `${row.name}@cohort.example` })).id
    const product = (await h.api('product.create', owner, { code: `interval-cohort-${row.name}`, name: `Cohort ${row.name}` })).id
    const fields = { product, kind: 'flat', taxable: false, billing_interval: row.interval, billing_timing: row.timing }
    const old = (await publishPrice(h, owner, { ...fields, unit_amount: row.old })).id
    const target = (await publishPrice(h, owner, { ...fields, unit_amount: row.next })).id
    const subscription = (await h.api('subscription.create', owner, { customer, start_date: row.start, billing_anchor_date: row.start, price: [old] })).id
    const held = (await h.api('subscription.create', owner, { customer, start_date: row.start, billing_anchor_date: row.start, price: [old] })).id
    const heldBefore = await h.api(`subscriptions/${held}`, owner)
    const created = await h.api('proposal.create', owner, { kind: 'price_change', title: `${row.name} anniversary cohort`, payload: { source_price: old, target_price: target, timing: 'renewal', effective_date: row.reference, subscriptions: [subscription] } })
    const prepared = await h.api(`proposals/${created.id}`, owner), entry = prepared.impact[0]
    assert.equal(entry.effective_date, row.renewal, 'Renewal follows the saved cadence rather than the next monthly anchor')
    assert.equal(entry.periods[0].after.totalCents, row.cents)
    assert.equal(entry.periods[0].afterWindow.period.start, row.renewal)
    await h.api('proposal.decide', finance, { proposal: created.id, decision: 'approved' })
    assert.deepEqual(await h.api(`subscriptions/${held}`, owner), heldBefore, 'An excluded interval cohort remains grandfathered')
    await h.advanceClock(`${row.due}-28T20:00:00Z`)
    await h.api('billrun.prepare', owner, { period: row.due })
    const invoice = (await h.api(`subscriptions/${subscription}`, owner)).invoices.find(invoice => invoice.period_start === row.renewal)
    assert.ok(invoice)
    assert.equal(invoice.total_cents, entry.periods[0].after.totalCents, 'Ordinary interval billing equals the saved cohort preview')
    const detail = await h.api(`invoices/${invoice.id}`, owner)
    assert.deepEqual([detail.period_start, detail.period_end], [entry.periods[0].afterWindow.period.start, entry.periods[0].afterWindow.period.end])
    if (row.name === 'annual') {
      const monthly = (await publishPrice(h, owner, { product, kind: 'flat', unit_amount: '100', taxable: false })).id
      assert.equal((await h.api('proposal.create', owner, { kind: 'price_change', title: 'Refuse cadence conversion', payload: { target_price: monthly, effective_date: '2032-01-01', subscriptions: [held] } }, 409)).error, 'pricing_cadence_change_requires_separate_terms')
    }
  }
}
