// Assert the report, source, CSV and monthly frozen snapshot at real ledger
// transitions. The scheduled transport is the harness's mail network edge.
import assert from 'node:assert/strict'
import { csvRows } from './financial-reports.mjs'

export async function prepaidReportParity(h,owner,row,{snapshotActor,snapshots=[]}={}) {
  const state=await h.api(`prepaid/${row.subscription}`,owner)
  const report=await h.api(`reports/credit-balances?customer=${row.customer}`,owner)
  const lots=state.grants.filter(grant=>grant.remainingN||grant.liabilityCents)
  const entries=report.entries.filter(entry=>entry.prepaid?.subscriptionId===row.subscription)
  assert.equal(entries.length,lots.length)
  for(const grant of lots){
    const entry=entries.find(entry=>entry.prepaid.grantId===grant.id)
    assert.ok(entry)
    assert.deepEqual([entry.prepaid.remainingN,entry.prepaid.availableN,entry.prepaid.liabilityCents],[grant.remainingN,grant.availableN,grant.liabilityCents])
    assert.equal(entry.amountCents,grant.kind==='money'?grant.availableN:grant.liabilityCents)
    const source=await h.api(entry.href.replace('/app/',''),owner)
    assert.equal(source.components.reduce((sum,item)=>sum+item.amountCents,0),entry.amountCents)
    assert.deepEqual(source.prepaid.entries.map(entry=>[entry.id,entry.amountN,entry.liabilityCents,entry.recognitionCents]),state.entries.filter(entry=>entry.grantId===grant.id).map(entry=>[entry.id,entry.amountN,entry.liabilityCents,entry.recognitionCents]))
  }
  const csv=csvRows(await (await h.raw(`/app/exports/reports/credit-balances.csv?customer=${row.customer}`,{cookie:owner})).text()).filter(row=>row.prepaid_kind)
  assert.equal(csv.length,entries.length)
  assert.deepEqual(csv.map(row=>[row.source_reference,Number(row.amount),Number(row.prepaid_paid_liability)]).sort(),entries.map(entry=>[entry.invoiceId,entry.amountCents/100,entry.prepaid.liabilityCents/100]).sort())
  if(snapshotActor){
    const date=state.date
    await h.api('report.schedule',snapshotActor,{enabled:true,day:Number(date.slice(8))})
    const tick=await h.raw(`/cdn-cgi/local/scheduled?time=${Date.parse(`${date}T20:00:00Z`)}&cron=${encodeURIComponent('0 14 * * *')}`)
    assert.equal(tick.status,200,await tick.text())
    const deliveries=(await h.api('report-schedule',snapshotActor)).deliveries
    const delivery=await h.api(`report-deliveries/${deliveries[0].id}`,snapshotActor)
    assert.equal(delivery.status,'accepted')
    const sources=delivery.sourceEvidence.filter(source=>source.metric==='credit-balances'&&source.detail.prepaid?.subscriptionId===row.subscription)
    assert.equal(sources.length,entries.length)
    for(const source of sources){
      const entry=entries.find(entry=>entry.invoiceId===source.sourceId)
      assert.ok(entry)
      assert.deepEqual(source.detail.prepaid,entry.prepaid)
      assert.equal(source.detail.totalCents,entry.amountCents)
    }
    snapshots.push({actor:snapshotActor,delivery})
  }
  for(const saved of snapshots)assert.deepEqual(await h.api(`report-deliveries/${saved.delivery.id}`,saved.actor),saved.delivery,'Later grants, consumption, top-ups and expiry never rewrite an earlier delivered report')
  return snapshots
}
