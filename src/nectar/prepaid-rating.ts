// Pure drawdown planning: never writes, charges a card or creates funding.
import { insist, type Row } from './core'
import { micros, roundHalfAway } from './decimal'
import { metricQuantityPrice } from './metric-pricing'
import { rational, subtractRational } from './metric-plan'
import type { Line, RatingInput } from './rating'
import { prepaidDays, prepaidQuantity, weightedIntegers } from './prepaid-days'
import { boundaryEntries, lotPriority, lotStates, releaseValue } from './prepaid-math'
import type { PrepaidAllocation, PrepaidEntry } from './prepaid-types'

export function prepaidLines(input: RatingInput, source: Line[]): Line[] {
  if (!input.prepaid?.grants.length) return source
  const lots = lotStates(input.prepaid).sort(lotPriority), additions: Line[] = []
  const usage = source.map((line,index) => ({line,index})).filter(({line}) => ['usage','late_usage','overage','metric_usage'].includes(line.kind)).sort((a,b) => a.line.periodStart.localeCompare(b.line.periodStart) || a.index - b.index)
  const contexts = usage.filter(({line}) => input.prices[line.priceId!] && line.amountCents > 0).map(({line,index}) => ({line,index,price:input.prices[line.priceId!],days:prepaidDays(input,line),quantity:prepaidQuantity(line),amount:line.amountCents}))
  const unitTasks = contexts.flatMap(context => context.days.map(day => ({context,day}))).sort((a,b) => a.day.date.localeCompare(b.day.date) || a.context.index-b.context.index)
  const use = (lot: typeof lots[number], n: number, date: string, lineIndex: number): PrepaidAllocation => {
    const valueCents = releaseValue(lot,n), beforeN = lot.remainingN
    lot.remainingN -= n; lot.liabilityCents -= valueCents
    return {grantId:lot.grant.id,amountN:n,valueCents,date,lineIndex,source:lot.grant.source,beforeN,afterN:lot.remainingN}
  }
  for (const {context,day} of unitTasks) for (const lot of lots.filter(lot => lot.grant.kind === 'units' && lot.grant.meterId === context.line.meterId)) {
    const transitions = boundaryEntries(lot,day.date)
    const eligible = lot.grant.effectiveDate <= day.date && (!lot.grant.expiresDate || lot.grant.expiresDate > day.date)
    const n = eligible ? Math.min(day.unitsN,lot.remainingN) : 0
    if (n) {
      const before = context.amount, allocation = use(lot,n,day.date,context.index)
      day.unitsN -= n; context.quantity = subtractRational(context.quantity,rational(BigInt(n),1000000n))
      context.amount = context.price.pricing ? metricQuantityPrice(context.price.pricing,context.quantity).amountCents : Number(roundHalfAway(micros(context.line.unitAmount || context.price.unitAmount) * context.quantity.n * 100n,1000000n * context.quantity.d))
      additions.push(drawLine(context.line,context.index,lot.grant.source === 'promotion',context.amount-before,[allocation],transitions))
    } else if (transitions.length) additions.push(drawLine(context.line,context.index,false,0,[],transitions))
  }
  const moneyTasks = contexts.flatMap(context => weightedIntegers(BigInt(Math.max(0,context.amount)),context.days.map(day => ({date:day.date,weight:rational(BigInt(day.unitsN))}))).map(day => ({context,day}))).sort((a,b) => a.day.date.localeCompare(b.day.date) || a.context.index-b.context.index)
  for (const {context,day} of moneyTasks) for (const lot of lots.filter(lot => lot.grant.kind === 'money' && (!lot.grant.meterId || lot.grant.meterId === context.line.meterId))) {
    const transitions = boundaryEntries(lot,day.date)
    const eligible = lot.grant.effectiveDate <= day.date && (!lot.grant.expiresDate || lot.grant.expiresDate > day.date)
    const n = eligible ? Math.min(Number(day.amount),lot.remainingN) : 0
    if (n) {
      const allocation = use(lot,n,day.date,context.index); day.amount -= BigInt(n)
      additions.push(drawLine(context.line,context.index,lot.grant.source === 'promotion',-n,[allocation],transitions))
    } else if (transitions.length) additions.push(drawLine(context.line,context.index,false,0,[],transitions))
  }
  insist(additions.every(line => Number.isSafeInteger(line.amountCents)), 'prepaid_amount_out_of_range')
  return [...source,...additions]
}
function drawLine(source: Line, lineIndex: number, promotion: boolean, amountCents: number, allocations: PrepaidAllocation[], transitions: PrepaidEntry[]): Line {
  return {kind:'prepaid_drawdown',description:promotion?'Promotional prepaid service drawdown':'Purchased prepaid service drawdown',quantity:'1',unitAmount:'',amountCents,taxable:promotion && source.taxable,priceId:source.priceId,meterId:source.meterId,periodStart:source.periodStart,periodEnd:source.periodEnd,
    evidence:{prepaid:{version:'nectar-prepaid-1',lineIndex,allocations,transitions,sourceKind:source.kind,sourcePeriod:{start:source.periodStart,end:source.periodEnd}},calendar:source.evidence.calendar,
      revenueEntries:allocations.length?[{period:allocations[0].date.slice(0,7),amountCents,basis:{method:'prepaid-source-day-adjustment',lineIndex}}]:[{period:source.periodStart.slice(0,7),amountCents:0,basis:{method:'prepaid-boundary-only'}}]}}
}
