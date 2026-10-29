// Preserve an explicit boundary cancellation even when the source omits its
// redundant cancel_at field. Ambiguous instants must never become extra bills.
import { insist } from '../core'
import { localDate, zonedStart } from '../dates'

export function importedCancellation(subscription: any, zone: string): string | null {
  const boundary = subscription.cancel_at_period_end === true ? subscription.current_period_end : null
  insist(subscription.cancel_at_period_end !== true || Number.isSafeInteger(boundary) && boundary > 0, 'unsupported_imported_cancellation', 400)
  const instant = subscription.status === 'canceled' ? subscription.ended_at ?? subscription.canceled_at
    : subscription.cancel_at ?? boundary
  if (instant == null) return null
  insist(Number.isSafeInteger(instant) && instant > 0 && instant < 253_402_214_400,
    'unsupported_imported_cancellation', 400)
  // Historical cancellations retain the existing dated history mapping.
  const date = localDate(instant * 1000, zone)
  insist(subscription.status === 'canceled' || zonedStart(date, zone) === instant * 1000,
    'unsupported_imported_cancellation', 400)
  insist(!boundary || instant === boundary, 'unsupported_imported_cancellation', 400)
  return date
}
