// Assert the report, source, CSV and monthly frozen snapshot at real ledger
// transitions. The scheduled transport is the harness's mail network edge.
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
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
    const currentEntries=(await h.api(`reports/credit-balances?customer=${row.customer}`,owner)).entries.filter(entry=>entry.prepaid?.subscriptionId===row.subscription)
    const sources=delivery.sourceEvidence.filter(source=>source.metric==='credit-balances'&&source.detail.prepaid?.subscriptionId===row.subscription)
    assert.equal(sources.length,currentEntries.length)
    for(const source of sources){
      const entry=currentEntries.find(entry=>entry.invoiceId===source.sourceId)
      assert.ok(entry)
      assert.deepEqual(source.detail.prepaid,entry.prepaid)
      assert.equal(source.detail.totalCents,entry.amountCents)
    }
    snapshots.push({actor:snapshotActor,delivery})
  }
  for(const saved of snapshots)assert.deepEqual(await h.api(`report-deliveries/${saved.delivery.id}`,saved.actor),saved.delivery,'Later grants, consumption, top-ups and expiry never rewrite an earlier delivered report')
  return snapshots
}

// Inside push Verify (prepaid-refresh.mjs): measure completed public reads after a committed ledger
// transition. The timestamp is monotonic wall time, independent of the test's
// business clock; there is no polling, cached expectation or database access.
export async function prepaidRefreshParity(h,owner,row) {
  const started=performance.now(),state=await h.api(`prepaid/${row.subscription}`,owner)
  const view=await h.api(`subscriptions/${row.subscription}/upcoming?period=${state.date.slice(0,7)}`,owner)
  const fields=balances=>balances.map(({kind,meterId,remainingN,availableN,liabilityCents})=>({kind,meterId,remainingN,availableN,liabilityCents})).sort((a,b)=>`${a.kind}:${a.meterId}`.localeCompare(`${b.kind}:${b.meterId}`))
  for(const upcoming of view.invoices??[view])assert.deepEqual(fields(upcoming.prepaid.balances),fields(state.balances))
  const page=await h.page(`/app/subscriptions/${row.subscription}?preview_period=${state.date.slice(0,7)}`,owner)
  const sections=[...page.matchAll(/<h3>Prepaid balances<\/h3>([\s\S]*?)<\/table>/g)].map(match=>match[1])
  assert.ok(sections.length,'The operator refresh includes its actual prepaid table')
  const money=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n/100)
  const units=n=>`${new Intl.NumberFormat('en-US',{maximumFractionDigits:6}).format(n/1000000)} units`
  for(const section of sections)for(const balance of view.prepaid.balances){
    const text=section.replace(/<[^>]*>/g,' ')
    for(const key of ['remainingN','availableN','purchasedRemainingN','promotionalRemainingN'])assert.ok(text.includes(balance.kind==='money'?money(balance[key]):units(balance[key])),`Operator refresh shows ${key} from the current ledger`)
    assert.ok(text.includes(money(balance.liabilityCents)))
  }
  assert.deepEqual(await h.api(`prepaid/${row.subscription}`,owner),state,'Refreshing the operator/API doors never consumes or settles prepaid credits')
  await h.api('portal.configure',owner,{hosts:[h.origin],parents:[]})
  const session=await h.api('portal.session.issue',owner,{customer:row.customer,origin:h.origin,audience:'hosted'})
  const response=await h.raw(`/portal/prepaid/data?session=${session.token}`)
  assert.equal(response.status,200)
  const portal=await response.json(),own=portal.lots.filter(lot=>lot.subscription===row.subscription)
  for(const grant of state.grants){
    const lot=own.find(lot=>lot.id===`prepaid-${grant.id}`)
    assert.ok(lot,'Every granted, consumed or expired credit retains its customer ledger')
    assert.deepEqual([lot.remainingN,lot.availableN,lot.liabilityCents],[grant.remainingN,grant.availableN,grant.liabilityCents],'Portal grant, drawdown, expiry and top-up quantities equal the ledger')
  }
  assert.deepEqual(await h.api(`prepaid/${row.subscription}`,owner),state,'Portal balance refresh never draws credit')
  const elapsedMs=performance.now()-started
  console.log(`PORT-002 prepaid refresh ms=${Math.round(elapsedMs)}`)
  assert.ok(elapsedMs<=60000,`Public operator/API refresh took ${elapsedMs} ms`)
  return {revision:state.revision,entryKinds:[...new Set(state.entries.map(entry=>entry.kind))],elapsedMs}
}
