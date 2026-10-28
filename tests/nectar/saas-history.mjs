import assert from 'node:assert/strict'

// The normalized reporting sanity journey owns these assertions as well as the
// uploaded 18-month history. All setup uses the ordinary governed public doors.
export function capturedAnalytics(report, expected) {
  const rows = report.saas.months
  assert.deepEqual(rows.map(row => row.closingMrrCents), expected)
  for (const [index,row] of rows.entries()) {
    const before = expected[index-1] ?? 0, after = expected[index]
    const ever = expected.slice(0,index).some(value => value > 0)
    const delta = after-before
    const values = [0,0,0,0,0]
    if (delta) values[before===0 ? ever ? 4 : 0 : after===0 ? 3 : delta>0 ? 1 : 2] = delta
    assert.deepEqual([row.openingMrrCents,row.newMrrCents,row.expansionMrrCents,row.contractionMrrCents,row.churnMrrCents,row.reactivationMrrCents], [before,...values], `Independent customer movement at ${row.period}`)
    assert.equal(row.payingCustomers, after>0?1:0)
    assert.equal(row.arpaCents, after>0?after:null)
    assert.equal(row.logoChurn.value,before>0?(after===0?1:0):null)
    assert.equal(row.grossRetention.value,before>0?Math.min(before,after)/before:null)
    assert.equal(row.netRetention.value,before>0?after/before:null)
  }
  assert.equal(report.saas.cohorts[0].startingMrrCents,5000)
  assert.deepEqual(report.saas.cohorts[0].months.map(row=>row.mrrCents),expected)
  assert.equal(report.saas.trialCohorts[0].trials,1)
  assert.equal(report.saas.trialCohorts[0].converted,expected.length>1?1:0)
}

