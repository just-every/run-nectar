import type { Bindings } from '../../auth.server'
import type { Actor } from '../actor'
import { all, one, type Row } from '../core'
import { BALANCE_SQL } from '../receivables'
import { cents, check, field, form, h, select, type Html } from './html'

/** An explicit verification of existing cash, never a debit or mandate form. */
export async function achPaymentEvidenceSection(env: Bindings, actor: Actor, customer: Row): Promise<Html | string> {
  if(actor.kind!=='member'||actor.role!=='owner'||customer.erased_at||customer.status!=='active'
    ||await one(env,'SELECT 1 FROM nc_erased_records WHERE record_id=?',customer.id))return ''
  const [bindings,invoices]=await Promise.all([
    all(env,'SELECT account_ref FROM nc_stripe_customer_bindings WHERE customer_id=? ORDER BY account_ref',customer.id),
    all(env,`SELECT i.id,i.number,i.currency,${BALANCE_SQL} AS balance_cents FROM nc_invoices i
      WHERE i.customer_id=? AND i.status='issued' AND NOT EXISTS(SELECT 1 FROM nc_native_collection_claims WHERE invoice_id=i.id)
      AND NOT EXISTS(SELECT 1 FROM nc_prepaid_topup_claims WHERE invoice_id=i.id)
      AND NOT EXISTS(SELECT 1 FROM nc_invoice_payers WHERE invoice_id=i.id)
      AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id=i.id) ORDER BY i.issue_date,i.id`,customer.id),
  ])
  const owed=invoices.filter(invoice=>invoice.balance_cents>=50)
  if(!bindings.length||!owed.length)return ''
  return h`<section class="card" id="verify-ach-payment"><h2>Verify an external ACH payment</h2>
    <p>Record an ACH payment already settled on this customer's held Stripe account. Verification reads the processor and records the exact remaining invoice balance once. It does not initiate a debit or send a receipt.</p>
    ${form('payment.ach_evidence.record',`/app/customers/${customer.id}`,h`
      ${select('Unpaid invoice','invoice',owed.map(invoice=>({value:invoice.id,label:`${invoice.number} · ${cents(invoice.balance_cents,invoice.currency)}`})))}
      ${select('Held processor account','account_ref',bindings.map(binding=>({value:binding.account_ref,label:binding.account_ref})))}
      ${field('Existing payment intent','payment_intent_ref',{hint:'The settled bank payment must identify this exact invoice in its nectar_native_invoice metadata.'})}
      ${check('Verify this existing settled payment and record its cash against this invoice once.','confirm')}`,'Verify settled payment',{secondary:true,layout:'columns'})}
  </section>`
}
