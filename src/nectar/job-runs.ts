// Dispatcher observations contain schedule metadata only. They never authorize,
// replay or recover product work; each job retains its own custody and claims.
import type { Bindings } from '../auth.server'
import { requireOwner, type Actor } from './actor'
import { clockInstant } from './clock'
import { newId, stmt, type Row } from './core'

type Job = { name: string; run: () => Promise<unknown> }
const LEASE_MS = 30 * 60_000

// Error text, provider results and even arbitrary typed error codes may contain
// customer data. The operational door publishes only these fixed categories.
function failureCode(error: unknown) {
  const message = error instanceof Error ? error.message : ''
  return /D1_ERROR|SQLITE|constraint failed/.test(message)
    ? 'storage_failure' : 'job_failure'
}

export async function runScheduledJobs(env: Bindings, schedule: { cron: string; scheduledTime: number }, jobs: Job[]) {
  const id = newId(), at = clockInstant(env)
  // Observation writes deliberately do not create business audit events. A
  // refused business audit must still leave an independently visible failure.
  await env.DB.batch([
    stmt(env, "UPDATE nc_job_executions SET status='interrupted',finished_at=?,error_code='execution_lease_expired' WHERE status='running' AND dispatch_id IN (SELECT id FROM nc_job_dispatches WHERE status='running' AND heartbeat_at<=?)", at, at - LEASE_MS),
    stmt(env, "UPDATE nc_job_dispatches SET status='interrupted',finished_at=?,error_code='execution_lease_expired' WHERE status='running' AND heartbeat_at<=?", at, at - LEASE_MS),
    stmt(env, "INSERT INTO nc_job_dispatches(id,cron,scheduled_at,status,started_at,heartbeat_at) VALUES(?,?,?,'running',?,?)", id, schedule.cron, schedule.scheduledTime, at, at),
    ...jobs.map((job, index) => stmt(env, "INSERT INTO nc_job_executions(dispatch_id,ordinal,job,status) VALUES(?,?,?,'not_started')", id, index, job.name)),
  ])
  let heartbeat = Promise.resolve()
  const timer = setInterval(() => {
    heartbeat = heartbeat.then(async () => {
      await stmt(env, "UPDATE nc_job_dispatches SET heartbeat_at=? WHERE id=? AND status='running'", clockInstant(env), id).run()
    }).catch(() => { /* A missing heartbeat is recovered as an expired lease. */ })
  }, 60_000)
  let failed = false
  try {
    for (const [index, job] of jobs.entries()) {
      await env.DB.batch([
        stmt(env, "UPDATE nc_job_executions SET status='running',started_at=? WHERE dispatch_id=? AND ordinal=? AND status='not_started'", clockInstant(env), id, index),
        stmt(env, "UPDATE nc_job_dispatches SET heartbeat_at=? WHERE id=? AND status='running'", clockInstant(env), id),
      ])
      try {
        const result = await job.run()
        // Some existing jobs report a handled failure without throwing. Keep
        // their established continuation behavior and report that failure too.
        const reportedFailure = result !== null && typeof result === 'object' && 'status' in result && result.status === 'failed'
        failed ||= reportedFailure
        await stmt(env, "UPDATE nc_job_executions SET status=?,finished_at=?,error_code=? WHERE dispatch_id=? AND ordinal=? AND status='running'",
          reportedFailure ? 'failed' : 'completed', clockInstant(env), reportedFailure ? 'job_reported_failure' : null, id, index).run()
      } catch (error) {
        const code = failureCode(error)
        await env.DB.batch([
          stmt(env, "UPDATE nc_job_executions SET status='failed',finished_at=?,error_code=? WHERE dispatch_id=? AND ordinal=? AND status='running'", clockInstant(env), code, id, index),
          stmt(env, "UPDATE nc_job_dispatches SET status='failed',finished_at=?,error_code=? WHERE id=? AND status='running'", clockInstant(env), code, id),
        ])
        throw error
      }
    }
    await stmt(env, "UPDATE nc_job_dispatches SET status=?,finished_at=?,error_code=? WHERE id=? AND status='running'",
      failed ? 'failed' : 'completed', clockInstant(env), failed ? 'job_reported_failure' : null, id).run()
  } finally {
    clearInterval(timer)
    await heartbeat
  }
}

export async function jobRuns(env: Bindings, actor: Actor) {
  requireOwner(actor)
  // Explicit projections keep this door independent of future internal fields.
  const [dispatches, executions] = await env.DB.batch<Row>([
    stmt(env, 'SELECT id,cron,scheduled_at,status,started_at,finished_at,error_code FROM nc_job_dispatches ORDER BY seq DESC LIMIT 50'),
    stmt(env, 'SELECT dispatch_id,ordinal,job,status,started_at,finished_at,error_code FROM nc_job_executions WHERE dispatch_id IN (SELECT id FROM nc_job_dispatches ORDER BY seq DESC LIMIT 50) ORDER BY ordinal'),
  ])
  return { runs: dispatches.results.map(run => ({ ...run, jobs: executions.results.filter(job => job.dispatch_id === run.id).map(({ dispatch_id: _dispatch, ...job }) => job) })) }
}
