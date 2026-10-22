// Pure drawdown planning: never writes, charges a card or creates funding.
import { insist } from './core'
import { upliftAmount, type RenewalRate } from './renewal-rating'
import { rational, subtractRational } from './metric-plan'
import type { Line, RatingInput } from './rating'
import { prepaidDays, prepaidQuantity, weightedIntegers } from './prepaid-days'
import { boundaryEntries, lotPriority, lotStates, releaseValue } from './prepaid-math'
import { prepaidUnitCharge, prepaidUnitLimit } from './prepaid-unit-value'
import type { PrepaidAllocation, PrepaidEntry } from './prepaid-types'

export function prepaidLines(input: RatingInput, source: Line[]): Line[] {
  if (!input.prepaid?.grants.length) return source
  const lots = lotStates(input.prepaid).sort(lotPriority), additions: Line[] = []
  const usage = source.map((line,index) => ({line,index})).filter(({line}) => ['usage','late_usage','overage','metric_usage'].includes(line.kind))
  const contexts=usage.filter(({line})=>input.prices[line.priceId!]&&line.amountCents>0).map(({line,index})=>{
    const price=input.prices[line.priceId!],rates=line.evidence.renewals as RenewalRate[]|undefined
    const pricing=price.pricing&&rates?.length?{...price.pricing,tiers:price.pricing.tiers.map(tier=>({...tier,unitAmount:upliftAmount(tier.unitAmount,rates),flatAmount:upliftAmount(tier.flatAmount,rates)}))}:price.pricing
    return {line,index,pricing,unitAmount:line.unitAmount||price.unitAmount,days:prepaidDays(input,line).map(day=>({...day,sourceUnitsN:day.unitsN})),quantity:prepaidQuantity(line),amount:line.amountCents,fundedCents:0,fundedDays:new Map<string,number>()}
  })
  const use = (lot: typeof lots[number], n: number, date: string, lineIndex: number): PrepaidAllocation => {
    const valueCents = releaseValue(lot,n), beforeN = lot.remainingN
    lot.remainingN -= n; lot.liabilityCents -= valueCents
    return {grantId:lot.grant.id,amountN:n,valueCents,date,lineIndex,source:lot.grant.source,beforeN,afterN:lot.remainingN}
  }
  // Priority is global across purchased/promotional dollars AND units. Each
  // lot uses chronological actual service days before the next lot is tried.
  for(const lot of lots){
    const eligibleContexts=contexts.filter(context=>!lot.grant.meterId||lot.grant.meterId===context.line.meterId)
    const tasks=eligibleContexts.flatMap(context=>{
      if(lot.grant.kind==='units')return context.days.map(day=>({context,day,amount:0n}))
      const remainingUnits=context.days.reduce((sum,day)=>sum+day.unitsN,0)
      // Residual sub-micro native consideration still belongs to its actual
      // source days, even when all redeemable unit millionths were exhausted.
      const nominal=weightedIntegers(BigInt(context.amount),context.days.map(day=>({date:day.date,weight:rational(BigInt(remainingUnits?day.unitsN:day.sourceUnitsN))})))
      const weights=nominal.map(day=>({date:day.date,weight:rational(BigInt(Math.max(0,Number(day.amount)-(context.fundedDays.get(day.date)??0))))}))
      return weightedIntegers(BigInt(context.amount-context.fundedCents),weights).map(day=>({context,day:context.days.find(saved=>saved.date===day.date)!,amount:day.amount}))
    }).sort((a,b)=>a.day.date.localeCompare(b.day.date)||a.context.index-b.context.index)
    for(const task of tasks){
      const {context,day}=task,transitions=boundaryEntries(lot,day.date)
      const eligible=lot.grant.effectiveDate<=day.date&&(!lot.grant.expiresDate||lot.grant.expiresDate>day.date)
      const maximum=eligible?Math.min(lot.grant.kind==='units'?day.unitsN:Number(task.amount),lot.remainingN):0
      const n=lot.grant.kind==='units'?prepaidUnitLimit(context.pricing,context.unitAmount,context.quantity,maximum,context.fundedCents):maximum
      if(n){
        const allocation=use(lot,n,day.date,context.index)
        let adjustment=-n
        if(lot.grant.kind==='units'){
          const before=context.amount
          day.unitsN-=n;context.quantity=subtractRational(context.quantity,rational(BigInt(n),1000000n))
          context.amount=prepaidUnitCharge(context.pricing,context.unitAmount,context.quantity)
          adjustment=context.amount-before
        }else {context.fundedCents+=n;context.fundedDays.set(day.date,(context.fundedDays.get(day.date)??0)+n)}
        additions.push(drawLine(context.line,context.index,lot.grant.source==='promotion',adjustment,[allocation],transitions))
      }else if(transitions.length)additions.push(drawLine(context.line,context.index,false,0,[],transitions))
    }
  }
  insist(additions.every(line=>Number.isSafeInteger(line.amountCents))&&contexts.every(context=>context.amount>=context.fundedCents),'prepaid_amount_out_of_range')
  return [...source,...additions]
}
function drawLine(source: Line, lineIndex: number, promotion: boolean, amountCents: number, allocations: PrepaidAllocation[], transitions: PrepaidEntry[]): Line {
  return {kind:'prepaid_drawdown',description:promotion?'Promotional prepaid service drawdown':'Purchased prepaid service drawdown',quantity:'1',unitAmount:'',amountCents,taxable:promotion && source.taxable,priceId:source.priceId,meterId:source.meterId,periodStart:source.periodStart,periodEnd:source.periodEnd,
    evidence:{prepaid:{version:'nectar-prepaid-1',unitPrecision:1000000,allocationPolicy:'priority, expiry, effective date, grant ID across all denominations; exact native remaining-quantity valuation; actual service-day weights',lineIndex,allocations,transitions,sourceKind:source.kind,sourcePeriod:{start:source.periodStart,end:source.periodEnd}},calendar:source.evidence.calendar,
      revenueEntries:allocations.length?[{period:allocations[0].date.slice(0,7),amountCents,basis:{method:'prepaid-source-day-adjustment',lineIndex}}]:[{period:source.periodStart.slice(0,7),amountCents:0,basis:{method:'prepaid-boundary-only'}}]}}
}
