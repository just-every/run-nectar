import { selectedRetryPolicy } from './retry-policy'
import type { Bindings } from '../auth.server'
import { actorLabel, requireMember, type Actor } from './actor'
import { requireBusiness } from './business'
import { clockInstant } from './clock'
import { canonical, commit, fingerprint, guard, insist, newId, one, stmt } from './core'
import { requireDate, localDate } from './dates'
import { customerText } from './locale'
import type { Input } from './input'
import { requireFreshFactor } from './mfa'
import { collectionAuthority, collectionOwner } from './movein/collection-state'
import { customerSession } from './portal-session'
import { savedCollectionMethod } from './payments/default-method'
import { stripeForAccount } from './payments/stripe'
import { automaticAuthority, automaticView, storedAutomaticCollection, validateAutomaticBasis, type AutomaticQuote } from './automatic-collection-records'
const other = "SELECT 1 FROM nc_members WHERE id<>? AND role IN ('owner','finance') AND status='active'"

export async function prepareAutomaticCollection(env: Bindings, actor: Actor, input: Input) {
 await collectionOwner(env,actor)
 input.only(['invoice','issue_date','mandate_ref','enable_retries','returnTo'])
 const invoice=await one(env,`SELECT i.*,c.language,c.revision AS customer_revision FROM nc_invoices i JOIN nc_customers c ON c.id=i.customer_id
 WHERE i.id=? AND i.status IN ('draft','approved') AND c.erased_at IS NULL AND c.status='active'`,input.text('invoice',{max:100}))
 insist(invoice && invoice.currency==='USD' && invoice.total_cents>=50 && invoice.total_cents<=99999999,'automatic_collection_draft_required',409)
 insist(!await one(env,"SELECT 1 FROM nc_automatic_collections WHERE invoice_id=? AND status NOT IN ('revoked','invalidated')",invoice.id),'automatic_collection_exists',409)
 const business=await requireBusiness(env),calculation=JSON.parse(invoice.calculation_json),route=calculation.inputs?.invoiceContent?.billingEntity?.route
 const selected=await stripeForAccount(env,route?.processorAccountRef??null)
 const binding=await one(env,'SELECT * FROM nc_stripe_customer_bindings WHERE customer_id=? AND account_ref=?',invoice.customer_id,selected.account)
 insist(binding,'native_customer_binding_required',409)
 const method=await savedCollectionMethod(selected.stripe,binding.stripe_customer_ref,input.text('mandate_ref',{max:255,optional:true})||undefined)
 const issueDate=requireDate(input.text('issue_date',{max:10}),'issue_date')
 insist(issueDate>=localDate(clockInstant(env),business.timezone),'automatic_collection_date_invalid',409)
 const retryPolicy=input.flag('enable_retries')?await selectedRetryPolicy(env,invoice,method.kind):undefined
 const L=customerText(invoice.language),wording=L.t('automatic.consent',{merchant:business.legal_name,amount:L.money(invoice.total_cents),date:L.day(issueDate),last4:method.summary.last4,method:L.t(method.kind==='card'?'automatic.card':'automatic.bank')})+(retryPolicy?' '+L.t('automatic.retryConsent',{count:retryPolicy.maxAttempts,days:retryPolicy.windowDays,version:retryPolicy.version}):'')
 const q:AutomaticQuote={invoice:invoice.id,customer:invoice.customer_id,customerRevision:invoice.customer_revision,fingerprint:invoice.source_fingerprint,calculation:invoice.calculation_json,
 amountCents:invoice.total_cents,currency:'usd',accountRef:selected.account,bindingId:binding.id,bindingRevision:binding.revision,method,owner:actor.id,issueDate,businessRevision:business.revision,wording,wordingVersion:retryPolicy?'exact-invoice-retries-1':'exact-invoice-1',attempts:1,...(retryPolicy?{retryPolicy}:{})}
 const id=newId(),basis=await fingerprint(q),at=clockInstant(env)
 await commit(env,[collectionAuthority(env,actor),guard(env,'automatic_collection_draft_changed',"EXISTS(SELECT 1 FROM nc_invoices WHERE id=? AND status IN ('draft','approved') AND source_fingerprint=? AND calculation_json=?)",invoice.id,q.fingerprint,q.calculation),
 stmt(env,`INSERT INTO nc_automatic_collections(id,invoice_id,customer_id,status,basis_json,basis_hash,prepared_by,prepared_at,account_ref,stripe_customer_ref,payment_method_ref,amount_cents,method_kind,revision)
 VALUES(?,?,?,'awaiting_customer',?,?,?,?,?,?,?,?,?,?)`,id,invoice.id,invoice.customer_id,canonical(q),basis,actor.id,at,q.accountRef,method.customerRef,method.paymentMethodRef,q.amountCents,method.kind,newId()),stmt(env,'INSERT INTO nc_automatic_collection_authorizations(id,customer_id,invoice_id,basis_hash,created_by,created_at) VALUES(?,?,?,?,?,?)',id,invoice.customer_id,invoice.id,basis,actor.id,at)],
 {actor:actorLabel(actor),action:'automatic.collection.prepare',subject:id,detail:{invoice:invoice.id,basis,amountCents:q.amountCents,issueDate}})
 return automaticView(await storedAutomaticCollection(env,id))
}
export async function acceptAutomaticCollection(env:Bindings,request:Request,input:Input){
 const session=await customerSession(env,request),row=await storedAutomaticCollection(env,input.text('request',{max:100}))
 insist(request.method==='POST'&&request.headers.get('origin')===session.origin&&session.audience==='hosted','forbidden',403)
 insist(row.customer_id===session.customer,'automatic_collection_not_found',404)
 insist(input.flag('accept')&&input.text('basis_hash',{max:100})===row.basis_hash&&row.status==='awaiting_customer','automatic_collection_acceptance_changed',409)
 await validateAutomaticBasis(row);const at=clockInstant(env)
 await commit(env,[automaticAuthority(env,row,false),guard(env,'customer_session_changed','EXISTS(SELECT 1 FROM nc_portal_sessions WHERE id=? AND customer_id=? AND revoked_at IS NULL AND expires_at>?)',session.jti,session.customer,at),
 stmt(env,"UPDATE nc_automatic_collections SET status='pending_approval',customer_session_id=?,accepted_at=?,revision=? WHERE id=?",session.jti,at,newId(),row.id)],
 {actor:`customer:${session.customer}`,action:'automatic.collection.accept',subject:row.id,detail:{basis:row.basis_hash,wordingVersion:JSON.parse(row.basis_json).wordingVersion,session:session.jti}})
 return automaticView(await storedAutomaticCollection(env,row.id))
}
export async function decideAutomaticCollection(env:Bindings,actor:Actor,input:Input){
 requireMember(actor,'approve');await requireFreshFactor(env,actor)
 input.only(['request','basis_hash','decision','confirm','confirm_single','returnTo'])
 const row=await storedAutomaticCollection(env,input.text('request',{max:100})),decision=input.text('decision',{max:10})
 insist(input.flag('confirm')&&row.status==='pending_approval'&&input.text('basis_hash',{max:100})===row.basis_hash&&['approved','rejected'].includes(decision),'automatic_collection_approval_changed',409)
 await validateAutomaticBasis(row);const single=actor.id===row.prepared_by
 if(single){await collectionOwner(env,actor);insist(input.flag('confirm_single')&&!await one(env,other,actor.id),'second_approver_required',409)}
 await commit(env,[automaticAuthority(env,row,false),guard(env,'forbidden',"EXISTS(SELECT 1 FROM nc_members WHERE id=? AND role IN ('owner','finance') AND status='active')",actor.id),
 ...(single?[guard(env,'second_approver_required',`NOT EXISTS(${other})`,actor.id)]:[]),
 stmt(env,'UPDATE nc_automatic_collections SET status=?,approved_by=?,approved_at=?,approval_mode=?,revision=? WHERE id=?',decision==='approved'?'active':'revoked',actor.id,clockInstant(env),single?'single-approver':'two-person',newId(),row.id)],
 {actor:actorLabel(actor),action:`automatic.collection.${decision}`,subject:row.id,detail:{basis:row.basis_hash,approvalMode:single?'single-approver':'two-person'}})
 return automaticView(await storedAutomaticCollection(env,row.id))
}
export async function revokeAutomaticCollection(env:Bindings,actor:Actor,input:Input){
 await collectionOwner(env,actor);const row=await storedAutomaticCollection(env,input.text('request',{max:100}))
 const retryStop=!!(JSON.parse(row.basis_json).retryPolicy&&['refused','returned'].includes(row.status))
 insist(!row.claimed_at||retryStop,'automatic_collection_already_claimed',409)
 await commit(env,[collectionAuthority(env,actor),guard(env,'automatic_collection_state_changed','EXISTS(SELECT 1 FROM nc_automatic_collections WHERE id=? AND revision=?)',row.id,row.revision),stmt(env,"UPDATE nc_automatic_collections SET status='revoked',revision=? WHERE id=?",newId(),row.id)],{actor:actorLabel(actor),action:'automatic.collection.revoke',subject:row.id,detail:{basis:row.basis_hash}})
 return automaticView(await storedAutomaticCollection(env,row.id))
}

