import { insist } from './core'
import { roundHalfAway } from './decimal'
import type { QuantityPrice } from './price-model'
import { addRational,compareRational,divideRational,multiplyRational,parseRational,rational,subtractRational,type Rational } from './metric-plan'
const saved=(v:Rational)=>({numerator:String(v.n),denominator:String(v.d)})
/** Rational quantities keep time weighting exact through all existing models. */
export function metricQuantityPrice(pricing:QuantityPrice,quantity:Rational) {
  insist(quantity.n>=0n,'negative_metric_quantity')
  let dollars=rational(0n);const tiers:Record<string,unknown>[]=[]
  const charge=(index:number,units:Rational,blocks?:bigint)=>{
    const t=pricing.tiers[index],cost=addRational(multiplyRational(units,parseRational(t.unitAmount)),parseRational(t.flatAmount));dollars=addRational(dollars,cost)
    tiers.push({tier:index+1,quantity:saved(units),unitAmount:t.unitAmount,flatAmount:t.flatAmount,amount:saved(cost),...(blocks===undefined?{}:{blocks:String(blocks)})})
  }
  if(quantity.n>0n) {
    if(pricing.model==='package') {const blocks=divideRational(quantity,parseRational(pricing.packageSize!)),count=(blocks.n+blocks.d-1n)/blocks.d;charge(0,rational(count),count)}
    else if(pricing.model==='volume'||pricing.model==='stair_step') {const index=pricing.tiers.findIndex(t=>t.upTo===null||compareRational(quantity,parseRational(t.upTo))<=0);charge(index,pricing.model==='volume'?quantity:rational(0n))}
    else {let lower=rational(0n);for(const [index,t] of pricing.tiers.entries()){const upper=t.upTo===null||compareRational(quantity,parseRational(t.upTo))<0?quantity:parseRational(t.upTo);if(compareRational(upper,lower)>0)charge(index,subtractRational(upper,lower));if(t.upTo===null||compareRational(quantity,parseRational(t.upTo))<=0)break;lower=parseRational(t.upTo)}}
  }
  return {amountCents:Number(roundHalfAway(dollars.n*100n,dollars.d)),evidence:{metricPricingModel:pricing.model,metricPricingTiers:tiers,exactDollars:saved(dollars)}}
}
