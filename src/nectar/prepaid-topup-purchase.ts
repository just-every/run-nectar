// Automatic purchases use the ordinary immutable liability calculation,
// numbering and recognition policy. The signed, independently approved quote
// authorizes only this fixed amount and original grant terms, within its cap.
import { transferInstructionIssue } from './transfer-instructions'
import type { Bindings } from '../auth.server'
import { actorLabel, type Actor } from './actor'
import { requireBusiness, taxReady } from './business'
import { clockInstant } from './clock'
import { canonical, commit, guard, insist, newId, one, stmt } from './core'
import { addDays } from './dates'
import { documentNumberAllocation } from './invoice-numbering'
import { prepaidPurchaseCalculation, prepaidPurchaseIssueStatements } from './prepaid-purchase'
import { recognitionForSavedInvoice, REVENUE_POLICY_VERSION } from './revenue-allocation'
import { currentTopupAuthorization, topupAuthorizationGuard, topupRuntimeOwner } from './prepaid-topup-records'
export async function issueAuthorizedPrepaidTopupPurchase(env:Bindings,actor:Actor,claimId:string){
  const claim=await one(env,'SELECT * FROM nc_prepaid_topup_claims WHERE id=?',claimId)
  insist(claim,'topup_claim_not_found',404)
  if(claim.invoice_id)return {invoice:claim.invoice_id}
  insist(claim.status==='reserved','topup_claim_changed',409)
  const {row,q,date}=await currentTopupAuthorization(env,claim.authorization_id),business=await requireBusiness(env)
  insist(taxReady(business),'tax_not_reviewed',409)
  const customer=await one(env,'SELECT * FROM nc_customers WHERE id=? AND erased_at IS NULL',q.customer)
  insist(customer&&customer.revision===q.customerRevision,'topup_content_changed',409)
  insist(!q.content.poRequired||q.content.poNumber,'po_required',409)
  const calculation=await prepaidPurchaseCalculation(env,business,q.customer,claim.funding_id,date)
  insist(calculation.rating.totalCents===q.amountCents&&canonical(calculation.input.invoiceContent)===canonical(q.content),'topup_purchase_changed',409)
  const allocation=await documentNumberAllocation(env,business,customer,'invoice')
  insist((q.content.billingEntity?.id??null)===allocation.entityId&&(!q.content.billingEntity||canonical(q.content.billingEntity.route)===canonical(JSON.parse(allocation.routeJson))),'topup_entity_account_changed',409)
  const invoice=newId(),run=newId(),lineId=newId(),at=clockInstant(env),line=calculation.rating.lines[0]
  const calculationJson=JSON.stringify({...calculation.rating,inputs:calculation.input,fingerprint:calculation.fingerprint,version:calculation.input.version})
  const invoiceRow={id:invoice,invoice_kind:'manual',customer_id:q.customer,issue_date:date,period_start:date,period_end:addDays(date,1),subtotal_cents:q.amountCents,tax_cents:0,total_cents:q.amountCents,source_fingerprint:calculation.fingerprint,calculation_json:calculationJson,calc_version:calculation.input.version,status:'issued'}
  const lineRow={id:lineId,invoice_id:invoice,seq:1,kind:line.kind,description:line.description,quantity:line.quantity,unit_amount:line.unitAmount,amount_cents:line.amountCents,taxable:0,price_id:null,meter_id:null,period_start:line.periodStart,period_end:line.periodEnd,evidence_json:JSON.stringify(line.evidence)}
  const statements=[topupRuntimeOwner(env,actor),topupAuthorizationGuard(env,row),...allocation.statements,
    guard(env,'topup_claim_changed',"EXISTS(SELECT 1 FROM nc_prepaid_topup_claims WHERE id=? AND authorization_id=? AND status='reserved' AND invoice_id IS NULL AND amount_cents=?)",claimId,row.id,q.amountCents),
    stmt(env,"INSERT INTO nc_bill_runs(id,period,cutoff_at,calc_version,status,summary_json,created_by,created_at,kind) VALUES(?,?,?,?,'draft',?,?,?,'manual')",run,date.slice(0,7),at,calculation.input.version,JSON.stringify({invoices:1,prepaidTopupAuthorization:row.id,claim:claimId}),actorLabel(actor),at),
    stmt(env,"INSERT INTO nc_invoices(id,bill_run_id,customer_id,subscription_id,invoice_kind,period_start,period_end,status,subtotal_cents,tax_cents,total_cents,calc_version,source_fingerprint,calculation_json,comparison_json,exceptions_json,created_at) VALUES(?,?,?,?,'manual',?,?,'draft',?,0,?,?,?,?,'{}','[]',?)",invoice,run,q.customer,q.subscription,date,addDays(date,1),q.amountCents,q.amountCents,calculation.input.version,calculation.fingerprint,calculationJson,at),
    stmt(env,'INSERT INTO nc_invoice_lines(id,invoice_id,seq,kind,description,quantity,unit_amount,amount_cents,taxable,price_id,meter_id,period_start,period_end,evidence_json) VALUES(?,?,1,?,?,?,?,?,0,NULL,NULL,?,?,?)',lineId,invoice,line.kind,line.description,line.quantity,line.unitAmount,line.amountCents,line.periodStart,line.periodEnd,lineRow.evidence_json),
    stmt(env,'UPDATE nc_prepaid_funding_intents SET invoice_id=? WHERE id=? AND status=\'pending\'',invoice,claim.funding_id),
    stmt(env,"UPDATE nc_invoices SET status='approved',approved_fingerprint=source_fingerprint,approved_by=?,approved_at=? WHERE id=?",`prepaid-policy:${row.id}:${row.approved_by_id}`,row.approved_at,invoice),
    guard(env,'native_collection_already_claimed','NOT EXISTS(SELECT 1 FROM nc_native_collection_claims WHERE invoice_id=?)',invoice),
    ...await transferInstructionIssue(env,{...invoiceRow,currency:'USD'},allocation.routeJson),
    stmt(env,"UPDATE nc_invoices SET status='issued',number=?,issue_date=?,due_date=?,issued_by=?,issued_at=?,legal_name=?,billing_entity_id=?,billing_route_json=? WHERE id=?",allocation.number,date,addDays(date,q.content.paymentTermsDays),actorLabel(actor),at,customer.name,allocation.entityId,allocation.routeJson,invoice),
    ...prepaidPurchaseIssueStatements(env,invoiceRow,calculation.input),
    stmt(env,"UPDATE nc_prepaid_topup_claims SET invoice_id=?,status='issued' WHERE id=?",invoice,claimId),
    stmt(env,"UPDATE nc_bill_runs SET status='finalised',finalised_by=?,finalised_at=? WHERE id=?",actorLabel(actor),at,run)]
  for(const schedule of recognitionForSavedInvoice(invoiceRow,[lineRow],business.timezone)){
    statements.push(stmt(env,'INSERT INTO nc_revenue_schedules(id,line_id,invoice_id,customer_id,policy_version,policy,kind,amount_cents,service_start,service_end,source_fingerprint,basis_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',schedule.lineId,schedule.lineId,invoice,q.customer,REVENUE_POLICY_VERSION,schedule.policy,schedule.kind,schedule.amountCents,schedule.serviceStart,schedule.serviceEnd,calculation.fingerprint,JSON.stringify(schedule.basis)))
    for(const entry of schedule.entries)statements.push(stmt(env,'INSERT INTO nc_revenue_entries(id,schedule_id,line_id,invoice_id,customer_id,recognition_date,amount_cents,basis_json) VALUES(?,?,?,?,?,?,?,?)',`${schedule.lineId}:${entry.period}`,schedule.lineId,schedule.lineId,invoice,q.customer,`${entry.period}-01`,entry.amountCents,JSON.stringify(entry.basis)))
  }
  await commit(env,statements,[{actor:actorLabel(actor),action:'prepaid.topup.purchase.issue',subject:invoice,detail:{authorization:row.id,basis:row.basis_hash,claim:claimId,amountCents:q.amountCents,number:allocation.number}},{actor:actorLabel(actor),action:'invoice.issue',subject:invoice,detail:{number:allocation.number,total:q.amountCents,fingerprint:calculation.fingerprint,prepaidTopupAuthorization:row.id}}])
  return {invoice}
}
