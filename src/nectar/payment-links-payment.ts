import type { Bindings } from '../auth.server'
import { clockInstant } from './clock'
import { canonical, commit, insist, newId, one, stmt, type Row } from './core'
import { customerText } from './locale'
import { frozenPaymentLinkTerms, paymentLinkCaptureGuard } from './payment-links'
import { attemptGuard } from './payment-links-state'
import { capturedPayment, providerReference, type StripeClient } from './payments/stripe'

export async function createPaymentLinkCheckout(stripe:StripeClient,link:Row,row:Row,returnUrl:string) {
  const terms=JSON.parse(link.terms_json),L=customerText(row.language)
  const body=new URLSearchParams({mode:'payment',customer:row.customer_ref,locale:L.tag.startsWith('es')?'es':'en',success_url:returnUrl,cancel_url:returnUrl,
    'payment_method_types[0]':'card','adaptive_pricing[enabled]':'false','metadata[nectar_payment_link_attempt]':row.id,
    'payment_intent_data[metadata][nectar_native_collection_key]':row.consent_hash,'payment_intent_data[metadata][nectar_native_collection_request]':row.id,
    'payment_intent_data[metadata][nectar_native_invoice]':row.invoice_id,
    'line_items[0][price_data][currency]':'usd','line_items[0][price_data][unit_amount]':String(terms.subtotalCents),
    'line_items[0][price_data][product_data][name]':terms.oneTime.description,'line_items[0][quantity]':'1'})
  if(terms.taxCents){body.set('line_items[1][price_data][currency]','usd');body.set('line_items[1][price_data][unit_amount]',String(terms.taxCents));body.set('line_items[1][price_data][product_data][name]',L.t('paymentLink.oneTime.tax'));body.set('line_items[1][quantity]','1')}
  const session=await stripe('/checkout/sessions',body,`nectar-payment-link-payment-${row.id}`)
  checkPaymentLinkSession(session,row,terms.totalCents)
  return {sessionRef:providerReference(session.id),url:session.url as string}
}
export function checkPaymentLinkSession(session:Row,row:Row,amount:number) {
  insist(session.object==='checkout.session'&&session.mode==='payment'&&session.livemode===false
    && providerReference(session.customer)===row.customer_ref&&session.metadata?.nectar_payment_link_attempt===row.id
    &&(!row.session_ref||session.id===row.session_ref)&&session.currency==='usd'&&session.amount_total===amount,'payment_link_evidence_mismatch',409)
}
export async function paymentLinkPaymentProof(env:Bindings,link:Row,row:Row,stripe:StripeClient) {
  const terms=await frozenPaymentLinkTerms(link,row),session=await stripe(`/checkout/sessions/${encodeURIComponent(row.session_ref)}`)
  checkPaymentLinkSession(session,row,terms.totalCents)
  insist(session.status==='complete'&&session.payment_status==='paid','payment_link_payment_pending',409)
  const intentRef=providerReference(session.payment_intent),intent=await stripe(`/payment_intents/${encodeURIComponent(intentRef)}`)
  insist(intent.id===intentRef,'payment_link_evidence_mismatch',409)
  const identity={accountRef:link.account_ref,customerRef:row.customer_ref,paymentMethodRef:providerReference(intent.payment_method),livemode:false,
    invoiceId:row.invoice_id,requestId:row.id,key:row.consent_hash,amountCents:terms.totalCents,currency:'USD'}
  const proof=await capturedPayment(stripe,intent,identity,terms.timezone)
  insist(proof.capturedAt>=row.created_at-300000&&proof.capturedAt<=clockInstant(env),'payment_link_capture_date_invalid',409)
  const method=await stripe(`/payment_methods/${encodeURIComponent(identity.paymentMethodRef)}`)
  insist(method.object==='payment_method'&&method.id===identity.paymentMethodRef&&method.type==='card'&&method.livemode===false
    &&(!method.customer||providerReference(method.customer)===row.customer_ref)&&method.card&&/^[a-z_]{1,30}$/.test(method.card.brand)
    &&/^\d{4}$/.test(method.card.last4)&&Number.isInteger(method.card.exp_month)&&method.card.exp_month>=1&&method.card.exp_month<=12
    &&Number.isInteger(method.card.exp_year)&&method.card.exp_year>=2000&&method.card.exp_year<=9999,'payment_link_evidence_mismatch',409)
  const safe=canonical({methodRef:method.id,type:'card',brand:method.card.brand,last4:method.card.last4,expMonth:method.card.exp_month,expYear:method.card.exp_year})
  await commit(env,[attemptGuard(env,row),paymentLinkCaptureGuard(env,link,row),stmt(env,"UPDATE nc_payment_link_attempts SET status='captured',proof_json=?,payment_intent_ref=?,charge_ref=?,method_json=?,revision=? WHERE id=?",canonical(proof),proof.paymentIntentRef,proof.chargeRef,safe,newId(),row.id)],{actor:'customer:payment-link',action:'payment_link.payment.captured',subject:row.id,detail:{link:link.id,amountCents:proof.amountCents,paymentIntentRef:proof.paymentIntentRef,capturedAt:proof.capturedAt}})
  return (await one(env,'SELECT * FROM nc_payment_link_attempts WHERE id=?',row.id))!
}
export async function expiredPaymentLinkPayment(stripe:StripeClient,link:Row,row:Row) {
  const terms=JSON.parse(link.terms_json),session=await stripe(`/checkout/sessions/${encodeURIComponent(row.session_ref)}`)
  checkPaymentLinkSession(session,row,terms.totalCents)
  if(session.status!=='expired'||session.payment_status==='paid')return false
  if(!session.payment_intent)return true
  const intent=await stripe(`/payment_intents/${encodeURIComponent(providerReference(session.payment_intent))}`)
  return intent.object==='payment_intent'&&intent.id===providerReference(session.payment_intent)&&intent.livemode===false
    &&providerReference(intent.customer)===row.customer_ref&&intent.metadata?.nectar_native_collection_request===row.id
    &&intent.status==='canceled'&&intent.amount_received===0&&!intent.latest_charge
}
