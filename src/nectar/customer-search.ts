// CUS-001 evidence lookup. instr keeps %, _ and quotes literal.
import type { Bindings } from '../auth.server'
import { canRead, type Actor } from './actor'
import { all } from './core'
import { customerProcessorFacts } from './customer-billing-record'

export async function customerEvidenceMatches(env: Bindings, search: string, actor?: Actor) {
  const text = search.toLowerCase()
  const contacts=await all(env,'SELECT customer_id FROM nc_contacts WHERE instr(lower(email),?)>0',text)
  const found=new Set<string>(contacts.map(row=>row.customer_id))
  if(actor&&canRead(actor,'invoices')){
    const invoices=await all(env,`SELECT customer_id FROM nc_invoices WHERE status='issued' AND instr(lower(number),?)>0
      UNION SELECT customer_id FROM nc_credit_notes WHERE instr(lower(number),?)>0
      UNION SELECT customer_id FROM nc_incumbent_invoices WHERE instr(lower(number),?)>0 OR instr(lower(provider_ref),?)>0`,...Array(4).fill(text))
    for(const row of invoices)found.add(row.customer_id)
  }
  if (!actor || !canRead(actor, 'payments') || !canRead(actor, 'invoices')) return found
  const paymentReferences=await all(env,'SELECT customer_id FROM nc_payments WHERE instr(lower(reference),?)>0',text)
  for(const row of paymentReferences)found.add(row.customer_id)
  const receipts=await all(env,`SELECT p.customer_id FROM nc_payment_receipts r JOIN nc_payments p ON p.id=r.payment_id
    JOIN nc_customers c ON c.id=p.customer_id WHERE c.erased_at IS NULL AND instr(lower(r.number),?)>0
    AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(p.id,c.id))`,text)
  for(const receipt of receipts)found.add(receipt.customer_id)
  const financial = await all(env, `SELECT r.customer_id FROM nc_prepaid_refunds r JOIN nc_customers c ON c.id=r.customer_id
      WHERE c.erased_at IS NULL AND instr(lower(r.refund_ref),?)>0
    UNION SELECT e.customer_id FROM nc_ach_payment_evidence e JOIN nc_customers c ON c.id=e.customer_id
      WHERE c.erased_at IS NULL AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(e.id,e.customer_id,e.invoice_id))
      AND (instr(lower(e.payment_intent_ref),?)>0 OR instr(lower(e.charge_ref),?)>0)
    UNION SELECT r.customer_id FROM nc_incumbent_history r JOIN nc_customers c ON c.id=r.customer_id
      WHERE c.erased_at IS NULL AND r.kind IN ('payment','refund','dispute') AND instr(lower(r.provider_ref),?)>0
    UNION SELECT r.customer_id FROM nc_imported_collections r JOIN nc_customers c ON c.id=r.customer_id
      WHERE c.erased_at IS NULL AND (instr(lower(r.charge_ref),?)>0 OR instr(lower(r.payment_intent_ref),?)>0)`, text, text, text, text, text, text)
  for (const row of financial) found.add(row.customer_id)
  const automatic=await all(env,`SELECT a.customer_id,a.payment_intent_ref,a.charge_ref,a.method_kind,json_extract(a.basis_json,'$.method.summary.brand') AS brand,json_extract(a.basis_json,'$.method.summary.last4') AS last4 FROM nc_automatic_collections a JOIN nc_customers c ON c.id=a.customer_id WHERE c.erased_at IS NULL AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(a.id,c.id,a.invoice_id))`)
  for(const row of automatic){
    if([row.payment_intent_ref,row.charge_ref].some(ref=>typeof ref==='string'&&ref.toLowerCase().includes(text)))found.add(row.customer_id)
    const tokens=text.replace(/[^a-z0-9]+/g,' ').trim().split(/\s+/)
    if(row.method_kind==='card'&&(text===row.last4||tokens.length===2&&tokens.includes(String(row.brand).toLowerCase())&&tokens.includes(row.last4)))found.add(row.customer_id)
  }
  const savedCards=await all(env,`SELECT m.last4,m.brand,m.customer_id FROM nc_customer_payment_methods m
    JOIN nc_customer_payment_method_snapshots s ON s.id=m.snapshot_id AND s.customer_id=m.customer_id
    JOIN nc_stripe_customer_bindings b ON b.id=s.binding_id AND b.revision=s.binding_revision AND b.account_ref=s.account_ref AND b.stripe_customer_ref=s.stripe_customer_ref
    JOIN nc_customers c ON c.id=m.customer_id WHERE c.erased_at IS NULL AND m.kind='card'
    AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN (m.id,s.id,b.id,c.id))
    UNION SELECT json_extract(s.method_json,'$.last4') AS last4,json_extract(s.method_json,'$.brand') AS brand,s.customer_id FROM nc_hosted_setups s
    JOIN nc_stripe_customer_bindings b ON b.id=s.binding_id AND b.revision=s.binding_revision JOIN nc_customers c ON c.id=s.customer_id
    WHERE c.erased_at IS NULL AND s.status='complete' AND s.method='card'
    AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN (s.id,b.id,c.id))
    UNION SELECT json_extract(h.method_json,'$.last4'),json_extract(h.method_json,'$.brand'),h.customer_id FROM nc_hosted_setup_history h JOIN nc_customers c ON c.id=h.customer_id
    WHERE c.erased_at IS NULL AND h.status='complete' AND h.method='card' AND h.method_json IS NOT NULL AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(h.id,c.id))`)
  const linked=await all(env,`SELECT a.customer_id,json_extract(a.method_json,'$.last4') AS last4,json_extract(a.method_json,'$.brand') AS brand FROM nc_payment_link_attributions a JOIN nc_customers c ON c.id=a.customer_id WHERE c.erased_at IS NULL AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(a.id,a.customer_id,a.subscription_id))`)
  savedCards.push(...linked)
  const checkoutRefs=await all(env,`SELECT a.customer_id,a.payment_intent_ref,a.charge_ref FROM nc_payment_link_attributions a JOIN nc_customers c ON c.id=a.customer_id WHERE c.erased_at IS NULL AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(a.id,a.customer_id,a.invoice_id,a.subscription_id))`)
  for(const row of checkoutRefs)if([row.payment_intent_ref,row.charge_ref].some(ref=>typeof ref==='string'&&ref.toLowerCase().includes(text)))found.add(row.customer_id)
  for(const card of savedCards){const tokens=text.replace(/[^a-z0-9]+/g,' ').trim().split(/\s+/);if(text===card.last4||tokens.length===2&&tokens.includes(card.brand.toLowerCase())&&tokens.includes(card.last4))found.add(card.customer_id)}
  for (const row of await customerProcessorFacts(env)) {
    if ([row.paymentIntentRef, row.chargeRef].some(ref => typeof ref === 'string' && ref.toLowerCase().includes(text))) found.add(row.customer)
    if (!row.card) continue
    const brand = row.card.brand.toLowerCase(), last4 = row.card.last4
    // Last four alone works. When brand is supplied as well, both must match;
    // the correct four digits must never rescue a mismatched brand.
    const tokens = text.replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/)
    if (text === last4 || tokens.length === 2 && tokens.includes(brand) && tokens.includes(last4)) found.add(row.customer)
  }
  return found
}
