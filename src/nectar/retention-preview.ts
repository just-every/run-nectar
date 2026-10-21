import type { Bindings } from '../auth.server'
import type { Business } from './business'
import { fingerprint, type Row } from './core'
import { clockInstant } from './clock'
import { addMonths, localDate } from './dates'
import { ratingInputs } from './inputs'
import { rate, type RatingInput } from './rating'
import type { RetentionDuration } from './retention-interval'

/** Exact input/output evidence is saved with the offer and re-read at accept. */
export async function retentionPreview(env: Bindings, business: Business, sub: Row, duration: RetentionDuration, settings: Row, reactivating = false) {
  const schedule = duration.calendar ? duration.windows : Array.from({ length: settings.kind === 'pause' ? settings.pauseMonths : settings.months }, (_, i) => ({ period: { start: addMonths(duration.from, i), end: addMonths(duration.from, i + 1) } }))
  const periods: Row[] = []
  const reactivationDate=localDate(clockInstant(env),business.timezone)
  for (const scheduled of schedule) {
    const billing = duration.calendar ? duration.windows[periods.length] : undefined
    let before = await ratingInputs(env, business, sub.id, scheduled.period, undefined, billing)
    if (reactivating) before = { ...before, subscription: { ...before.subscription, endDate: null, contractEndDate: null }, lifecycle: before.lifecycle?.map(interval => interval.kind === 'cancellation' && interval.to === null ? { ...interval, to: reactivationDate < interval.from ? interval.from : reactivationDate } : interval) }
    const after: RatingInput = settings.kind === 'pause' ? { ...before, lifecycle: [...(before.lifecycle ?? []), { id: 'retention-preview', kind: 'pause', access: 'suspend', from: duration.from, to: duration.to }] } : { ...before, amendments: [...before.amendments, { id: 'retention-preview', kind: 'discount_percent', priceId: duration.priceId, value: String(settings.percent), from: duration.from, to: duration.to, note: 'Retention offer preview' }] }
    periods.push({ period: scheduled.period, ...(billing ? { billing } : {}), before: rate(before), after: rate(after), inputs: after, fingerprint: await fingerprint(after) })
  }
  return periods
}
