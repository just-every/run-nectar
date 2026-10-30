import { reviewer } from './policy-helper.mjs'
import assert from 'node:assert/strict'
import { publishPrice } from './price-helper.mjs'

// SUB-004 carries CAT-001/CAT-007/AGENT-004 current pricing and full-term parity.
export async function renewalPricing(h,owner) {
  const me=await h.api('me',owner)
  const singleAllowed=!(await h.api('members',owner)).some(m=>m.id!==me.id&&m.status==='active'&&['owner','finance'].includes(m.role))
  const approver=await reviewer(h,owner,singleAllowed)
  const customer=(await h.api('customer.create',owner,{external_id:'SUB004-MODELS',name:'Term model laboratory',billing_email:'terms@laboratory.example'})).id
  const meter=(await h.api('meter.create',owner,{code:'sub004-units',name:'Measured units',unit_label:'units'})).id
  const models=[
    ['simple',{unit_amount:'10'},7350],
    ['graduated',{pricing_model:'graduated',tiers:[{up_to:'5',unit_amount:'8',flat_amount:'2'},{up_to:null,unit_amount:'6',flat_amount:'3'}]},5985],
    ['volume',{pricing_model:'volume',tiers:[{up_to:'5',unit_amount:'8'},{up_to:null,unit_amount:'6',flat_amount:'3'}]},4725],
    ['package',{pricing_model:'package',package_size:'3',tiers:[{up_to:null,unit_amount:'12'}]},3780],
    ['stair_step',{pricing_model:'stair_step',tiers:[{up_to:'5',flat_amount:'30'},{up_to:null,flat_amount:'50'}]},5250],
  ]
  const terms=[],initials=[]
  for(const [name,pricing,expected] of models) {
    const product=(await h.api('product.create',owner,{code:`sub004-model-${name}`,name:`Term ${name}`})).id
    const price=(await h.api('price.create',owner,{product,kind:'seat',taxable:false,...pricing})).id
    const sub=(await h.api('subscription.create',owner,{customer,start_date:'2026-01-01',price:[price],quantity:['7']})).id
    const detail=await h.api(`subscriptions/${sub}`,owner)
    const term=await h.api('term.prepare',owner,{subscription:sub,revision:detail.revision,term_start:'2026-01-01',months:12,auto_renew:true,notice_days:30,uplift_percent:'5'})
    await h.api('term.decide',approver,{term:term.term,decision:'approved',confirm_single:singleAllowed})
    terms.push({sub,expected,name})
    initials.push(await h.api(`subscriptions/${sub}/upcoming?period=2026-07`,owner))
  }
  // Simple metered prices and source metrics receive the identical dated uplift.
  const metric=await h.api('meter.prepare',owner,{code:'sub004-metric',name:'Term maximum',unit_label:'units',source_meter:meter,definition:{aggregation:'maximum'}})
  for(const period of ['2020-01','2020-02','2020-03'])await h.api('meter.preview',owner,{request:metric.request,customer,period})
  const activated=await h.api('meter.activate',owner,{request:metric.request})
  const product=(await h.api('product.create',owner,{code:'sub004-metric-price',name:'Metric plan'})).id
  const metricPrice=(await h.api('price.create',owner,{product,kind:'unit',meter:activated.id,unit_amount:'0.0004',taxable:false})).id
  const metricSub=(await h.api('subscription.create',owner,{customer,start_date:'2026-01-01',price:[metricPrice]})).id
  const metricTerm=await h.api('term.prepare',owner,{subscription:metricSub,revision:(await h.api(`subscriptions/${metricSub}`,owner)).revision,term_start:'2026-01-01',months:12,auto_renew:true,notice_days:30,uplift_percent:'5'})
  await h.api('term.decide',approver,{term:metricTerm.term,decision:'approved',confirm_single:singleAllowed})
  assert.equal((await h.api('subscription.create',owner,{customer,start_date:'2028-01-01',price:[metricPrice]},409)).error,'meter_already_billed','SUB-004 automatic future terms retain source ownership')
  assert.equal((await h.api('subscription.addon',owner,{subscription:terms[0].sub,price:metricPrice,effective_date:'2028-01-01'},409)).error,'meter_already_billed','SUB-004 add-ons cannot reclaim an automatically renewing source')
  const event=await h.api('usage.submit',owner,{events:[{event_id:'sub004-metric-renewal',customer:'SUB004-MODELS',meter:'sub004-units',quantity:'1000.5',occurred_at:'2027-01-10T12:00:00-08:00'}]})
  assert.equal(event.accepted,1)
  const clock=stamp=>h.raw(`/cdn-cgi/local/scheduled?time=${Date.parse(stamp)}&cron=${encodeURIComponent('0 14 * * *')}`)
  assert.equal((await clock('2027-01-01T08:00:00Z')).status,200)
  for(const [index,t] of terms.entries()) {
    const next=await h.api(`subscriptions/${t.sub}/upcoming?period=2027-01`,owner)
    assert.equal(next.calculation.totalCents,t.expected,`SUB-004 ${t.name} uplift preserves quantity model and exact fees`)
    assert.deepEqual((await h.api(`subscriptions/${t.sub}/upcoming?period=2026-07`,owner)).calculation.lines,initials[index].calculation.lines,`SUB-004 ${t.name} earlier inputs and cents remain unchanged`)
  }
  const metricNext=await h.api(`subscriptions/${metricSub}/upcoming?period=2027-01`,owner)
  assert.equal(metricNext.calculation.totalCents,42,'SUB-004 metric rational quantity receives six-place uplift with one final cent rounding')
  assert.equal(metricNext.calculation.lines[0].unitAmount,'0.00042')
  // A signed annual cohort remains on its old price until its actual term boundary.
  const seatProduct=(await h.api('product.create',owner,{code:'sub004-history',name:'Full annual history'})).id
  const old=(await publishPrice(h,owner,{product:seatProduct,kind:'flat',unit_amount:'100',taxable:false})).id
  const target=(await publishPrice(h,owner,{product:seatProduct,kind:'flat',unit_amount:'120',taxable:false})).id
  const historical=(await h.api('subscription.create',owner,{customer,start_date:'2025-01-01',price:[old]})).id
  const ht=await h.api('term.prepare',owner,{subscription:historical,revision:(await h.api(`subscriptions/${historical}`,owner)).revision,term_start:'2025-01-01',months:12,auto_renew:true,notice_days:30,uplift_percent:'5'})
  await h.api('term.decide',approver,{term:ht.term,decision:'approved',confirm_single:singleAllowed})
  const history=[]
  for(let m=1;m<=12;m++) {
    const period=`2025-${String(m).padStart(2,'0')}`,run=await h.api('billrun.prepare',owner,{period})
    const invoice=(await h.api(`runs/${run.id}`,owner)).invoices.find(i=>i.customer_id===customer)
    assert.ok(invoice)
    await h.api('invoice.approve',owner,{invoice:invoice.id,acknowledge:true})
    await h.api('invoice.finalise',owner,{invoice:invoice.id,issue_date:m===12?'2026-01-01':`2025-${String(m+1).padStart(2,'0')}-01`})
    history.push(await h.api(`invoices/${invoice.id}`,owner))
  }
  const simulation=await h.api('proposal.create',owner,{kind:'price_change',title:'Replay full signed term',payload:{simulation:true,start_month:'2025-01',effective_date:'2026-01-01',source_price:old,target_price:target,subscriptions:[historical],cost_cents:1000}})
  const replay=(await h.api(`proposals/${simulation.id}`,owner)).impact[0].historical
  assert.equal(replay.periods.length,12,'SUB-004/AGENT-004 replays the complete signed annual term, not six months')
  assert.deepEqual([replay.totals.beforeTotalCents,replay.totals.afterTotalCents,replay.totals.deltaTotalCents],[120000,144000,24000])
  assert.equal(replay.estimatedMargins.totalCostCents,12000)
  const migration=await h.api('proposal.create',owner,{kind:'price_change',title:'At annual renewal',payload:{target_price:target,timing:'renewal',effective_date:'2025-07-01',subscriptions:[historical]}})
  const impact=(await h.api(`proposals/${migration.id}`,owner)).impact[0]
  assert.equal(impact.effective_date,'2026-01-01','SUB-004/CAT-007 resolves actual annual renewal instead of monthly anchor')
  assert.equal(impact.periods[0].after.totalCents,12600,'SUB-004/CAT-007 approved renewal price preview includes signed5% uplift')
  await h.api('proposal.create',owner,{kind:'price_change',title:'Break signed term',payload:{target_price:target,effective_date:'2025-07-01',subscriptions:[historical]}},409)
  await h.api('access.give',owner,{email:'cohort-finance@renewals.example',role:'finance',name:'Cohort Finance'})
  const finance=await h.signIn('cohort-finance@renewals.example',{requested:true})
  await h.api('proposal.decide',finance,{proposal:migration.id,decision:'approved'})
  assert.equal((await clock('2026-01-01T08:00:00Z')).status,200)
  const renewedRun=await h.api('billrun.prepare',owner,{period:'2026-01'})
  const renewedInvoice=(await h.api(`subscriptions/${historical}`,owner)).invoices.find(i=>i.period_start==='2026-01-01')
  assert.equal(renewedInvoice.total_cents,impact.periods[0].after.totalCents,'SUB-004/CAT-007 actual renewal bills the saved migration preview')
  await h.api('invoice.approve',owner,{invoice:renewedInvoice.id,acknowledge:true})
  await h.api('invoice.finalise',owner,{invoice:renewedInvoice.id,issue_date:'2026-02-01'})
  assert.equal((await h.api(`invoices/${renewedInvoice.id}`,owner)).total_cents,12600)
  for(const issued of history)assert.deepEqual(await h.api(`invoices/${issued.id}`,owner),issued,'SUB-004 annual pricing preparation preserves every issued invoice')
  await annualIntervalRenewal(h, owner, finance)
  console.log('SUB-004 pricing models, metric uplift, full-term replay and annual cohort boundaries passed')
}

