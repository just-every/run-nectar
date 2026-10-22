// A governed correction appends exact signed differences, retaining every
// issued invoice, purchase value and original ledger entry.
import type { Bindings } from '../auth.server'
import { requireMember, requireOwner, actorLabel, type Actor } from './actor'
import { all, canonical, fingerprint, guard, insist, now, stmt, type Audit } from './core'
import { requireFreshFactor } from './mfa'
import { isDate } from './dates'
import { lotStates } from './prepaid-math'
import { prepaidRevisionGuard, prepaidSnapshot } from './prepaid-records'
import { appendPrepaidBoundaries, introducePrepaidGrants, introducePrepaidRefunds, prepaidEntryKind, replayPrepaidHistory, type PrepaidReplayPeriod, type PrepaidReplayResult } from './prepaid-replay'
import type { PrepaidBasis, PrepaidEntry } from './prepaid-types'
export { replayPrepaidPeriods, type PrepaidReplayPeriod } from './prepaid-replay'
export interface PrepaidCorrectionPlan {
  subscription: string; customer: string; revision: number; date: string
  originals: {invoice:string;fingerprint:string}[]; replay: PrepaidReplayResult[]; deltas: PrepaidEntry[]; basis: string
}
/** Every downstream issued draw must be supplied. Earlier correction entries
 * retain their semantic source kind, so a second correction compares against
 * the already corrected ledger rather than reversing an unrelated decision. */
export async function planPrepaidCorrection(current: PrepaidBasis, periods: PrepaidReplayPeriod[], date: string): Promise<PrepaidCorrectionPlan> {
  insist(isDate(date),'invalid_prepaid_correction_date')
  const {replay,running}=replayPrepaidHistory(periods,current.entries), first=periods[0].beforeInput.prepaid!
  insist(first.subscription===current.subscription && first.customer===current.customer,'prepaid_correction_source_required',409)
  const replayIds=new Set(periods.map(period=>period.invoice))
  // Earlier effective draws may have different opaque correction IDs from
  // their saved replay; compare their financial operands, never their IDs.
  const outsideDraws=(entries:PrepaidEntry[])=>{
    const totals=new Map<string,number[]>()
    for(const entry of entries)if(prepaidEntryKind(entry)==='drawdown'&&(!entry.invoiceId||!replayIds.has(entry.invoiceId))){
      const key=canonical([entry.grantId,entry.serviceDate,entry.invoiceId,entry.lineIndex]),row=totals.get(key)??[0,0,0]
      row[0]+=entry.amountN;row[1]+=entry.liabilityCents;row[2]+=entry.recognitionCents;totals.set(key,row)
    }
    return [...totals].filter(([,values])=>values.some(Boolean)).sort(([a],[b])=>a.localeCompare(b))
  }
  insist(canonical(outsideDraws(current.entries))===canonical(outsideDraws(first.entries)),'prepaid_full_history_required',409)
  introducePrepaidGrants(running,current)
  introducePrepaidRefunds(running,current.entries)
  appendPrepaidBoundaries(running,current)
  const buckets=new Map<string,{template:PrepaidEntry;amountN:number;liabilityCents:number;recognitionCents:number}>()
  for(const [entries,sign] of [[current.entries,-1],[running.entries,1]] as const)for(const entry of entries){
    const kind=prepaidEntryKind(entry)
    insist(kind,'prepaid_correction_source_required',409)
    const key=canonical([entry.grantId,entry.serviceDate,entry.invoiceId,entry.lineIndex,kind]),bucket=buckets.get(key)??{template:{...entry,kind},amountN:0,liabilityCents:0,recognitionCents:0}
    bucket.amountN+=sign*entry.amountN;bucket.liabilityCents+=sign*entry.liabilityCents;bucket.recognitionCents+=sign*entry.recognitionCents;buckets.set(key,bucket)
  }
  const deltas=[...buckets.values()].filter(row=>row.amountN||row.liabilityCents||row.recognitionCents).map((row,index)=>({...row.template,id:`correction-${index}`,correctionKind:row.template.kind as 'drawdown'|'expiry'|'rollover',kind:'correction' as const,amountN:row.amountN,liabilityCents:row.liabilityCents,recognitionCents:row.recognitionCents}))
  insist(deltas.every(entry=>['drawdown','expiry','rollover'].includes(entry.correctionKind??'') && Number.isSafeInteger(entry.amountN)&&Number.isSafeInteger(entry.liabilityCents)&&entry.recognitionCents===-entry.liabilityCents),'prepaid_correction_balance_invalid',409)
  for(const lot of lotStates(running))insist(lot.remainingN<=lot.grant.amountN&&lot.liabilityCents<=lot.grant.valueCents,'prepaid_correction_balance_invalid',409)
  const originals=periods.map(period=>({invoice:period.invoice,fingerprint:period.originalFingerprint}))
  const plan={subscription:current.subscription,customer:current.customer,revision:current.revision,date,originals,replay,deltas}
  return {...plan,basis:await fingerprint({current,plan})}
}
/** Append after the existing usage-correction approved UPDATE, in the SAME
 * batch as saved replays, financial documents and frozen customer message.
 * Its prepared plan_json must contain prepaid:{basis:plan.basis,...}. */
