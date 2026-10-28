import type { Bindings } from '../auth.server'
import type { Actor } from './actor'
import { requireBusiness } from './business'
import { clockInstant } from './clock'
import { all, canonical, commit, fingerprint, guard, insist, newId, one, stmt, type Row } from './core'
import { localDate } from './dates'
import type { Input } from './input'
import { customerText } from './locale'
import { nativeCollectionSource, nativeSourceGuard } from './payments/source'
import { capturedPayment, providerReference, stripeForAccount, type PaymentIdentity, type StripeClient } from './payments/stripe'
import { portalProfileFence, requirePortalProfileSession } from './portal-profile-authority'
import type { CustomerSession } from './portal-session'
import { collectedPaymentStatements, issuedInvoice } from './receivables'

export async function portalInvoicePayment(env: Bindings, session: CustomerSession, invoice: string) {
  insist(await one(env,"SELECT 1 FROM nc_invoices WHERE id=? AND customer_id=? AND status='issued'",invoice,session.customer),'not_found',404)
  const row=await one(env,'SELECT * FROM nc_portal_invoice_payments WHERE invoice_id=? AND customer_id=? ORDER BY created_at DESC,id DESC LIMIT 1',invoice,session.customer)
  return row?{id:row.id,status:row.status,amountCents:row.amount_cents,currency:row.currency,payment:row.payment_id}:null
}

export async function portalInvoiceConsent(env: Bindings, session: CustomerSession, invoice: string) {
  const source=await nativeCollectionSource(env,invoice)
  insist(source.row.customer_id===session.customer&&source.payerId===session.customer,'not_found',404)
  insist(source.row.currency==='USD','portal_payment_usd_required',409)
  const L=customerText(session.language),business=await requireBusiness(env)
  const wording=L.t('portal.pay.consent',{merchant:business.legal_name,invoice:source.row.number,amount:L.money(source.collectibleCents)})
  return {source,wording,hash:await fingerprint({source:source.sourceHash,wording,version:1,language:session.language})}
}

async function rowFor(env: Bindings, session: CustomerSession, id: string) {
  const row=await one(env,`SELECT p.* FROM nc_portal_invoice_payments p JOIN nc_customers c ON c.id=p.customer_id
    WHERE p.id=? AND p.customer_id=? AND c.erased_at IS NULL AND c.status='active'
    AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(p.id,c.id,p.invoice_id))`,id,session.customer)
  insist(row,'not_found',404)
  insist(await one(env,'SELECT 1 FROM nc_portal_invoice_payment_authority WHERE id=? AND customer_id=?',id,session.customer),'portal_payment_historical',409)
  return row
}
function paymentFence(env: Bindings, session: CustomerSession, row: Row) {
  return [portalProfileFence(env,session),guard(env,'portal_payment_changed',`EXISTS(SELECT 1 FROM nc_portal_invoice_payments p JOIN nc_portal_invoice_payment_authority a ON a.id=p.id
    WHERE p.id=? AND p.customer_id=? AND p.revision=? AND p.status=?)`,row.id,session.customer,row.revision,row.status)]
}
async function outcome(env: Bindings, session: CustomerSession, row: Row, fields: Row) {
  const values={...fields,revision:newId()}
  await commit(env,[...paymentFence(env,session,row),stmt(env,`UPDATE nc_portal_invoice_payments SET ${Object.keys(values).map(key=>`${key}=?`).join(',')} WHERE id=?`,...Object.values(values),row.id)],
    {actor:`customer:portal:${session.jti}`,action:'portal.invoice.payment.outcome',subject:row.id,detail:{status:fields.status,invoice:row.invoice_id}})
  return rowFor(env,session,row.id)
}
function verifyCheckout(checkout: Row,row: Row) {
  insist(checkout.object==='checkout.session'&&checkout.mode==='payment'&&checkout.livemode===false
    &&providerReference(checkout.customer)===row.customer_ref&&checkout.client_reference_id===row.id
    &&checkout.amount_total===row.amount_cents&&checkout.currency===row.currency
    &&checkout.metadata?.nectar_portal_payment===row.id&&checkout.metadata?.nectar_native_invoice===row.invoice_id,
  'portal_checkout_mismatch',409)
  return providerReference(checkout.id)
}
async function readCheckout(stripe: StripeClient,row: Row) {
  if(row.session_ref){const checkout=await stripe(`/checkout/sessions/${encodeURIComponent(row.session_ref)}`);verifyCheckout(checkout,row);return checkout}
  const found:Row[]=[];let cursor=''
  for(let page=0;page<20;page++) {
    const listed=await stripe(`/checkout/sessions?${new URLSearchParams({customer:row.customer_ref,limit:'100',...(cursor?{starting_after:cursor}:{})})}`)
    insist(listed.object==='list'&&Array.isArray(listed.data)&&typeof listed.has_more==='boolean','portal_checkout_history_incomplete',409)
    for(const checkout of listed.data)if(checkout.client_reference_id===row.id){verifyCheckout(checkout,row);found.push(checkout)}
    if(!listed.has_more){insist(found.length===1,'portal_checkout_unconfirmed',409);return found[0]}
    cursor=providerReference(listed.data.at(-1)?.id)
  }
  insist(false,'portal_checkout_history_incomplete',409)
}

