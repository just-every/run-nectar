import assert from 'node:assert/strict'
import { file } from './harness.mjs'
import { csvRows } from './financial-reports.mjs'
import { stripeHistoryCapture } from '../fixtures/stripe-history.mjs'

export async function moveHistoryFlow(h,owner,{onState=async()=>{},keepHistory=false}={}) {
  const api=(path,body,status)=>h.api(path,owner,body,status)
  await api('business.configure',{...(await api('business')),timezone:'UTC'})
  await h.advanceClock('2026-07-01T16:00:00Z')
  const capture=stripeHistoryCapture(),privateMarker='synthetic-nectar-private-7'
  // Retain the exact untrusted bytes, while typed projections must reject
  // provider prose and extra fields even when the current reader is the owner.
  for(const invoice of capture.invoices.data)for(const line of invoice.lines.data){
    line.description=privateMarker;line.metadata={private:privateMarker}
    line.price.metadata={...line.price.metadata,private:privateMarker}
  }
  for(const kind of ['payments','refunds','disputes'])for(const record of capture[kind].data){record.metadata={private:privateMarker};record.description=privateMarker}
  for(const event of capture.subscription_events.data){
    event.metadata={private:privateMarker};event.data.object.metadata={private:privateMarker}
    event.data.object.private_note=privateMarker
    if(event.data.object.pause_collection)event.data.object.pause_collection.metadata={private:privateMarker}
    for(const item of event.data.object.items.data)item.metadata={private:privateMarker}
  }
  const files=Object.fromEntries(Object.entries(capture).map(([name,value])=>[name,file(`${name}.json`,JSON.stringify(value),'application/json')]))
  const noPrivate=value=>assert.ok(!JSON.stringify(value).includes(privateMarker),'typed history excludes provider prose and metadata for every role')
  const preview=await api('import.preview',files)
  assert.deepEqual(preview.rejected,[])
  assert.equal(preview.create.history,24)
  assert.equal((await api('customers')).length,0,'history preview writes no customer')
  const truncated={...files,payments:file('payments.json',JSON.stringify({...capture.payments,has_more:true}),'application/json')}
  await api('import.preview',truncated,400)
  const missing={...files};delete missing.refunds
  await api('import.preview',missing,400)
  await onState({h,owner,label:'preview',files,capture})
  const job=await api('import.apply',{...files,fingerprint:preview.fingerprint})
  const customer=(await api('customers')).find(c=>c.external_id==='synthetic-nectar-1').id
  const read=()=>api(`customers/${customer}`)
  const first=await read()
  assert.equal(first.incumbentHistory.documents.length,20)
  assert.equal(first.incumbentHistory.records.length,24)
  assert.deepEqual(first.incumbentHistory.totals,{invoicedCents:1398000,creditedCents:2200,paymentsCents:1398000,refundsCents:2200,remainingCents:0})
  for(const kind of ['payment','refund','dispute','subscription-event'])assert.ok(first.incumbentHistory.records.some(row=>row.kind===kind),kind)
  const timeline=first.incumbentHistory.records.find(row=>row.provider_ref==='synthetic-nectar-event-1').timeline
  assert.equal(timeline.id,capture.subscription_events.data[1].id)
  assert.equal(timeline.type,'customer.subscription.updated')
  assert.equal(timeline.data.object.trial_end,capture.subscription_events.data[1].data.object.trial_end)
  assert.deepEqual(timeline.data.object.pause_collection,{behavior:'void'})
  assert.deepEqual(timeline.data.object.items.data,[{id:'synthetic-nectar-item-1',quantity:2,price:'synthetic-nectar-4'}])
  assert.ok(first.incumbentHistory.documents.every(document=>document.original===undefined))
  assert.ok(first.incumbentHistory.documents.flatMap(document=>document.lines).every(line=>line.description===undefined&&line.price_source===undefined))
  noPrivate(first)
  assert.equal((await api('import.apply',{...files,fingerprint:preview.fingerprint})).job,job.job)
  assert.deepEqual(await read(),first,'repeat apply changes no history')
  assert.equal((await api('imports')).filter(row=>row.id===job.job).length,1,'a repeated apply appears as one move in the operator journal')
  const report=(metric,period)=>api(`reports/${metric}?period=${period}&customer=${customer}`)
  for(let index=0;index<18;index++) {
    const period=new Date(Date.UTC(2025,index,1)).toISOString().slice(0,7)
    const annual=index>=14?100000:0
    const expectedBilling=11000+(index===14?1200000:0)
    for(const [metric,amount] of [['billings',expectedBilling],['collections',expectedBilling],['mrr',10000+annual],['tax',index===0?800:1000],['credits',index===0?2200:0]]) {
      const r=await report(metric,period);assert.equal(r.totalCents,amount,`${metric} ${period}`)
      for(const entry of r.entries) {
        assert.equal(entry.sourceProvider,'stripe')
        const source=await api(`reports/${metric}/${entry.invoiceId}?period=${period}&customer=${customer}`)
        assert.equal(source.totalCents,entry.amountCents)
        assert.equal(source.components.reduce((sum,row)=>sum+row.amountCents,0),entry.amountCents)
        assert.equal(source.historical.reference,entry.sourceReference)
        noPrivate(source)
        assert.equal(source.historical.original.provider_ref,entry.sourceReference)
      }
    }
  }
  const series=(await report('mrr','2026-06')).series
  assert.equal(series.length,18)
  assert.deepEqual(series.map(row=>[row.period,row.amountCents,row.sourceCount]),Array.from({length:18},(_,index)=>[new Date(Date.UTC(2025,index,1)).toISOString().slice(0,7),10000+(index>=14?100000:0),index>=14?2:1]))
  const revenue=await api(`revenue?from=2026-07&to=2027-02&customer=${customer}`)
  assert.equal(revenue.openingCents,800000,'four recognized annual months leave eight deferred months')
  assert.equal(revenue.recognizedCents,800000)
  assert.equal(revenue.closingCents,0)
  assert.deepEqual(revenue.months.map(row=>row.recognizedCents),Array(8).fill(100000))
  const annual=first.incumbentHistory.documents.find(row=>row.provider_ref==='synthetic-nectar-invoice-annual')
  const source=await api(`revenue/${annual.id}?from=2026-07&to=2027-02&customer=${customer}`)
  assert.equal(source.source.providerRef,annual.provider_ref)
  assert.deepEqual(source.schedules[0].entries.map(row=>row.amountCents),Array(12).fill(100000))
  noPrivate(source)
  assert.equal(source.schedules[0].basis.capturedLine.price_source,undefined)
  assert.equal(source.schedules[0].basis.capturedLine.description,undefined)
  assert.equal(source.schedules[0].basis.capturedLine.amount_cents,1200000)
  await api('invoice.approve',{invoice:annual.id,acknowledge:true},404)
  assert.equal((await api('invoice.finalise',{invoice:annual.id,issue_date:'2026-07-01'},409)).error,'nothing_approved')
  assert.deepEqual(await read(),first,'imported document refusals change no history')
  for(const doc of first.incumbentHistory.documents.slice(0,2))await api('payment.allocate',{payment:first.incumbentHistory.records.find(row=>row.kind==='payment').id,invoice:doc.id,amount:'1'},404)
  const march=await report('billings','2026-03')
  const csv=await h.raw(`/app/exports/reports/billings.csv?period=2026-03&customer=${customer}`,{cookie:owner})
  const csvText=await csv.text();noPrivate(csvText)
  const rows=csvRows(csvText)
  assert.equal(rows.filter(row=>row.source!=='TOTAL').length,2)
  assert.ok(rows.filter(row=>row.source!=='TOTAL').every(row=>row.source_provider==='stripe'))
  const revenueCsv=await h.raw(`/app/exports/revenue.csv?from=2026-07&to=2027-02&customer=${customer}`,{cookie:owner})
  assert.equal(revenueCsv.status,200)
  const revenueText=await revenueCsv.text();noPrivate(revenueText)
  const revenueRows=csvRows(revenueText).filter(row=>row.row_kind==='recognition')
  assert.equal(revenueRows.length,8)
  assert.ok(revenueRows.every(row=>row.source_provider==='stripe'&&row.source_reference===annual.provider_ref&&row.signed_contribution==='1000.00'))
  await api('report.schedule',{enabled:true,day:1})
  assert.equal((await h.raw('/cdn-cgi/local/scheduled?time='+Date.parse('2026-04-02T16:00:00Z')+'&cron='+encodeURIComponent('0 14 * * *'))).status,200)
  const delivery=(await api('report-schedule')).deliveries.find(row=>row.period==='2026-03')
  assert.equal(delivery.status,'accepted')
  const saved=await api(`report-deliveries/${delivery.id}`)
  assert.equal(saved.reports.find(r=>r.metric==='billings').totalCents,march.totalCents)
  assert.ok(saved.sourceEvidence.some(e=>e.detail.historical?.reference===annual.provider_ref))
  noPrivate(saved)
  assert.deepEqual(await read(),first,'reporting and snapshots never change history')
  await api('access.give',{email:'history-reader@example.test',name:'History Reader',role:'accountant'})
  const reader=await h.signIn('history-reader@example.test',{requested:true})
  const readerView=await h.api(`customers/${customer}`,reader)
  assert.ok(!JSON.stringify(readerView).includes('synthetic-nectar-private-7'),'customer readers receive historical figures without private raw capture fields')
  const readerSource=await h.api(`reports/billings/${annual.id}?period=2026-03&customer=${customer}`,reader)
  assert.equal(readerSource.totalCents,1200000)
  assert.ok(!JSON.stringify(readerSource).includes('synthetic-nectar-private-7'),'report readers receive exact financial operands without private raw capture fields')
  noPrivate((await read()).incumbentHistory)
  noPrivate(await api('audit'))
  for(const role of [owner,reader]){
    const response=await h.raw('/app/exports/customers.csv',{cookie:role});assert.equal(response.status,200);noPrivate(await response.text())
    const revenueSource=await h.api(`revenue/${annual.id}?from=2026-07&to=2027-02&customer=${customer}`,role);noPrivate(revenueSource)
    const page=await h.page(`/app/customers/${customer}`,role);noPrivate(page)
  }

  await onState({h,owner,label:'history',customer,annual:annual.id,payment:first.incumbentHistory.records.find(row=>row.provider_ref==='synthetic-nectar-payment-annual').id,delivery:delivery.id,period:'2026-03'})
  if(keepHistory)return {customer,annual:annual.id,delivery:delivery.id,saved,first}
  await api('import.job',{job:job.job,action:'undo'})
  assert.equal((await api('customers')).length,0,'untouched historical-only move can be undone')
  assert.equal((await api('reports/billings?period=2026-03')).totalCents,0)
  assert.deepEqual(await api(`report-deliveries/${delivery.id}`),saved,'a saved report keeps its original history after undo')
  console.log('MOVE-007 historical customer, 18-month reports, deferred revenue, source/CSV/snapshots, idempotency, undo and native execution refusals passed')
}

