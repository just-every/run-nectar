import { validateScheduleConfirmation, reconcileScheduledPayment } from './invoice-payment-schedules'
import type { Bindings } from '../auth.server'
import { actorLabel, requireOwner, type Actor } from './actor'
import { requireBusiness } from './business'
import { clockInstant } from './clock'
import { all, canonical, commit, fingerprint, guard, insist, newId, one, parseJson, stmt, type Row } from './core'
import { setupOwner, setupOwnerFence } from './hosted-setup-basis'
import type { Input } from './input'
import { STEP_UP_MS } from './mfa'
import { nativeCollectionSource, nativeSourceGuard } from './payments/source'
import { capturedPayment, providerReference, stripeForAccount, type StripeClient } from './payments/stripe'
import { collectedPaymentStatements } from './receivables'
import { customerSessionGuard, type CustomerSession } from './portal-session'
import { customerText } from './locale'

export async function partialPaymentRow(env: Bindings, id: string) {
  const row = await one(env, `SELECT p.* FROM nc_invoice_partial_payments p JOIN nc_customers c ON c.id=p.customer_id
    WHERE p.id=? AND c.erased_at IS NULL AND c.status='active' AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(p.id,c.id,p.invoice_id))`, id)
  insist(row, 'invoice_partial_not_found', 404)
  return row
}
export function partialPaymentView(row: Row) {
  const basis = parseJson<Row>(row.basis_json, {})
  return { id: row.id, invoice: row.invoice_id, customer: row.customer_id, status: row.status, amountCents: row.amount_cents,
    kind: row.payment_kind, scheduledOn: basis.scheduledOn ?? null, method: basis.method?.summary ?? null, paymentMethodRef:basis.method?.paymentMethodRef??null, claimedAt: row.claimed_at,
    balanceCents: row.balance_cents, basisHash: row.basis_hash, accountRef: row.account_ref, customerRef: row.customer_ref,
    payment: row.payment_id, allocation: row.allocation_id, error: row.error_code,
    confirm: row.status === 'prepared' ? { request: row.id, basis_hash: row.basis_hash, invoice: row.invoice_id, customer: row.customer_id,
      amount_cents: row.amount_cents, balance_cents: row.balance_cents, account_ref: row.account_ref, stripe_customer_ref: row.customer_ref,
      ...(row.payment_kind === 'scheduled_ach' ? { scheduled_on: basis.scheduledOn, payment_method_ref: basis.method.paymentMethodRef, mandate_ref: basis.method.mandateRef } : {}), confirm: true } : null }
}
export async function partialPaymentRows(env: Bindings, actor: Actor, customer?: string) {
  requireOwner(actor)
  return (await all(env, `SELECT p.* FROM nc_invoice_partial_payments p JOIN nc_customers c ON c.id=p.customer_id WHERE c.erased_at IS NULL
    AND c.status='active' ${customer ? 'AND p.customer_id=?' : ''} ORDER BY p.prepared_at,p.id`, ...(customer ? [customer] : []))).map(partialPaymentView)
}