export async function prepaidCorrectionStatements(env: Bindings, actor: Actor, correction: string, preparer: string, plan: PrepaidCorrectionPlan, periods: PrepaidReplayPeriod[], confirmSingle=false): Promise<{statements:D1PreparedStatement[];audits:Audit[]}> {
  requireMember(actor,'approve');await requireFreshFactor(env,actor)
  const current=await prepaidSnapshot(env,plan.subscription)
  insist(current,'prepaid_account_not_found',404)
  const recomputed=await planPrepaidCorrection(current,periods,plan.date)
  insist(recomputed.basis===plan.basis,'prepaid_correction_stale',409)
  const single=actor.id===preparer
  if(single){requireOwner(actor);insist(confirmSingle,'single_confirmation_required',409);insist(!(await all(env,"SELECT id FROM nc_members WHERE role IN ('owner','finance') AND status='active' AND id<>?",actor.id)).length,'second_approver_required',409)}
  const statements=[prepaidRevisionGuard(env,plan.subscription,plan.revision),
    guard(env,'prepaid_correction_not_approved',"EXISTS(SELECT 1 FROM nc_usage_corrections WHERE id=? AND status='approved' AND subscription_id=? AND customer_id=? AND json_extract(plan_json,'$.prepaid.basis')=? AND COALESCE(authorized_by_id,prepared_by_id)=?)",correction,plan.subscription,plan.customer,plan.basis,preparer),
    guard(env,'second_approver_required',"EXISTS(SELECT 1 FROM nc_members WHERE id=? AND status='active' AND role IN ('owner','finance'))",preparer),
    ...(single?[guard(env,'second_approver_required',"NOT EXISTS(SELECT 1 FROM nc_members WHERE role IN ('owner','finance') AND status='active' AND id<>?)",actor.id)]:[]),
    stmt(env,'INSERT INTO nc_prepaid_corrections(id,subscription_id,customer_id,basis,applied_at) VALUES(?,?,?,?,?)',correction,plan.subscription,plan.customer,plan.basis,now())]
  for(const original of plan.originals)statements.push(guard(env,'prepaid_correction_source_changed',"EXISTS(SELECT 1 FROM nc_invoices WHERE id=? AND subscription_id=? AND customer_id=? AND status='issued' AND source_fingerprint=?)",original.invoice,plan.subscription,plan.customer,original.fingerprint))
  // One atomic set can move rounding cents between service dates. Per-row
  // lower bounds are deferred for approved corrections; complete lot bounds
  // below roll the entire batch back if any final balance is invalid.
  const rows=plan.deltas.map((entry,index)=>[`${correction}-${index}`,entry.grantId,plan.customer,plan.subscription,'correction',entry.amountN,entry.liabilityCents,entry.recognitionCents,entry.serviceDate,entry.invoiceId,entry.lineIndex,entry.purchaseInvoice,entry.purchaseLine,now(),correction,entry.correctionKind])
  if(rows.length)statements.push(stmt(env,`INSERT INTO nc_prepaid_ledger(id,grant_id,customer_id,subscription_id,kind,amount_n,liability_cents,recognition_cents,service_date,invoice_id,line_index,purchase_invoice_id,purchase_line_id,created_at,correction_id,correction_kind) SELECT ${rows[0].map((_,index)=>`json_extract(value,'$[${index}]')`).join(',')} FROM json_each(?)`,JSON.stringify(rows)))
  for(const grant of current.grants)statements.push(guard(env,'prepaid_correction_balance_invalid','(SELECT COALESCE(SUM(amount_n),0) FROM nc_prepaid_ledger WHERE grant_id=?) BETWEEN 0 AND ? AND (SELECT COALESCE(SUM(liability_cents),0) FROM nc_prepaid_ledger WHERE grant_id=?) BETWEEN 0 AND ?',grant.id,grant.amountN,grant.id,grant.valueCents))
  statements.push(stmt(env,'UPDATE nc_prepaid_accounts SET revision=revision+1 WHERE subscription_id=?',plan.subscription))
  return {statements,audits:[{actor:actorLabel(actor),action:'prepaid.correction.apply',subject:correction,detail:{subscription:plan.subscription,preparer,basis:plan.basis,originals:plan.originals,deltas:plan.deltas.map(entry=>({grant:entry.grantId,date:entry.serviceDate,amountN:entry.amountN,recognitionCents:entry.recognitionCents}))}}]}
}
