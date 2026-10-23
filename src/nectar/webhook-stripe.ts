// DEV-001: authenticated, explicitly requested Stripe shadow-event capture.
// No raw provider JSON, contact fields or financial writes are retained.
import type { Bindings } from '../auth.server'
import { actorLabel, requireMember, type Actor } from './actor'
import { clockInstant } from './clock'
import { all, commit, guard, insist, NectarError, newId, one, stmt, type Row } from './core'
import type { Input } from './input'
import { requireFreshFactor } from './mfa'
import { providerReference, providerUnavailable, stripeForAccount } from './payments/stripe'

export const STRIPE_EVENT_MAP: Record<string,string> = {
  'customer.created':'customer.created', 'customer.updated':'customer.updated', 'customer.deleted':'customer.deleted',
  'customer.subscription.created':'subscription.created', 'customer.subscription.updated':'subscription.updated', 'customer.subscription.deleted':'subscription.updated',
  'invoice.created':'invoice.created', 'invoice.finalized':'invoice.issued', 'invoice.paid':'invoice.paid',
  'invoice.payment_succeeded':'payment.recorded', 'invoice.payment_failed':'payment.failed',
  'payment_method.attached':'payment_method.attached', 'payment_method.updated':'payment_method.updated',
  'payment_method.automatically_updated':'payment_method.updated', 'payment_method.detached':'payment_method.detached',
  'entitlements.active_entitlement_summary.updated':'entitlements.updated', 'credit_note.created':'credit.created',
}
const ref=(value:unknown):string=>typeof value==='string'?value:value&&typeof value==='object'?String((value as Row).id??''):''
const meta=(kind:string,id:string)=>`json_object('kind','${kind}','id',${id},'metadata',json(COALESCE((SELECT metadata_json FROM nc_metadata_revisions WHERE kind='${kind}' AND record_id=${id} ORDER BY revision DESC LIMIT 1),'{}')))`
const metadata=`json_array(${meta('customer','c.customer')},${meta('subscription','c.subscription')},${meta('invoice','c.invoice')},${meta('payment','NULL')},${meta('credit-note','NULL')},json_object('kind','prices','objects',json((SELECT json_group_array(${meta('price','p.id')}) FROM nc_prices p WHERE p.id IN(SELECT price_id FROM nc_items WHERE subscription_id=c.subscription UNION SELECT price_id FROM nc_invoice_lines WHERE invoice_id=c.invoice)))))`