// Deliberately ordinary native invoices only. No standing collection or saved
// method authority follows from this one customer-initiated card purchase.
export async function sourceForPartial(env: Bindings, invoice: string, reservation?: string) {
  const source = await nativeCollectionSource(env, invoice, reservation), row = source.row, calculation = parseJson<Row>(row.calculation_json, {})
  insist(row.customer_origin === 'native' && row.currency === 'USD' && source.disputedCents === 0 && source.payerId === row.customer_id
    && !calculation.inputs?.prepaidPurchase && !calculation.inputs?.reissue
    && !await one(env, `SELECT 1 FROM nc_invoice_lines WHERE invoice_id=? AND kind='prepaid_purchase'`, invoice)
    && !await one(env, 'SELECT 1 FROM nc_payment_link_attempts WHERE invoice_id=?', invoice)
    && !await one(env, "SELECT 1 FROM nc_processor_cash_applications WHERE invoice_id=? AND status='uncertain'", invoice)
    && !await one(env, 'SELECT 1 FROM nc_invoice_payers WHERE invoice_id=?', invoice)
    && !await one(env, 'SELECT 1 FROM nc_customer_hierarchies WHERE customer_id=? OR parent_id=?', row.customer_id, row.customer_id)
    && !await one(env, 'SELECT 1 FROM nc_prepaid_topup_claims WHERE invoice_id=?', invoice)
    && !await one(env, "SELECT 1 FROM nc_automatic_collections WHERE invoice_id=? AND status NOT IN ('revoked','invalidated')", invoice)
    && !await one(env, 'SELECT 1 FROM nc_native_collection_claims WHERE invoice_id=?', invoice)
    && !await one(env, "SELECT 1 FROM nc_native_collections WHERE invoice_id=? AND status='pending'", invoice)
    && !await one(env, "SELECT 1 FROM nc_credit_requests WHERE invoice_id=? AND status='pending'", invoice)
    && !await one(env, "SELECT 1 FROM nc_processor_objects WHERE invoice_id=? AND kind IN ('dispute','ach_return') AND status IN ('needs_response','under_review','lost','warning_needs_response','warning_under_review')", invoice),
  'invoice_partial_unsupported_source', 409)
  return source
}
export function eligibleGuard(env: Bindings, invoice: string) {
  return guard(env, 'invoice_partial_unsupported_source', `EXISTS(SELECT 1 FROM nc_invoices i JOIN nc_customers c ON c.id=i.customer_id WHERE i.id=? AND c.origin='native'
      AND NOT EXISTS(SELECT 1 FROM nc_customer_hierarchies WHERE customer_id=c.id OR parent_id=c.id))
    AND NOT EXISTS(SELECT 1 FROM nc_payment_link_attempts WHERE invoice_id=?)
    AND NOT EXISTS(SELECT 1 FROM nc_processor_cash_applications WHERE invoice_id=? AND status='uncertain')
    AND NOT EXISTS(SELECT 1 FROM nc_native_collection_claims WHERE invoice_id=?)
    AND NOT EXISTS(SELECT 1 FROM nc_native_collections WHERE invoice_id=? AND status='pending')
    AND NOT EXISTS(SELECT 1 FROM nc_automatic_collections WHERE invoice_id=? AND status NOT IN ('revoked','invalidated'))
    AND NOT EXISTS(SELECT 1 FROM nc_invoice_payers WHERE invoice_id=?)
    AND NOT EXISTS(SELECT 1 FROM nc_credit_requests WHERE invoice_id=? AND status='pending')
    AND NOT EXISTS(SELECT 1 FROM nc_processor_objects WHERE invoice_id=? AND kind IN ('dispute','ach_return') AND status IN ('needs_response','under_review','lost','warning_needs_response','warning_under_review'))`, invoice, invoice, invoice, invoice, invoice, invoice, invoice, invoice, invoice)
}
export function rowGuard(env: Bindings, row: Row) {
  return guard(env, 'invoice_partial_state_changed', 'EXISTS(SELECT 1 FROM nc_invoice_partial_payments WHERE id=? AND revision=? AND status=?)', row.id, row.revision, row.status)
}
export function reservationGuard(env: Bindings, row: Row) {
  return guard(env, 'invoice_partial_reserved', 'EXISTS(SELECT 1 FROM nc_invoice_partial_reservations WHERE invoice_id=? AND request_id=?)', row.invoice_id, row.id)
}
export function partialAuthorityGuard(env: Bindings, row: Row) {
  const at = clockInstant(env)
  return guard(env, 'invoice_partial_authority_expired', `EXISTS(SELECT 1 FROM nc_invoice_partial_authority a
    JOIN oa_sessions s ON s.id=a.owner_session_id JOIN oa_operators o ON o.id=s.operator_id
    JOIN nc_members m ON m.email=lower(o.email) AND m.id=? JOIN nc_mfa_sessions f ON f.session_id=s.id AND f.member_id=m.id
    WHERE a.id=? AND m.status='active' AND m.role='owner' AND o.status='active' AND o.role='owner' AND s.operator_version=o.version
    AND s.revoked_at IS NULL AND s.expires_at>CAST(strftime('%s','now') AS INTEGER)*1000
    AND a.factor_verified_at BETWEEN ? AND ? AND f.method IN ('totp','passkey') AND f.verified_at>=a.factor_verified_at
    AND f.verified_at BETWEEN ? AND ?)`, row.prepared_by, row.id, at-STEP_UP_MS, at, at-STEP_UP_MS, at)
}
export async function currentSource(env: Bindings, row: Row) {
  const source = await sourceForPartial(env, row.invoice_id, row.id), basis = parseJson<Row>(row.basis_json, {})
  insist(await fingerprint(basis) === row.basis_hash && source.sourceHash === basis.sourceHash && source.row.balance_cents === row.balance_cents,
    'invoice_partial_source_changed', 409)
  const binding = await one(env, 'SELECT * FROM nc_stripe_customer_bindings WHERE id=? AND revision=? AND customer_id=? AND account_ref=? AND stripe_customer_ref=?',
    row.binding_id, row.binding_revision, row.customer_id, row.account_ref, row.customer_ref)
  insist(binding, 'invoice_partial_binding_changed', 409)
  return source
}
export function bindingFence(env: Bindings, row: Row) {
  return guard(env, 'invoice_partial_binding_changed', 'EXISTS(SELECT 1 FROM nc_stripe_customer_bindings WHERE id=? AND revision=? AND customer_id=? AND account_ref=? AND stripe_customer_ref=?)',
    row.binding_id, row.binding_revision, row.customer_id, row.account_ref, row.customer_ref)
}
export async function prepareInvoicePartial(env: Bindings, actor: Actor, input: Input) {
  const factor = await setupOwner(env, actor)
  input.only(['invoice','amount_cents','returnTo'])
  const source = await sourceForPartial(env, input.text('invoice', { max: 100 }))
  const amount = input.integer('amount_cents', { min: 50, max: 99999999 })
  insist(amount !== null && amount < source.row.balance_cents, 'invoice_partial_amount_invalid', 409)
  const selected = await stripeForAccount(env, source.accountRef)
  const binding = await one(env, 'SELECT * FROM nc_stripe_customer_bindings WHERE customer_id=? AND account_ref=?', source.row.customer_id, selected.account)
  insist(binding, 'native_customer_binding_required', 409)
  const customer = await selected.stripe(`/customers/${encodeURIComponent(binding.stripe_customer_ref)}`)
  insist(customer.object === 'customer' && customer.id === binding.stripe_customer_ref && customer.deleted !== true && customer.livemode === false, 'invoice_partial_test_customer_required', 409)
  const id = newId(), at = clockInstant(env), basis = { sourceHash: source.sourceHash, invoice: source.row.id, number: source.row.number,
    customer: source.row.customer_id, amountCents: amount, balanceCents: source.row.balance_cents, account: selected.account,
    customerRef: binding.stripe_customer_ref, binding: binding.id, bindingRevision: binding.revision, timezone: (await requireBusiness(env)).timezone }
  const hash = await fingerprint(basis)
  await commit(env, [...setupOwnerFence(env, actor), nativeSourceGuard(env, source), eligibleGuard(env, source.row.id),
    bindingFence(env, { binding_id: binding.id, binding_revision: binding.revision, customer_id: source.row.customer_id, account_ref: selected.account, customer_ref: binding.stripe_customer_ref }),
    stmt(env, `INSERT INTO nc_invoice_partial_payments(id,invoice_id,customer_id,status,amount_cents,balance_cents,basis_json,basis_hash,account_ref,customer_ref,binding_id,binding_revision,prepared_by,prepared_at,revision)
      VALUES(?,?,?,'prepared',?,?,?,?,?,?,?,?,?,?,?)`, id, source.row.id, source.row.customer_id, amount, source.row.balance_cents, canonical(basis), hash, selected.account, binding.stripe_customer_ref, binding.id, binding.revision, actor.id, at, newId()),
    stmt(env, 'INSERT INTO nc_invoice_partial_authority(id,customer_id,owner_session_id,factor_verified_at) VALUES(?,?,?,?)', id, source.row.customer_id, actor.sessionId, factor.verifiedAt),
  ], { actor: actorLabel(actor), action: 'invoice.partial.prepare', subject: id, detail: { invoice: source.row.id, amountCents: amount, balanceCents: source.row.balance_cents, basisHash: hash } })
  return partialPaymentView(await partialPaymentRow(env, id))
}
export async function confirmInvoicePartial(env: Bindings, actor: Actor, input: Input) {
  await setupOwner(env, actor)
  input.only(['request','basis_hash','invoice','customer','amount_cents','balance_cents','account_ref','stripe_customer_ref','scheduled_on','payment_method_ref','mandate_ref','confirm','returnTo'])
  const row = await partialPaymentRow(env, input.text('request', { max: 100 }))
  insist(row.prepared_by === actor.id && row.status === 'prepared', 'invoice_partial_state_changed', 409)
  insist(input.flag('confirm'), 'confirmation_required')
  insist(input.text('basis_hash', { max: 100 }) === row.basis_hash && input.text('invoice', { max: 100 }) === row.invoice_id
    && input.text('customer', { max: 100 }) === row.customer_id && input.text('account_ref', { max: 255 }) === row.account_ref
    && input.text('stripe_customer_ref', { max: 255 }) === row.customer_ref && input.integer('amount_cents', { min: 50 }) === row.amount_cents
    && input.integer('balance_cents', { min: 50 }) === row.balance_cents, 'invoice_partial_confirmation_changed', 409)
  const source = await currentSource(env, row)
  if (row.payment_kind === 'scheduled_ach') await validateScheduleConfirmation(env, row, input)
  await commit(env, [...setupOwnerFence(env, actor), partialAuthorityGuard(env, row), rowGuard(env, row), nativeSourceGuard(env, source), bindingFence(env, row), eligibleGuard(env, row.invoice_id),
    stmt(env, 'INSERT INTO nc_invoice_partial_reservations(invoice_id,request_id,customer_id,created_at) VALUES(?,?,?,?)', row.invoice_id, row.id, row.customer_id, clockInstant(env)),
    stmt(env, "UPDATE nc_invoice_partial_payments SET status='approved',approved_at=?,revision=? WHERE id=?", clockInstant(env), newId(), row.id),
  ], { actor: actorLabel(actor), action: 'invoice.partial.approve', subject: row.id, detail: { invoice: row.invoice_id, basisHash: row.basis_hash, amountCents: row.amount_cents } })
  return partialPaymentView(await partialPaymentRow(env, row.id))
}
export async function revokeInvoicePartial(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor)
  input.only(['request','returnTo'])
  const row = await partialPaymentRow(env, input.text('request', { max: 100 }))
  insist(['prepared','approved'].includes(row.status) || row.payment_kind === 'scheduled_ach' && row.status === 'open' && !row.claimed_at, 'invoice_partial_requires_reconciliation', 409)
  await commit(env, [...setupOwnerFence(env, actor), rowGuard(env, row), stmt(env,'DELETE FROM nc_invoice_partial_reservations WHERE request_id=?',row.id),
    stmt(env,'DELETE FROM nc_invoice_partial_authority WHERE id=?',row.id),
    stmt(env,'DELETE FROM nc_invoice_schedule_authority WHERE id=?',row.id),
    stmt(env,"UPDATE nc_invoice_partial_payments SET status='revoked',revision=? WHERE id=?",newId(),row.id)],
  {actor:actorLabel(actor),action:'invoice.partial.revoke',subject:row.id,detail:{invoice:row.invoice_id}})
  return partialPaymentView(await partialPaymentRow(env,row.id))
}