export async function withdrawAutomaticCollection(env:Bindings,request:Request,input:Input){
 const session=await customerSession(env,request),row=await storedAutomaticCollection(env,input.text('request',{max:100}))
 insist(request.method==='POST'&&request.headers.get('origin')===session.origin&&session.audience==='hosted','forbidden',403)
 insist(row.customer_id===session.customer,'automatic_collection_not_found',404)
 insist(input.flag('withdraw')&&(!row.claimed_at&&['awaiting_customer','pending_approval','active'].includes(row.status)||JSON.parse(row.basis_json).retryPolicy&&['refused','returned'].includes(row.status)),'automatic_collection_already_claimed',409)
 await commit(env,[automaticAuthority(env,row,false),guard(env,'customer_session_changed','EXISTS(SELECT 1 FROM nc_portal_sessions WHERE id=? AND customer_id=? AND revoked_at IS NULL AND expires_at>?)',session.jti,session.customer,clockInstant(env)),
 stmt(env,"UPDATE nc_automatic_collections SET status='revoked',revision=? WHERE id=?",newId(),row.id)],{actor:`customer:${session.customer}`,action:'automatic.collection.withdraw',subject:row.id,detail:{basis:row.basis_hash}})
 return automaticView(await storedAutomaticCollection(env,row.id))
}
