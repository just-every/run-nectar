// Issue owns consumption. Every amount is the saved deterministic preview,
// atomically fenced against all earlier grants, spending and funding changes.
import type { Bindings } from '../auth.server'
import { actorLabel, requireOwner, type Actor } from './actor'
import { all, commit, guard, insist, now, one, parseJson, stmt, type Row } from './core'
import { clockInstant } from './clock'
import { today } from './dates'
import { requireBusiness } from './business'
import type { Input } from './input'
import { requireFreshFactor } from './mfa'
import { boundaryEntries, lotStates } from './prepaid-math'
import { prepaidFundingIntentStatements, prepaidRevisionGuard, prepaidSnapshot, prepaidTerms } from './prepaid-records'
import type { PrepaidBasis, PrepaidEntry } from './prepaid-types'

export function prepaidLedgerStatements(env: Bindings, basis: PrepaidBasis, entries: PrepaidEntry[]) {
  if (!entries.length) return []
  const rows = entries.map(entry => [entry.id,entry.grantId,basis.customer,basis.subscription,entry.kind,entry.amountN,entry.liabilityCents,entry.recognitionCents,entry.serviceDate,entry.invoiceId,entry.lineIndex,entry.purchaseInvoice,entry.purchaseLine,now()])
  return [prepaidRevisionGuard(env,basis.subscription,basis.revision),
    stmt(env, `INSERT INTO nc_prepaid_ledger(id,grant_id,customer_id,subscription_id,kind,amount_n,liability_cents,recognition_cents,service_date,invoice_id,line_index,purchase_invoice_id,purchase_line_id,created_at) SELECT ${rows[0].map((_,index)=>`json_extract(value,'$[${index}]')`).join(',')} FROM json_each(?)`, JSON.stringify(rows)),
    stmt(env,'UPDATE nc_prepaid_accounts SET revision=revision+1 WHERE subscription_id=?',basis.subscription)]
}
function drawEntries(invoice: Row, calculation: Row): PrepaidEntry[] {
  const basis = calculation.inputs.prepaid as PrepaidBasis, entries: PrepaidEntry[] = []
  for (const [index,line] of calculation.lines.entries()) {
    const prepaid = line.evidence?.prepaid
    if (!prepaid) continue
    entries.push(...prepaid.transitions)
    for (const [part,allocation] of prepaid.allocations.entries()) {
      const grant = basis.grants.find(grant=>grant.id===allocation.grantId)
      insist(grant,'prepaid_source_changed',409)
      entries.push({id:`${invoice.id}-${index}-${part}`,grantId:grant.id,kind:'drawdown',amountN:-allocation.amountN,liabilityCents:-allocation.valueCents,recognitionCents:allocation.valueCents,serviceDate:allocation.date,invoiceId:invoice.id,lineIndex:allocation.lineIndex,purchaseInvoice:grant.purchaseInvoice,purchaseLine:grant.purchaseLine})
    }
  }
  return entries.sort((a,b)=>a.serviceDate.localeCompare(b.serviceDate)||Number(['expiry','rollover'].includes(b.kind))-Number(['expiry','rollover'].includes(a.kind))||(a.lineIndex??0)-(b.lineIndex??0)||a.id.localeCompare(b.id))
}
export async function prepaidIssueStatements(env: Bindings, invoice: Row, calculation: Row, _issueDate: string) {
  const basis = calculation.inputs?.prepaid as PrepaidBasis|undefined
  if (!basis) return []
  const savedLines = await all(env,'SELECT kind,evidence_json FROM nc_invoice_lines WHERE invoice_id=? ORDER BY seq',invoice.id)
  const entries = drawEntries(invoice,{...calculation,lines:savedLines.map(line=>({...line,evidence:parseJson(line.evidence_json,{})}))})
  return [...prepaidLedgerStatements(env,basis,entries), ...await prepaidTopupStatements(env,basis,entries)]
}
export async function prepaidTopupStatements(env: Bindings, basis: PrepaidBasis, additions: PrepaidEntry[] = []) {
  const consent = await one(env,"SELECT * FROM nc_prepaid_consents WHERE subscription_id=? AND status='active'",basis.subscription)
  if (!consent || await one(env,"SELECT 1 FROM nc_prepaid_funding_intents WHERE consent_id=? AND status='pending'",consent.id)) return []
  const terms = prepaidTerms(consent), date = today((await requireBusiness(env)).timezone,clockInstant(env))
  if (terms.expiresDate && terms.expiresDate <= date) return []
  const lots = lotStates({...basis,entries:[...basis.entries,...additions]})
  const balance = lots.filter(lot=>lot.grant.kind===terms.kind && lot.grant.meterId===terms.meterId && lot.grant.effectiveDate<=date && (!lot.grant.expiresDate||lot.grant.expiresDate>date)).reduce((sum,lot)=>sum+lot.remainingN,0)
  if (balance > consent.threshold_n) return []
  // The unique pending row is a funding request, never a processor attempt.
  const id = crypto.randomUUID()
  return [guard(env,'prepaid_consent_revoked',"EXISTS(SELECT 1 FROM nc_prepaid_consents WHERE id=? AND status='active')",consent.id),...prepaidFundingIntentStatements(env,id,basis.subscription,basis.customer,{...terms,effectiveDate:date},null,consent.id),
    stmt(env,"INSERT INTO nc_audit(at,actor,action,subject,detail) SELECT ?,prepared_by,'prepaid.topup.prepare',?,? FROM nc_prepaid_requests WHERE id=?",now(),id,JSON.stringify({subscription:basis.subscription,consent:consent.id,balanceN:balance,thresholdN:consent.threshold_n,amountCents:terms.valueCents}),consent.request_id)]
}
export async function settlePrepaid(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor); await requireFreshFactor(env,actor)
  const subscription=input.text('subscription',{max:100}), basis=await prepaidSnapshot(env,subscription)
  insist(basis,'prepaid_account_not_found',404)
  const date=today((await requireBusiness(env)).timezone,clockInstant(env)), entries=await prepaidSettlementEntries(env,basis,date)
  await commit(env,[...prepaidLedgerStatements(env,basis,entries),...await prepaidTopupStatements(env,basis,entries)],{actor:actorLabel(actor),action:'prepaid.settle',subject:subscription,detail:{date,entries:entries.map(entry=>({id:entry.id,kind:entry.kind,amountN:entry.amountN,recognitionCents:entry.recognitionCents}))}})
  return {subscription,date,entries}
}