export async function startPortalInvoicePayment(env: Bindings, session: CustomerSession,input: Input) {
  await requirePortalProfileSession(env,session)
  input.only(['invoice','consent_hash','confirm'])
  insist(input.flag('confirm'),'portal_payment_confirmation_required')
  const invoice=input.text('invoice',{max:100}),consent=await portalInvoiceConsent(env,session,invoice)
  insist(input.text('consent_hash',{max:100})===consent.hash,'portal_payment_terms_changed',409)
  const {source}=consent,{stripe,account}=await stripeForAccount(env,source.accountRef)
  const binding=await one(env,'SELECT * FROM nc_stripe_customer_bindings WHERE customer_id=? AND account_ref=?',session.customer,account)
  insist(binding,'native_customer_binding_required',409)
  const customer=await stripe(`/customers/${encodeURIComponent(binding.stripe_customer_ref)}`)
  insist(customer.object==='customer'&&customer.id===binding.stripe_customer_ref&&customer.livemode===false&&!customer.deleted,'portal_payment_test_customer_required',409)
  const previous=await one(env,"SELECT id FROM nc_portal_invoice_payments WHERE invoice_id=? AND status NOT IN ('expired','failed')",invoice)
  if(previous)return reconcilePortalInvoicePayment(env,session,previous.id)
  const id=newId(),at=clockInstant(env)
  await commit(env,[portalProfileFence(env,session),nativeSourceGuard(env,source),
    guard(env,'portal_payment_binding_changed','EXISTS(SELECT 1 FROM nc_stripe_customer_bindings WHERE id=? AND customer_id=? AND revision=? AND account_ref=? AND stripe_customer_ref=?)',binding.id,session.customer,binding.revision,account,binding.stripe_customer_ref),
    stmt(env,`INSERT INTO nc_portal_invoice_payments(id,customer_id,invoice_id,account_ref,customer_ref,binding_id,binding_revision,amount_cents,currency,source_hash,consent_hash,status,created_at,revision)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,'creating',?,?)`,id,session.customer,invoice,account,binding.stripe_customer_ref,binding.id,binding.revision,source.collectibleCents,'usd',source.sourceHash,consent.hash,at,newId()),
    stmt(env,'INSERT INTO nc_portal_invoice_payment_authority(id,customer_id,created_at) VALUES(?,?,?)',id,session.customer,at)],
    {actor:`customer:portal:${session.jti}`,action:'portal.invoice.payment.claim',subject:id,detail:{invoice,amountCents:source.collectibleCents,consentHash:consent.hash}})
  let row=await rowFor(env,session,id)
  const fields=new URLSearchParams({mode:'payment',locale:session.language==='es-US'?'es':session.language,customer:binding.stripe_customer_ref,client_reference_id:id,
    'payment_method_types[0]':'us_bank_account','line_items[0][price_data][currency]':'usd',
    'line_items[0][price_data][unit_amount]':String(row.amount_cents),'line_items[0][price_data][product_data][name]':source.row.number,'line_items[0][quantity]':'1',
    'metadata[nectar_portal_payment]':id,'metadata[nectar_native_invoice]':invoice,
    'payment_intent_data[metadata][nectar_native_collection_key]':id,'payment_intent_data[metadata][nectar_native_collection_request]':id,'payment_intent_data[metadata][nectar_native_invoice]':invoice,
    success_url:`${session.origin}/portal/signin`,cancel_url:`${session.origin}/portal/signin`})
  try {
    const checkout=await stripe('/checkout/sessions',fields,`nectar-portal-invoice-${id}`),sessionRef=verifyCheckout(checkout,row)
    insist(typeof checkout.url==='string'&&new URL(checkout.url).origin==='https://checkout.stripe.com','portal_checkout_url_invalid',409)
    row=await outcome(env,session,row,{session_ref:sessionRef,status:'open'})
    return {id,status:row.status,url:checkout.url}
  } catch {return {id,status:'uncertain'}}
}

