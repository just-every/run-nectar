// Signed commitment windows are independent of the monthly invoice cadence.
// Every historical contribution is saved invoice evidence, never today's prices.
import type { Line, RatingInput, Exception } from './rating'
import { activeSegments } from './lifecycle-math'
import { daysBetween } from './dates'
import { roundHalfAway } from './decimal'

export const CONTRACT_RATING_VERSION = 'nectar-rating-6'
export interface Commitment { contract: string; from: string; to: string; minimumCents: number; taxable: boolean }
export interface Included { contract: string; price: string; quantity: string; from: string; to: string }
export interface PriorInvoice { id: string; number: string; from: string; to: string; lines: Line[] }
export interface ContractBasis { commitments: Commitment[]; included: Included[]; invoices: PriorInvoice[] }
export const earnedCents = (lines: Line[]) => Math.max(0, lines.filter(l=>['flat','seat','usage','late_usage','overage','metric_usage','discount','cancellation_credit'].includes(l.kind)).reduce((n,l)=>n+l.amountCents,0))

export function minimumFor(input: Pick<RatingInput,'subscription'|'lifecycle'>, window: Commitment) {
  const from=[window.from,input.subscription.startDate,input.subscription.trialEnd??window.from,input.subscription.billFrom??window.from].sort().at(-1)!
  const to=[window.to,input.subscription.endDate??window.to].sort()[0]
  const days=from<to?activeSegments(from,to,input.lifecycle??[]).reduce((n,[a,b])=>n+daysBetween(a,b),0):0
  return Number(roundHalfAway(BigInt(window.minimumCents)*BigInt(days),BigInt(daysBetween(window.from,window.to))))
}

export function commitmentLines(input: RatingInput, lines: Line[]): {lines:Line[];exceptions:Exception[]} {
  if (!input.contracts) return {lines,exceptions:[]}
  const additions:Line[]=[],exceptions:Exception[]=[]
  for (const w of input.contracts.commitments) {
    const end=input.subscription.endDate && input.subscription.endDate<w.to?input.subscription.endDate:w.to
    // End-exclusive: a cancellation exactly at a period boundary settles in
    // the preceding period; an early cancellation settles in its final period.
    if (end<=input.period.start || end>input.period.end || end<=w.from) continue
    const previous=input.contracts.invoices.filter(i=>i.from>=w.from && i.to<=input.period.start)
    let next=w.from
    for(const i of [...previous].sort((a,b)=>a.from.localeCompare(b.from))) {if(i.from===next)next=i.to}
    if(next<input.period.start) exceptions.push({code:'commitment_prior_periods',message:'Issue every earlier commitment period before settling its minimum.',detail:{contract:w.contract,from:next,to:input.period.start}})
    const earned=previous.reduce((n,i)=>n+earnedCents(i.lines),0)+earnedCents(lines)
    const previouslySettled=previous.flatMap(i=>i.lines).filter(l=>l.kind==='commitment_trueup'&&l.evidence.contract===w.contract&&l.periodStart===w.from).reduce((n,l)=>n+l.amountCents,0)
    const minimum=minimumFor(input,w), amount=Math.max(0,minimum-earned-previouslySettled)
    if(amount) additions.push({kind:'commitment_trueup',description:'Minimum commitment true-up',quantity:'1',unitAmount:'',amountCents:amount,taxable:w.taxable,priceId:null,meterId:null,periodStart:w.from,periodEnd:end,evidence:{rule:'active-day minimum less earned recurring and metered charges after discounts, before tax; one-time charges and credits excluded',contract:w.contract,minimumCents:minimum,nominalMinimumCents:w.minimumCents,earnedCents:earned,previouslySettledCents:previouslySettled,priorInvoices:previous.map(i=>({id:i.id,number:i.number,earnedCents:earnedCents(i.lines)}))}})
  }
  return {lines:[...lines,...additions],exceptions}
}
