import type { RetryPolicy } from './retry-policy'
import type { Bindings } from '../auth.server'
import type { Actor } from './actor'
import { requireRead } from './actor'
import { all, fingerprint, guard, insist, one, parseJson, type Row } from './core'
import type { savedCollectionMethod } from './payments/default-method'

export interface AutomaticQuote {
 invoice: string; customer: string; customerRevision: string; fingerprint: string; calculation: string;
 amountCents: number; currency: 'usd'; accountRef: string; bindingId: string; bindingRevision: string;
 method: Awaited<ReturnType<typeof savedCollectionMethod>>; owner: string; issueDate: string; businessRevision: number;
 wording: string; wordingVersion: string; attempts: 1; retryPolicy?: RetryPolicy
}
export const automaticQuote = (row: Row) => parseJson<AutomaticQuote>(row.basis_json, null as never)
export async function storedAutomaticCollection(env: Bindings, id: string) {
 const row = await one(env, `SELECT a.*,EXISTS(SELECT 1 FROM nc_automatic_collection_authorizations z WHERE z.id=a.id AND z.basis_hash=a.basis_hash) AS authorized FROM nc_automatic_collections a JOIN nc_customers c ON c.id=a.customer_id
 WHERE a.id=? AND c.status='active' AND c.erased_at IS NULL AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN (a.id,a.customer_id,a.invoice_id))`, id)
 insist(row, 'automatic_collection_not_found', 404)
 return row
}
export function automaticAuthority(env: Bindings, row: Row, approved = true) {
 const q = automaticQuote(row)
 return guard(env, 'automatic_collection_authority_changed', `EXISTS(SELECT 1 FROM nc_automatic_collections a JOIN nc_invoices i ON i.id=a.invoice_id
 JOIN nc_automatic_collection_authorizations z ON z.id=a.id AND z.basis_hash=a.basis_hash
 JOIN nc_customers c ON c.id=a.customer_id JOIN nc_members m ON m.id=a.prepared_by JOIN oa_operators o ON o.email=m.email
 JOIN nc_stripe_customer_bindings b ON b.id=? WHERE a.id=? AND a.revision=? AND a.status=? AND a.basis_hash=?
 AND i.customer_id=c.id AND i.source_fingerprint=? AND i.calculation_json=? AND i.currency='USD'
 AND c.revision=? AND c.status='active' AND c.erased_at IS NULL AND m.status='active' AND m.role='owner' AND o.status='active' AND o.role='owner'
 AND b.customer_id=c.id AND b.revision=? AND b.account_ref=? AND b.stripe_customer_ref=?
 AND EXISTS(SELECT 1 FROM nc_business WHERE singleton=1 AND revision=?)
 ${approved ? "AND a.accepted_at IS NOT NULL AND a.approved_at IS NOT NULL AND EXISTS(SELECT 1 FROM nc_members f JOIN oa_operators fo ON lower(fo.email)=f.email WHERE f.id=a.approved_by AND f.role IN ('owner','finance') AND f.status='active' AND fo.status='active' AND ((f.role='owner' AND fo.role='owner') OR (f.role='finance' AND fo.role IN ('owner','member'))))" : ''})
 AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN (?,?,?))`, q.bindingId,row.id,row.revision,row.status,row.basis_hash,q.fingerprint,q.calculation,q.customerRevision,q.bindingRevision,q.accountRef,q.method.customerRef,q.businessRevision,row.id,row.customer_id,row.invoice_id)
}
export async function validateAutomaticBasis(row: Row) {
 const q=automaticQuote(row)
 insist(q && await fingerprint(q)===row.basis_hash && q.invoice===row.invoice_id && q.customer===row.customer_id && q.owner===row.prepared_by
 && q.amountCents===row.amount_cents && q.method.paymentMethodRef===row.payment_method_ref && q.accountRef===row.account_ref && q.attempts===1,'automatic_collection_basis_changed',409)
 return q
}
export function automaticView(row: Row) {
 const q=automaticQuote(row)
 return {id:row.id,historical:!row.authorized,invoice:row.invoice_id,customer:row.customer_id,status:row.status,basis:row.basis_hash,quote:q,
 amountCents:row.amount_cents,method:row.method_kind,paymentIntentRef:row.payment_intent_ref,payment:row.payment_id,
 acceptedAt:row.accepted_at,approvedAt:row.approved_at,approvalMode:row.approval_mode,claimedAt:row.claimed_at,settledAt:row.settled_at,errorCode:row.error_code}
}
export async function automaticCollections(env: Bindings, actor: Actor, customer?: string) {
 requireRead(actor,'payments'); requireRead(actor,'invoices')
 return (await all(env,`SELECT a.*,EXISTS(SELECT 1 FROM nc_automatic_collection_authorizations z WHERE z.id=a.id AND z.basis_hash=a.basis_hash) AS authorized FROM nc_automatic_collections a JOIN nc_customers c ON c.id=a.customer_id WHERE c.erased_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN (a.id,a.customer_id,a.invoice_id)) ${customer?'AND a.customer_id=?':''} ORDER BY a.prepared_at,a.id`,...(customer?[customer]:[]))).map(automaticView)
}
