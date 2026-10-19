// USE-006: a live, write-free view of the exact next calculation.
import type { Bindings } from '../auth.server'
import { requireCapability, type Actor } from './actor'
import { requireBusiness } from './business'
import { draftFor, invoiceDetail } from './billruns'
import { all, insist, now, one, type Row } from './core'
import { isMonth, periodContaining, periodStartingIn, today, zonedStart } from './dates'
import { cents, decimalText, micros } from './decimal'
import type { RatingInput } from './rating'
import { requireSubscription } from './subscriptions'

export async function upcoming(env: Bindings, actor: Actor, subscriptionId: string, month?: string | null) {
  requireCapability(actor, 'read')
  const business = await requireBusiness(env)
  const sub = await requireSubscription(env, subscriptionId)
  insist(month === undefined || month === null || isMonth(month), 'invalid_period')
  const period = month ? periodStartingIn(sub.anchor_day,month) : periodContaining(sub.anchor_day,today(business.timezone))
  insist(sub.start_date < period.end && (!sub.end_date || sub.end_date > period.start), 'subscription_not_in_period', 409)
  insist(!sub.cutover_start || period.end > sub.cutover_start, 'previous_biller_period', 409)
  const issued = await one(env, "SELECT id FROM nc_invoices WHERE subscription_id=? AND invoice_kind='recurring' AND period_start=? AND status='issued'",sub.id,period.start)
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
    const draft=await draftFor(env,business,{...sub,billing_email:customer?.billing_email},period)
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
    generatedAt,state,invoiceId,meters,credits:credits.map(c=>({...c,amountCents:cents(c.value),appliesThisPeriod:c.effective_from>=period.start && c.effective_from<period.end})),
    remainingContractCreditCents:credits.reduce((sum,c)=>sum+cents(c.value),0),calculation}
}
