import { prepaidReportParity } from './prepaid-report-parity.mjs'
import assert from 'node:assert/strict'
import { applyPolicy } from './policy-helper.mjs'
import { csvRows } from './financial-reports.mjs'

// CAT-004 foundation: real native purchase/approve/issue/payment doors.
// Bank receipts here are ordinary operator-recorded external payments; the
// separate native-card journey supplies actual processor-edge receipts.
export async function prepaidFlow(h,owner,{fundPurchase,onState=async()=>{}}={}) {
  const api=(path,body,status)=>h.api(path,owner,body,status)
  await h.advanceClock('2026-01-01T18:00:00Z')
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'flat_rate',tax_rate:'10',tax_note:'Synthetic prepaid consumption tax'})
  await api('tax.review',{revision:(await api('business')).revision})
  await api('access.give',{email:'synthetic-nectar-301@example.test',name:'Synthetic prepaid finance',role:'finance'})
  const finance=await h.signIn('synthetic-nectar-301@example.test',{requested:true})
  await api('access.give',{email:'synthetic-nectar-302@example.test',name:'Synthetic prepaid reader',role:'accountant'})
  const reader=await h.signIn('synthetic-nectar-302@example.test',{requested:true})
  const agent={bearer:(await api('credential.issue',{name:'Synthetic prepaid observer',scopes:['prepare']})).key}
  const make=async(n,unit='1',annual=false)=>{
    const external=`synthetic-nectar-${n}`,customer=(await api('customer.create',{external_id:external,name:`Synthetic prepaid ${n}`,billing_email:`${external}@example.test`})).id
    const meterCode=`synthetic-nectar-${n+1}`,meter=(await api('meter.create',{code:meterCode,name:'Synthetic prepaid calls',unit_label:'calls'})).id
    const product=(await api('product.create',{code:`synthetic-nectar-${n+2}`,name:'Synthetic prepaid usage'})).id
    const price=(await api('price.create',{product,kind:'unit',meter,unit_amount:unit,taxable:true})).id
    const prices=[price]
    if(annual){const p=(await api('product.create',{code:`synthetic-nectar-${n+3}`,name:'Synthetic annual fee'})).id;prices.push((await api('price.create',{product:p,kind:'flat',unit_amount:'12000',billing_interval:'annual',billing_timing:'advance',taxable:true})).id)}
    const subscription=(await api('subscription.create',{customer,start_date:'2026-01-01',price:prices,term_months:24})).id
    return {customer,subscription,external,meter,meterCode,price}
  }
  const state=sub=>api(`prepaid/${sub}`)
  const prepare=async(row,changes={})=>api('prepaid.prepare',{subscription:row.subscription,mode:'grant',kind:'money',source:'promotion',amount:'1000',effective_date:'2026-01-01',expires_date:'2026-02-01',priority:0,expiry_consent:true,...changes})
  const approve=async(request,who=finance,extra={})=>h.api('prepaid.decide',who,{request,decision:'approved',...extra})
  const purchase=async(intent,row,date)=>{
    const prepared=await api('prepaid.purchase.prepare',{intent,issue_date:date})
    await api('invoice.approve',{invoice:prepared.invoice,acknowledge:true})
    await api('invoice.finalise',{invoice:prepared.invoice,issue_date:date})
    const issued=await api(`invoices/${prepared.invoice}`)
    assert.equal(issued.lines.length,1);assert.equal(issued.lines[0].kind,'prepaid_purchase')
    assert.equal(issued.tax_cents,0)
    assert.equal((await state(row.subscription)).grants.some(grant=>grant.purchaseInvoice===issued.id),false,'Issuing a real unpaid purchase creates liability custody, never spendable funds')
    await api('prepaid.funding.confirm',{intent,confirm:true},409)
    if(fundPurchase)await fundPurchase({h,owner,finance,row,intent,invoice:issued})
    else {
      const payment=await api('payment.record',{customer:row.customer,amount:(issued.total_cents/100).toFixed(2),received_on:date,method:'bank_transfer',reference:`synthetic-nectar-payment-${intent}`})
      await api('payment.allocate',{payment:payment.payment,invoice:issued.id,amount:(issued.total_cents/100).toFixed(2)})
      await api('prepaid.funding.confirm',{intent,confirm:true})
    }
    await api('prepaid.funding.confirm',{intent,confirm:true},409)
    assert.equal((await api(`invoices/${issued.id}`)).balanceCents,0)
    return issued
  }
  const issue=async(row,period,date)=>{
    const run=await api('billrun.prepare',{period}),invoices=(await api(`runs/${run.id}`)).invoices.filter(invoice=>invoice.customer_id===row.customer)
    assert.ok(invoices.length)
    for(const invoice of invoices){await api('invoice.approve',{invoice:invoice.id,acknowledge:true});await api('invoice.finalise',{invoice:invoice.id,issue_date:date})}
    return Promise.all(invoices.map(invoice=>api(`invoices/${invoice.id}`)))
  }
  const usage=(row,id,quantity,date)=>api('usage.submit',{events:[{event_id:`synthetic-nectar-${id}`,customer:row.external,meter:row.meterCode,quantity,occurred_at:`${date}T12:00:00Z`}]})
  const snapshots=[]
  const moneyBalance=body=>body.balances.filter(balance=>balance.kind==='money').reduce((sum,balance)=>sum+balance.remainingN,0)
  const row=await make(310,'1',true)
  const annual=(await issue(row,'2026-01','2026-01-01'))[0]
  const annualOriginal=annual.calculation
  const paid=await prepare(row,{source:'purchase',amount:'10000',expires_date:'2026-04-01',priority:10,rollover_months:1,rollover_percent:100})
  const before=await state(row.subscription)
  assert.equal(before.grants.length,0)
  await h.api('prepaid.decide',owner,{request:paid.request,decision:'approved'},409)
  for(const who of [agent,reader])await h.api('prepaid.decide',who,{request:paid.request,decision:'approved'},403)
  const approved=await approve(paid.request)
  assert.equal(approved.fundingIntent,paid.request)
  const purchaseInvoice=await purchase(approved.fundingIntent,row,'2026-01-01')
  assert.equal(moneyBalance(await state(row.subscription)),1000000)
  const promo=await prepare(row);await approve(promo.request)
  const consent=await prepare(row,{mode:'consent',source:'purchase',amount:'5000',threshold:'1000',effective_date:'2026-01-01',expires_date:'2026-12-01',priority:10,funding_consent:true})
  await approve(consent.request)
  assert.equal(moneyBalance(await state(row.subscription)),1100000)
  assert.equal((await state(row.subscription)).fundingIntents.filter(intent=>intent.status==='pending').length,0)
  await prepaidReportParity(h,owner,row,{snapshotActor:owner,snapshots})
  await usage(row,320,'6000','2026-01-15')
  const beforePreview=await state(row.subscription)
  for(let count=0;count<2;count++){
    const upcoming=await api(`subscriptions/${row.subscription}/upcoming?period=2026-02`)
    assert.equal(upcoming.calculation.totalCents,50000,'Promotion reduces taxable consideration; purchased credits retain the original consumption tax')
    assert.equal(upcoming.calculation.lines.filter(line=>line.kind==='prepaid_drawdown').reduce((sum,line)=>sum+line.amountCents,0),-600000)
  }
  assert.deepEqual(await state(row.subscription),beforePreview,'Usage previews never mutate grants, ledgers or funding intents')
  await h.advanceClock('2026-02-01T18:00:00Z')
  const january=(await issue(row,'2026-02','2026-02-01'))[0]
  assert.equal(january.total_cents,50000)
  assert.equal(moneyBalance(await state(row.subscription)),500000)
  const firstLedger=await state(row.subscription)
  assert.equal(firstLedger.entries.filter(entry=>entry.kind==='drawdown').reduce((sum,entry)=>sum+entry.recognitionCents,0),500000)
  await prepaidReportParity(h,owner,row,{snapshotActor:owner,snapshots})
  await usage(row,321,'4100','2026-02-15')
  await h.advanceClock('2026-03-01T18:00:00Z')
  const february=(await issue(row,'2026-03','2026-03-01'))[0]
  assert.equal(february.total_cents,41000)
  const low=await state(row.subscription)
  assert.equal(moneyBalance(low),90000)
  await prepaidReportParity(h,owner,row,{snapshots})
  const topup=low.fundingIntents.filter(intent=>intent.status==='pending')
  assert.equal(topup.length,1);assert.equal(topup[0].amount_cents,500000)
  assert.equal(topup[0].payment_id,null,'A low-balance funding intent has no invented payment or provider receipt')
  await api('prepaid.settle',{subscription:row.subscription})
  assert.equal((await state(row.subscription)).fundingIntents.filter(intent=>intent.status==='pending').length,1,'Repeated low-balance evaluation owns one pending funding intent')
  const topupInvoice=await purchase(topup[0].id,row,'2026-03-01')
  assert.equal(moneyBalance(await state(row.subscription)),590000)
  await prepaidReportParity(h,owner,row,{snapshotActor:owner,snapshots})
  await api('prepaid.consent.revoke',{consent:consent.request})
  const expiring=await prepare(row,{amount:'200',effective_date:'2026-03-01',expires_date:'2026-03-15'})
  await approve(expiring.request)
  await h.advanceClock('2026-03-15T18:00:00Z')
  await api('prepaid.settle',{subscription:row.subscription})
  const expired=await state(row.subscription)
  assert.equal(moneyBalance(expired),590000)
  await prepaidReportParity(h,owner,row,{snapshotActor:reader,snapshots})
  assert.ok(expired.entries.some(entry=>entry.kind==='expiry'&&entry.amountN===-20000))
  assert.deepEqual((await api(`invoices/${annual.id}`)).calculation,annualOriginal)
  for(const original of [january,february,purchaseInvoice,topupInvoice])assert.deepEqual((await api(`invoices/${original.id}`)).calculation,original.calculation,'Later spending, funding and expiry preserve every issued original')
  const csv=await h.raw(`/app/exports/prepaid/${row.subscription}.csv`,{cookie:owner});assert.equal(csv.status,200)
  const csvEntries=csvRows(await csv.text());assert.equal(csvEntries.length,expired.entries.length)
  for(const entry of expired.entries){const source=await api(`prepaid/${row.subscription}/entries/${encodeURIComponent(entry.id)}`);assert.equal(source.entry.amountN,entry.amountN);assert.equal(source.entry.recognitionCents,entry.recognitionCents)}
  await onState({row,purchaseInvoice,topupInvoice,january,february,expired})

  // Units, fractional consumption, priority and capped rollover use the same
  // native ledger and exact saved unit-price engine, with final-cent recovery.
  const units=await make(330,'2')
  const unitPurchase=await prepare(units,{kind:'units',source:'purchase',amount:'3',purchase_amount:'1',meter:units.meter,expires_date:'2026-05-01',priority:10})
  await approve(unitPurchase.request);await purchase(unitPurchase.request,units,'2026-01-01')
  const freeUnits=await prepare(units,{kind:'units',amount:'1',meter:units.meter,priority:0});await approve(freeUnits.request)
  const rollover=await prepare(units,{kind:'units',amount:'10',meter:units.meter,expires_date:'2026-05-01',priority:1000,rollover_months:1,rollover_percent:50,rollover_cap:'3'});await approve(rollover.request)
  const dollarPriority=await prepare(units,{kind:'money',amount:'0.50',expires_date:'2026-05-01',priority:5});await approve(dollarPriority.request)
  await usage(units,340,'1.75','2026-01-15')
  const unitJanuary=(await issue(units,'2026-01','2026-02-01'))[0]
  assert.equal(unitJanuary.subtotal_cents,0);assert.equal(unitJanuary.tax_cents,10,'Promotional units and higher-priority promotional dollars reduce tax; purchased units retain the remaining service tax')
  const unitJanuaryLedger=await state(units.subscription)
  assert.equal(unitJanuaryLedger.entries.filter(entry=>entry.kind==='drawdown').reduce((sum,entry)=>sum+entry.recognitionCents,0),17)
  assert.equal(unitJanuaryLedger.entries.filter(entry=>entry.grantId===dollarPriority.request&&entry.kind==='drawdown').reduce((sum,entry)=>sum+entry.amountN,0),-50,'A higher-priority dollar lot is drawn before lower-priority units')
  assert.equal(unitJanuaryLedger.entries.filter(entry=>entry.purchaseInvoice&&entry.kind==='drawdown').reduce((sum,entry)=>sum+entry.amountN,0),-500000,'Exact native repricing prevents lower-priority units from redeeming the same consideration twice')
  for(const grant of unitJanuaryLedger.grants.filter(grant=>grant.source==='promotion'))assert.equal(grant.liabilityCents,0,'Promotional grants never enter paid contract liability')
  await usage(units,341,'2.5','2026-02-15')
  const unitFebruary=(await issue(units,'2026-02','2026-03-01'))[0]
  assert.equal(unitFebruary.subtotal_cents,0);assert.equal(unitFebruary.tax_cents,50)
  await api('prepaid.settle',{subscription:units.subscription})
  const unitState=await state(units.subscription)
  assert.equal(unitState.entries.filter(entry=>entry.kind==='drawdown').reduce((sum,entry)=>sum+entry.recognitionCents,0),100,'Last unit consumption recovers the exact original purchased dollar')
  assert.deepEqual(unitState.entries.filter(entry=>entry.grantId===rollover.request&&entry.kind==='rollover').map(entry=>[entry.serviceDate,entry.amountN]),[['2026-02-01',-7000000],['2026-03-01',-1500000]])
  const stale=await prepare(units,{kind:'units',amount:'2',meter:units.meter,expires_date:'2026-05-01'})
  const intervening=await prepare(units,{kind:'units',amount:'1',meter:units.meter,expires_date:'2026-05-01'});await approve(intervening.request)
  await h.api('prepaid.decide',finance,{request:stale.request,decision:'approved'},409)
  await h.api('prepaid.prepare',finance,{subscription:units.subscription},403)
  for(const who of [agent,reader])for(const action of ['prepaid.prepare','prepaid.purchase.prepare','prepaid.funding.confirm','prepaid.settle','prepaid.consent.revoke'])await h.api(action,who,{},403)
  await h.api(`prepaid/${units.subscription}`,undefined,undefined,401)
  assert.equal((await h.api(`prepaid/${units.subscription}`,reader)).balances[0].remainingN,unitState.balances[0].remainingN+1000000)
  await onState({row,units,purchaseInvoice,topupInvoice,january,february,expired,unitState})
  await h.advanceClock('2026-04-01T18:00:00Z')
  await api('prepaid.settle',{subscription:row.subscription})
  const paidExpiry=await state(row.subscription)
  assert.equal(moneyBalance(paidExpiry),500000,'Unused original paid credit expires; the later independently funded purchase retains its own effective terms')
  const valuedExpiry=paidExpiry.entries.find(entry=>entry.kind==='expiry'&&entry.purchaseInvoice===purchaseInvoice.id)
  assert.equal(valuedExpiry.amountN,-90000);assert.equal(valuedExpiry.recognitionCents,90000)
  assert.equal(paidExpiry.entries.filter(entry=>entry.purchaseInvoice===purchaseInvoice.id).reduce((sum,entry)=>sum+entry.recognitionCents,0),purchaseInvoice.total_cents,'Purchased consideration is recognized exactly once through actual consumption and approved expiry')
  await usage(row,322,'6000','2026-04-15')
  await h.advanceClock('2026-05-01T18:00:00Z')
  const excess=(await issue(row,'2026-05','2026-05-01'))[0]
  assert.equal(excess.subtotal_cents,100000);assert.equal(excess.tax_cents,60000);assert.equal(excess.total_cents,160000,'Usage beyond the funded balance bills its exact rated excess with original paid-redemption service tax')
  assert.equal(moneyBalance(await state(row.subscription)),0,'Drawdown never creates a negative balance')
  console.log('CAT-004 prepaid foundation: governed money/units, real paid purchases, pure previews, priority, source tax, exact consumption, capped rollover, expiry and consent-bound pending topups passed')
  return {row,units,purchaseInvoice,topupInvoice,january,february,expired,unitState}
}