export async function ownInvoicePartials(env: Bindings, session: CustomerSession, invoice: string) {
  insist(session.audience === 'hosted', 'forbidden', 403)
  insist(await one(env, "SELECT 1 FROM nc_invoices WHERE id=? AND customer_id=? AND status='issued'", invoice, session.customer), 'invoice_not_found', 404)
  return all(env, `SELECT * FROM nc_invoice_partial_payments WHERE invoice_id=? AND customer_id=? AND status<>'prepared' ORDER BY prepared_at,id`, invoice, session.customer)
}
export async function startInvoicePartial(env: Bindings, session: CustomerSession, row: Row, input: Input, returnHash: string, returnExpiry: number) {
  input.only(['request','basis_hash','accept'])
  insist(input.flag('accept') && input.text('basis_hash',{max:100}) === row.basis_hash, 'invoice_partial_acceptance_required')
  insist(session.audience === 'hosted' && row.customer_id === session.customer, 'invoice_partial_not_found', 404)
  insist(row.payment_kind === 'card', 'invoice_partial_card_required', 409)
  insist(row.status === 'approved', 'invoice_partial_already_claimed', 409)
  const source = await currentSource(env,row), at=clockInstant(env), L=customerText(session.language)
  const consent = { version: 1, language: L.tag, wording: L.t('partial.accept'), invoice: row.invoice_id, number: source.row.number,
    account: row.account_ref, customer: row.customer_id, customerRef: row.customer_ref, amountCents: row.amount_cents, balanceCents: row.balance_cents,
    basisHash: row.basis_hash, portalSession: session.jti, acceptedAt: at }
  await commit(env,[customerSessionGuard(env,session),partialAuthorityGuard(env,row),rowGuard(env,row),reservationGuard(env,row),nativeSourceGuard(env,source),bindingFence(env,row),eligibleGuard(env,row.invoice_id),
    stmt(env,'INSERT INTO nc_invoice_partial_returns(id,request_id,customer_id,portal_session_id,expires_at) VALUES(?,?,?,?,?)',returnHash,row.id,row.customer_id,session.jti,returnExpiry),
    stmt(env,"UPDATE nc_invoice_partial_payments SET status='claimed',accepted_at=?,claimed_at=?,consent_json=?,revision=? WHERE id=?",at,at,canonical(consent),newId(),row.id)],
  {actor:'customer:invoice-partial',action:'invoice.partial.accept',subject:row.id,detail:{invoice:row.invoice_id,amountCents:row.amount_cents,basisHash:row.basis_hash}})
  let current=await partialPaymentRow(env,row.id)
  try {
    const selected=await stripeForAccount(env,row.account_ref)
    const customer=await selected.stripe(`/customers/${encodeURIComponent(row.customer_ref)}`)
    insist(customer.object==='customer'&&customer.id===row.customer_ref&&customer.livemode===false&&customer.deleted!==true,'invoice_partial_test_customer_required',409)
    // Recheck immediately before the only provider write. The durable claim is
    // retained even when the process stops between this check and the request.
    await currentSource(env,current)
    await commit(env,[customerSessionGuard(env,session),partialAuthorityGuard(env,current),rowGuard(env,current),reservationGuard(env,current)],{actor:'customer:invoice-partial',action:'invoice.partial.checkout.claim',subject:row.id})
    const returnUrl=`${session.origin}/portal/invoice-payment/return`
    const checkout=await selected.stripe('/checkout/sessions',new URLSearchParams({mode:'payment',customer:row.customer_ref,locale:L.tag.startsWith('es')?'es':'en',
      success_url:returnUrl,cancel_url:returnUrl,expires_at:String(Math.floor(at/1000)+1800),
      'payment_method_types[0]':'card','adaptive_pricing[enabled]':'false','saved_payment_method_options[payment_method_save]':'disabled',
      'metadata[nectar_invoice_partial]':row.id,'payment_intent_data[metadata][nectar_native_collection_key]':row.basis_hash,
      'payment_intent_data[metadata][nectar_native_collection_request]':row.id,'payment_intent_data[metadata][nectar_native_invoice]':row.invoice_id,
      'line_items[0][price_data][currency]':'usd','line_items[0][price_data][unit_amount]':String(row.amount_cents),
      'line_items[0][price_data][product_data][name]':L.t('partial.title'),'line_items[0][quantity]':'1'}),`nectar-invoice-partial-${row.id}`)
    checkPartialSession(checkout,row)
    const url=new URL(checkout.url)
    insist(url.origin==='https://checkout.stripe.com'&&!url.username&&!url.password&&!url.hash,'invoice_partial_checkout_invalid',409)
    await commit(env,[rowGuard(env,current),reservationGuard(env,current),stmt(env,"UPDATE nc_invoice_partial_payments SET status='open',session_ref=?,revision=? WHERE id=?",providerReference(checkout.id),newId(),row.id)],
    {actor:'customer:invoice-partial',action:'invoice.partial.checkout',subject:row.id,detail:{invoice:row.invoice_id}})
    return {id:row.id,status:'open',url:url.href}
  } catch {
    current=await partialPaymentRow(env,row.id)
    await commit(env,[rowGuard(env,current),stmt(env,"UPDATE nc_invoice_partial_payments SET status='uncertain',error_code='checkout_unconfirmed',revision=? WHERE id=?",newId(),row.id)],
    {actor:'customer:invoice-partial',action:'invoice.partial.uncertain',subject:row.id})
    return {id:row.id,status:'uncertain'}
  }
}
export function checkPartialSession(checkout: Row,row: Row) {
  insist(checkout.object==='checkout.session'&&checkout.mode==='payment'&&checkout.livemode===false&&checkout.currency==='usd'
    &&checkout.amount_total===row.amount_cents&&providerReference(checkout.customer)===row.customer_ref
    &&checkout.metadata?.nectar_invoice_partial===row.id&&(!row.session_ref||checkout.id===row.session_ref),'invoice_partial_checkout_mismatch',409)
}
async function findCheckout(stripe: StripeClient,row: Row) {
  if(row.session_ref){const found=await stripe(`/checkout/sessions/${encodeURIComponent(row.session_ref)}`);checkPartialSession(found,row);return found}
  const candidates:Row[]=[]
  let cursor=''
  for(let page=0;page<20;page++){
    const query=new URLSearchParams({customer:row.customer_ref,'created[gte]':String(Math.floor(row.claimed_at/1000)-300),limit:'100',...(cursor?{starting_after:cursor}:{})})
    const result=await stripe(`/checkout/sessions?${query}`)
    insist(result.object==='list'&&Array.isArray(result.data)&&typeof result.has_more==='boolean','invoice_partial_checkout_unconfirmed',409)
    candidates.push(...result.data.filter((c:Row)=>c.metadata?.nectar_invoice_partial===row.id))
    if(!result.has_more){insist(candidates.length===1,'invoice_partial_checkout_unconfirmed',409);checkPartialSession(candidates[0],row);return candidates[0]}
    const last=result.data.at(-1);insist(last&&providerReference(last.id)!==cursor,'invoice_partial_checkout_unconfirmed',409);cursor=providerReference(last.id)
  }
  insist(false,'invoice_partial_checkout_unconfirmed',409)
}
// Both customer completion and owner reconciliation are reads at Stripe. A
// missing or pending result never releases a reservation or creates Checkout.
export async function reconcileInvoicePartial(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor)
  input.only(['request','returnTo'])
  return partialPaymentView(await reconcilePartial(env,await partialPaymentRow(env,input.text('request',{max:100})),actor))
}
export async function reconcilePartial(env: Bindings,row: Row,actor?: Actor,session?: CustomerSession,returnHash?: string) {
  if (row.payment_kind === 'scheduled_ach') return reconcileScheduledPayment(env, row, session)
  if(['collected','expired'].includes(row.status))return row
  insist(['claimed','open','uncertain'].includes(row.status),'invoice_partial_not_reconcilable',409)
  if(session)insist(row.customer_id===session.customer&&session.audience==='hosted','forbidden',403)
  const source=await currentSource(env,row),selected=await stripeForAccount(env,row.account_ref),checkout=await findCheckout(selected.stripe,row)
  const guards=[rowGuard(env,row),reservationGuard(env,row),nativeSourceGuard(env,source),bindingFence(env,row),...(session?[customerSessionGuard(env,session)]:[])]
  if(returnHash)guards.push(guard(env,'invalid_customer_session','EXISTS(SELECT 1 FROM nc_invoice_partial_returns WHERE id=? AND request_id=? AND consumed_at IS NULL AND expires_at>?)',returnHash,row.id,clockInstant(env)))
  let proof:Row|null=null
  if(checkout.status==='expired'&&checkout.payment_status!=='paid'){
    if(checkout.payment_intent){const intent=await selected.stripe(`/payment_intents/${encodeURIComponent(providerReference(checkout.payment_intent))}`)
      insist(intent.object==='payment_intent'&&intent.id===providerReference(checkout.payment_intent)&&intent.customer===row.customer_ref&&intent.livemode===false&&intent.status==='canceled'&&intent.amount_received===0&&!intent.latest_charge
        &&intent.metadata?.nectar_native_collection_request===row.id&&intent.metadata?.nectar_native_invoice===row.invoice_id&&intent.metadata?.nectar_native_collection_key===row.basis_hash,'invoice_partial_checkout_unconfirmed',409)
      const charges=await selected.stripe(`/charges?${new URLSearchParams({payment_intent:intent.id,limit:'100'})}`)
      insist(charges.object==='list'&&charges.has_more===false&&Array.isArray(charges.data)&&charges.data.every((c:Row)=>c.paid!==true&&c.captured!==true&&c.status!=='succeeded'),'invoice_partial_checkout_unconfirmed',409)
    }
  } else {
    insist(checkout.status==='complete'&&checkout.payment_status==='paid','invoice_partial_payment_pending',409)
    const intentRef=providerReference(checkout.payment_intent),intent=await selected.stripe(`/payment_intents/${encodeURIComponent(intentRef)}`)
    insist(intent.id===intentRef,'invoice_partial_checkout_mismatch',409)
    proof=await capturedPayment(selected.stripe,intent,{accountRef:row.account_ref,customerRef:row.customer_ref,paymentMethodRef:providerReference(intent.payment_method),livemode:false,
      invoiceId:row.invoice_id,requestId:row.id,key:row.basis_hash,amountCents:row.amount_cents,currency:'USD'},parseJson<Row>(row.basis_json,{}).timezone)
    const method=await selected.stripe(`/payment_methods/${encodeURIComponent(proof.paymentMethodRef)}`)
    insist(method.object==='payment_method'&&method.id===proof.paymentMethodRef&&method.type==='card'&&method.livemode===false&&(!method.customer||providerReference(method.customer)===row.customer_ref),'invoice_partial_card_required',409)
    insist(proof.capturedAt>=row.claimed_at-300000&&proof.capturedAt<=clockInstant(env),'invoice_partial_capture_date_invalid',409)
  }
  const recordingActor:Actor=actor??{kind:'agent',id:'invoice-partial',name:'invoice-partial',email:'',role:null,sessionId:null,capabilities:new Set(['receivables'])}
  const financial=proof?await collectedPaymentStatements(env,recordingActor,{customerId:row.customer_id,invoiceId:row.invoice_id,amountCents:row.amount_cents,balanceCents:row.balance_cents,
    currency:'USD',receivedOn:proof.receivedOn,reference:`stripe:${row.account_ref}:${proof.paymentIntentRef}`,evidence:canonical(proof)}):null
  await commit(env,[...guards,
    stmt(env,'DELETE FROM nc_invoice_partial_reservations WHERE request_id=?',row.id),
    ...(financial?.statements??[]),
    stmt(env,"UPDATE nc_invoice_partial_payments SET status=?,session_ref=?,payment_intent_ref=?,charge_ref=?,payment_id=?,allocation_id=?,proof_json=?,completed_at=?,error_code=NULL,revision=? WHERE id=?",
      proof?'collected':'expired',providerReference(checkout.id),proof?.paymentIntentRef??null,proof?.chargeRef??null,financial?.paymentId??null,financial?.allocationId??null,canonical(proof),clockInstant(env),newId(),row.id),
    stmt(env,'DELETE FROM nc_invoice_partial_authority WHERE id=?',row.id),
    stmt(env,'UPDATE nc_invoice_partial_returns SET consumed_at=? WHERE request_id=?',clockInstant(env),row.id)],
  [...(financial?.audits??[]),{actor:actor?actorLabel(actor):'customer:invoice-partial',action:proof?'invoice.partial.collected':'invoice.partial.expired',subject:row.id,detail:{invoice:row.invoice_id,amountCents:row.amount_cents,payment:financial?.paymentId??null}}])
  return partialPaymentRow(env,row.id)
}
