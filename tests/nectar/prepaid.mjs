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
  await usage(row,321,'4100','2026-02-15')
  await h.advanceClock('2026-03-01T18:00:00Z')
  const february=(await issue(row,'2026-03','2026-03-01'))[0]
  assert.equal(february.total_cents,41000)
  const low=await state(row.subscription)
  assert.equal(moneyBalance(low),90000)
  const topup=low.fundingIntents.filter(intent=>intent.status==='pending')
  assert.equal(topup.length,1);assert.equal(topup[0].amount_cents,500000)
  assert.equal(topup[0].payment_id,null,'A low-balance funding intent has no invented payment or provider receipt')
  await api('prepaid.settle',{subscription:row.subscription})
  assert.equal((await state(row.subscription)).fundingIntents.filter(intent=>intent.status==='pending').length,1,'Repeated low-balance evaluation owns one pending funding intent')
  const topupInvoice=await purchase(topup[0].id,row,'2026-03-01')
  assert.equal(moneyBalance(await state(row.subscription)),590000)
  await api('prepaid.consent.revoke',{consent:consent.request})
  const expiring=await prepare(row,{amount:'200',effective_date:'2026-03-01',expires_date:'2026-03-15'})
  await approve(expiring.request)
  await h.advanceClock('2026-03-15T18:00:00Z')
  await api('prepaid.settle',{subscription:row.subscription})
  const expired=await state(row.subscription)
  assert.equal(moneyBalance(expired),590000)
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
  await usage(units,340,'1.5','2026-01-15')
  const unitJanuary=(await issue(units,'2026-01','2026-02-01'))[0]
  assert.equal(unitJanuary.subtotal_cents,0);assert.equal(unitJanuary.tax_cents,10,'Only the two promotional dollars reduce tax; the purchased unit retains its original service tax')
  assert.equal((await state(units.subscription)).entries.filter(entry=>entry.kind==='drawdown').reduce((sum,entry)=>sum+entry.recognitionCents,0),17)
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
  console.log('CAT-004 prepaid foundation: governed money/units, real paid purchases, pure previews, priority, source tax, exact consumption, capped rollover, expiry and consent-bound pending topups passed')
}
