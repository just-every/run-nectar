// Imported receivables retain their original identity and a separate cash ledger.
import type { Bindings } from '../auth.server'
import type { Actor } from './actor'
import { requireBusiness } from './business'
import { clockInstant } from './clock'
import { all, canonical, commit, fingerprint, guard, insist, newId, one, parseJson, stmt, type Row } from './core'
import { localDate } from './dates'
import type { Input } from './input'
import { invoiceFacts } from './movein/collection-provider'
import { collectionAuthority, collectionOwner, collectionSourceGuard, importedCollectionSource, matchOriginalInvoice } from './movein/collection-state'
import { providerReference, stripeForAccount, type StripeClient } from './payments/stripe'
import { completeList, ref, transactionStatement } from './processor-source'

const remaining = `i.remaining_cents-COALESCE((SELECT SUM(a.amount_cents) FROM nc_processor_cash_imported_applications a WHERE a.invoice_id=i.id AND a.status='collected'),0)`
async function sourceBinding(env: Bindings, invoice: string, account?: string) {
 const source=await importedCollectionSource(env,invoice)
 const b=await one(env,`SELECT b.* FROM nc_stripe_customer_bindings b WHERE b.customer_id=? AND b.stripe_customer_ref=? ${account?'AND b.account_ref=?':''}
 AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id=b.id)`,source.row.customer_id,ref(source.original.customer),...(account?[account]:[]))
 insist(b,'processor_cash_imported_binding_required',409)
 insist(!await one(env,'SELECT 1 FROM nc_imported_collections WHERE invoice_id=?',invoice),'processor_cash_imported_already_managed',409)
 return {source,b}
}
async function currentInvoice(stripe: StripeClient, source: Awaited<ReturnType<typeof importedCollectionSource>>, b: Row, disabled=false) {
 const live=invoiceFacts(await stripe(`/invoices/${encodeURIComponent(providerReference(source.row.provider_ref))}`))
 matchOriginalInvoice(source.original,live)
 insist(live.id===source.row.provider_ref&&live.customer===b.stripe_customer_ref&&live.livemode===false,'processor_cash_imported_source_changed',409)
 const customer=await stripe(`/customers/${encodeURIComponent(providerReference(b.stripe_customer_ref))}`)
 insist(customer.object==='customer'&&customer.id===b.stripe_customer_ref&&customer.deleted!==true&&customer.livemode===false,'processor_cash_imported_source_changed',409)
 const payments=await completeList(stripe,'/invoice_payments',{invoice:live.id})
 for(const row of payments) {
  insist(row.object==='invoice_payment'&&ref(row.invoice)===live.id,'processor_cash_imported_payment_pending',409)
  if(row.status==='open') {
   // Stripe lists an invoice's own unattempted PaymentIntent as its open default payment; anything attempted is pending.
   const intentRef=row.payment?.type==='payment_intent'?ref(row.payment.payment_intent):null
   insist(intentRef,'processor_cash_imported_payment_pending',409)
   const intent=await stripe(`/payment_intents/${encodeURIComponent(providerReference(intentRef))}`)
   insist(intent.object==='payment_intent'&&intent.id===intentRef&&intent.status==='requires_payment_method'&&!intent.latest_charge&&intent.amount_received===0,'processor_cash_imported_payment_pending',409)
  }
 }
 if(disabled)insist(live.auto_advance===false,'processor_cash_imported_not_disabled',409)
 return live
}
const bindingGuard=(env:Bindings,b:Row)=>guard(env,'processor_cash_imported_binding_changed',`EXISTS(SELECT 1 FROM nc_stripe_customer_bindings WHERE id=? AND revision=? AND customer_id=? AND account_ref=? AND stripe_customer_ref=?)`,b.id,b.revision,b.customer_id,b.account_ref,b.stripe_customer_ref)
function takeoverView(row:Row) {
 return {id:row.id,invoice:row.invoice_id,accountRef:row.account_ref,status:row.status,basisHash:row.basis_hash,amountCents:row.amount_cents,
 instructions:{confirm:row.status==='prepared'?{takeover:row.id,basis_hash:row.basis_hash,confirm:true,disable_auto_advance:true}:null,
 observe:row.status==='disabling'?{takeover:row.id,basis_hash:row.basis_hash,confirm:true,disable_auto_advance:true}:null}}
}
export async function prepareImportedCashTakeover(env:Bindings,actor:Actor,input:Input) {
 await collectionOwner(env,actor);input.only(['invoice','account_ref','returnTo'])
 const {source,b}=await sourceBinding(env,input.text('invoice',{max:100}),providerReference(input.text('account_ref',{max:255})))
 const {stripe}=await stripeForAccount(env,b.account_ref),live=await currentInvoice(stripe,source,b)
 const basis={source:await fingerprint(source.original),revision:source.row.revision,binding:b.revision,live},id=newId(),at=clockInstant(env)
 await commit(env,[collectionAuthority(env,actor),collectionSourceGuard(env,source),bindingGuard(env,b),
  stmt(env,`INSERT INTO nc_processor_cash_imported_takeovers(id,customer_id,invoice_id,account_ref,stripe_customer_ref,invoice_ref,status,basis_json,basis_hash,amount_cents,prepared_by,prepared_at)
  VALUES(?,?,?,?,?,?,'prepared',?,?,?,?,?)`,id,b.customer_id,source.row.id,b.account_ref,b.stripe_customer_ref,source.row.provider_ref,canonical(basis),await fingerprint(basis),source.row.remaining_cents,actor.id,at)],
  {actor:actor.id,action:'processor.cash.imported.prepare',subject:id,detail:{invoice:source.row.id,account:b.account_ref,amountCents:source.row.remaining_cents}})
 return takeoverView((await one(env,'SELECT * FROM nc_processor_cash_imported_takeovers WHERE id=?',id))!)
}
/** A lost disable response is observed with GETs; it never causes another POST. */
export async function confirmImportedCashTakeover(env:Bindings,actor:Actor,input:Input) {
 await collectionOwner(env,actor);input.only(['takeover','basis_hash','confirm','disable_auto_advance','returnTo'])
 insist(input.flag('confirm')&&input.flag('disable_auto_advance'),'processor_cash_imported_confirmation_required')
 const row=await one(env,'SELECT * FROM nc_processor_cash_imported_takeovers WHERE id=?',input.text('takeover',{max:100}))
 insist(row&&row.prepared_by===actor.id&&row.basis_hash===input.text('basis_hash',{max:100}),'processor_cash_imported_basis_changed',409)
 const {source,b}=await sourceBinding(env,row.invoice_id,row.account_ref),{stripe}=await stripeForAccount(env,b.account_ref)
 const basis=parseJson<Row>(row.basis_json,{})
 insist(basis.source===await fingerprint(source.original)&&basis.revision===source.row.revision&&basis.binding===b.revision,'processor_cash_imported_basis_changed',409)
 let live=await currentInvoice(stripe,source,b)
 if(row.status==='prepared'){
  insist(await fingerprint(live)===await fingerprint(basis.live),'processor_cash_imported_basis_changed',409)
  await commit(env,[collectionAuthority(env,actor),collectionSourceGuard(env,source),bindingGuard(env,b),
   guard(env,'processor_cash_imported_already_claimed',"EXISTS(SELECT 1 FROM nc_processor_cash_imported_takeovers WHERE id=? AND status='prepared')",row.id),
   stmt(env,"UPDATE nc_processor_cash_imported_takeovers SET status='disabling',approved_by=?,approved_at=? WHERE id=?",actor.id,clockInstant(env),row.id)],
   {actor:actor.id,action:'processor.cash.imported.claim',subject:row.id,detail:{invoice:row.invoice_id,collector:'customer_balance',disableAutomaticAdvancement:true}})
  // This write only stops automatic advancement. It cannot charge or mark paid.
  try{await stripe(`/invoices/${encodeURIComponent(providerReference(row.invoice_ref))}`,new URLSearchParams({auto_advance:'false'}),`nectar-cash-takeover-${row.id}`)}catch{return takeoverView({...row,status:'disabling'})}
  live=await currentInvoice(stripe,source,b)
 }
 if(live.auto_advance===false&&row.status!=='active')await commit(env,[collectionAuthority(env,actor),collectionSourceGuard(env,source),bindingGuard(env,b),
  stmt(env,"UPDATE nc_processor_cash_imported_takeovers SET status='active',disabled_at=? WHERE id=? AND status='disabling'",clockInstant(env),row.id)],
  {actor:actor.id,action:'processor.cash.imported.active',subject:row.id,detail:{invoice:row.invoice_id}})
 return takeoverView((await one(env,'SELECT * FROM nc_processor_cash_imported_takeovers WHERE id=?',row.id))!)
}
export async function importedCashCandidates(env:Bindings,b:Row) {
 return all(env,`SELECT i.*,${remaining} AS balance_cents,'imported' AS source_kind FROM nc_incumbent_invoices i JOIN nc_processor_cash_imported_takeovers t ON t.invoice_id=i.id
 JOIN nc_customers c ON c.id=i.customer_id WHERE t.status='active' AND t.account_ref=? AND t.stripe_customer_ref=? AND i.customer_id=?
 AND i.status='open' AND c.status='active' AND c.erased_at IS NULL AND ${remaining}>0
 AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(i.id,c.id,t.id)) ORDER BY i.issue_date,i.number,i.id`,b.account_ref,b.stripe_customer_ref,b.customer_id)
}
export async function importedCashSource(env:Bindings,stripe:StripeClient,b:Row,invoice:string) {
 const {source,b:currentBinding}=await sourceBinding(env,invoice,b.account_ref)
 insist(currentBinding.id===b.id&&currentBinding.revision===b.revision,'processor_cash_imported_binding_changed',409)
 const takeover=await one(env,"SELECT * FROM nc_processor_cash_imported_takeovers WHERE invoice_id=? AND status='active' AND account_ref=? AND stripe_customer_ref=?",invoice,b.account_ref,b.stripe_customer_ref)
 insist(takeover,'processor_cash_imported_takeover_required',409)
 await currentInvoice(stripe,source,b,true)
 const basis=parseJson<Row>(takeover.basis_json,{})
 insist(basis.source===await fingerprint(source.original)&&basis.revision===source.row.revision&&basis.binding===b.revision,'processor_cash_imported_basis_changed',409)
 const row=(await importedCashCandidates(env,b)).find(row=>row.id===invoice)
 insist(row,'processor_cash_imported_no_balance',409)
 return {...source,row,takeover,sourceHash:await fingerprint({original:source.original,takeover:takeover.id,binding:b.revision})}
}
/** Payment webhooks may precede the funding observation's final local commit. */
export async function observeImportedCashPayment(env:Bindings,stripe:StripeClient,b:Row,charge:Row,intent:Row|null,requireKnown=true) {
 const matches=await all(env,`SELECT * FROM nc_processor_cash_imported_applications WHERE account_ref=? AND customer_id=? AND stripe_customer_ref=?
 AND (charge_ref=? OR payment_intent_ref=? OR id=?)`,b.account_ref,b.customer_id,b.stripe_customer_ref,charge.id,intent?.id??null,intent?.metadata?.nectar_cash_application??null)
 insist(matches.length<=1,'processor_cash_imported_evidence_invalid',409)
 const row=matches[0]
 if(!row){insist(!requireKnown||!intent?.metadata?.nectar_imported_invoice,'processor_cash_imported_claim_required',409);return null}
 insist(intent&&intent.object==='payment_intent'&&intent.id===ref(charge.payment_intent)&&ref(intent.latest_charge)===charge.id
 && intent.metadata?.nectar_imported_invoice===row.invoice_id&&intent.metadata?.nectar_cash_application===row.id&&intent.metadata?.nectar_cash_transfer===row.transfer_ref
 && !intent.metadata?.nectar_native_invoice&&!charge.metadata?.nectar_native_invoice
 && intent.amount===row.amount_cents&&intent.currency===row.currency&&intent.amount_received===row.amount_cents&&intent.amount_capturable===0&&intent.status==='succeeded'
 && intent.livemode===false&&ref(intent.customer)===b.stripe_customer_ref&&intent.payment_method_types?.length===1&&intent.payment_method_types[0]==='customer_balance'
 && charge.object==='charge'&&charge.amount===row.amount_cents&&charge.amount_captured===row.amount_cents&&charge.currency===row.currency
 && charge.status==='succeeded'&&charge.paid===true&&charge.captured===true&&charge.livemode===false&&ref(charge.customer)===b.stripe_customer_ref
 && charge.payment_method_details?.type==='customer_balance'&&(!row.payment_intent_ref||row.payment_intent_ref===intent.id)&&(!row.charge_ref||row.charge_ref===charge.id),
 'processor_cash_imported_evidence_invalid',409)
 const {source,b:current}=await sourceBinding(env,row.invoice_id,b.account_ref)
 const takeover=await one(env,"SELECT * FROM nc_processor_cash_imported_takeovers WHERE id=? AND status='active'",row.takeover_id)
 insist(takeover&&current.id===b.id&&current.revision===b.revision&&takeover.customer_id===b.customer_id&&takeover.account_ref===b.account_ref&&takeover.stripe_customer_ref===b.stripe_customer_ref,'processor_cash_imported_basis_changed',409)
 const basis=parseJson<Row>(takeover.basis_json,{})
 insist(basis.source===await fingerprint(source.original)&&basis.revision===source.row.revision&&basis.binding===b.revision
 && row.source_hash===await fingerprint({original:source.original,takeover:takeover.id,binding:b.revision}),'processor_cash_imported_basis_changed',409)
 await currentInvoice(stripe,source,b,true)
 const captured=(await completeList(stripe,'/charges',{payment_intent:intent.id})).filter(item=>item.status==='succeeded'&&item.paid===true&&item.captured===true)
 insist(captured.length===1&&captured[0].id===charge.id,'processor_cash_imported_evidence_invalid',409)
 return row
}
type CashSource=Awaited<ReturnType<typeof importedCashSource>>
function cashSourceGuard(env:Bindings,b:Row,source:CashSource,amount:number) {
 return guard(env,'processor_cash_imported_source_changed',`EXISTS(SELECT 1 FROM nc_incumbent_invoices i JOIN nc_processor_cash_imported_takeovers t ON t.invoice_id=i.id
 JOIN nc_customers c ON c.id=i.customer_id WHERE i.id=? AND i.revision=? AND i.source_json=? AND t.id=? AND t.status='active'
 AND t.account_ref=? AND t.stripe_customer_ref=? AND c.id=? AND c.status='active' AND c.erased_at IS NULL AND ${remaining}>=?
 AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(i.id,t.id,c.id)))`,source.row.id,source.row.revision,source.row.source_json,source.takeover.id,b.account_ref,b.stripe_customer_ref,b.customer_id,amount)
}
export function importedCashClaimStatements(env:Bindings,b:Row,source:CashSource,row:Row) {
 insist(row.amount_cents>0&&row.amount_cents<=source.row.balance_cents&&row.invoice_id===source.row.id,'processor_cash_imported_amount_invalid',409)
 return [bindingGuard(env,b),cashSourceGuard(env,b,source,row.amount_cents),stmt(env,`INSERT INTO nc_processor_cash_imported_applications
 (id,customer_id,invoice_id,takeover_id,account_ref,stripe_customer_ref,transfer_ref,amount_cents,currency,source_hash,claimed_at,status)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,'uncertain')`,row.id,b.customer_id,source.row.id,source.takeover.id,b.account_ref,b.stripe_customer_ref,row.transfer_ref,row.amount_cents,row.currency,source.sourceHash,row.claimed_at)]
}
export async function importedCashSettlementStatements(env:Bindings,stripe:StripeClient,b:Row,row:Row,intent:Row,charge:Row) {
 const source=await importedCashSource(env,stripe,b,row.invoice_id),intentRef=providerReference(intent.id),chargeRef=providerReference(charge.id)
 insist(source.sourceHash===row.source_hash&&intent.object==='payment_intent'&&intent.status==='succeeded'&&intent.amount===row.amount_cents&&intent.amount_received===row.amount_cents
 && intent.amount_capturable===0&&intent.currency===row.currency&&ref(intent.customer)===b.stripe_customer_ref&&intent.livemode===false
 && intent.metadata?.nectar_imported_invoice===row.invoice_id&&intent.metadata?.nectar_cash_application===row.id&&intent.metadata?.nectar_cash_transfer===row.transfer_ref
 && intent.payment_method_types?.length===1&&intent.payment_method_types[0]==='customer_balance'&&(!row.payment_intent_ref||row.payment_intent_ref===intentRef)
 && charge.object==='charge'&&ref(intent.latest_charge)===chargeRef&&ref(charge.payment_intent)===intentRef&&ref(charge.customer)===b.stripe_customer_ref&&charge.currency===row.currency
 && charge.status==='succeeded'&&charge.paid===true&&charge.captured===true&&charge.amount===row.amount_cents&&charge.amount_captured===row.amount_cents
 && charge.amount_refunded===0&&charge.refunded===false&&charge.disputed===false&&charge.livemode===false&&charge.payment_method_details?.type==='customer_balance'
 && Number.isSafeInteger(charge.created)&&charge.created>0&&charge.created*1000<=clockInstant(env),'processor_cash_imported_evidence_invalid',409)
 const proof={kind:'imported_processor_cash_application',accountRef:b.account_ref,invoiceRef:source.row.provider_ref,customerRef:b.stripe_customer_ref,
  transferRef:row.transfer_ref,paymentIntentRef:intentRef,chargeRef,amountCents:row.amount_cents,currency:row.currency,capturedAt:charge.created*1000}
 const statements=[bindingGuard(env,b),cashSourceGuard(env,b,source,row.amount_cents),
  guard(env,'processor_cash_imported_already_recorded',"EXISTS(SELECT 1 FROM nc_processor_cash_imported_applications WHERE id=? AND status='uncertain')",row.id),
  stmt(env,`UPDATE nc_processor_cash_imported_applications SET status='collected',payment_intent_ref=?,charge_ref=?,collected_on=?,proof_json=?,reconciled_at=? WHERE id=?`,
   intentRef,chargeRef,localDate(proof.capturedAt,(await requireBusiness(env)).timezone),canonical(proof),clockInstant(env),row.id)]
 if(ref(charge.balance_transaction)){
  const transaction=await stripe(`/balance_transactions/${encodeURIComponent(providerReference(ref(charge.balance_transaction)))}`)
  insist(ref(transaction.source)===chargeRef&&transaction.amount===row.amount_cents&&transaction.currency===row.currency,'processor_cash_imported_evidence_invalid',409)
  statements.push(await transactionStatement(env,b.account_ref,transaction,{customer:b.customer_id}))
 }
 return statements
}
/** Same typed shape as existing imported collection custody for report unions. */
export async function importedCashCollections(env:Bindings,customer?:string) {
 return all(env,`SELECT a.*,i.number,i.provider_ref AS invoice_ref,a.payment_intent_ref AS payment_ref
 FROM nc_processor_cash_imported_applications a JOIN nc_incumbent_invoices i ON i.id=a.invoice_id WHERE a.status='collected' ${customer?'AND a.customer_id=?':''}`, ...(customer?[customer]:[]))
}
