// Native state input shared by entitlement decisions and future lifecycle jobs.
// Financial state is derived from immutable issued invoices and recorded outcomes;
// it never invents a provider event or mutates a subscription on a read.
import type { Bindings } from '../auth.server'
import { all, one, type Row } from './core'
import { BALANCE_SQL } from './receivables'
import { blockedAt } from './lifecycle-math'
import { lifecycleHistory, lifecycleIntervals } from './lifecycle-records'

export async function entitlementState(env: Bindings, sub: Row, day: string) {
  const intervals = blockedAt(day, lifecycleIntervals(await lifecycleHistory(env, sub.id)))
  const lifecycle = sub.start_date > day ? 'scheduled' : sub.end_date && sub.end_date <= day ? 'ended'
    : intervals.some(i => i.kind === 'cancellation') ? 'canceled'
    : intervals.some(i => i.kind === 'pause') ? 'paused'
    : sub.trial_end && sub.trial_end > day ? 'trialing' : 'active'
  const invoices = await all(env, `SELECT i.id,i.due_date,${BALANCE_SQL} AS balance_cents FROM nc_invoices i
    WHERE i.subscription_id=? AND i.status='issued' AND i.issue_date<=? AND ${BALANCE_SQL}>0 ORDER BY i.due_date,i.id`, sub.id, day)
  const failures = await all(env, `SELECT n.id,n.invoice_id,n.status FROM nc_native_collections n
    JOIN nc_invoices i ON i.id=n.invoice_id WHERE i.subscription_id=? AND i.issue_date<=? AND i.status='issued'
    AND ${BALANCE_SQL}>0 AND n.status IN ('declined','customer_action_required','uncertain') ORDER BY n.id`, sub.id, day)
  const automaticFailures=await all(env, `SELECT a.id,a.invoice_id,CASE WHEN a.status='uncertain' THEN 'uncertain' ELSE 'declined' END AS status FROM nc_automatic_collections a
    JOIN nc_invoices i ON i.id=a.invoice_id WHERE i.subscription_id=? AND i.issue_date<=? AND i.status='issued'
    AND ${BALANCE_SQL}>0 AND a.status IN ('refused','uncertain') ORDER BY a.id`,sub.id,day)
  failures.push(...automaticFailures)
  const unpaid=await one(env,`SELECT 1 FROM nc_dunning_series s JOIN nc_invoices i ON i.id=s.invoice_id JOIN nc_customers c ON c.id=s.customer_id WHERE i.subscription_id=? AND s.status='mark_unpaid' AND s.end_date<=? AND i.status='issued' AND c.erased_at IS NULL AND ${BALANCE_SQL}>0`,sub.id,day)
  return { lifecycle, suspended: intervals.some(i => i.access === 'suspend'),
    payment: { status: unpaid ? 'unpaid' : invoices.some(i => i.due_date <= day) || failures.some(f => f.status !== 'uncertain') ? 'past_due' : failures.length ? 'uncertain' : 'current',
      invoices: invoices.map(i => ({ id: i.id, dueDate: i.due_date, balanceCents: i.balance_cents })),
      failures: failures.map(f => ({ id: f.id, invoice: f.invoice_id, status: f.status })) } }
}
