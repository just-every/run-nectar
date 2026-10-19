import type { Bindings } from '../auth.server'
import { all, parseJson, type Row } from './core'
import type { LifecycleInterval } from './lifecycle-math'

export const LIFECYCLE_RATING_VERSION = 'nectar-rating-4'
export const lifecycleHistory = (env: Bindings, subscription: string) => all(env,
  'SELECT * FROM nc_subscription_lifecycle WHERE subscription_id=? ORDER BY seq', subscription)

export function lifecycleIntervals(history: Row[]): LifecycleInterval[] {
  return history.filter(e => e.kind === 'pause' || e.kind === 'cancel').map(e => {
    const close = history.find(c => c.related_id === e.id)
    const end = close?.effective_date ?? e.until_date
    return { id: e.id, from: e.effective_date, to: end ?? null, access: e.access,
      kind: e.kind === 'pause' ? 'pause' : 'cancellation',
      ...(e.kind === 'cancel' ? {creditUnused: parseJson<Row>(e.policy_json, {}).creditUnused !== false} : {}) }
  })
}
