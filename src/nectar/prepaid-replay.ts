// Replay saved service operands against one chronological prepaid ledger. Pure:
// neither a preview nor a proposed correction reserves or consumes a balance.
import { insist, type Row } from './core'
import { rate, type Line, type Rating, type RatingInput } from './rating'
import { boundaryEntries, lotStates } from './prepaid-math'
import type { PrepaidBasis, PrepaidEntry } from './prepaid-types'
export interface PrepaidReplayPeriod { invoice: string; originalFingerprint: string; beforeInput: RatingInput; afterInput: RatingInput }
export interface PrepaidReplayResult { invoice: string; input: RatingInput; rating: Rating }
export const prepaidEntryKind = (entry:PrepaidEntry) => entry.kind==='correction' ? entry.correctionKind : entry.kind
export function prepaidDrawEntries(invoice: string, lines: Line[], basis: PrepaidBasis) {
  const entries:PrepaidEntry[]=[]
  for(const [index,line] of lines.entries()){
    const prepaid=line.evidence.prepaid as Row|undefined
    if(!prepaid)continue
    entries.push(...prepaid.transitions)
    for(const [part,allocation] of prepaid.allocations.entries()){
      const grant=basis.grants.find(grant=>grant.id===allocation.grantId)
      insist(grant,'prepaid_correction_source_required',409)
      entries.push({id:`${invoice}-${index}-${part}`,grantId:grant.id,kind:'drawdown',amountN:-allocation.amountN,liabilityCents:-allocation.valueCents,recognitionCents:allocation.valueCents,serviceDate:allocation.date,invoiceId:invoice,lineIndex:allocation.lineIndex,purchaseInvoice:grant.purchaseInvoice,purchaseLine:grant.purchaseLine})
    }
  }
  return entries
}
export function appendPrepaidBoundaries(basis: PrepaidBasis, snapshot:PrepaidBasis) {
  const dates=snapshot.entries.filter(entry=>['expiry','rollover'].includes(prepaidEntryKind(entry)??'')&&!basis.entries.some(saved=>saved.id===entry.id)).map(entry=>entry.serviceDate)
  for(const date of [...new Set(dates)].sort()){
    const entries=lotStates(basis).flatMap(lot=>boundaryEntries(lot,date))
    for(const entry of entries)if(!basis.entries.some(saved=>saved.id===entry.id))basis.entries.push(entry)
  }
}
export function introducePrepaidGrants(basis:PrepaidBasis,snapshot:PrepaidBasis) {
  for(const grant of snapshot.grants)if(!basis.grants.some(saved=>saved.id===grant.id))basis.grants.push(grant)
  for(const entry of snapshot.entries)if(entry.kind==='grant'&&!basis.entries.some(saved=>saved.id===entry.id))basis.entries.push(entry)
}
export function replayPrepaidHistory(periods: PrepaidReplayPeriod[]) {
  insist(periods.length>0,'prepaid_correction_source_required',409)
  const first=periods[0].beforeInput.prepaid!
  insist(first && periods.every((period,index)=>period.beforeInput.prepaid?.subscription===first.subscription && period.afterInput.subscription.id===first.subscription && (!index||periods[index-1].beforeInput.period.start<period.beforeInput.period.start)) && new Set(periods.map(period=>period.invoice)).size===periods.length,'prepaid_correction_source_required',409)
  const running:PrepaidBasis={...first,grants:[...first.grants],entries:[...first.entries]}
  const replay:PrepaidReplayResult[]=[], rerated=new Map<string,Line[]>()
  for(const period of periods){
    const snapshot=period.beforeInput.prepaid!
    introducePrepaidGrants(running,snapshot)
    appendPrepaidBoundaries(running,snapshot)
    const input:RatingInput={...period.afterInput,prepaid:{...running,revision:snapshot.revision,grants:[...running.grants],entries:[...running.entries]},
      ...(period.afterInput.contracts?{contracts:{...period.afterInput.contracts,invoices:period.afterInput.contracts.invoices.map(invoice=>({...invoice,lines:rerated.get(invoice.id)??invoice.lines}))}}:{})}
    const rating=rate(input)
    replay.push({invoice:period.invoice,input,rating});rerated.set(period.invoice,rating.lines)
    for(const entry of prepaidDrawEntries(period.invoice,rating.lines,running))if(!running.entries.some(saved=>saved.id===entry.id))running.entries.push(entry)
  }
  return {replay,running}
}
export const replayPrepaidPeriods = (periods:PrepaidReplayPeriod[]) => replayPrepaidHistory(periods).replay