// New customer-owned ledger families inherit withdrawal and financial custody.
export async function prepaidErasureFlow(h,owner){
  const {row,purchaseInvoice,topupInvoice}=await prepaidFlow(h,owner)
  const api=(path,body,status)=>h.api(path,owner,body,status)
  const before=await api(`revenue?from=2026-01&to=2026-12&customer=${row.customer}`)
  const request=await api('erasure.request',{customer:row.customer})
  const link=h.mails.at(-1).text.match(/https?:\/\/[^\s"<]+\/erase\/[a-f0-9]{64}/)[0]
  assert.equal((await h.raw(new URL(link).pathname,{form:new URLSearchParams({confirm:'yes'})})).status,200)
  const approved=await api('erasure.approve',{request:request.id,confirm:true})
  for(const kind of ['nc_prepaid_requests','nc_prepaid_consents','nc_prepaid_funding_intents'])assert.ok(approved.receipt.changed.some(change=>change.kind===kind),kind)
  await api(`prepaid/${row.subscription}`,undefined,410)
  await api('prepaid.prepare',{subscription:row.subscription},410)
  const after=await api(`revenue?from=2026-01&to=2026-12&customer=${row.customer}`)
  assert.deepEqual(after.months,before.months,'Anonymous retained prepaid purchase and consumption schedules preserve every financial cent and date')
  for(const invoice of [purchaseInvoice,topupInvoice]){
    const source=await api(`revenue/${invoice.id}?from=2026-01&to=2026-12`)
    for(const privateText of ['synthetic-nectar-310@example.test','Synthetic prepaid 310','synthetic-nectar-payment-'])assert.ok(!JSON.stringify(source).includes(privateText))
  }
  const audit=await api('audit')
  assert.ok(!JSON.stringify(audit).includes('synthetic-nectar-310@example.test'))
}

// The same historical usage doors govern financial tax corrections AND the
// append-only restoration/reallocation of previously consumed paid credits.
export async function prepaidCorrectionFlow(h,owner){
  const api=(path,body,status)=>h.api(path,owner,body,status)
  await h.advanceClock('2026-01-01T18:00:00Z')
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'flat_rate',tax_rate:'10',tax_note:'Synthetic prepaid correction tax'})
  await api('tax.review',{revision:(await api('business')).revision})
  await api('access.give',{email:'synthetic-nectar-351@example.test',name:'Synthetic correction finance',role:'finance'})
  const finance=await h.signIn('synthetic-nectar-351@example.test',{requested:true})
  const customer=(await api('customer.create',{external_id:'synthetic-nectar-352',name:'Synthetic prepaid correction',billing_email:'synthetic-nectar-352@example.test'})).id
  const meter=(await api('meter.create',{code:'synthetic-nectar-353',name:'Synthetic correction calls',unit_label:'calls'})).id
  const product=(await api('product.create',{code:'synthetic-nectar-354',name:'Synthetic correction usage'})).id
  const price=(await api('price.create',{product,kind:'unit',meter,unit_amount:'1',taxable:true})).id
  const subscription=(await api('subscription.create',{customer,start_date:'2026-01-01',price:[price]})).id
  const prepareGrant=async(source,amount)=>api('prepaid.prepare',{subscription,mode:'grant',kind:'money',source,amount,effective_date:'2026-01-01',expires_date:'2026-05-01',priority:10,expiry_consent:true})
  const paid=await prepareGrant('purchase','100')
  await h.api('prepaid.decide',finance,{request:paid.request,decision:'approved'})
  const purchase=(await api('prepaid.purchase.prepare',{intent:paid.request,issue_date:'2026-01-01'})).invoice
  await api('invoice.approve',{invoice:purchase,acknowledge:true});await api('invoice.finalise',{invoice:purchase,issue_date:'2026-01-01'})
  const payment=await api('payment.record',{customer,amount:'100',received_on:'2026-01-01',method:'bank_transfer',reference:'synthetic-nectar-355'})
  await api('payment.allocate',{payment:payment.payment,invoice:purchase,amount:'100'})
  await api('prepaid.funding.confirm',{intent:paid.request,confirm:true})
  const submit=(id,quantity,date)=>api('usage.submit',{events:[{event_id:`synthetic-nectar-${id}`,customer:'synthetic-nectar-352',meter:'synthetic-nectar-353',quantity,occurred_at:`${date}T12:00:00Z`}]})
  const issued=[]
  for(const [period,quantity,id,date] of [['2026-01','40',356,'2026-02-01'],['2026-02','30',357,'2026-03-01']]){
    await submit(id,quantity,`${period}-15`)
    await h.advanceClock(`${date}T18:00:00Z`)
    const run=await api('billrun.prepare',{period}),invoice=(await api(`runs/${run.id}`)).invoices.find(invoice=>invoice.customer_id===customer)
    await api('invoice.approve',{invoice:invoice.id,acknowledge:true});await api('invoice.finalise',{invoice:invoice.id,issue_date:date})
    issued.push(await api(`invoices/${invoice.id}`))
  }
  const state=()=>api(`prepaid/${subscription}`),before=await state()
  assert.equal(before.balances[0].remainingN,3000)
  const originalLedger=before.entries.map(entry=>({...entry})),purchaseOriginal=await api(`invoices/${purchase}`)
  await submit(358,'20','2026-01-15')
  const body={subscription,from_period:'2026-01',through_period:'2026-02',void_event_ids:['synthetic-nectar-356'],add_event_ids:['synthetic-nectar-358']}
  const preview=await api('usage.correction.preview',body)
  assert.deepEqual(preview.delta,{subtotalCents:0,taxCents:-200,totalCents:-200})
  assert.deepEqual(await state(),before,'Historical previews reserve neither restored funds nor a liability change')
  const prepare=(body)=>api('usage.correction.prepare',{...body,reason:'Synthetic retained source correction',explanation:'Reviewed source usage and its original purchase ledger change by the exact approved amounts.'})
  const first=await prepare(body)
  assert.equal(first.plan.prepaid.deltas.reduce((sum,entry)=>sum+entry.amountN,0),2000)
  await api('usage.correction.decide',{correction:first.id,decision:'approved'},409)
  await h.api('usage.correction.decide',finance,{correction:first.id,decision:'approved'})
  const restored=await state()
  assert.equal(restored.balances[0].remainingN,5000)
  assert.equal(restored.entries.reduce((sum,entry)=>sum+entry.recognitionCents,0),5000)
  for(const entry of originalLedger)assert.deepEqual(restored.entries.find(saved=>saved.id===entry.id),entry,'Correction appends signed differences without editing original ledger statements')
  await h.api('usage.correction.decide',finance,{correction:first.id,decision:'approved'},409)
  const second=await prepare({subscription,from_period:'2026-02',through_period:'2026-02',void_event_ids:['synthetic-nectar-357'],add_event_ids:[]})
  await h.api('usage.correction.decide',finance,{correction:second.id,decision:'approved'})
  const corrected=await state()
  assert.equal(corrected.balances[0].remainingN,8000,'A later correction retains the first corrected predecessor basis')
  assert.equal(corrected.entries.reduce((sum,entry)=>sum+entry.recognitionCents,0),2000)
  assert.ok(corrected.entries.some(entry=>entry.kind==='correction'&&entry.recognitionCents<0))
  for(const original of [...issued,purchaseOriginal])assert.deepEqual((await api(`invoices/${original.id}`)).calculation,original.calculation)
  const csv=await h.raw(`/app/exports/prepaid/${subscription}.csv`,{cookie:owner});assert.equal(csv.status,200)
  assert.equal(csvRows(await csv.text()).length,corrected.entries.length)
  for(const entry of corrected.entries.filter(entry=>entry.kind==='correction'))assert.equal((await api(`prepaid/${subscription}/entries/${entry.id}`)).entry.recognitionCents,entry.recognitionCents)
  await submit(359,'5','2026-02-15')
  const stale=await prepare({subscription,from_period:'2026-02',through_period:'2026-02',void_event_ids:[],add_event_ids:['synthetic-nectar-359']})
  const promotion=await prepareGrant('promotion','1');await h.api('prepaid.decide',finance,{request:promotion.request,decision:'approved'})
  await h.api('usage.correction.decide',finance,{correction:stale.id,decision:'approved'},409)
  assert.equal((await state()).balances[0].remainingN,8100,'A stale financial approval cannot consume or restore any prepaid balance')
  await api('usage.correction.decide',{correction:stale.id,decision:'rejected'})
  const revenueBefore=await api(`revenue?from=2026-01&to=2026-12&customer=${customer}`)
  const erase=await api('erasure.request',{customer})
  const link=h.mails.at(-1).text.match(/https?:\/\/[^\s"<]+\/erase\/[a-f0-9]{64}/)[0]
  assert.equal((await h.raw(new URL(link).pathname,{form:new URLSearchParams({confirm:'yes'})})).status,200)
  const receipt=await api('erasure.approve',{request:erase.id,confirm:true})
  assert.ok(receipt.receipt.changed.some(row=>row.kind==='nc_prepaid_corrections'))
  assert.deepEqual((await api(`revenue?from=2026-01&to=2026-12&customer=${customer}`)).months,revenueBefore.months)
  await h.advanceClock('2033-03-02T18:00:00Z')
  assert.deepEqual((await api('erasure.purge',{})).removed,[erase.id])
  assert.deepEqual((await api('erasure.purge',{})).removed,[])
  console.log('CAT-004 governed historical prepaid replay: exact tax, signed liability/recognition, immutable originals, repeated correction, source/CSV and stale refusal passed')
  return {subscription,customer,purchase,issued,first,second}
}

// An unpaid purchase credit reduces only its contract liability. Reduced
// consideration never becomes a fully funded grant or an automatic charge.
export async function prepaidPurchaseCreditFlow(h,owner){
  const api=(path,body,status)=>h.api(path,owner,body,status)
  await h.advanceClock('2026-01-01T18:00:00Z')
  await api('access.give',{email:'synthetic-nectar-361@example.test',name:'Synthetic purchase credit finance',role:'finance'})
  const finance=await h.signIn('synthetic-nectar-361@example.test',{requested:true})
  const customer=(await api('customer.create',{external_id:'synthetic-nectar-362',name:'Synthetic credited prepaid purchase',billing_email:'synthetic-nectar-362@example.test'})).id
  const product=(await api('product.create',{code:'synthetic-nectar-363',name:'Synthetic prepaid credit service'})).id
  const price=(await api('price.create',{product,kind:'flat',unit_amount:'1',taxable:false})).id
  const subscription=(await api('subscription.create',{customer,start_date:'2026-01-01',price:[price]})).id
  const grant=await api('prepaid.prepare',{subscription,mode:'grant',kind:'money',source:'purchase',amount:'100',effective_date:'2026-01-01',expires_date:'2026-05-01',priority:0,expiry_consent:true})
  await h.api('prepaid.decide',finance,{request:grant.request,decision:'approved'})
  const invoice=(await api('prepaid.purchase.prepare',{intent:grant.request,issue_date:'2026-01-01'})).invoice
  await api('invoice.approve',{invoice,acknowledge:true});await api('invoice.finalise',{invoice,issue_date:'2026-01-01'})
  const original=await api(`invoices/${invoice}`),source=await api(`revenue/${invoice}`)
  await api('credit.issue',{invoice,amount:'25',reason:'Synthetic unused unpaid purchase correction'})
  assert.equal((await api(`invoices/${invoice}`)).balanceCents,7500)
  await api('prepaid.funding.confirm',{intent:grant.request,confirm:true},409)
  const payment=await api('payment.record',{customer,amount:'75',received_on:'2026-01-01',method:'bank_transfer',reference:'synthetic-nectar-364'})
  await api('payment.allocate',{payment:payment.payment,invoice,amount:'75'})
  assert.equal((await api(`invoices/${invoice}`)).balanceCents,0)
  await api('prepaid.funding.confirm',{intent:grant.request,confirm:true},409)
  const state=await api(`prepaid/${subscription}`)
  assert.equal(state.grants.length,0);assert.equal(state.entries.length,0)
  assert.equal(state.fundingIntents.find(intent=>intent.id===grant.request).status,'pending')
  const report=await api(`revenue?period=2026-01&customer=${customer}`)
  assert.deepEqual([report.netBillingsCents,report.recognizedCents,report.closingCents],[7500,0,7500])
  assert.equal(report.months[0].deferredLiabilityCents,7500)
  assert.deepEqual((await api(`invoices/${invoice}`)).calculation,original.calculation)
  assert.deepEqual((await api(`revenue/${invoice}`)).schedules,source.schedules,'A credit preserves the original purchase schedule and appends only a liability reversal')
  console.log('CAT-004 credited unpaid purchase: reduced liability without revenue, paid-reduced-consideration funding refusal and immutable source passed')
  return {customer,subscription,invoice,intent:grant.request}
}
