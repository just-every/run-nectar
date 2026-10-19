import type { Bindings } from '../auth.server'
import { all, fingerprint, insist, one, parseJson, type Row } from './core'
import { business } from './business'
import { addMonths, localDate, periodContaining } from './dates'
import { clockInstant } from './clock'
import { ratingInputs,pricesById } from './inputs'
import { rate } from './rating'
import { retentionPolicy } from './retention-policy'
export async function retentionTerms(env:Bindings,subscription:string,kind:'save'|'winback',fromDate?:string) {
  const policy=await retentionPolicy(env),sub=await one(env,'SELECT * FROM nc_subscriptions WHERE id=?',subscription),b=(await business(env))!
  insist(sub,'subscription_not_found',404)
  const day=localDate(clockInstant(env),b.timezone),from=fromDate??periodContaining(sub.anchor_day,day).start
  const settings=kind==='save'?{kind:policy.save_kind,percent:policy.save_percent,months:policy.save_months,pauseMonths:policy.pause_months,target:policy.downgrade_price_id,source:policy.downgrade_source_price_id}:{kind:'discount',percent:policy.winback_percent,months:policy.winback_months,pauseMonths:0,target:'',source:''}
  const items=await all(env,'SELECT i.*,p.kind,p.meter_id,p.dimensions_json,p.revision AS price_revision,p.status AS price_status FROM nc_items i JOIN nc_prices p ON p.id=i.price_id WHERE i.subscription_id=? ORDER BY i.id',sub.id)
  const amendments=await all(env,"SELECT * FROM nc_amendments WHERE subscription_id=? AND status='approved' ORDER BY id",sub.id)
  const to=settings.kind==='downgrade'?null:addMonths(from,settings.kind==='pause'?settings.pauseMonths:settings.months)
  if(settings.kind==='discount')insist(!amendments.some(a=>a.kind==='discount_percent'&&a.effective_from<to!&&(a.effective_to??'9999')>from),'discount_already_applies',409)
  const term=await one(env,"SELECT id,revision,start_date,end_date,auto_renew,cancelled_at FROM nc_renewal_terms WHERE subscription_id=? AND status='active'",sub.id)
  let target:Row|null=null,selected:Row[]=[],previewBasis:Row|null=null
  if(settings.kind==='downgrade') {
    target=await one(env,"SELECT p.*,pr.name AS product_name FROM nc_prices p JOIN nc_products pr ON pr.id=p.product_id WHERE p.id=? AND p.status='active'",settings.target);insist(target,'downgrade_price_unavailable',409)
    selected=items.filter(i=>i.price_id===settings.source&&i.kind===target!.kind&&i.meter_id===target!.meter_id&&i.dimensions_json===target!.dimensions_json&&i.effective_from<=from&&(i.effective_to??'9999')>from)
    insist(selected.length,'downgrade_not_compatible',409)
    const before=await ratingInputs(env,b,sub.id,{start:from,end:addMonths(from,1)})
    const prices=await pricesById(env,[target.id])
    const after={...before,version:'nectar-rating-8',items:before.items.map(i=>selected.some(s=>s.id===i.id)?{...i,priceId:target!.id}:i),prices:{...before.prices,...prices}}
    previewBasis={before,after}
    insist(rate(after).totalCents<=rate(before).totalCents,'downgrade_must_not_increase_charges',409)
  }
  const targetLabel=target?`${target.product_name} v${target.version}: ${target.pricing_model==='simple'?`USD ${target.unit_amount}${target.kind==='seat'?' per seat per month':target.kind==='unit'?' per usage unit':' monthly'}`:`${target.pricing_model}${target.package_size?` in blocks of ${target.package_size}`:''}; ${parseJson<Row[]>(target.tiers_json,[]).map(t=>`through ${t.upTo??'unlimited'} units: USD ${t.unitAmount} per ${target!.pricing_model==='package'?'block':'unit'} + USD ${t.flatAmount} band fee`).join('; ')}`}`:null
  return {policyId:policy.id,subscription,sourceRevision:sub.revision,from,to,...settings,termId:term?.id??null,selectedItems:selected.map(i=>({id:i.id,from:i.effective_from,to:i.effective_to,quantity:i.quantity})),targetLabel,targetRevision:target?.revision??null,
    basis:await fingerprint({policy:policy.revision,sub,items,amendments,term,target,from,to,settings,previewBasis})}
}
