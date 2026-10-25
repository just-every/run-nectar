// Signed minimum commitments compared with the earnings and true-ups actually issued.
// A detector only reads: the true-up itself is the ordinary final invoice a person approves.
import type { Bindings } from '../auth.server'
import { all, fingerprint, type Row } from './core'
import { requireBusiness } from './business'
import { clockInstant } from './clock'
import { contractBurnDown } from './contract-terms'
import { today } from './dates'

export const TRUEUP_KIND = 'commitment_trueup'

/** One evidence record per signed minimum window that has ended with issued service. */
export async function trueUpEvidence(env: Bindings) {
  const day = today((await requireBusiness(env)).timezone, clockInstant(env))
  const subscriptions = await all(env, `SELECT DISTINCT s.id,s.customer_id,s.end_date FROM nc_contracts c JOIN nc_subscriptions s ON s.id=c.subscription_id
    JOIN nc_customers u ON u.id=s.customer_id WHERE c.status='approved' AND u.erased_at IS NULL ORDER BY s.id`)
  const found: Row[] = []
  for (const sub of subscriptions) {
    for (const window of await contractBurnDown(env, sub.id)) {
      const end = sub.end_date && sub.end_date < window.to ? sub.end_date : window.to
      if (end > day || !window.invoices.length) continue
      const source = `trueup:${window.contract}:${window.from}`
      const proof = { kind: TRUEUP_KIND, source, customer: sub.customer_id, subscription: sub.id, contract: window.contract,
        window: { from: window.from, to: window.to, end }, minimumCents: window.minimumCents, nominalMinimumCents: window.nominalMinimumCents,
        earnedCents: window.earnedCents, trueUpCents: window.trueUpCents, remainingCents: window.remainingCents,
        issuedThrough: (await all(env, 'SELECT MAX(period_end) AS day FROM nc_invoices WHERE id IN (' + window.invoices.map(() => '?').join(',') + ')', ...window.invoices.map((i: Row) => i.id)))[0].day as string,
        invoices: await Promise.all(window.invoices.map(async (i: Row) => {
          // The issuing person is the human-approved execution of the fix when a true-up line appears.
          const saved = (await all(env, 'SELECT issue_date,approved_by,issued_by FROM nc_invoices WHERE id=?', i.id))[0]
          return { invoice: i.id, number: i.number, earnedCents: i.earnedCents, trueUpCents: i.trueUpCents, issueDate: saved?.issue_date ?? null,
            ...(i.trueUpCents ? { approvedBy: saved?.approved_by ?? null, issuedBy: saved?.issued_by ?? null } : {}) }
        })),
        mismatch: window.remainingCents > 0 }
      found.push({ ...proof, basis: await fingerprint(proof) })
    }
  }
  return found
}
