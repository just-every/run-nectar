// Scheduled observers watch dated facts, so most minutes they have nothing to
// learn. These gates keep an idle minute at a handful of rows: a full sweep runs
// only when the business's local day changed, an hour passed, or recorded
// activity suggests a source the commit-time capture does not cover.
import type { Bindings } from '../auth.server'
import { one } from './core'
import { localDate } from './dates'

export const HOUR_MS = 3_600_000
export const ACTIVITY_SWEEP_MS = 5 * 60_000

/** What the audit trail and usage ledger hold now; unchanged means no recorded change. */
export async function changeMarker(env: Bindings) {
  const row = (await one(env, 'SELECT (SELECT COALESCE(MAX(seq),0) FROM nc_audit) a,(SELECT COALESCE(MAX(rowid),0) FROM nc_usage_events) u'))!
  return `${row.a}:${row.u}`
}

/** True when a sweep that finished at `cleanAt` no longer covers `at`. */
export function sweepDue(at: number, cleanAt: number | null | undefined, timezone: string) {
  return cleanAt == null || at < cleanAt || at - cleanAt >= HOUR_MS || localDate(at, timezone) !== localDate(cleanAt, timezone)
}
