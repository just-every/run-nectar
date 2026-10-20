import assert from 'node:assert/strict'
import { erasureFlow } from './erasure.mjs'

// REV-001 inherits the complete GOV-005 journey with real issued schedules.
export async function revenueErasureFlow(h,owner){
 const withdrawn=[]
 await erasureFlow(h,owner,async state=>{
  if(!['receipt','alternative-receipt','financial-removal'].includes(state.label))return
  if(state.label==='financial-removal'){
   for(const invoice of withdrawn)await h.api(`revenue/${invoice}`,owner,undefined,404)
   return
  }
  const receipt=JSON.parse((await h.api('erasures',owner)).find(r=>r.id===state.request).receipt_json)
  for(const kind of ['nc_revenue_schedules','nc_revenue_entries',...(state.label==='alternative-receipt'?['nc_revenue_credits']:[])])
   assert.ok(receipt.changed.some(r=>r.kind===kind&&r.fields.includes('basis_json')),`REV-001 GOV-005 enumerates withdrawn ${kind} source custody`)
  const ledger=(await h.api(`customers/${state.customer}`,owner)).ledger
  for(const invoice of ledger.invoices){
   const source=await h.api(`revenue/${invoice.id}`,owner)
   withdrawn.push(invoice.id)
   assert.equal(source.invoice.customerName,'Erased customer')
   assert.equal(source.schedules.reduce((n,r)=>n+r.amountCents,0),source.invoice.subtotalCents,'REV-001 GOV-005 retains exact scheduled consideration')
   for(const schedule of source.schedules){
    assert.deepEqual(schedule.basis,{})
    assert.equal(schedule.entries.reduce((n,r)=>n+r.amountCents,0),schedule.amountCents)
    for(const entry of schedule.entries)assert.deepEqual(entry.basis,{})
   }
   for(const credit of source.credits){assert.deepEqual(credit.basis,{});assert.equal(credit.amountCents,-ledger.credits.find(r=>r.id===credit.id).amount_cents)}
   const csv=await h.raw(`/app/exports/revenue.csv?from=2026-01&to=2033-12&customer=${state.customer}`,{cookie:owner})
   assert.equal(csv.status,200)
   assert.ok(!(await csv.text()).includes('@gov005.example'),'REV-001 GOV-005 CSV never resurrects personal identity')
  }
 })
 console.log('REV-001 GOV-005 revenue source redaction, exact retained cents/dates and eventual removal passed')
}
