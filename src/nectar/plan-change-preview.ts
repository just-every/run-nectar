// Issued annual service is replayed from its immutable source, using the same
// validated interval expansion and rating core as cancellation corrections.
import type { Bindings } from '../auth.server'
import { canonical,fingerprint,insist,one,parseJson,type Row } from './core'
import { rate,rateIntervalService,type RatingInput,type Line } from './rating'
import { expandBillingWindows } from './interval-rating'
import { pricesById } from './inputs'
import { billingPeriodContaining,billingAnchor,dueBillingWindows } from './billing-calendar'
import { BALANCE_SQL } from './receivables'
import { recognitionForLine } from './revenue-allocation'
import { addDays } from './dates'
import { planChangeHistory } from './plan-change-history'

export async function planChangeQuote(env: Bindings, sub: Row, item: Row, target: string, quantity: number, mode: string, date: string, policy: string, newItem: string) {
  const invoice=await one(env,`SELECT i.*,${BALANCE_SQL} AS balance_cents FROM nc_invoices i JOIN nc_billing_components c ON c.invoice_id=i.id WHERE i.subscription_id=? AND i.status='issued' AND c.item_id=? AND c.nominal_start<=? AND c.nominal_end>? ORDER BY c.nominal_start DESC LIMIT 1`,sub.id,item.id,date,date)
  insist(invoice,'issued_advance_period_required',409)
  const saved=parseJson<Row>(invoice.calculation_json,{}),original=saved.inputs as RatingInput
  insist(original?.billing&&original.billing.terms.timing==='advance'&&!original.billing.mixed&&original.billing.components.length===1,'single_advance_component_required',409)
  insist(!original.prepaid&&!original.charges?.length&&!original.contracts&&!original.usageAdjustments?.length&&!original.usageCredits?.length&&!original.renewals?.length&&!original.lifecycle?.length,'plan_change_special_terms_pending',409)
  const expanded=expandBillingWindows(original)[0]
  const {input:current,history,waivedService}=await planChangeHistory(env,invoice,original,expanded,item)
  // A waived price difference is not purchased consideration. Until an exact
  // paid-service basis is approved, it cannot become a later debit or credit.
  insist(!waivedService||mode==='period_end'||policy==='none','plan_change_waived_service_basis_pending',409)
  const old=current.prices[item.price_id],price=(await pricesById(env,[target]))[target]
  insist(old&&price&&['flat','seat'].includes(old.kind)&&price.kind===old.kind&&canonical(old.billing)===canonical(price.billing)&&old.taxable===price.taxable,'plan_change_compatible_price_required',409)
  insist(expanded.items.length===1,'single_advance_component_required',409)
  insist(item.price_id!==target||item.quantity!==quantity,'nothing_changes')
  const period=billingPeriodContaining(billingAnchor(original),old.billing!,date),effective=mode==='period_end'?period.end:date
  insist(effective>item.effective_from&&(!item.effective_to||effective<item.effective_to)&&(!sub.end_date||effective<sub.end_date),'invalid_effective_date')
  const issued=rate(original),before=history.length?rateIntervalService(current):issued
  insist(issued.subtotalCents===invoice.subtotal_cents&&issued.taxCents===invoice.tax_cents&&issued.totalCents===invoice.total_cents,'plan_change_original_mismatch',409)
  const changed:RatingInput={...current,prices:{...current.prices,[target]:price},items:[...current.items.map(i=>i.id===item.id?{...i,to:effective}:i),{id:newItem,priceId:target,quantity,from:effective,to:expanded.items[0].to}],events:[],charges:[],usageCredits:[],usageAdjustments:[]}
  const after=mode==='period_end'?before:rateIntervalService(changed)
  insist(!after.exceptions.length,'plan_change_calculation_blocked',409,after.exceptions)
  const delta={subtotalCents:after.subtotalCents-before.subtotalCents,taxCents:after.taxCents-before.taxCents,totalCents:after.totalCents-before.totalCents}
  const actual=mode==='period_end'||policy==='none'?{subtotalCents:0,taxCents:0,totalCents:0}:delta
  insist([actual.subtotalCents,actual.taxCents,actual.totalCents].every(Number.isSafeInteger)&&Math.sign(actual.subtotalCents)===Math.sign(actual.totalCents)&&actual.subtotalCents*actual.taxCents>=0,'unsupported_plan_change_tax_delta',409)
  const calendar=issued.lines.find(l=>l.priceId===expanded.items[0].priceId)?.evidence.calendar
  const beforeLines=before.lines.map(l=>({...l,evidence:{...l.evidence,...(calendar?{calendar}:{})}}))
  const afterLines=after.lines.map(l=>({...l,evidence:{...l.evidence,...(calendar?{calendar}:{})}}))
  const amounts=new Map<string,number>()
  for(const [lines,sign]of [[beforeLines,-1],[afterLines,1]] as const)for(const [index,line]of lines.entries())for(const e of recognitionForLine(line,original,`plan-change:${sign}:${index}`).entries)amounts.set(e.period,(amounts.get(e.period)??0)+sign*e.amountCents)
  const revenue=[...amounts].filter(([,n])=>n!==0).sort(([a],[b])=>a.localeCompare(b)).map(([period,amountCents])=>({period,amountCents,basis:{method:'issued-advance-plan-before-after',sourceInvoice:invoice.id}}))
  const newItems=[...current.items.map(i=>i.id===item.id?{...i,to:effective}:i),{id:newItem,priceId:target,quantity,from:effective,to:item.effective_to}]
  const windows=mode==='immediate'?dueBillingWindows({...original,items:newItems,prices:{...current.prices,[target]:price}},effective,addDays(effective,1)).filter(w=>w.components.some(c=>c.itemId===newItem)):[]
  const quote={sourceInvoice:invoice.id,sourceFingerprint:invoice.source_fingerprint,sourceBalance:invoice.balance_cents,history,effectiveDate:effective,period,policy,mode,before:{subtotalCents:before.subtotalCents,taxCents:before.taxCents,totalCents:before.totalCents},after:{subtotalCents:after.subtotalCents,taxCents:after.taxCents,totalCents:after.totalCents},delta:actual,waivedDelta:policy==='none'?delta:null,revenue,windows,originalTax:original.tax,targetPrice:price}
  return {...quote,basis:await fingerprint(quote)}
}
export function planChangeLine(change: Row, quote: Row):Line {
  return {kind:'plan_change',description:'Prorated plan change',quantity:'1',unitAmount:'',amountCents:quote.delta.subtotalCents,taxable:quote.targetPrice.taxable,priceId:change.new_price_id,meterId:null,periodStart:quote.effectiveDate,periodEnd:quote.period.end,evidence:{rule:'saved issued-service after minus before; original invoice unchanged',change:change.id,sourceInvoice:quote.sourceInvoice,taxDeltaCents:quote.delta.taxCents,revenueEntries:quote.revenue}}
}