export async function nativeSaasHistory(h, owner, onState) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  const segment = 'Synthetic research cohort'
  const makeCustomer = async n => {
    const id = (await api('customer.create',{external_id:`synthetic-nectar-saas-${n}`,name:`Research cohort ${n}`,billing_email:[`synthetic-nectar-saas-${n}`,'example.test'].join(String.fromCharCode(64))})).id
    await api('metadata.write',{kind:'customer',record:id,revision:0,metadata:{segment}})
    return id
  }
  const [a,b,c] = [await makeCustomer(1),await makeCustomer(2),await makeCustomer(3)]
  const price = async amount => {
    const product = (await api('product.create',{code:`synthetic-nectar-saas-${amount}`,name:`Research recurring ${amount}`})).id
    return (await api('price.create',{product,kind:'flat',unit_amount:amount})).id
  }
  const [base,addon,trial] = [await price('100'),await price('50'),await price('200')]
  const first = (await api('subscription.create',{customer:a,start_date:'2026-01-01',price:[base]})).id
  const second = (await api('subscription.create',{customer:a,start_date:'2026-02-01',price:[addon]})).id
  const converted = (await api('subscription.create',{customer:b,start_date:'2026-01-01',trial_end:'2026-03-15',price:[trial]})).id
  const lost = (await api('subscription.create',{customer:c,start_date:'2026-01-01',trial_end:'2026-02-15',price:[trial]})).id
  const amendment = await api('amendment.propose',{subscription:first,kind:'discount_percent',value:'50',effective_from:'2026-03-01',effective_to:'2026-04-01',note:'Reviewed dated contract discount',clause:'Half price during March.'})
  await api('amendment.decide',{amendment:amendment.amendment,decision:'approved'})
  for (const subscription of [first,second]) await api('subscription.pause',{subscription,revision:(await api(`subscriptions/${subscription}`)).revision,effective_date:'2026-04-01',resume_date:'2026-05-01',access:'suspend',reason:'Reviewed research pause'})
  for (const [subscription,date] of [[converted,'2026-06-01'],[lost,'2026-02-01']]) await api('subscription.cancel',{subscription,revision:(await api(`subscriptions/${subscription}`)).revision,mode:'immediate',effective_date:date,reason:'Research ended'})
  const query = new URLSearchParams({period:'2026-06',segment})
  const report = await api(`reports/normalized-mrr?${query}`), rows = report.saas.months
  assert.deepEqual(rows.map(row=>row.closingMrrCents),[10000,15000,30000,20000,35000,15000])
  assert.deepEqual(rows.map(row=>row.payingCustomers),[1,1,2,1,2,1],'Two subscriptions belonging to one customer count once')
  assert.deepEqual(rows.map(row=>[row.newMrrCents,row.expansionMrrCents,row.contractionMrrCents,row.churnMrrCents,row.reactivationMrrCents]),[
    [10000,0,0,0,0],[0,5000,0,0,0],[20000,0,-5000,0,0],[0,0,0,-10000,0],[0,0,0,0,15000],[0,0,0,-20000,0],
  ])
  assert.deepEqual(rows.map(row=>row.arpaCents),[10000,15000,15000,20000,17500,15000])
  assert.deepEqual(rows.map(row=>row.logoChurn.value),[null,0,0,0.5,0,0.5])
  assert.deepEqual(rows.map(row=>row.revenueChurn.value),[null,0,1/3,1/3,0,4/7])
  assert.deepEqual(rows.map(row=>row.netRetention.value),[null,1.5,2/3,2/3,1,3/7])
  assert.deepEqual(rows.map(row=>row.grossRetention.value),[null,1,2/3,2/3,1,3/7])
  assert.deepEqual(report.saas.cohorts.map(cohort=>[cohort.period,cohort.customers,cohort.startingMrrCents,cohort.months.map(cell=>cell.mrrCents)]),[
    ['2026-01',1,10000,[10000,15000,10000,0,15000,15000]],['2026-03',1,20000,[20000,20000,20000,0]],
  ])
  assert.deepEqual(report.saas.cohorts[0].months.map(cell=>cell.customerRetention.value),[1,1,1,0,1,1])
  assert.deepEqual(report.saas.cohorts[0].months.map(cell=>cell.netRevenueRetention.value),[1,1.5,1,0,1.5,1.5])
  assert.deepEqual(report.saas.cohorts[0].months.map(cell=>cell.grossRevenueRetention.value),[1,1,1,0,1,1])
  assert.deepEqual(report.saas.trialCohorts.map(cohort=>[cohort.trials,cohort.converted,cohort.conversion.value]),[[2,1,0.5]],'An ended unpaid trial never converts')
  for (const member of report.saas.trialCohorts[0].members) {
    assert.equal((await api(member.trial.href.replace('/app/',''))).totalCents,0)
    if (member.converted) assert.equal((await api(member.converted.href.replace('/app/',''))).totalCents,20000,'Trial conversion drills to its first positive month even after later cancellation')
  }
  const jan = await api(`reports/normalized-mrr?period=2026-01&segment=${encodeURIComponent(segment)}`)
  assert.equal(jan.saas.trialCohorts[0].converted,0,'Future trial conversions never leak into an earlier report')
  for (const month of rows) for (const movement of month.movements) {
    assert.equal(movement.after.reduce((sum,source)=>sum+source.amountCents,0)-movement.before.reduce((sum,source)=>sum+source.amountCents,0),movement.amountCents)
    for (const source of [...movement.before,...movement.after]) assert.equal((await api(source.href.replace('/app/',''))).totalCents,source.amountCents,'Every movement resolves both month-end source contributions')
  }
  for (const cohort of report.saas.cohorts) for (const cell of cohort.months) assert.equal(cell.sources.reduce((sum,source)=>sum+source.amountCents,0),cell.mrrCents)
  const filtered = await api(`reports/normalized-mrr?${query}&plan=${base}`)
  assert.deepEqual(filtered.series.map(row=>row.amountCents),[10000,10000,5000,0,10000,10000])
  await api(`reports/normalized-mrr/${second}?${query}&plan=${base}`,undefined,404)
  const foreign = await api(`reports/normalized-mrr?${query}&customer=${b}&plan=${base}`)
  assert.equal(foreign.totalCents,0)
  assert.deepEqual(foreign.saas.cohorts,[])
  const createEntity = async n => api('entity.create',{revision:(await api('business')).revision,legal_name:`Research Entity ${n}`,address:'1 Research Way',ein:`${20+n}-3456789`,invoice_prefix:`RE${n}`,invoice_number_width:4,payment_terms_days:30,processor_account_ref:`synthetic-nectar-entity-${n}`,ledger_company_ref:`synthetic-nectar-ledger-${n}`,tax_registration:'Synthetic registration'})
  const entity = await createEntity(1)
  await api('customer.entity',{revision:(await api('business')).revision,customer:a,entity:entity.id,confirm:true})
  const entityReport = await api(`reports/normalized-mrr?${query}&entity=${entity.id}`)
  assert.deepEqual(entityReport.series.map(row=>row.amountCents),[10000,15000,10000,0,15000,15000])
  assert.equal(entityReport.entries.some(row=>row.customerId===b),false)
  assert.equal((await api(`reports/normalized-mrr?${query}&entity=${entity.id}&plan=${trial}`)).totalCents,0,'Combined exact filters do not broaden the population')
  await api(`reports/normalized-mrr?${query}&plan=${base}&plan=${trial}`,undefined,400)
  const role = await api('role.define',{name:'Research report reader',capabilities:['read.reports']})
  const email = ['synthetic-nectar-report-reader','example.test'].join(String.fromCharCode(64))
  await api('access.give',{email,name:'Research report reader',role:'custom',custom_role:role.id})
  const reader = await h.signIn(email,{requested:true})
  await h.api(`reports/normalized-mrr?${query}`,reader,undefined,403)
  await h.api(filtered.entries[0].href.replace('/app/',''),reader,undefined,403)
  const publicReport = await h.api(`reports/normalized-mrr?period=2026-06&customer=${a}`,reader)
  assert.deepEqual(publicReport.filterOptions.segments,[],'Report-only authority never reveals customer metadata values')
  await api('role.update',{role:role.id,revision:1,capabilities:['read.reports','read.customers']})
  assert.equal((await h.api(`reports/normalized-mrr?${query}`,reader)).totalCents,15000)
  await api('role.update',{role:role.id,revision:2,capabilities:['read.customers']})
  await h.api(`reports/normalized-mrr?${query}`,reader,undefined,403)
  const before = await api(`subscriptions/${first}`)
  await api(`reports/normalized-arr?${query}`)
  assert.deepEqual(await api(`subscriptions/${first}`),before,'Reading analytics never mutates billing sources')
  await onState({analytics:{customers:'1',arpa:'$150.00',logo:'50.00%',net:'42.86%',gross:'42.86%'},label:'customer-movements',path:`/app/reports/normalized-mrr?${query}`,amount:15000})
  await onState({label:'plan-cohort',path:`/app/reports/normalized-mrr?${query}&plan=${base}`,amount:10000})
  await onState({label:'entity-cohort',path:`/app/reports/normalized-mrr?${query}&entity=${entity.id}`,amount:15000})
  console.log('Native multi-subscription customer movements, churn, retention, ARPA, trial and customer cohorts, exact filters and source reconciliation passed')
}
