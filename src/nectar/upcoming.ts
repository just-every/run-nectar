import { subscriptionCalendar } from './billing-plan'
import { dueBillingWindows,type BillingWindow } from './billing-calendar'
import { addMonths } from './dates'
import { clockInstant } from './clock'
import { carriedUsageCredits,usageCreditAllocations } from './usage-correction-records'
// USE-006: a live, write-free view of the exact next calculation.
import type { Bindings } from '../auth.server'
import { requireRead, type Actor } from './actor'
import { requireBusiness } from './business'
import { draftFor, invoiceDetail } from './billruns'
import { all, insist, now, one, type Row } from './core'
import { isMonth, periodContaining, periodStartingIn, today, zonedStart } from './dates'
import { cents, decimalText, micros } from './decimal'
import { addRational,rational,type Rational } from './metric-plan'
import { displayQuantity } from './metric-aggregate'
import type { RatingInput } from './rating'
import { requireSubscription } from './subscriptions'

async function upcomingOne(env: Bindings, actor: Actor, subscriptionId: string, month?: string | null,window?:BillingWindow) {
  requireRead(actor, 'subscriptions')
  const business = await requireBusiness(env)
  const sub = await requireSubscription(env, subscriptionId)
  insist(month === undefined || month === null || isMonth(month), 'invalid_period')
  const period = window?.period??(month ? periodStartingIn(sub.anchor_day,month) : periodContaining(sub.anchor_day,today(business.timezone,clockInstant(env))))
  insist(sub.start_date < period.end && (!sub.end_date || sub.end_date > period.start), 'subscription_not_in_period', 409)
  insist(!sub.cutover_start || period.end > sub.cutover_start, 'previous_biller_period', 409)
  const issued = await one(env, "SELECT id FROM nc_invoices WHERE subscription_id=? AND invoice_kind='recurring' AND period_start=? AND status='issued' AND billing_key=?",sub.id,period.start,window?.key??'legacy-monthly-arrears')
  const generatedAt = now()
  let calculation: Row, state: string, invoiceId: string | null = null
  if (issued) {
    const invoice = await invoiceDetail(env,actor,issued.id)
    calculation = { inputs:invoice.calculation.inputs, fingerprint:invoice.source_fingerprint,
      version:invoice.calc_version, tax:invoice.calculation.tax, consumedEvents:invoice.calculation.consumedEvents,
      lines:(invoice.lines as Row[]).map(l=>({kind:l.kind,description:l.description,quantity:l.quantity,unitAmount:l.unit_amount,amountCents:l.amount_cents,
        taxable:!!l.taxable,priceId:l.price_id,meterId:l.meter_id,periodStart:l.period_start,periodEnd:l.period_end,evidence:l.evidence})),
      subtotalCents:invoice.subtotal_cents,taxCents:invoice.tax_cents,totalCents:invoice.total_cents,
      exceptions:invoice.exceptions }
    state='issued';invoiceId=invoice.id
  } else {
    const customer=await one(env,'SELECT billing_email FROM nc_customers WHERE id=?',sub.customer_id)
    const draft=await draftFor(env,business,{...sub,billing_email:customer?.billing_email},period,window)
    calculation={inputs:draft.input,fingerprint:draft.fingerprint,version:(draft.input as RatingInput).version,
      ...draft.rating,exceptions:draft.exceptions}
    state=sub.billing_mode==='shadow' ? 'shadow' : 'preview'
  }
  const input=calculation.inputs as RatingInput
  const from=zonedStart(period.start,business.timezone),to=zonedStart(period.end,business.timezone)
  const meterIds=[...new Set(Object.values(input.prices).flatMap(p=>p.meterId ? [p.meterId] : []))]
  const meters: Row[]=[]
  for(const id of meterIds){
    const meter=await one(env,'SELECT id,code,name,unit_label FROM nc_meters WHERE id=?',id)
    const metrics=Object.values(input.prices).filter(p=>p.meterId===id&&p.metric)
    if(metrics.length){for(const p of metrics){const own=(calculation.lines as Row[]).filter(l=>l.priceId===p.id&&l.kind==='metric_usage'),current=own.filter(l=>l.periodStart===period.start),late=own.filter(l=>l.periodStart<period.start);const quantity=(rows:Row[])=>displayQuantity(rows.reduce<Rational>((n,l)=>{const exact=l.evidence.rawExactQuantity;return addRational(n,rational(BigInt(exact.numerator),BigInt(exact.denominator)))},rational(0n)));const eventIds=[...new Set(current.flatMap(l=>l.evidence.eventIds as string[]))];meters.push({...meter,dimensions:p.metric!.dimensions,quantity:quantity(current),events:eventIds.length,eventIds,lateQuantity:quantity(late),lateEventIds:[...new Set(late.flatMap(l=>l.evidence.eventIds as string[]))]})}continue}
    const events=input.events.filter(e=>e.meterId===id && e.occurredAt>=from && e.occurredAt<to)
    const late=input.events.filter(e=>e.meterId===id && e.occurredAt<from)
    meters.push({...meter,quantity:decimalText(events.reduce((sum,e)=>sum+micros(e.quantity,'quantity'),0n)),events:events.length,
      eventIds:events.map(e=>e.eventId),lateQuantity:decimalText(late.reduce((sum,e)=>sum+micros(e.quantity,'quantity'),0n)),lateEventIds:late.map(e=>e.eventId)})
  }
  const credits=await all<Row & {id:string;value:string;note:string;effective_from:string;effective_to:string|null}>(env, `SELECT a.id,a.value,a.effective_from,a.effective_to,a.note FROM nc_amendments a
    WHERE a.subscription_id=? AND a.status='approved' AND a.kind='fixed_credit'
      AND NOT EXISTS(SELECT 1 FROM nc_invoice_lines l JOIN nc_invoices i ON i.id=l.invoice_id
        WHERE i.subscription_id=a.subscription_id AND i.status='issued' AND l.kind='credit' AND json_extract(l.evidence_json,'$.amendment')=a.id)
    ORDER BY a.effective_from,a.id`,sub.id)
  return {subscription:sub.id,customer:sub.customer_id,customerName:sub.customer_name,period,timezone:business.timezone,
    generatedAt,state,invoiceId,billingDueDate:window?.dueDate??period.end,billingWindow:window??null,meters,credits:credits.map(c=>({...c,amountCents:cents(c.value),appliesThisPeriod:c.effective_from>=period.start && c.effective_from<period.end})),
    carriedUsageCredits:await carriedUsageCredits(env,sub.customer_id),
    creditApplications:usageCreditAllocations(input.usageCredits??[],calculation.totalCents),
    balanceAfterCreditsCents:calculation.totalCents-usageCreditAllocations(input.usageCredits??[],calculation.totalCents).reduce((n,a)=>n+a.amountCents,0),
    remainingContractCreditCents:credits.reduce((sum,c)=>sum+cents(c.value),0),calculation}
}

/** Every component due in the selected month is visible; mixed intervals never
 * collapse into a fictitious single monthly invoice. */
export async function upcoming(env:Bindings,actor:Actor,subscriptionId:string,month?:string|null) {
  requireRead(actor,'subscriptions')
  insist(month===undefined||month===null||isMonth(month),'invalid_period')
  const sub=await requireSubscription(env,subscriptionId),calendar=await subscriptionCalendar(env,sub)
  if(!calendar.enabled)return upcomingOne(env,actor,subscriptionId,month)
  const business=await requireBusiness(env),selected=month??today(business.timezone,clockInstant(env)).slice(0,7),from=`${selected}-01`
  const windows=dueBillingWindows(calendar.basis,from,addMonths(from,1))
  insist(windows.length,'billing_window_not_due',409)
  const invoices=await Promise.all(windows.map(window=>upcomingOne(env,actor,subscriptionId,selected,window)))
  return {...invoices[0],invoices}
}