export async function consumeStripeWebhookEvent(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor,'credentials');await requireFreshFactor(env,actor)
  input.only(['customer','account_ref','event_ref','consent','returnTo'])
  insist(input.flag('consent'),'stripe_event_consent_required')
  const customer=await one(env,"SELECT id,provider_ref,revision FROM nc_customers WHERE id=? AND origin='import' AND status='active' AND erased_at IS NULL",input.text('customer',{max:100}))
  insist(customer&&!await one(env,'SELECT 1 FROM nc_erased_records WHERE record_id=?',customer.id),'shadow_customer_required',409)
  const shadows=await all(env,"SELECT id,provider_ref,revision FROM nc_subscriptions WHERE customer_id=? AND billing_mode='shadow'",customer.id)
  insist(shadows.length>0,'shadow_customer_required',409)
  const accountRef=providerReference(input.text('account_ref',{max:255})),eventRef=providerReference(input.text('event_ref',{max:255}))
  const prior=await one(env,'SELECT event_id,customer_id FROM nc_webhook_stripe_receipts WHERE account_ref=? AND provider_event_ref=?',accountRef,eventRef)
  if(prior){insist(prior.customer_id===customer.id,'stripe_event_customer_mismatch',409);return {id:prior.event_id,replayed:true}}
  const {stripe}=await stripeForAccount(env,accountRef).catch(providerUnavailable)
  const sourceCustomer=await stripe(`/customers/${encodeURIComponent(providerReference(customer.provider_ref))}`).catch(providerUnavailable)
  // Fetch by id from the frozen account; caller-supplied event objects are never accepted.
  const event=await stripe(`/events/${encodeURIComponent(eventRef)}`).catch(providerUnavailable)
  insist(event.object==='event'&&event.id===eventRef&&event.livemode===false&&Number.isSafeInteger(event.created)&&event.created>0,'stripe_event_invalid',409)
  insist(sourceCustomer.object==='customer'&&sourceCustomer.id===customer.provider_ref&&
    (sourceCustomer.deleted===true?event.type==='customer.deleted':sourceCustomer.livemode===false),'stripe_test_shadow_customer_required',409)
  const type=STRIPE_EVENT_MAP[event.type],object=event.data?.object
  insist(type&&object&&typeof object==='object'&&!Array.isArray(object),'stripe_event_unmapped',409)
  const sourceCustomerRef=event.type.startsWith('customer.')&&!event.type.startsWith('customer.subscription.')?ref(object.id):
    ref(object.customer)||(event.type==='payment_method.detached'?ref(event.data.previous_attributes?.customer):'')
  insist(sourceCustomerRef===customer.provider_ref,'stripe_event_customer_mismatch',409)
  const registered=await one<{at:number}>(env,'SELECT MIN(created_at) at FROM nc_webhook_endpoints WHERE enabled=1')
  insist(registered?.at!==null&&registered?.at!==undefined&&event.created>=Math.floor(registered.at/1000),'stripe_event_before_consent',409)
  const sourceId=providerReference(event.type==='entitlements.active_entitlement_summary.updated'?sourceCustomerRef:object.id)
  const subscription=event.type.startsWith('customer.subscription.')?shadows.find(s=>s.provider_ref===sourceId):
    shadows.find(s=>s.provider_ref===ref(object.subscription??object.parent?.subscription_details?.subscription))
  if(event.type.startsWith('customer.subscription.'))insist(subscription,'stripe_event_subscription_mismatch',409)
  const invoice=event.type.startsWith('invoice.')?await one(env,"SELECT id FROM nc_incumbent_invoices WHERE provider='stripe' AND provider_ref=? AND customer_id=?",sourceId,customer.id):null
  // Closed typed projection: no provider metadata, billing contact, description,
  // card details, failure text or arbitrary object fields cross this boundary.
  const data:Row={customer_id:customer.id,subscription_id:subscription?.id??null,invoice_id:invoice?.id??null,
    source:{provider:'stripe',account_ref:accountRef,event_ref:eventRef,event_type:event.type,object_ref:sourceId,created_at:event.created*1000},custody:'stripe-test-shadow-event'}
  if(typeof object.status==='string'){
    insist(['active','trialing','past_due','unpaid','canceled','incomplete','incomplete_expired','paused','draft','open','paid','uncollectible','void','issued'].includes(object.status),'stripe_event_status_invalid',409)
    data.status=object.status
  }
  for(const field of ['amount_paid','amount_due','total'])if(object[field]!==undefined){insist(Number.isSafeInteger(object[field])&&object[field]>=0,'stripe_event_amount_invalid',409);data[field+'_cents']=object[field]}
  if(object.currency!==undefined&&object.currency!==null){insist(/^[a-z]{3}$/.test(object.currency),'stripe_event_currency_invalid',409);data.currency=object.currency}
  if(event.type.startsWith('payment_method.'))data.payment_method_ref=sourceId
  if(event.type.startsWith('customer.subscription.')){
    insist(object.items?.object==='list'&&object.items.has_more===false&&Array.isArray(object.items.data)&&object.items.data.length<=100,'stripe_event_items_incomplete',409)
    data.items=object.items.data.map((item:Row)=>{
      insist(item.quantity===undefined||item.quantity===null||Number.isSafeInteger(item.quantity)&&item.quantity>=0,'stripe_event_quantity_invalid',409)
      return {item_ref:providerReference(item.id),price_ref:providerReference(ref(item.price)),quantity:item.quantity??null}
    })
    data.cancel_at_period_end=object.cancel_at_period_end===true
    data.paused=object.pause_collection!==null&&object.pause_collection!==undefined||object.status==='paused'
  }
  if(event.type==='entitlements.active_entitlement_summary.updated'){
    insist(object.entitlements?.object==='list'&&object.entitlements.has_more===false&&Array.isArray(object.entitlements.data)&&object.entitlements.data.length<=100,'stripe_event_entitlements_incomplete',409)
    data.features=object.entitlements.data.map((f:Row)=>({feature_ref:providerReference(ref(f.feature)),lookup_key:providerReference(f.lookup_key)}))
  }
  const id=newId(),at=clockInstant(env)
  try{
    await commit(env,[
      guard(env,'stripe_event_source_changed',"EXISTS(SELECT 1 FROM nc_customers WHERE id=? AND revision=? AND erased_at IS NULL AND status='active') AND EXISTS(SELECT 1 FROM nc_subscriptions WHERE customer_id=? AND billing_mode='shadow') AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id=?)",customer.id,customer.revision,customer.id,customer.id),
      ...(subscription?[guard(env,'stripe_event_source_changed',"EXISTS(SELECT 1 FROM nc_subscriptions WHERE id=? AND revision=? AND billing_mode='shadow')",subscription.id,subscription.revision)]:[]),
      stmt(env,'INSERT INTO nc_webhook_stripe_receipts(account_ref,provider_event_ref,customer_id,event_id) VALUES(?,?,?,?)',accountRef,eventRef,customer.id,id),
      stmt(env,`INSERT INTO nc_webhook_events(id,type,customer_id,subject,payload_json,created_at)
        SELECT ?,?,c.customer,?,json_object('type',?,'data',json(?),'metadata',${metadata}),? FROM (SELECT ? customer,? subscription,? invoice) c`,id,type,subscription?.id??customer.id,type,JSON.stringify(data),at,customer.id,subscription?.id??null,invoice?.id??null),
    ],{actor:actorLabel(actor),action:'webhook.stripe.consume',subject:id,detail:{customer:customer.id,accountRef,eventRef,type,consent:true}})
  }catch(error){
    if(!(error instanceof NectarError&&error.code==='already_exists'))throw error
    const winner=await one(env,'SELECT event_id,customer_id FROM nc_webhook_stripe_receipts WHERE account_ref=? AND provider_event_ref=?',accountRef,eventRef)
    insist(winner&&winner.customer_id===customer.id,'stripe_event_customer_mismatch',409)
    return {id:winner.event_id,replayed:true}
  }
  return {id,replayed:false}
}
