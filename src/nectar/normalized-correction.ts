// Freeze the same month ownership and retained operands used by reports.
import type { Bindings } from '../auth.server'
import type { Business } from './business'
import { all, fingerprint, insist, NectarError, one } from './core'
import { addDays, addMonths } from './dates'
import { capturedNormalizedInput, usesCapturedContract } from './movein/normalized-history'
import { correctionMrr, normalizedEffect, NORMALIZED_POLICY, type NormalizedCorrection, type NormalizedSnapshot } from './normalized-metrics'
import type { RatingInput } from './rating'

export async function normalizedCorrection(env: Bindings, business: Business, before: RatingInput, after: RatingInput): Promise<NormalizedCorrection> {
  const sub = await one(env, 'SELECT * FROM nc_subscriptions WHERE id=?', before.subscription.id)
  insist(sub, 'subscription_not_found', 404)
  if (sub.origin !== 'import') return correctionMrr(before, after)
  const history = await all(env, "SELECT * FROM nc_incumbent_history WHERE customer_id=? AND subscription_ref=? AND kind='subscription-event' ORDER BY occurred_on,id", sub.customer_id, sub.provider_ref)
  const periods: NormalizedCorrection['periods'] = []
  for (let month = before.period.start.slice(0, 7); `${month}-01` < before.period.end; month = addMonths(`${month}-01`, 1).slice(0, 7)) {
    const through = addMonths(`${month}-01`, 1), asOf = addDays(through, -1)
    if (usesCapturedContract(sub, asOf)) {
      try {
        const captured = capturedNormalizedInput(sub, history, through, business.timezone)
        // A native amendment cannot rewrite read-only incumbent history. Binding
        // its selected source also makes approval refuse a changed capture.
        periods.push({ ...await normalizedEffect(captured.input, captured.input, asOf), source: captured.source })
      } catch (error) {
        if (!(error instanceof NectarError && error.code === 'normalized_history_evidence_required')) throw error
        // A shadow correction remains reviewable without pretending its capture
        // qualifies for historical metrics. Bind the absence and retained sources
        // into approval, but publish no supported MRR amount for either side.
        const unavailable = async (input: RatingInput): Promise<NormalizedSnapshot> => ({
          policyVersion: NORMALIZED_POLICY, asOf, subscriptionId: sub.id,
          fingerprint: await fingerprint({ policyVersion: NORMALIZED_POLICY, asOf, input, history }),
          supported: false, exclusions: ['captured_contract_history_unavailable'], active: false,
          mrrCents: 0, arrCents: 0, exactMrrCents: { numerator: '0', denominator: '1' }, components: [],
        })
        periods.push({ policyVersion: NORMALIZED_POLICY, before: await unavailable(before), after: await unavailable(after), deltaMrrCents: 0, deltaArrCents: 0 })
      }
    } else periods.push(await normalizedEffect(before, after, asOf))
  }
  return { policyVersion: NORMALIZED_POLICY, periods }
}
