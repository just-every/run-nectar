// Public billing doors share one calendar and the same immutable component keys.
import type { Bindings } from '../auth.server'
import { all, insist, one, parseJson, type Row } from './core'
import { addDays, addMonths } from './dates'
import { dueBillingWindows, nonMonthlyArrears, storedBillingTerms, type BillingWindow, type CalendarBasis } from './billing-calendar'
import { unissuedBillingWindows } from './billing-components'

export async function subscriptionCalendar(env:Bindings,sub:Row) {
  const items=await all(env,`SELECT i.id,i.price_id,i.effective_from,i.effective_to,p.kind,b.interval_unit,b.interval_count,b.billing_timing
    FROM nc_items i JOIN nc_prices p ON p.id=i.price_id LEFT JOIN nc_price_intervals b ON b.price_id=p.id WHERE i.subscription_id=? ORDER BY i.id`,sub.id)
  const renewal=await one(env,"SELECT end_date,auto_renew,cancelled_at FROM nc_renewal_terms WHERE subscription_id=? AND status='active' ORDER BY created_at DESC LIMIT 1",sub.id)
  const renewing=renewal?.auto_renew&&!renewal.cancelled_at
  const basis:CalendarBasis={subscription:{anchorDay:sub.anchor_day,startDate:sub.start_date,trialEnd:sub.trial_end,endDate:renewing?null:sub.end_date,billFrom:sub.cutover_start,
    billingAnchorDate:sub.billing_anchor_date,contractEndDate:renewing?null:renewal?.end_date??sub.contract_end_date},
    items:items.map(row=>({id:row.id,priceId:row.price_id,from:row.effective_from,to:row.effective_to})),
    prices:Object.fromEntries(items.map(row=>[row.price_id,{kind:row.kind,billing:storedBillingTerms(row)}]))}
  return {basis,enabled:!!sub.billing_anchor_date||Object.values(basis.prices).some(price=>price.billing&&nonMonthlyArrears(price.billing))}
}
export async function billingWindowsForMonth(env:Bindings,sub:Row,month:string) {
  const calendar=await subscriptionCalendar(env,sub)
  if(!calendar.enabled)return null
  return unissuedBillingWindows(env,sub.id,dueBillingWindows(calendar.basis,`${month}-01`,addMonths(`${month}-01`,1)))
}
/** Reconstruct the approved component selection from current records. A removed
 * or shortened component refuses; prices/quantities/terms are re-read by rated. */
export async function currentBillingWindow(env:Bindings,invoice:Row):Promise<BillingWindow|undefined> {
  const saved=parseJson<Row>(invoice.calculation_json,{}).inputs?.billing as BillingWindow|undefined
  if(!saved)return undefined
  const sub=await one(env,'SELECT * FROM nc_subscriptions WHERE id=?',invoice.subscription_id)
  insist(sub,'subscription_not_found',404)
  const {basis}=await subscriptionCalendar(env,sub)
  const match=dueBillingWindows(basis,saved.dueDate,addDays(saved.dueDate,1)).find(window=>window.key===saved.key)
  insist(match&&saved.components.every(component=>match.components.some(current=>current.key===component.key&&current.from===component.from&&current.to===component.to)),'billing_window_changed',409)
  const components=match.components.filter(component=>saved.components.some(prior=>prior.key===component.key))
  return {...match,components,period:{start:components.map(c=>c.from).sort()[0],end:components.map(c=>c.to).sort().at(-1)!}}
}
