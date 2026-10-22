// A lower-priority unit grant cannot redeem consideration already covered by
// a higher-priority dollar grant. Retain the native tier/package operands,
// including legitimate volume-price discontinuities, at unit microprecision.
import { micros, roundHalfAway } from './decimal'
import { metricQuantityPrice } from './metric-pricing'
import { parseRational, rational, subtractRational, type Rational } from './metric-plan'
import type { QuantityPrice } from './price-model'
export function prepaidUnitCharge(pricing:QuantityPrice|undefined,unitAmount:string,quantity:Rational) {
  return pricing ? metricQuantityPrice(pricing,quantity).amountCents : Number(roundHalfAway(micros(unitAmount)*quantity.n*100n,1000000n*quantity.d))
}
export function prepaidUnitLimit(pricing:QuantityPrice|undefined,unitAmount:string,quantity:Rational,maxN:number,fundedCents:number) {
  const covered=(n:number)=>{
    const remaining=subtractRational(quantity,rational(BigInt(n),1000000n))
    if(pricing){const exact=metricQuantityPrice(pricing,remaining).evidence.exactDollars;return BigInt(exact.numerator)*100n>=BigInt(fundedCents)*BigInt(exact.denominator)}
    return micros(unitAmount)*remaining.n*100n>=BigInt(fundedCents)*1000000n*remaining.d
  }
  if(!fundedCents||covered(maxN))return maxN
  const starts=new Set([0])
  // Within each tier the price is nondecreasing with quantity. Splitting at
  // exact rational boundaries makes binary search valid even for discounted
  // volume tiers and nonmonotone stair-step prices.
  for(const tier of pricing?.tiers??[])if(tier.upTo!==null){
    const difference=subtractRational(quantity,parseRational(tier.upTo))
    if(difference.n<=0n)continue
    const threshold=Number((difference.n*1000000n+difference.d-1n)/difference.d)
    if(threshold>0&&threshold<=maxN)starts.add(threshold)
  }
  const bounds=[...starts].sort((a,b)=>a-b), candidates=[0]
  for(const [index,start] of bounds.entries()){
    let lower=start,upper=index+1<bounds.length?bounds[index+1]-1:maxN
    if(!covered(lower))continue
    while(lower<upper){const middle=lower+Math.ceil((upper-lower)/2);if(covered(middle))lower=middle;else upper=middle-1}
    candidates.push(lower)
  }
  return Math.max(...candidates)
}
