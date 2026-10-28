// Corrections and reports resolve the same month-end contract authority.
import type { Bindings } from '../auth.server'
import type { Business } from './business'
import { all, insist, one } from './core'
import { addDays, addMonths } from './dates'
import { capturedNormalizedInput, capturedOwnsDate } from './movein/normalized-history'
import { normalizedEffect, NORMALIZED_POLICY, type NormalizedCorrection } from './normalized-metrics'
import type { RatingInput } from './rating'

export async function correctionMrr(env: Bindings, business: Business, before: RatingInput, after: RatingInput): Promise<NormalizedCorrection> {
  const sub = await one(env, 'SELECT * FROM nc_subscriptions WHERE id=?', before.subscription.id)
  insist(sub, 'subscription_not_found', 404)
  const history = sub.origin === 'import' ? await all(env,
    "SELECT * FROM nc_incumbent_history WHERE kind='subscription-event' AND customer_id=? AND subscription_ref=? ORDER BY occurred_on,id", sub.customer_id, sub.provider_ref) : []
  const periods = []
  for (let month = before.period.start.slice(0, 7); `${month}-01` < before.period.end; month = addMonths(`${month}-01`, 1).slice(0, 7)) {
    const through = addMonths(`${month}-01`, 1), asOf = addDays(through, -1)
    const captured = capturedOwnsDate(sub, asOf) ? capturedNormalizedInput(sub, history, through, business.timezone).input : null
    // Native amendments cannot rewrite the previous biller's retained history.
    periods.push(await normalizedEffect(captured ?? before, captured ?? after, asOf))
  }
  return { policyVersion: NORMALIZED_POLICY, periods }
}