async function annualIntervalRenewal(h, owner, finance) {
  const product = (await h.api('product.create', owner, { code: 'annual-interval-renewal', name: 'Annual signed service' })).id
  const definition = { product, kind: 'flat', taxable: false, billing_interval: 'annual', billing_timing: 'advance' }
  const old = (await publishPrice(h, owner, { ...definition, unit_amount: '1000' })).id
  const target = (await publishPrice(h, owner, { ...definition, unit_amount: '1200' })).id
  const customer = (await h.api('customer.create', owner, { external_id: 'synthetic-nectar-annual-renewal', name: 'Annual signed cohort', billing_email: 'annual@renewal.example' })).id
  const subscription = (await h.api('subscription.create', owner, { customer, start_date: '2035-01-01', billing_anchor_date: '2035-01-01', price: [old] })).id
  const term = await h.api('term.prepare', owner, { subscription, revision: (await h.api(`subscriptions/${subscription}`, owner)).revision, term_start: '2035-01-01', months: 12, auto_renew: true, notice_days: 30, uplift_percent: '5' })
  await h.api('term.decide', finance, { term: term.term, decision: 'approved' })
  const before = await h.api(`subscriptions/${subscription}`, owner)
  const payload = { source_price: old, target_price: target, subscriptions: [subscription], effective_date: '2035-07-01' }
  assert.equal((await h.api('proposal.create', owner, { kind: 'price_change', title: 'Preserve signed annual fee', payload }, 409)).error, 'signed_term_grandfathered')
  const request = await h.api('proposal.create', owner, { kind: 'price_change', title: 'Next annual service term', payload: { ...payload, timing: 'renewal' } })
  const view = await h.api(`proposals/${request.id}`, owner), entry = view.impact[0]
  assert.equal(entry.effective_date, '2036-01-01')
  assert.equal(entry.periods.length, 1, 'A twelve month annual service term is one real annual invoice')
  assert.deepEqual([entry.periods[0].before.totalCents, entry.periods[0].after.totalCents], [105000, 126000])
  assert.deepEqual(await h.api(`subscriptions/${subscription}`, owner), before, 'Preparation leaves the current signed annual term intact')
  await h.api('proposal.decide', finance, { proposal: request.id, decision: 'approved' })
  await h.advanceClock('2036-01-01T20:00:00Z')
  await h.raw(`/cdn-cgi/local/scheduled?time=${Date.parse('2036-01-01T20:00:00Z')}&cron=${encodeURIComponent('0 14 * * *')}`)
  await h.api('billrun.prepare', owner, { period: '2036-01' })
  const invoice = (await h.api(`subscriptions/${subscription}`, owner)).invoices.find(invoice => invoice.period_start === '2036-01-01')
  assert.ok(invoice)
  assert.equal(invoice.total_cents, entry.periods[0].after.totalCents)
}
