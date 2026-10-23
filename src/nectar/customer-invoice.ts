// A customer projection never includes raw events, private notes or rating inputs.
import { parseJson, type Row } from './core'
import type { CustomerText } from './locale'
import { invoiceBranding } from './invoice-branding'

export function customerInvoiceContent(calculation: string) {
  const saved=parseJson<Row>(calculation,{}).inputs?.invoiceContent??{}
  return {paymentTermsDays:saved.paymentTermsDays??null,poNumber:saved.poNumber??'',memo:saved.memo??'',customFields:saved.customFields??{},
    hideUsageDetail:!!saved.hideUsageDetail,branding:invoiceBranding(saved.branding??{})}
}
export function customerInvoiceLines(lines: Row[], hide: boolean, prices: Record<string,Row>={}) {
  if(!hide)return lines.map(line=>{
    const evidence=parseJson<Row>(line.evidence_json,{})
    return {description:line.description,quantity:line.quantity,unit_amount:line.unit_amount,amount_cents:line.amount_cents,period_start:line.period_start,period_end:line.period_end,
      days:evidence.days,periodDays:evidence.periodDays,amountExact:evidence.amountExact,
      tiers:(Array.isArray(evidence.tiers)?evidence.tiers:[]).map((tier:Row)=>({tier:tier.tier,quantity:tier.quantity,unitAmount:tier.unitAmount,flatAmount:tier.flatAmount,amountExact:tier.amountExact}))}
  })
  const result:Row[]=[],groups=new Map<string,Row>()
  for(const line of lines){
    if(!line.meter_id||!line.price_id){result.push({description:line.description,amount_cents:line.amount_cents});continue}
    let grouped=groups.get(line.price_id)
    if(!grouped){grouped={description:prices[line.price_id]?.label||line.description,amount_cents:0};groups.set(line.price_id,grouped);result.push(grouped)}
    grouped.amount_cents+=line.amount_cents
  }
  return result
}

export function customerLineFacts(line: Row, L: CustomerText, currency='USD'): string[] {
  if(line.quantity===undefined)return []
  const facts=[`${L.t('invoice.quantity')}: ${line.quantity}`]
  if(line.unit_amount)facts.push(`${L.t('invoice.unit')}: ${L.amount(line.unit_amount,currency)}`)
  if(line.days!==undefined&&line.periodDays!==undefined)facts.push(L.t('invoice.days',{days:line.days,total:line.periodDays}))
  for(const tier of line.tiers??[])facts.push(`${L.t('invoice.tier')} ${tier.tier}: ${L.t('invoice.quantity')} ${tier.quantity}; ${L.t('invoice.unit')} ${L.amount(tier.unitAmount,currency)}; ${L.t('invoice.fee')} ${L.amount(tier.flatAmount,currency)}; ${L.t('invoice.exact')} ${currency} ${tier.amountExact}`)
  if(line.amountExact)facts.push(`${L.t('invoice.exact')}: ${currency} ${line.amountExact}`)
  return facts
}
