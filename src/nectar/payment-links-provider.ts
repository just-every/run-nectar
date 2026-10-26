// Every external mutation has a durable claim. Recovery reads the original
// customer, session and default only; a missing search result never releases it.
import type { Bindings } from '../auth.server'
import { commit, guard, insist, one, stmt, type Row } from './core'
import { currentLinkTerms, activeLinkGuard, frozenPaymentLinkTerms, linkOwnerGuard, linkTerms, requireActivePaymentLink } from './payment-links'
import { attemptGuard, changePaymentLinkAttempt, paymentLinkAttemptView } from './payment-links-state'
import { completePaymentLink } from './payment-links-complete'
import { createHostedSetup, expiredHostedSetup, readHostedSetup, setHostedDefault } from './payments/hosted-setup'
import { providerReference, type StripeClient } from './payments/stripe'
import { paymentLinkStripe } from './payment-links-stripe'
import { checkPaymentLinkSession, createPaymentLinkCheckout, expiredPaymentLinkPayment, paymentLinkPaymentProof } from './payment-links-payment'
import { preparePaymentLinkInvoice, recordPaymentLinkCash } from './payment-links-one-time'

async function findOriginal(stripe: StripeClient, path: string, matches: (row: Row)=>boolean) {
  const rows: Row[]=[],seen=new Set<string>();let cursor=''
  for(let page=0;;page++) {
    insist(page<100,'payment_link_uncertain',409)
    const result=await stripe(`${path}${path.includes('?')?'&':'?'}limit=100${cursor?`&starting_after=${encodeURIComponent(cursor)}`:''}`)
    insist(result.object==='list'&&Array.isArray(result.data)&&typeof result.has_more==='boolean'&&(!result.has_more||result.data.length>0),'payment_link_uncertain',409)
    for(const row of result.data){const id=providerReference(row.id);insist(!seen.has(id),'payment_link_uncertain',409);seen.add(id);if(matches(row))rows.push(row)}
    if(!result.has_more)break
    cursor=providerReference(result.data.at(-1).id)
  }
  insist(rows.length===1,'payment_link_uncertain',409)
  return rows[0]
}
function checkedCustomer(customer: Row, attempt: Row) {
  insist(customer.object==='customer'&&!customer.deleted&&customer.livemode===false
    && customer.metadata?.nectar_payment_link_attempt===attempt.id && customer.email===attempt.billing_email
    && (!attempt.customer_ref||customer.id===attempt.customer_ref),'payment_link_evidence_mismatch',409)
  return providerReference(customer.id)
}
function checkoutDestination(value: unknown) {
  let url:URL;try{url=new URL(String(value))}catch{insist(false,'payment_link_evidence_mismatch',409)}
  insist(url.protocol==='https:'&&url.hostname==='checkout.stripe.com'&&!url.username&&!url.password&&!url.port,'payment_link_evidence_mismatch',409)
  return url.href
}
async function providerCustomer(stripe:StripeClient,row:Row) {
  const customer=await stripe(`/customers/${encodeURIComponent(row.customer_ref)}`)
  checkedCustomer(customer,row);return customer
}

/** First attempt only, after beginPaymentLink has durably claimed capacity. */
export async function createPaymentLinkCustomer(env: Bindings,link:Row,row:Row) {
  insist(row.status==='creating_customer','payment_link_state_changed',409)
  const {stripe}=await paymentLinkStripe(env,link.account_ref)
  await requireActivePaymentLink(env,link.id)
  const customer=await stripe('/customers',new URLSearchParams({name:row.name,email:row.billing_email,
    'metadata[nectar_payment_link_attempt]':row.id,'metadata[nectar_payment_link]':link.id}),`nectar-payment-link-customer-${row.id}`)
  const ref=checkedCustomer(customer,row)
  return changePaymentLinkAttempt(env,link,row,{customer_ref:ref,status:'customer_ready'},'customer.created')
}