// New imported record families inherit GOV-005 before shipping.
export async function moveHistoryErasureFlow(h,owner) {
  const {customer,annual,delivery}=await moveHistoryFlow(h,owner,{keepHistory:true})
  const api=(path,body)=>h.api(path,owner,body)
  const meter='synthetic-nectar-history-erasure-usage'
  await api('meter.create',{code:meter,name:'Historical private usage',unit_label:'events'})
  for(let start=0;start<10000;start+=5000){
    const batch=await api('usage.submit',{events:Array.from({length:5000},(_,offset)=>({event_id:`synthetic-nectar-history-private-${start+offset}`,customer:'synthetic-nectar-1',meter,quantity:'1',occurred_at:'2026-06-15T00:00:00Z',properties:{person:'Alder Research',email:'billing@alder.example'}}))})
    assert.deepEqual([batch.accepted,batch.duplicates,batch.rejected],[5000,0,0])
  }
  const beforeRevenue=await api(`revenue?from=2026-07&to=2027-02&customer=${customer}`)
  const beforeBillings=await api(`reports/billings?period=2026-03&customer=${customer}`)
  const beforeCollections=await api(`reports/collections?period=2026-03&customer=${customer}`)
  const request=await api('erasure.request',{customer})
  const path=new URL(h.mails.at(-1).text.match(/https?:\/\/[^\s"<]+\/erase\/[a-f0-9]{64}/)[0]).pathname
  assert.equal((await h.raw(path,{form:new URLSearchParams({confirm:'yes'})})).status,200)
  const result=await api('erasure.approve',{request:request.id,confirm:true})
  assert.equal(result.receipt.changed.find(row=>row.kind==='nc_usage_events').records,10000)
  const usageCsv=await h.raw('/app/exports/usage.csv',{cookie:owner})
  const usage=csvRows(await usageCsv.text())
  assert.equal(usage.length,10000)
  assert.ok(usage.every(row=>row.event_id.startsWith('erased-')&&row.properties_json==='{}'))
  for(const kind of ['nc_incumbent_history','nc_incumbent_invoices'])assert.ok(result.receipt.changed.some(row=>row.kind===kind&&row.records>0),kind)
  const erased=await api(`customers/${customer}`)
  assert.deepEqual(erased.incumbentHistory,{documents:[],records:[]})
  const afterRevenue=await api(`revenue?from=2026-07&to=2027-02&customer=${customer}`)
  assert.deepEqual(afterRevenue.months,beforeRevenue.months,'retained anonymous revenue schedules preserve every date and cent')
  assert.equal((await api(`reports/billings?period=2026-03&customer=${customer}`)).totalCents,beforeBillings.totalCents)
  assert.equal((await api(`reports/collections?period=2026-03&customer=${customer}`)).totalCents,beforeCollections.totalCents)
  const source=await api(`revenue/${annual}?from=2026-07&to=2027-02&customer=${customer}`)
  const snapshot=await api(`report-deliveries/${delivery}`)
  const projections=[erased,afterRevenue,source,snapshot,await api('audit')]
  for(const value of ['billing@alder.example','synthetic-nectar-1','Alder Research','synthetic-nectar-private-7'])for(const projection of projections)assert.ok(!JSON.stringify(projection).includes(value),'imported source identity is withdrawn from projections')
  assert.equal((await api('erasure.purge',{})).removed.length,0)
  await h.advanceClock(`${result.receipt.retained.until}T16:00:00Z`)
  const sweep=await api('erasure.purge',{})
  assert.ok(sweep.removed.includes(request.id),JSON.stringify({sweep,until:result.receipt.retained.until,requests:(await api('erasures')).map(row=>({id:row.id,status:row.status,customer:row.customer_id,retainUntil:row.retain_until,purgedAt:row.purged_at}))}))
  await h.api(`revenue/${annual}`,owner,undefined,404)
  console.log('MOVE-007 inherited erasure withdraws all history families and preserves exact financial revenue until due removal')
}

// Public-door move-collection checks share this retained journey module.
const moveCollectionJourneys = await (async () => {
const { default: assert } = await import('node:assert/strict')
const { file } = await import('./harness.mjs')
const { collectionCapture,stripeCollectionEdge } = await import('../fixtures/stripe-collection-edge.mjs')
const edge=stripeCollectionEdge()
const harnessOptions=()=>({stripeFetch:edge.fetch,stripeSecret:'synthetic-nectar-1'})
async function moveCollectionFlow(h,owner,{onState=async()=>{},prepare,execute,finalize}={}) {
  const api=(path,body,status)=>h.api(path,owner,body,status)
  await h.advanceClock('2026-07-01T16:00:00Z')
  const capture=collectionCapture(),files=Object.fromEntries(Object.entries(capture).map(([name,value])=>[name,file(`${name}.json`,JSON.stringify(value),'application/json')]))
  const preview=await api('import.preview',files)
  assert.deepEqual(preview.rejected,[])
  const imported=await api('import.apply',{...files,fingerprint:preview.fingerprint})
  const customer=(await api('customers')).find(row=>row.external_id==='synthetic-nectar-1').id
  const read=()=>api(`customers/${customer}`),before=await read(),documents=before.incumbentHistory.documents
  const invoice=n=>documents.find(row=>row.provider_ref===`synthetic-nectar-open-${n}`).id
  for(const row of documents.filter(row=>['paid','void'].includes(row.status)))await api('imported.collection.prepare',{invoice:row.id},409)
  await api('access.give',{email:'collector-reader@example.test',name:'Collection Reader',role:'accountant'})
  const reader=await h.signIn('collector-reader@example.test')
  for(const action of ['prepare','execute','reconcile','finalize'])await h.api(`imported.collection.${action}`,reader,{},403)
  await onState({label:'open',h,owner,customer,invoice:invoice(1)})
  const prepared=prepare?await prepare(customer,invoice(1)):await api('imported.collection.prepare',{invoice:invoice(1)})
  assert.equal(prepared.status,'pending');assert.equal(prepared.amount_cents,11000)
  await api('imported.collection.execute',{...prepared.instructions.execute,confirm:false},400)
  await api('imported.collection.execute',{...prepared.instructions.execute,basis_hash:'synthetic-nectar-wrong'},409)
  await onState({label:'review',h,owner,customer,request:prepared})
  const pending=execute?await execute(customer,prepared):await api('imported.collection.execute',prepared.instructions.execute)
  assert.equal(pending.status,'uncertain');assert.ok(pending.charge_ref);assert.ok(pending.payment_intent_ref)
  assert.equal(edge.calls.filter(call=>call.path.endsWith('/pay')&&call.method==='POST').length,0,'Payment never automatically mirrors the old invoice')
  assert.equal(edge.invoices.get('synthetic-nectar-open-1').status,'open')
  await onState({label:'mirror-pending',h,owner,customer,request:pending})
  const result=finalize?await finalize(customer,pending):await api('imported.collection.finalize',{request:pending.id,confirm:true})
  assert.equal(result.status,'collected')
  await api('imported.collection.execute',prepared.instructions.execute,409)
  assert.equal((await api('imported.collection.reconcile',{request:result.id})).charge_ref,result.charge_ref)
  assert.equal(edge.calls.filter(call=>call.path==='/payment_intents'&&call.method==='POST').length,1)
  assert.equal(edge.invoices.get('synthetic-nectar-open-1').status,'paid')
  assert.equal(edge.invoices.get('synthetic-nectar-open-1').auto_advance,false)
  const current=await read()
  assert.deepEqual(current.incumbentHistory.documents,documents,'collection never rewrites originals')
  assert.equal(current.incumbentHistory.totals.paymentsCents-before.incumbentHistory.totals.paymentsCents,11000)
  assert.equal(current.incumbentHistory.totals.remainingCents,before.incumbentHistory.totals.remainingCents-11000)
  const report=await api(`reports/collections?period=2026-07&customer=${customer}`)
  assert.equal(report.totalCents,11000)
  const source=await api(`reports/collections/${result.id}?period=2026-07&customer=${customer}`)
  assert.equal(source.totalCents,11000);assert.equal(source.historical.provider,'stripe')
  await onState({label:'collected',h,owner,customer,request:result})
  const changed=await api('imported.collection.prepare',{invoice:invoice(2)})
  edge.invoices.get('synthetic-nectar-open-2').status='paid'
  await api('imported.collection.execute',changed.instructions.execute,409)
  assert.equal(edge.calls.filter(call=>call.path==='/payment_intents'&&call.method==='POST').length,1,'source-paid refusal never charges')
  const uncertain=await api('imported.collection.prepare',{invoice:invoice(3)})
  edge.losePayment()
  const lost=await api('imported.collection.execute',uncertain.instructions.execute)
  assert.equal(lost.status,'uncertain')
  const posts=edge.calls.filter(call=>call.method==='POST').length
  const checked=await api('imported.collection.reconcile',{request:lost.id})
  assert.ok(checked.charge_ref,'read-only check recovers actual payment evidence')
  assert.equal(edge.calls.filter(call=>call.method==='POST').length,posts,'reconciliation never pays or mirrors')
  await api('imported.collection.execute',uncertain.instructions.execute,409)
  await onState({label:'uncertain',h,owner,customer,request:checked})
  const finalized=await api('imported.collection.finalize',{request:checked.id,confirm:true})
  assert.equal(finalized.status,'collected')
  await api('imported.collection.finalize',{request:checked.id,confirm:true})
  assert.equal(edge.calls.filter(call=>call.path==='/payment_intents'&&call.method==='POST').length,2,'uncertain attempt is never repeated')
  assert.equal((await api(`reports/collections?period=2026-07&customer=${customer}`)).totalCents,22000)
  await api('import.job',{job:imported.job,action:'undo'},409)
  const erasure=await api('erasure.request',{customer})
  await api('erasure.verify',{request:erasure.id,reason:'Independently verified the imported account owner',evidence:file('owner.txt','Verified request evidence','text/plain')})
  const erased=await api('erasure.approve',{request:erasure.id,confirm:true})
  assert.ok(erased.receipt.changed.some(row=>row.kind==='nc_imported_collections'))
  assert.equal((await api(`reports/collections?period=2026-07&customer=${customer}`)).totalCents,22000,'erasure retains actual collected amounts and dates')
  await api('imported.collection.finalize',{request:checked.id,confirm:true},409)
  await api('imported.collection.prepare',{invoice:invoice(4)},409)
  console.log('MOVE collection: exact original, native charge, out-of-band mirror, source refusal, uncertainty, read-only reconciliation and no second charge')
}

return { harnessOptions, moveCollectionFlow }
})()
export const { harnessOptions: moveCollectionHarnessOptions, moveCollectionFlow } = moveCollectionJourneys
