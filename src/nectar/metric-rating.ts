import { aggregateMetric,displayQuantity,metricLineCents } from './metric-aggregate'
import { activeSegments } from './lifecycle-math'
import { addDays,localDate,periodContaining,zonedStart } from './dates'
import { canonical } from './core'
import { micros } from './decimal'
import { metricQuantityPrice } from './metric-pricing'
import { compareRational,parseRational,rational,subtractRational,type MetricPlan,type PropertyValue,type Rational } from './metric-plan'
import type { Exception,Line,RatingInput } from './rating'
export const METRIC_RATING_VERSION='nectar-rating-7'
export interface MetricPrice {sourceId:string;plan:MetricPlan;dimensions:Record<string,PropertyValue>;version:number;code:string}
export function metricUsage(input:RatingInput):{lines:Line[];exceptions:Exception[];consumed:string[]} {
  const lines:Line[]=[],exceptions:Exception[]=[],consumed=new Set<string>(),allowances=new Map<string,Rational>()
  const sources=new Set(Object.values(input.prices).flatMap(p=>p.metric?[p.metric.sourceId]:[]))
  for(const [index,item] of input.items.entries()){const price=input.prices[item.priceId];if(!price?.metric)continue;const duplicate=input.items.slice(0,index).find(other=>{const p=input.prices[other.priceId];return p?.meterId===price.meterId&&canonical(p.metric?.dimensions)===canonical(price.metric!.dimensions)&&item.from<(other.to??'9999')&&other.from<(item.to??'9999')});if(duplicate)exceptions.push({code:'metric_duplicate_selection',message:'The same metric version and dimensions overlap on this subscription.',detail:{items:[duplicate.id,item.id]}})}
  const sourceEvents=input.events.filter(e=>sources.has(e.meterId))
  for(const source of sources) {
    const unbilled=sourceEvents.filter(e=>e.meterId===source&&!e.invoiceId&&localDate(e.occurredAt,input.timezone)>=input.subscription.startDate)
    const nonadditive=Object.values(input.prices).some(p=>p.metric?.sourceId===source&&!['sum','count'].includes(p.metric.plan.aggregation))
    const late=unbilled.filter(e=>localDate(e.occurredAt,input.timezone)<input.period.start)
    if(nonadditive&&late.length)exceptions.push({code:'metric_late_correction',message:'Late nonadditive metric events need an evidenced historical correction under USE-004 before this invoice can issue.',detail:{source,eventIds:late.map(e=>e.eventId)}})
    for(const e of unbilled)if(e.occurredAt<zonedStart(input.period.end,input.timezone))consumed.add(e.eventId)
  }
  for(const item of input.items) {
    const price=input.prices[item.priceId],metric=price?.metric;if(!metric)continue
    const all=sourceEvents.filter(e=>e.meterId===metric.sourceId).map(e=>({...e,properties:e.properties??{}}))
    const windows=new Map([[input.period.start,input.period]])
    if(['sum','count'].includes(metric.plan.aggregation))for(const e of all.filter(e=>!e.invoiceId&&e.occurredAt<zonedStart(input.period.start,input.timezone)&&localDate(e.occurredAt,input.timezone)>=input.subscription.startDate)) {const p=periodContaining(input.subscription.anchorDay,localDate(e.occurredAt,input.timezone));windows.set(p.start,p)}
    for(const window of windows.values()) {
      const from=[window.start,input.subscription.startDate,input.subscription.trialEnd??window.start,input.subscription.billFrom??window.start,item.from].sort().at(-1)!
      const to=[window.end,input.subscription.endDate??window.end,item.to??window.end].sort()[0];if(from>=to)continue
      const overrideTerms=input.amendments.filter(a=>a.kind==='price_override'&&a.priceId===price.id&&a.from<to&&(a.to??'9999')>from)
      const cuts=[...new Set([from,...overrideTerms.flatMap(a=>[a.from,a.to].filter((v):v is string=>!!v&&v>from&&v<to)),to])].sort()
      const unitGroups=new Map<string,{from:number;to:number}[]>()
      for(let index=0;index<cuts.length-1;index++){const a=cuts[index],b=cuts[index+1],unit=overrideTerms.find(t=>t.from<=a&&(t.to??'9999')>=b)?.value??price.unitAmount;const spans=activeSegments(a,b,input.lifecycle??[]).map(([start,end])=>({from:zonedStart(start,input.timezone),to:zonedStart(end,input.timezone)}));unitGroups.set(unit,[...(unitGroups.get(unit)??[]),...spans])}
      for(const [unit,active] of unitGroups) {
      const events=window.start===input.period.start?all:all.filter(e=>!e.invoiceId)
      const results=aggregateMetric(metric.plan,events,{from:zonedStart(window.start,input.timezone),to:zonedStart(window.end,input.timezone),active})
      const result=results.find(r=>canonical(r.dimensions)===canonical(metric.dimensions))??{dimensions:metric.dimensions,quantity:'0',exact:{numerator:'0',denominator:'1'},eventIds:[],contextEventIds:[]}
      let quantity=rational(BigInt(result.exact.numerator),BigInt(result.exact.denominator)),included=rational(0n)
      if(quantity.n<0n){exceptions.push({code:'metric_negative_quantity',message:`Metric ${metric.code} has exact negative quantity ${quantity.n}/${quantity.d}; correct the source/definition before billing. It is not rated or issued as a credit.`,detail:{meter:price.meterId,dimensions:metric.dimensions,exact:{numerator:String(quantity.n),denominator:String(quantity.d)},eventIds:result.eventIds,contextEventIds:result.contextEventIds}});continue}
      const rawQuantity=quantity,allowance=input.contracts?.included.find(a=>a.price===price.id&&a.from<=window.start&&a.to>=window.end)
      if(allowance) {
        const key=`${price.id}|${window.start}`
        const used=(input.contracts?.invoices??[]).flatMap(i=>i.lines).filter(l=>l.priceId===price.id&&l.periodStart===window.start&&l.evidence.includedExact).reduce((n,l)=>{const e=l.evidence.includedExact as {numerator:string;denominator:string};return {n:n.n*BigInt(e.denominator)+BigInt(e.numerator)*n.d,d:n.d*BigInt(e.denominator)}},rational(0n))
        const available=allowances.get(key)??subtractRational(parseRational(allowance.quantity),used)
        included=available.n<=0n?rational(0n):compareRational(quantity,available)<0?quantity:available;quantity=subtractRational(quantity,included);allowances.set(key,subtractRational(available,included))
      }
      const modeled=price.pricing?metricQuantityPrice(price.pricing,quantity):null
      const amount=modeled?.amountCents??Number(metricLineCents(micros(unit),quantity))
      lines.push({kind:'metric_usage',description:`${window.start<input.period.start?'Late usage: ':''}${price.label} — ${displayQuantity(quantity)} ${price.unitLabel} (${Object.entries(metric.dimensions).map(([k,v])=>`${k}: ${v??'not set'}`).join(', ')||metric.plan.aggregation})`,quantity:displayQuantity(quantity),unitAmount:modeled?'':unit,amountCents:amount,taxable:price.taxable,priceId:price.id,meterId:price.meterId,periodStart:window.start,periodEnd:window.end,evidence:{rule:'exact metric rational × price; one final half-away-from-zero cent rounding',aggregation:metric.plan.aggregation,dimensions:metric.dimensions,exactQuantity:{numerator:String(quantity.n),denominator:String(quantity.d)},rawExactQuantity:{numerator:String(rawQuantity.n),denominator:String(rawQuantity.d)},...(allowance?{includedQuantity:displayQuantity(included),includedExact:{numerator:String(included.n),denominator:String(included.d)},contract:allowance.contract}:{}),eventIds:result.eventIds,contextEventIds:result.contextEventIds,sourceMeter:metric.sourceId,meterVersion:metric.version,metricPlan:metric.plan,activeIntervals:active,...modeled?.evidence}})
      }
    }
  }
  return {lines,exceptions,consumed:[...consumed]}
}