export async function operatePaymentLink(env:Bindings,link:Row,initial:Row,origin:string,operation:'continue'|'reconcile'|'finish') {
  let row=initial
  if(row.status==='complete')return paymentLinkAttemptView(row)
  const oneTime=linkTerms(link).kind==='one_time'
  const terms=oneTime?await frozenPaymentLinkTerms(link,row):await currentLinkTerms(env,link),{stripe}=await paymentLinkStripe(env,link.account_ref)
  if(!oneTime||!['open','captured','recording_invoice'].includes(row.status))await requireActivePaymentLink(env,link.id)
  if(operation==='continue')await requireActivePaymentLink(env,link.id)
  if(row.status==='creating_customer') {
    insist(operation==='reconcile','payment_link_uncertain',409)
    const customer=await findOriginal(stripe,`/customers?email=${encodeURIComponent(row.billing_email)}`,value=>value.metadata?.nectar_payment_link_attempt===row.id)
    row=await changePaymentLinkAttempt(env,link,row,{customer_ref:checkedCustomer(customer,row),status:'customer_ready'},'customer.reconciled')
  }
  if(row.status==='customer_ready') {
    await providerCustomer(stripe,row)
    row=await changePaymentLinkAttempt(env,link,row,{status:'creating_checkout'},'checkout.claim',terms)
    const returnUrl=`${origin}/pay-links/attempts/${row.id}`
    const created=oneTime?await createPaymentLinkCheckout(stripe,link,row,returnUrl):await createHostedSetup(stripe,{id:row.id,customerRef:row.customer_ref,method:'card',language:row.language,currency:terms.currency,returnUrl})
    row=await changePaymentLinkAttempt(env,link,row,{session_ref:created.sessionRef,status:'open'},'checkout.open')
    return {...paymentLinkAttemptView(row),url:checkoutDestination(created.url)}
  }
  if(row.status==='creating_checkout') {
    insist(operation==='reconcile','payment_link_uncertain',409)
    const session=await findOriginal(stripe,`/checkout/sessions?customer=${encodeURIComponent(row.customer_ref)}`,value=>oneTime?value.metadata?.nectar_payment_link_attempt===row.id:value.metadata?.nectar_setup_id===row.id)
    if(oneTime)checkPaymentLinkSession(session,row,terms.totalCents)
    else insist(session.object==='checkout.session'&&session.mode==='setup'&&session.livemode===false&&providerReference(session.customer)===row.customer_ref,'payment_link_evidence_mismatch',409)
    row=await changePaymentLinkAttempt(env,link,row,{session_ref:providerReference(session.id),status:'open'},'checkout.reconciled')
    if(session.status==='open')return {...paymentLinkAttemptView(row),url:checkoutDestination(session.url)}
  }
  insist(['open','updating_default','captured','recording_invoice','expired'].includes(row.status),'payment_link_state_changed',409)
  if(row.status==='expired')return paymentLinkAttemptView(row)
  const identity={id:row.id,customerRef:row.customer_ref,method:'card' as const,sessionRef:row.session_ref}
  if(operation==='continue'&&row.status==='open') {
    const session=await stripe(`/checkout/sessions/${encodeURIComponent(row.session_ref)}`)
    if(oneTime)checkPaymentLinkSession(session,row,terms.totalCents)
    else insist(session.object==='checkout.session'&&session.id===row.session_ref&&session.metadata?.nectar_setup_id===row.id
      && session.mode==='setup'&&session.livemode===false&&providerReference(session.customer)===row.customer_ref,'payment_link_unavailable',409)
    insist(session.status==='open','payment_link_unavailable',409)
    return {...paymentLinkAttemptView(row),url:checkoutDestination(session.url)}
  }
  if(row.status==='open'&&(oneTime?await expiredPaymentLinkPayment(stripe,link,row):await expiredHostedSetup(stripe,identity))) {
    await commit(env,[activeLinkGuard(env,link),linkOwnerGuard(env,link),attemptGuard(env,row),
      guard(env,'payment_link_state_changed','EXISTS(SELECT 1 FROM nc_payment_links WHERE id=? AND reserved_count>0)',link.id),
      stmt(env,"UPDATE nc_payment_link_attempts SET status='expired',revision=? WHERE id=?",crypto.randomUUID(),row.id),
      stmt(env,'UPDATE nc_payment_links SET reserved_count=reserved_count-1 WHERE id=?',link.id)],
      {actor:'customer:payment-link',action:'payment_link.expired',subject:row.id,detail:{link:link.id}})
    return paymentLinkAttemptView((await one(env,'SELECT * FROM nc_payment_link_attempts WHERE id=?',row.id))!)
  }
  if(oneTime) {
    if(row.status==='open')row=await paymentLinkPaymentProof(env,link,row,stripe)
    row=await preparePaymentLinkInvoice(env,link,row)
    const {issueAuthorizedPaymentLinkInvoice}=await import('./billruns')
    await issueAuthorizedPaymentLinkInvoice(env,row.id)
    return recordPaymentLinkCash(env,link,row)
  }
  const method=await readHostedSetup(stripe,{...identity,livemode:false}),customer=await providerCustomer(stripe,row)
  if(row.default_choice) {
    if(row.status==='updating_default') {
      insist(operation==='reconcile'&&providerReference(customer.invoice_settings?.default_payment_method)===method.methodRef,'payment_link_uncertain',409)
    } else {
      insist(!customer.invoice_settings?.default_payment_method,'payment_link_default_changed',409)
      row=await changePaymentLinkAttempt(env,link,row,{status:'updating_default'},'default.claim',terms)
      await setHostedDefault(stripe,row.customer_ref,method.methodRef,row.id)
    }
  } else insist(!customer.invoice_settings?.default_payment_method,'payment_link_default_changed',409)
  return completePaymentLink(env,link,row,method)
}
