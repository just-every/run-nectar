import assert from 'node:assert/strict'
import { file } from './harness.mjs'
import { csvRows } from './financial-reports.mjs'
import { stripeHistoryCapture } from '../fixtures/stripe-history.mjs'

export async function moveHistoryFlow(h,owner,{onState=async()=>{},keepHistory=false}={}) {
  const api=(path,body,status)=>h.api(path,owner,body,status)
  await api('business.configure',{...(await api('business')),timezone:'UTC'})
  await h.advanceClock('2026-07-01T16:00:00Z')
  const capture=stripeHistoryCapture(),files=Object.fromEntries(Object.entries(capture).map(([name,value])=>[name,file(`${name}.json`,JSON.stringify(value),'application/json')]))
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
  for(const kind of ['payment','refund','dispute','subscription-event'])assert.ok(first.incumbentHistory.records.some(row=>row.kind===kind),kind)
  assert.deepEqual(first.incumbentHistory.records.find(row=>row.provider_ref==='synthetic-nectar-event-1').original,capture.subscription_events.data[1])
  assert.deepEqual(first.incumbentHistory.documents.find(row=>row.provider_ref==='synthetic-nectar-invoice-annual').original,capture.invoices.data.at(-1))
  assert.equal((await api('import.apply',{...files,fingerprint:preview.fingerprint})).job,job.job)
  assert.deepEqual(await read(),first,'repeat apply changes no history')
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
      }
    }
  }
  const revenue=await api(`revenue?from=2026-07&to=2027-02&customer=${customer}`)
  assert.equal(revenue.openingCents,800000,'four recognized annual months leave eight deferred months')
  assert.equal(revenue.recognizedCents,800000)
  assert.equal(revenue.closingCents,0)
  assert.deepEqual(revenue.months.map(row=>row.recognizedCents),Array(8).fill(100000))
  const annual=first.incumbentHistory.documents.find(row=>row.provider_ref==='synthetic-nectar-invoice-annual')
  const source=await api(`revenue/${annual.id}?from=2026-07&to=2027-02&customer=${customer}`)
  assert.equal(source.source.providerRef,annual.provider_ref)
  assert.deepEqual(source.schedules[0].entries.map(row=>row.amountCents),Array(12).fill(100000))
  await api('invoice.approve',{invoice:annual.id,acknowledge:true},404)
  assert.equal((await api('invoice.finalise',{invoice:annual.id,issue_date:'2026-07-01'},409)).error,'nothing_approved')
  assert.deepEqual(await read(),first,'imported document refusals change no history')
  for(const doc of first.incumbentHistory.documents.slice(0,2))await api('payment.allocate',{payment:first.incumbentHistory.records.find(row=>row.kind==='payment').id,invoice:doc.id,amount:'1'},404)
  const march=await report('billings','2026-03')
  const csv=await h.raw(`/app/exports/reports/billings.csv?period=2026-03&customer=${customer}`,{cookie:owner})
  const rows=csvRows(await csv.text())
  assert.equal(rows.filter(row=>row.source!=='TOTAL').length,2)
  assert.ok(rows.filter(row=>row.source!=='TOTAL').every(row=>row.source_provider==='stripe'))
  const revenueCsv=await h.raw(`/app/exports/revenue.csv?from=2026-07&to=2027-02&customer=${customer}`,{cookie:owner})
  assert.equal(revenueCsv.status,200)
  const revenueRows=csvRows(await revenueCsv.text()).filter(row=>row.row_kind==='recognition')
  assert.equal(revenueRows.length,8)
  assert.ok(revenueRows.every(row=>row.source_provider==='stripe'&&row.source_reference===annual.provider_ref&&row.signed_contribution==='1000.00'))
  await api('report.schedule',{enabled:true,day:1})
  assert.equal((await h.raw('/cdn-cgi/local/scheduled?time='+Date.parse('2026-04-02T16:00:00Z')+'&cron='+encodeURIComponent('0 14 * * *'))).status,200)
  const delivery=(await api('report-schedule')).deliveries.find(row=>row.period==='2026-03')
  assert.equal(delivery.status,'accepted')
  const saved=await api(`report-deliveries/${delivery.id}`)
  assert.equal(saved.reports.find(r=>r.metric==='billings').totalCents,march.totalCents)
  assert.ok(saved.sourceEvidence.some(e=>e.detail.historical?.reference===annual.provider_ref))
  assert.deepEqual(await read(),first,'reporting and snapshots never change history')
  await api('access.give',{email:'history-reader@example.test',name:'History Reader',role:'accountant'})
  const reader=await h.signIn('history-reader@example.test',{requested:true})
  const readerView=await h.api(`customers/${customer}`,reader)
  assert.ok(!JSON.stringify(readerView).includes('synthetic-nectar-private-7'),'customer readers receive historical figures without private raw capture fields')
  const readerSource=await h.api(`reports/billings/${annual.id}?period=2026-03&customer=${customer}`,reader)
  assert.equal(readerSource.totalCents,1200000)
  assert.ok(!JSON.stringify(readerSource).includes('synthetic-nectar-private-7'),'report readers receive exact financial operands without private raw capture fields')
  assert.ok(JSON.stringify((await read()).incumbentHistory).includes('synthetic-nectar-private-7'),'only the owner can inspect full original capture evidence')

  await onState({h,owner,label:'history',customer,annual:annual.id,delivery:delivery.id,period:'2026-03'})
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
  const beforeRevenue=await api(`revenue?from=2026-07&to=2027-02&customer=${customer}`)
  const beforeBillings=await api(`reports/billings?period=2026-03&customer=${customer}`)
  const beforeCollections=await api(`reports/collections?period=2026-03&customer=${customer}`)
  const request=await api('erasure.request',{customer})
  const path=new URL(h.mails.at(-1).text.match(/https?:\/\/[^\s"<]+\/erase\/[a-f0-9]{64}/)[0]).pathname
  assert.equal((await h.raw(path,{form:new URLSearchParams({confirm:'yes'})})).status,200)
  const result=await api('erasure.approve',{request:request.id,confirm:true})
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
