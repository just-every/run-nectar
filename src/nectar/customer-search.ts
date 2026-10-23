// CUS-001 evidence lookup. instr keeps %, _ and quotes literal.
import type { Bindings } from '../auth.server'
import { canRead, type Actor } from './actor'
import { all } from './core'
import { customerProcessorFacts } from './customer-billing-record'

export async function customerEvidenceMatches(env: Bindings, search: string, actor?: Actor) {
  const text = search.toLowerCase()
  const rows = await all(env, `SELECT customer_id FROM nc_contacts WHERE instr(lower(email), ?) > 0
    UNION SELECT customer_id FROM nc_invoices WHERE status='issued' AND instr(lower(number), ?) > 0
    UNION SELECT customer_id FROM nc_credit_notes WHERE instr(lower(number), ?) > 0
    UNION SELECT customer_id FROM nc_payments WHERE instr(lower(reference), ?) > 0
    UNION SELECT customer_id FROM nc_incumbent_invoices WHERE instr(lower(number), ?) > 0 OR instr(lower(provider_ref), ?) > 0`,
    ...Array(6).fill(text))
  const found = new Set<string>(rows.map(row => row.customer_id))
  if (!actor || !canRead(actor, 'payments') || !canRead(actor, 'invoices')) return found
  const financial = await all(env, `SELECT r.customer_id FROM nc_prepaid_refunds r JOIN nc_customers c ON c.id=r.customer_id
      WHERE c.erased_at IS NULL AND instr(lower(r.refund_ref),?)>0
    UNION SELECT r.customer_id FROM nc_incumbent_history r JOIN nc_customers c ON c.id=r.customer_id
      WHERE c.erased_at IS NULL AND r.kind IN ('payment','refund','dispute') AND instr(lower(r.provider_ref),?)>0
    UNION SELECT r.customer_id FROM nc_imported_collections r JOIN nc_customers c ON c.id=r.customer_id
      WHERE c.erased_at IS NULL AND (instr(lower(r.charge_ref),?)>0 OR instr(lower(r.payment_intent_ref),?)>0)`, text, text, text, text)
  for (const row of financial) found.add(row.customer_id)
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