export async function reconcilePortalInvoicePayment(env: Bindings, session: CustomerSession,id: string): Promise<Row> {
  await requirePortalProfileSession(env,session)
  let row=await rowFor(env,session,id)
  if(['paid','expired','failed'].includes(row.status))return {id,status:row.status,payment:row.payment_id}
  const {stripe}=await stripeForAccount(env,row.account_ref)
  const checkout=await readCheckout(stripe,row),sessionRef=verifyCheckout(checkout,row)
  if(checkout.status==='expired'&&checkout.payment_status==='unpaid')return {id,status:(await outcome(env,session,row,{session_ref:sessionRef,status:'expired'})).status}
  if(checkout.status==='open') {
    row=await outcome(env,session,row,{session_ref:sessionRef,status:'open'})
    insist(typeof checkout.url==='string'&&new URL(checkout.url).origin==='https://checkout.stripe.com','portal_checkout_url_invalid',409)
    return {id,status:'open',url:checkout.url}
  }
  insist(checkout.status==='complete'&&checkout.payment_intent,'portal_checkout_unconfirmed',409)
  const intentRef=providerReference(checkout.payment_intent),intent=await stripe(`/payment_intents/${encodeURIComponent(intentRef)}`)
  const identity:PaymentIdentity={accountRef:row.account_ref,customerRef:row.customer_ref,paymentMethodRef:providerReference(intent.payment_method),livemode:false,
    invoiceId:row.invoice_id,requestId:row.id,key:row.id,amountCents:row.amount_cents,currency:'USD'}
  const method=await stripe(`/payment_methods/${encodeURIComponent(identity.paymentMethodRef)}`)
  insist(method.type==='us_bank_account'&&method.livemode===false&&providerReference(method.customer)===row.customer_ref,'portal_ach_method_mismatch',409)
  // Processing is never represented as cash or a paid invoice.
  if(intent.status==='processing')return {id,status:(await outcome(env,session,row,{session_ref:sessionRef,intent_ref:intentRef,status:'pending'})).status}
  const business=await requireBusiness(env),proof=await capturedPayment(stripe,intent,identity,business.timezone)
  insist(checkout.payment_status==='paid','portal_checkout_unpaid',409)
  const charge=await stripe(`/charges/${encodeURIComponent(proof.chargeRef)}`),balance=await stripe(`/balance_transactions/${encodeURIComponent(providerReference(charge.balance_transaction))}`)
  insist(balance.object==='balance_transaction'&&balance.type==='payment'&&providerReference(balance.source)===proof.chargeRef&&balance.amount===row.amount_cents
    &&balance.currency==='usd'&&Number.isSafeInteger(balance.available_on),'portal_ach_settlement_unconfirmed',409)
  if(balance.status!=='available'||balance.available_on*1000>clockInstant(env))return {id,status:(await outcome(env,session,row,{session_ref:sessionRef,intent_ref:intentRef,status:'pending'})).status}
  const invoice=await issuedInvoice(env,row.invoice_id)
  const system:Actor={id:`portal-payment:${id}`,kind:'agent',name:'Portal payment settlement',email:'',role:null,sessionId:null,capabilities:new Set(['receivables'])}
  const financial=await collectedPaymentStatements(env,system,{customerId:session.customer,invoiceId:row.invoice_id,amountCents:row.amount_cents,balanceCents:invoice.balance_cents,
    receivedOn:localDate(balance.available_on*1000,business.timezone),method:'bank_transfer',reference:`stripe:${row.account_ref}:${intentRef}`,evidence:canonical(proof)})
  await commit(env,[...paymentFence(env,session,row),...financial.statements,
    stmt(env,"UPDATE nc_portal_invoice_payments SET status='paid',session_ref=?,intent_ref=?,payment_id=?,revision=? WHERE id=?",sessionRef,intentRef,financial.paymentId,newId(),id)],
    [...financial.audits,{actor:`customer:portal:${session.jti}`,action:'portal.invoice.payment.paid',subject:id,detail:{invoice:row.invoice_id,payment:financial.paymentId,amountCents:row.amount_cents}}])
  return {id,status:'paid',payment:financial.paymentId}
}
