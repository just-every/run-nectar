import type { Bindings } from '../auth.server'
import { requireBusiness, taxReady } from './business'
import { fingerprint, insist, one } from './core'
import { customerText } from './locale'
import { h } from './ui/html'
import { addDays, periodContaining } from './dates'
import type { Input } from './input'
import { pricesById, ratingInputs } from './inputs'
import { changeBasis } from './portal-change-requests'
import type { CustomerSession } from './portal-session'
import { rate } from './rating'
import { startsInIssuedPeriod } from './subscriptions'

// An estimate is read-only. It never mints approval, an invoice or debit consent.
export async function portalChangePreview(env: Bindings, request: Request, session: CustomerSession, input: Input) {
  insist(request.headers.get('origin')===session.origin,'forbidden',403)
  input.only(['subscription','item','target_price','quantity','basis','policy_revision','confirm'])
  const subscription=input.text('subscription',{max:100}),data=await changeBasis(env,session,subscription)
  insist(input.text('basis',{max:64})===data.basis&&input.integer('policy_revision')===data.policy.revision,'portal_change_stale',409)
  insist(input.text('item',{max:100})===data.item.id,'not_found',404)
  const target=data.allowed.find(p=>p.id===input.text('target_price',{max:100}))
  insist(target,'plan_not_allowed',409)
  const quantity=input.integer('quantity',{min:1,max:1_000_000})!
  insist(target.kind==='seat'?quantity>=data.policy.minimumSeats:quantity===1,'seat_minimum',409)
  insist(target.id!==data.current.id||quantity!==data.item.quantity,'nothing_changes',409)
  const sub=(await one(env,'SELECT * FROM nc_subscriptions WHERE id=?',subscription))!,business=await requireBusiness(env)
  insist(taxReady(business),'tax_review_required',409)
  // Issued advance service keeps its existing governed SUB-002 door. This
  // public estimate is limited to one current unissued monthly arrears item.
  insist(!sub.billing_anchor_date&&!await startsInIssuedPeriod(env,subscription,data.day),'portal_change_requires_review',409)
  insist(!data.sourceData.items.some((item:{from:string})=>item.from>data.day),'portal_change_requires_review',409)
  const period=periodContaining(sub.anchor_day,data.day),beforeInput=await ratingInputs(env,business,subscription,period)
  const targetPrices=await pricesById(env,[target.id])
  const afterInput={...beforeInput,prices:{...beforeInput.prices,...targetPrices},items:[
    ...beforeInput.items.map(item=>item.id===data.item.id?{...item,to:data.day}:item),
    {id:'portal-preview',priceId:target.id,quantity,from:data.day,to:data.item.to},
  ]}
  const before=rate(beforeInput),after=rate(afterInput)
  insist(!before.exceptions.length&&!after.exceptions.length,'portal_change_calculation_blocked',409)
  const amount=(result:ReturnType<typeof rate>)=>({subtotalCents:result.subtotalCents,taxCents:result.taxCents,totalCents:result.totalCents})
  return {subscription,item:data.item.id,targetPrice:target.id,quantity,period,effectiveDate:data.day,
    before:amount(before),after:amount(after),difference:{subtotalCents:after.subtotalCents-before.subtotalCents,taxCents:after.taxCents-before.taxCents,totalCents:after.totalCents-before.totalCents},
    basis:await fingerprint({beforeInput,afterInput,policy:data.policy,source:data.source}),executionAuthority:false,paymentAuthority:false}
}

export function portalChangePreviewPage(session:CustomerSession,quote:Awaited<ReturnType<typeof portalChangePreview>>,back:string) {
  const L=customerText(session.language,session.currency)
  return h`<p><a href="${back}">${L.t('portal.change.heading')}</a></p><h1>${L.t('portal.change.previewHeading')}</h1><section class="card"><p>${L.day(quote.period.start)} – ${L.day(addDays(quote.period.end,-1))}</p><dl>
    <dt>${L.t('portal.change.effective')}</dt><dd>${L.day(quote.effectiveDate)}</dd>
    <dt>${L.t('portal.change.beforeAmount')}</dt><dd>${L.money(quote.before.totalCents)}</dd>
    <dt>${L.t('portal.change.afterAmount')}</dt><dd>${L.money(quote.after.totalCents)}</dd>
    <dt>${L.t('portal.tax')}</dt><dd>${L.money(quote.after.taxCents)}</dd>
    <dt>${L.t('portal.change.difference')}</dt><dd>${L.money(quote.difference.totalCents)}</dd>
  </dl><p>${L.t('portal.change.previewReadOnly')}</p></section>`
}
