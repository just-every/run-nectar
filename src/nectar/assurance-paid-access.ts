// Settled payment for service that continues past a recorded end, compared with the credit owed for it.
// A detector only reads: the credit itself is an ordinary invoice-credit proposal a person approves.
import type { Bindings } from '../auth.server'
import { all, fingerprint, NectarError, type Row } from './core'
import { requireBusiness } from './business'
import { clockInstant } from './clock'
import { today } from './dates'
import { cancellationPlan } from './interval-cancel-plan'

export const PAID_KIND = 'paid_without_access'

/** One evidence record per ended subscription whose paid advance service runs past its end date. */
export async function paidAccessEvidence(env: Bindings) {
  const day = today((await requireBusiness(env)).timezone, clockInstant(env))
  const ended = await all(env, `SELECT s.id,s.customer_id,s.end_date FROM nc_subscriptions s JOIN nc_customers c ON c.id=s.customer_id
    WHERE c.erased_at IS NULL AND s.end_date IS NOT NULL AND s.end_date<=? ORDER BY s.id`, day)
  const found: Row[] = []
  for (const sub of ended) {
    let plan
    try { plan = await cancellationPlan(env, sub.id, sub.end_date, 'assurance', true, { allowAdjusted: true }) }
    // Only issued advance service can run past an end date; other invoice shapes have none to compare.
    catch (error) { if (error instanceof NectarError && error.status === 409) continue; throw error }
    if (!plan.credits.length) continue
    const invoices: Row[] = []
    for (const credit of plan.credits) {
      const credited = (await all(env, 'SELECT COALESCE(SUM(amount_cents),0) AS cents FROM nc_credit_notes WHERE invoice_id=?', credit.invoice))[0].cents as number
      const paidCents = (await all(env, 'SELECT COALESCE(SUM(amount_cents),0) AS cents FROM nc_allocations WHERE invoice_id=?', credit.invoice))[0].cents as number
      invoices.push({ invoice: credit.invoice, number: credit.number, paidCents, unusedCents: credit.amountCents, creditedCents: credited,
        remainingCents: paidCents > 0 ? Math.max(0, credit.amountCents - credited) : 0 })
    }
    const source = `paid:${sub.id}`
    // Goodwill grants a person made while naming this case also return paid service to the customer's balance.
    const caseRow = (await all(env, 'SELECT id FROM nc_assurance_cases WHERE source_id=?', source))[0]
    const grantedCents = caseRow ? (await all(env, `SELECT COALESCE(SUM(json_extract(detail,'$.amount')),0) AS cents FROM nc_audit WHERE action='balance.goodwill' AND json_extract(detail,'$.assuranceCase')=?`, caseRow.id))[0].cents as number : 0
    const remainingCents = Math.max(0, invoices.reduce((n, i) => n + i.remainingCents, 0) - grantedCents)
    const proof = { kind: PAID_KIND, source, customer: sub.customer_id, subscription: sub.id, endedOn: sub.end_date, invoices, grantedCents, remainingCents, mismatch: remainingCents > 0 }
    found.push({ ...proof, basis: await fingerprint(proof) })
  }
  return found
}
