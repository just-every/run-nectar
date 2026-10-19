// Renewal uplifts are dated operands, never edits to catalogue or issued prices.
import type { RatingInput, PriceIn } from './rating'
import { decimalText, micros, roundHalfAway } from './decimal'
import type { Row } from './core'
export interface RenewalRate { id:string; effectiveDate:string; upliftPercent:string }
export const RENEWAL_RATING_VERSION='nectar-rating-8'
export function upliftAmount(amount:string,rates:RenewalRate[]) {
  return decimalText(rates.reduce((value,r)=>roundHalfAway(value*(100_000_000n+micros(r.upliftPercent)),100_000_000n),micros(amount)))
}
export function renewalOperands(input:RatingInput) {
  const events=input.renewals!,prices:Record<string,PriceIn>={},aliases=new Map<string,string>(),applied=new Map<string,RenewalRate[]>(),amendments:RatingInput['amendments']=[],included:Row[]=[]
  const items:RatingInput['items']=[]
  for(const item of input.items) {
    const original=input.prices[item.priceId];if(!original)continue
    const cuts=[item.from,...events.map(r=>r.effectiveDate).filter(d=>d>item.from&&d<(item.to??'9999-12-31')),item.to??'9999-12-31'].sort()
    for(let n=0;n<cuts.length-1;n++) {
      const from=cuts[n],to=cuts[n+1],rates=events.filter(r=>r.effectiveDate>=item.from&&r.effectiveDate<=from),key=`${original.id}@${from}`
      const change=(v:string)=>upliftAmount(v,rates)
      prices[key]={...original,id:key,unitAmount:change(original.unitAmount),...(original.pricing?{pricing:{...original.pricing,tiers:original.pricing.tiers.map(t=>({...t,unitAmount:change(t.unitAmount),flatAmount:change(t.flatAmount)}))}}:{})}
      aliases.set(key,original.id);applied.set(key,rates);items.push({...item,priceId:key,from,to:to==='9999-12-31'?null:to})
      for(const a of input.amendments.filter(a=>a.kind==='price_override'&&a.priceId===original.id&&a.from<to&&(a.to??'9999-12-31')>from))amendments.push({...a,priceId:key,value:change(a.value),from:a.from>from?a.from:from,to:(a.to??'9999-12-31')<to?a.to:to})
      for(const a of input.contracts?.included??[])if(a.price===original.id)included.push({...a,price:key})
    }
  }
  amendments.push(...input.amendments.filter(a=>a.kind!=='price_override'))
  const transformed:RatingInput={...input,renewals:undefined,prices,items,amendments,...(input.contracts?{contracts:{...input.contracts,included:included as never,invoices:input.contracts.invoices.map(invoice=>({...invoice,lines:invoice.lines.map(line=>{const item=items.find(i=>aliases.get(i.priceId)===line.priceId&&i.from<=line.periodStart&&(i.to??'9999')>line.periodStart);return item?{...line,priceId:item.priceId}:line})}))}}:{})}
  return {input:transformed,restore:(line:import('./rating').Line)=>{const rates=(line.priceId?applied.get(line.priceId)??[]:[]).filter(r=>r.effectiveDate<=line.periodStart);return {...line,priceId:line.priceId?aliases.get(line.priceId)??line.priceId:null,...(line.priceId&&rates.length?{evidence:{...line.evidence,renewals:rates}}:{})}}}
}
