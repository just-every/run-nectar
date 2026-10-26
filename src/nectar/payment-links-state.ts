import type { Bindings } from '../auth.server'
import { canRead, type Actor } from './actor'
import { clockInstant } from './clock'
import { all, canonical, commit, fingerprint, guard, insist, newId, one, parseJson, sha256Hex, stmt, type Row } from './core'
import { addDays,addMonthsClamped, today } from './dates'
import { customerText, languageInput } from './locale'
import { activeLinkGuard, currentLinkTerms, linkOwnerGuard, linkTermsGuards, type LinkTerms } from './payment-links'
import type { Input } from './input'

export async function paymentLinkOffer(env: Bindings, link: Row, language: string) {
  const terms=await currentLinkTerms(env,link),L=customerText(languageInput(language)),start=today(terms.timezone,clockInstant(env))
  const trialEnd=terms.trialDays?addDays(start,terms.trialDays):null
  const termEnd=terms.renewal?addMonthsClamped(start,terms.renewal.months):null
  insist(!trialEnd||!!termEnd&&trialEnd<termEnd,'invalid_trial_end',409)
  const oneTime=terms.kind==='one_time'
  const wording={merchant:terms.merchant,kind:terms.kind,oneTime:terms.oneTime,terms:L.t(oneTime?'paymentLink.oneTime.terms':'paymentLink.terms'),save:L.t(oneTime?'paymentLink.oneTime.pay':'paymentLink.save'),default:L.t('paymentLink.default'),
    noDebit:L.t(oneTime?'paymentLink.oneTime.noRecurring':'paymentLink.noDebit'),currency:terms.currency,monthlyTotal:terms.totalCents,start,trialEnd,
    items:terms.items.map(item=>({price:item.price,quantity:item.quantity,unitAmount:item.unitAmount,taxable:item.taxable,timing:item.timing})),tax:terms.tax,promotion:terms.promotion,renewal:terms.renewal,termEnd,language:L.tag,link:link.id,basis:link.basis_hash}
  return {terms,start,trialEnd,termEnd,language:L.tag,wording,hash:await fingerprint(wording)}
}
export function attemptCookie(id: string, token: string, secure: boolean) {
  return `nectar_payment_link=${token}; Path=/pay-links/attempts/${id}; HttpOnly; SameSite=Lax; Max-Age=86400${secure?'; Secure':''}`
}
export const newPaymentLinkToken=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),byte=>byte.toString(16).padStart(2,'0')).join('')
export async function paymentLinkAttempt(env: Bindings, request: Request, id: string) {
  const token=request.headers.get('cookie')?.split(';').map(value=>value.trim()).find(value=>value.startsWith('nectar_payment_link='))?.slice('nectar_payment_link='.length)
  insist(token&&/^[a-f0-9]{64}$/.test(token),'payment_link_return_required',401)
  const row=await one(env,`SELECT a.* FROM nc_payment_link_attempts a LEFT JOIN nc_customers c ON c.id=a.customer_id
    WHERE a.id=? AND a.token_hash=? AND a.expires_at>? AND (a.customer_id IS NULL OR (c.erased_at IS NULL AND c.status='active'))
    AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN (a.id,a.customer_id,a.subscription_id))`,id,await sha256Hex(token),clockInstant(env))
  insist(row,'payment_link_return_required',401)
  return row
}
export function attemptGuard(env: Bindings, row: Row) {
  return guard(env,'payment_link_state_changed',`EXISTS(SELECT 1 FROM nc_payment_link_attempts a LEFT JOIN nc_customers c ON c.id=a.customer_id
    WHERE a.id=? AND a.revision=? AND a.status=? AND a.token_hash=? AND a.expires_at>?
    AND (a.customer_id IS NULL OR (c.erased_at IS NULL AND c.status='active'))
    AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(a.id,a.customer_id,a.subscription_id)))`,row.id,row.revision,row.status,row.token_hash,clockInstant(env))
}
export async function beginPaymentLink(env: Bindings, link: Row, input: Input) {
  input.only(['name','billing_email','address','language','offer_hash','attempt_token','confirm','make_default'])
  insist(input.flag('confirm'),'payment_link_confirmation_required')
  const offer=await paymentLinkOffer(env,link,input.text('language',{max:35,optional:true}))
  insist(input.text('offer_hash',{max:100})===offer.hash,'payment_link_terms_changed',409)
  const name=input.text('name',{max:160}),email=input.text('billing_email',{max:200}).toLowerCase(),address=input.text('address',{max:400})
  insist(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),'invalid_billing_email')
  const token=input.text('attempt_token',{max:64});insist(/^[a-f0-9]{64}$/.test(token),'payment_link_return_required',401)
  const tokenHash=await sha256Hex(token),existing=await one(env,'SELECT * FROM nc_payment_link_attempts WHERE token_hash=?',tokenHash)
  if(existing) {
    insist(existing.link_id===link.id&&existing.name===name&&existing.billing_email===email&&existing.address===address
      &&existing.language===offer.language&&!!existing.default_choice===input.flag('make_default')&&existing.expires_at>clockInstant(env)
      && (!existing.customer_id||!!await one(env,"SELECT 1 FROM nc_customers WHERE id=? AND erased_at IS NULL AND status='active'",existing.customer_id)),'payment_link_state_changed',409)
    return {row:existing,token,replayed:true}
  }
  // Never guess an existing customer association from an anonymous email.
  insist(!await one(env,'SELECT 1 FROM nc_customers WHERE lower(billing_email)=?',email),'payment_link_existing_customer',409)
  const id=newId(),at=clockInstant(env)
  const choice=input.flag('make_default'),consent={...offer.wording,defaultChoice:choice,acceptedAt:at},hash=await fingerprint(consent)
  insist(offer.terms.kind!=='one_time'||!choice,'payment_link_default_not_offered')
  await commit(env,[activeLinkGuard(env,link),linkOwnerGuard(env,link),...linkTermsGuards(env,offer.terms),
    guard(env,'payment_link_exhausted','EXISTS(SELECT 1 FROM nc_payment_links WHERE id=? AND (max_uses IS NULL OR used_count+reserved_count<max_uses))',link.id),
    guard(env,'payment_link_existing_customer','NOT EXISTS(SELECT 1 FROM nc_customers WHERE lower(billing_email)=?)',email),
    stmt(env,'UPDATE nc_payment_links SET reserved_count=reserved_count+1 WHERE id=?',link.id),
    stmt(env,`INSERT INTO nc_payment_link_attempts(id,link_id,status,name,billing_email,address,language,consent_json,consent_hash,token_hash,expires_at,start_date,trial_end,default_choice,created_at,revision,invoice_id)
      VALUES(?,?,'creating_customer',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,id,link.id,name,email,address,offer.language,canonical(consent),hash,tokenHash,at+86400000,offer.start,offer.trialEnd,choice?1:0,at,newId(),offer.terms.kind==='one_time'?newId():null)],
    {actor:'customer:payment-link',action:'payment_link.claim',subject:id,detail:{link:link.id,basis:link.basis_hash,consentHash:hash,defaultChoice:choice,noDebit:true}})
  return {row:(await one(env,'SELECT * FROM nc_payment_link_attempts WHERE id=?',id))!,token,replayed:false}
}
export async function changePaymentLinkAttempt(env: Bindings, link: Row, row: Row, updates: Row, action: string, terms?: LinkTerms) {
  const values=Object.entries({...updates,revision:newId()})
  await commit(env,[activeLinkGuard(env,link),linkOwnerGuard(env,link),attemptGuard(env,row),...(terms?linkTermsGuards(env,terms):[]),
    stmt(env,`UPDATE nc_payment_link_attempts SET ${values.map(([key])=>`${key}=?`).join(',')} WHERE id=?`,...values.map(([,value])=>value),row.id)],
    {actor:'customer:payment-link',action:`payment_link.${action}`,subject:row.id,detail:{link:link.id,status:updates.status??row.status}})
  return (await one(env,'SELECT * FROM nc_payment_link_attempts WHERE id=?',row.id))!
}
export const paymentLinkAttemptView=(row:Row)=>({id:row.id,status:row.status,language:row.language,customer:row.customer_id??null,subscription:row.subscription_id??null,invoice:row.invoice_id??null,payment:row.payment_id??null,defaultChoice:!!row.default_choice,method:row.method_json?parseJson(row.method_json,null):null,debitAuthority:false})

/** Family-scoped closed projection; customer and child record callers compose this. */
export async function customerPaymentLinks(env: Bindings, actor: Actor, customer: string) {
  const subscriptions=canRead(actor,'subscriptions'),payments=canRead(actor,'payments')&&canRead(actor,'invoices')
  if(!subscriptions&&!payments)return null
  const rows=await all(env,`SELECT a.* FROM nc_payment_link_attributions a JOIN nc_customers c ON c.id=a.customer_id
    WHERE a.customer_id=? AND c.erased_at IS NULL AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(a.id,a.customer_id,a.subscription_id)) ORDER BY a.created_at,a.id`,customer)
  return rows.filter(row=>row.subscription_id?subscriptions:payments).map(row=>({id:row.id,link:row.link_id,customer:row.customer_id,subscription:row.subscription_id,createdAt:row.created_at,
    kind:row.subscription_id?'subscription':'one_time',status:row.status,source:row.subscription_id?`/app/subscriptions/${row.subscription_id}`:row.invoice_id?`/app/invoices/${row.invoice_id}`:`/app/payments/${row.payment_id}/receipt`,debitAuthority:false,
    ...(payments?{invoice:row.invoice_id,payment:row.payment_id,accountRef:row.account_ref,customerRef:row.customer_ref,sessionRef:row.session_ref,paymentIntentRef:row.payment_intent_ref,chargeRef:row.charge_ref,method:parseJson(row.method_json,null),defaultChoice:!!row.default_choice}:{})}))
}
