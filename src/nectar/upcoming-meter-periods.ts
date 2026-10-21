// A mixed invoice has one due date and several real service periods. Usage
// projections retain the period of their metered component, never its envelope.
import type { RatingInput } from './rating'
import { billingServiceWindows } from './billing-composition'
export function upcomingMeterPeriod(input: RatingInput, meter: string) {
  if (!input.billing) return input.period
  const periods=billingServiceWindows(input.billing).filter(window=>window.components.some(component=>{
    const item=input.items.find(item=>item.id===component.itemId)
    return item&&input.prices[item.priceId]?.kind==='unit'&&input.prices[item.priceId]?.meterId===meter
  })).map(window=>window.period)
  return periods.length?{start:periods.map(period=>period.start).sort()[0],end:periods.map(period=>period.end).sort().at(-1)!}:null
}
