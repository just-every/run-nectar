// Freeze the same month ownership and retained operands used by reports.
import type { Bindings } from '../auth.server'
import type { Business } from './business'
import { all, insist, one } from './core'
import { addDays, addMonths } from './dates'
import { capturedNormalizedInput, usesCapturedContract } from './movein/normalized-history'
import { correctionMrr, normalizedEffect, NORMALIZED_POLICY, type NormalizedCorrection } from './normalized-metrics'
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
      const captured = capturedNormalizedInput(sub, history, through, business.timezone)
      // A native amendment cannot rewrite read-only incumbent history. Binding
      // its selected source also makes approval refuse a changed capture.
      periods.push({ ...await normalizedEffect(captured.input, captured.input, asOf), source: captured.source })
    } else periods.push(await normalizedEffect(before, after, asOf))
  }
  return { policyVersion: NORMALIZED_POLICY, periods }
}