/** Reusable cron work is limited to explicitly approved expiry/rollover terms;
 * low-balance consent creates an intent only. It never calls a processor. */
async function prepaidSettlementEntries(env: Bindings, basis: PrepaidBasis, date: string) {
  const entries:PrepaidEntry[]=[]
  // Never expire funds before recorded, unissued earlier service is billed.
  const unbilled=await all(env,"SELECT occurred_at FROM nc_usage_events WHERE customer_id=? AND invoice_id IS NULL AND status='active' AND NOT EXISTS(SELECT 1 FROM nc_usage_voids v WHERE v.event_id=nc_usage_events.event_id)",basis.customer)
  for(const lot of lotStates(basis)) {
    const pending = boundaryEntries({...lot},date)
    if (!pending.length) continue
    const boundary = pending[0].serviceDate
    const zone=(await requireBusiness(env)).timezone
    const {localDate}=await import('./dates')
    insist(!unbilled.some(event=>localDate(event.occurred_at,zone)>=lot.grant.effectiveDate&&localDate(event.occurred_at,zone)<boundary),'prepaid_unbilled_service',409)
    entries.push(...boundaryEntries(lot,date))
  }
  return entries
}
export async function settlePrepaidScheduled(env: Bindings, actor: Actor) {
  requireOwner(actor)
  const date=today((await requireBusiness(env)).timezone,clockInstant(env)), settled:string[]=[], deferred:{subscription:string;reason:string}[]=[]
  const accounts=await all(env,'SELECT a.subscription_id FROM nc_prepaid_accounts a JOIN nc_customers c ON c.id=a.customer_id WHERE c.erased_at IS NULL ORDER BY a.subscription_id')
  for(const account of accounts){
    const basis=(await prepaidSnapshot(env,account.subscription_id))!
    let entries:PrepaidEntry[]
    try { entries=await prepaidSettlementEntries(env,basis,date) } catch(error) {
      if(error instanceof Error && error.message==='prepaid_unbilled_service'){deferred.push({subscription:basis.subscription,reason:error.message});continue}
      throw error
    }
    const funding=await prepaidTopupStatements(env,basis,entries)
    if(!entries.length&&!funding.length)continue
    await commit(env,[guard(env,'forbidden',"EXISTS(SELECT 1 FROM nc_members WHERE id=? AND role='owner' AND status='active')",actor.id),...prepaidLedgerStatements(env,basis,entries),...funding],{actor:actorLabel(actor),action:'prepaid.scheduled.settle',subject:basis.subscription,detail:{date,entries:entries.map(entry=>entry.id)}})
    settled.push(basis.subscription)
  }
  return {date,settled,deferred}
}
