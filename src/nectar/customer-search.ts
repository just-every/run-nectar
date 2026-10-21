// CUS-001: resolve billing evidence to its owning customer. Parameters are
// literal substrings: %, _ and quotes never become query syntax or wildcards.
import type { Bindings } from '../auth.server'
import { all } from './core'

export async function customerEvidenceMatches(env: Bindings, search: string) {
  const text = search.toLowerCase()
  const rows = await all(env, `SELECT customer_id FROM nc_contacts WHERE instr(lower(email), ?) > 0
    UNION SELECT customer_id FROM nc_invoices WHERE status='issued' AND instr(lower(number), ?) > 0
    UNION SELECT customer_id FROM nc_credit_notes WHERE instr(lower(number), ?) > 0
    UNION SELECT customer_id FROM nc_payments WHERE instr(lower(reference), ?) > 0
    UNION SELECT customer_id FROM nc_incumbent_invoices WHERE instr(lower(number), ?) > 0 OR instr(lower(provider_ref), ?) > 0`,
    ...Array(6).fill(text))
  return new Set<string>(rows.map(row => row.customer_id))
}
