// Settled payments and credits compared with the invoices they should have been applied to.
// A detector only reads: the application itself is the ordinary human-approved balance door.
import type { Bindings } from '../auth.server'
import { all, fingerprint, type Row } from './core'
import { BALANCE_SQL } from './balance-sql'
import { balanceSources } from './balance'

export const CREDIT_KIND = 'unapplied_credit'

/** One evidence record per customer holding available credit beside an invoice that still owes. */
export async function creditEvidence(env: Bindings) {
  const open = await all(env, `SELECT i.id,i.number,i.customer_id,${BALANCE_SQL} AS balance_cents FROM nc_invoices i JOIN nc_customers c ON c.id=i.customer_id
    WHERE i.status='issued' AND c.erased_at IS NULL AND ${BALANCE_SQL}>0 ORDER BY i.customer_id,i.issue_date,i.number`)
  const known = await all(env, `SELECT a.customer_id FROM nc_assurance_cases a JOIN nc_customers c ON c.id=a.customer_id WHERE a.kind=? AND c.erased_at IS NULL`, CREDIT_KIND)
  const customers = [...new Set([...open.map(r => r.customer_id as string), ...known.map(r => r.customer_id as string)])].sort()
  const found: Row[] = []
  for (const customer of customers) {
    const sources = await balanceSources(env, customer), invoices = open.filter(r => r.customer_id === customer)
    if (!sources.totalCents && !known.some(r => r.customer_id === customer)) continue
    const owedCents = invoices.reduce((n, r) => n + r.balance_cents, 0)
    const proof = { kind: CREDIT_KIND, source: `credit:${customer}`, customer,
      credits: [...sources.payments.map(p => ({ kind: 'payment', id: p.id, reference: p.reference, unappliedCents: p.unallocated })),
        ...sources.grants.map(g => ({ kind: 'goodwill', id: g.id, unappliedCents: g.remaining })),
        ...sources.carried.map(c => ({ kind: 'carried', id: c.id, unappliedCents: c.availableCents }))],
      availableCents: sources.totalCents, invoices: invoices.map(r => ({ invoice: r.id, number: r.number, balanceCents: r.balance_cents })), owedCents,
      applicableCents: Math.min(sources.totalCents, owedCents), mismatch: sources.totalCents > 0 && owedCents > 0 }
    found.push({ ...proof, basis: await fingerprint(proof) })
  }
  return found
}
