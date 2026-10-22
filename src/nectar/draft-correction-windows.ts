// Corrections select the same unissued, composed invoice windows as billing.
import type { Bindings } from '../auth.server'
import type { Business } from './business'
import { type Row } from './core'
import { addDays, localDate, periodContaining, periodStartingIn } from './dates'
import { billingAnchor, billingPeriodContaining, dueBillingWindows, intervalBoundary, MONTHLY_ARREARS } from './billing-calendar'
import { billingServiceWindows } from './billing-composition'
import { unissuedBillingWindows } from './billing-components'
import { billingWindowsForMonth, subscriptionCalendar } from './billing-plan'
import { pricesById, ratingInputs } from './inputs'
import type { RatingInput } from './rating'

export interface CorrectionEvent { customerId: string; meterId: string; occurredAt: number }
export function correctionEventInInput(input: RatingInput, event: Pick<CorrectionEvent,'meterId'|'occurredAt'>) {
  if (!input.billing) return true
  const date=localDate(event.occurredAt,input.timezone)
  return billingServiceWindows(input.billing).some(window=>window.terms.timing==='arrears'&&window.components.some(component=>{
    const item=input.items.find(item=>item.id===component.itemId),price=item&&input.prices[item.priceId]
    return price?.kind==='unit'&&(price.metric?.sourceId??price.meterId)===event.meterId&&date>=window.nominalStart&&date<window.nominalEnd
  }))
}
export async function amendmentCorrectionInputs(env:Bindings,business:Business,sub:Row,date:string):Promise<RatingInput[]> {
  const calendar=await subscriptionCalendar(env,sub)
  if(!calendar.enabled){
    const first=periodContaining(sub.anchor_day,date)
    return Promise.all([first,periodContaining(sub.anchor_day,first.end)].map(period=>ratingInputs(env,business,sub.id,period)))
  }
  const anchor=billingAnchor(calendar.basis)
  const ends=calendar.basis.items.filter(item=>(item.to??'9999-12-31')>date).map(item=>{
    const terms=calendar.basis.prices[item.priceId].billing??MONTHLY_ARREARS
    const period=billingPeriodContaining(anchor,terms,item.from>date?item.from:date)
    return intervalBoundary(anchor,terms,period.index+2)
  })
  if(!ends.length)return []
  const to=addDays(ends.sort().at(-1)!,1)
  const windows=(await unissuedBillingWindows(env,sub.id,dueBillingWindows(calendar.basis,date,to))).slice(0,2)
  return Promise.all(windows.map(window=>ratingInputs(env,business,sub.id,window.period,undefined,window)))
}
export async function usageCorrectionInputs(env:Bindings,business:Business,sub:Row,events:CorrectionEvent[],run:Row|null):Promise<RatingInput[]> {
  const calendar=await subscriptionCalendar(env,sub)
  if(!calendar.enabled){
    const latest=localDate(Math.max(...events.map(event=>event.occurredAt)),business.timezone)
    const period=run?periodStartingIn(sub.anchor_day,run.period):periodContaining(sub.anchor_day,latest)
    return [await ratingInputs(env,business,sub.id,period)]
  }
  if(run){
    const windows=await billingWindowsForMonth(env,sub,run.period)
    const inputs=await Promise.all((windows??[]).map(window=>ratingInputs(env,business,sub.id,window.period,undefined,window)))
    return inputs.filter(input=>events.some(event=>correctionEventInInput(input,event)))
  }
  const prices=await pricesById(env,[...new Set(calendar.basis.items.map(item=>item.priceId))]),dates=new Set<string>(),anchor=billingAnchor(calendar.basis)
  for(const event of events){
    const date=localDate(event.occurredAt,business.timezone)
    for(const item of calendar.basis.items){
      const price=prices[item.priceId]
      if(price.kind!=='unit'||(price.metric?.sourceId??price.meterId)!==event.meterId||item.from>date||(item.to??'9999-12-31')<=date)continue
      const nominal=billingPeriodContaining(anchor,price.billing??MONTHLY_ARREARS,date)
      dates.add([nominal.end,calendar.basis.subscription.endDate??nominal.end,calendar.basis.subscription.contractEndDate??nominal.end].sort()[0])
    }
  }
  const selected=new Map<string,RatingInput>()
  for(const due of [...dates].sort()){
    const windows=await unissuedBillingWindows(env,sub.id,dueBillingWindows(calendar.basis,due,addDays(due,1)))
    for(const window of windows){
      const input=await ratingInputs(env,business,sub.id,window.period,undefined,window)
      if(events.some(event=>correctionEventInInput(input,event)))selected.set(window.key,input)
    }
  }
  return [...selected.values()]
}
