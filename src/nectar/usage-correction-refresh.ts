// Re-preparation replaces an unissued correcting draft. It never changes the
// approved correction, original invoices, staged deltas or frozen message.
import type { Bindings } from '../auth.server'
import { actorLabel,requireCapability,type Actor } from './actor'
import { all,commit,fingerprint,guard,insist,newId,now,one,parseJson,stmt,type Row } from './core'
import type { Input } from './input'
import { requireBusiness } from './business'
import { invoiceContent } from './invoice-content'
import { carriedUsageCredits } from './usage-correction-records'
import { rate,type RatingInput } from './rating'
export async function refreshCorrectingInvoice(env:Bindings,actor:Actor,input:Input){
  requireCapability(actor,'records')
  const seq=(await one(env,'SELECT COALESCE(MAX(seq),0) AS value FROM nc_audit'))!.value
  const previous=await one(env,'SELECT * FROM nc_invoices WHERE id=?',input.text('invoice',{max:100}))
  insist(previous,'invoice_not_found',404)
  const saved=parseJson<Row>(previous.calculation_json,{}).inputs as RatingInput
  insist(previous.invoice_kind==='manual'&&saved?.usageCorrection&&['draft','approved'].includes(previous.status),'unissued_correcting_invoice_required',409)
  const staged=await all(env,'SELECT id FROM nc_usage_adjustments WHERE target_invoice_id=? AND invoice_id IS NULL',previous.id)
  insist(staged.length===saved.usageAdjustments?.length,'correction_already_billed',409)
  const inputs:RatingInput={...saved,usageCredits:await carriedUsageCredits(env,previous.customer_id),invoiceContent:await invoiceContent(env,await requireBusiness(env),previous.customer_id)}
  const r=rate(inputs),basis=await fingerprint(inputs),id=newId(),at=now()
  await commit(env,[
    guard(env,'source_changed','(SELECT COALESCE(MAX(seq),0) FROM nc_audit)=?',seq),
    guard(env,'unissued_correcting_invoice_required',"EXISTS(SELECT 1 FROM nc_invoices WHERE id=? AND status IN ('draft','approved'))",previous.id),
    stmt(env,"UPDATE nc_invoices SET status='discarded' WHERE id=?",previous.id),
    stmt(env,`INSERT INTO nc_invoices(id,bill_run_id,customer_id,subscription_id,invoice_kind,period_start,period_end,status,subtotal_cents,tax_cents,total_cents,calc_version,source_fingerprint,calculation_json,comparison_json,exceptions_json,created_at)
      VALUES(?,?,?,?,'manual',?,?,'draft',?,?,?,?,?,?,'{}',?,?)`,id,previous.bill_run_id,previous.customer_id,previous.subscription_id,previous.period_start,previous.period_end,r.subtotalCents,r.taxCents,r.totalCents,inputs.version,basis,
      JSON.stringify({version:inputs.version,fingerprint:basis,tax:r.tax,consumedEvents:[],inputs}),JSON.stringify(r.exceptions),at),
    ...r.lines.map((line,index)=>stmt(env,`INSERT INTO nc_invoice_lines(id,invoice_id,seq,kind,description,quantity,unit_amount,amount_cents,taxable,price_id,meter_id,period_start,period_end,evidence_json) VALUES(?,?,?,?,?,?,?,?,0,NULL,NULL,?,?,?)`,newId(),id,index+1,line.kind,line.description,line.quantity,line.unitAmount,line.amountCents,line.periodStart,line.periodEnd,JSON.stringify(line.evidence))),
    ...staged.map(a=>stmt(env,'UPDATE nc_usage_adjustments SET target_invoice_id=? WHERE id=? AND invoice_id IS NULL',id,a.id)),
  ],{actor:actorLabel(actor),action:'invoice.correction.refresh',subject:id,detail:{replaces:previous.id,correction:saved.usageCorrection,basis}})
  return {id,run:previous.bill_run_id}
}
