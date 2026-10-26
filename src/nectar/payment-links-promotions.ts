// Reuse native coupon application without granting the public caller any
// member action. This identity labels only the existing statement composer.
import type { Bindings } from '../auth.server'
import type { Actor } from './actor'
import { canonical, guard, insist, one, parseJson, type Row } from './core'
import { clockInstant } from './clock'
import { today } from './dates'
import { promotionRedemption } from './promotions'
import type { LinkItem } from './payment-links'

const fields=['id','coupon_id','code','coupon_name','kind','value','duration','months','products_json','expires_on','max_redemptions','first_time_only','status','coupon_status'] as const
const projection=`c.id,c.coupon_id,c.code,k.name AS coupon_name,k.kind,k.value,k.duration,k.months,k.products_json,c.expires_on,c.max_redemptions,c.first_time_only,c.status,k.status AS coupon_status`
export async function paymentLinkPromotion(env:Bindings,code:string,items:LinkItem[],timezone:string) {
  if(!code)return null
  const row=await one(env,`SELECT ${projection} FROM nc_promotion_codes c JOIN nc_coupons k ON k.id=c.coupon_id WHERE c.code=? COLLATE NOCASE`,code)
  insist(row&&row.status==='active'&&row.coupon_status==='active','promotion_code_not_found',404)
  insist(!row.expires_on||row.expires_on>=today(timezone,clockInstant(env)),'promotion_expired',409)
  const products=parseJson<string[]>(row.products_json,[])
  insist(items.some(item=>!products.length||products.includes(item.product)),'promotion_not_applicable',409)
  const count=await one(env,'SELECT COUNT(*) AS n FROM nc_promotion_redemptions WHERE code_id=?',row.id)
  insist(row.max_redemptions===null||count!.n<row.max_redemptions,'promotion_exhausted',409)
  return Object.fromEntries(fields.map(key=>[key,row[key]]))
}
export function paymentLinkPromotionGuard(env:Bindings,saved:Row) {
  const expressions=fields.map(key=>{
    const column=key==='coupon_name'?'k.name':key==='coupon_status'?'k.status':['kind','value','duration','months','products_json'].includes(key)?`k.${key}`:`c.${key}`
    return `${column} IS ?`
  })
  return guard(env,'payment_link_terms_changed',`EXISTS(SELECT 1 FROM nc_promotion_codes c JOIN nc_coupons k ON k.id=c.coupon_id WHERE ${expressions.join(' AND ')})`,...fields.map(key=>saved[key]))
}
export async function paymentLinkPromotionStatements(env:Bindings,saved:Row|null,attempt:Row,customer:string,subscription:string,items:LinkItem[]) {
  if(!saved)return []
  const actor:Actor={id:`payment-link:${attempt.id}`,kind:'agent',name:`payment-link:${attempt.id}`,email:'',role:null,sessionId:null,capabilities:new Set()}
  const redemption=await promotionRedemption(env,actor,{text:saved.code,customer:{id:customer},subscription,start:attempt.start_date,trialEnd:attempt.trial_end,
    items:items.map(item=>({price:{id:item.price,product_id:item.product,kind:'flat'}}))})
  insist(canonical(Object.fromEntries(fields.map(key=>[key,redemption.code[key]])))===canonical(saved),'payment_link_terms_changed',409)
  return [paymentLinkPromotionGuard(env,saved),...redemption.statements]
}
