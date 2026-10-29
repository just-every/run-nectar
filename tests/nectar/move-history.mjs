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
