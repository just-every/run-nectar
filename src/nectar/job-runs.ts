// Dispatcher observations contain schedule metadata only. They never authorize,
// replay or recover product work; each job retains its own custody and claims.
import type { Bindings } from '../auth.server'
import { requireOwner, type Actor } from './actor'
import { clockInstant } from './clock'
import { newId, one, stmt, type Row } from './core'

type Job = { name: string; run: () => Promise<unknown> }
type Execution = { ordinal: number; job: string; status: string; startedAt: number | null; finishedAt: number | null; errorCode: string | null }
const LEASE_MS = 30 * 60_000
// A job still running after this long is recorded as running, so a hung job is
// visible; faster jobs are recorded only if they changed something or failed.
const SLOW_MS = 2_000
// Dispatches kept, in minutes of the per-minute schedule (seven days).
const KEEP_DISPATCHES = 7 * 24 * 60
const PRUNE_PER_RUN = 100

// Error text, provider results and even arbitrary typed error codes may contain
// customer data. The operational door publishes only these fixed categories.
function failureCode(error: unknown) {
  const message = error instanceof Error ? error.message : ''
  return /D1_ERROR|SQLITE|constraint failed/.test(message)
    ? 'storage_failure' : 'job_failure'
}

const auditMark = async (env: Bindings) => (await one(env, 'SELECT COALESCE(MAX(seq),0) seq FROM nc_audit'))!.seq as number
const record = (env: Bindings, id: string, rows: Execution[]) => rows.map(row => stmt(env,
  `INSERT INTO nc_job_executions(dispatch_id,ordinal,job,status,started_at,finished_at,error_code) VALUES(?,?,?,?,?,?,?)
   ON CONFLICT(dispatch_id,ordinal) DO UPDATE SET status=excluded.status,started_at=excluded.started_at,finished_at=excluded.finished_at,error_code=excluded.error_code`,
  id, row.ordinal, row.job, row.status, row.startedAt, row.finishedAt, row.errorCode))

export async function runScheduledJobs(env: Bindings, schedule: { cron: string; scheduledTime: number }, jobs: Job[]) {
  const id = newId(), at = clockInstant(env)
  // Observation writes deliberately do not create business audit events. A
  // refused business audit must still leave an independently visible failure.
  await env.DB.batch([
    stmt(env, "UPDATE nc_job_executions SET status='interrupted',finished_at=?,error_code='execution_lease_expired' WHERE status='running' AND dispatch_id IN (SELECT id FROM nc_job_dispatches WHERE status='running' AND heartbeat_at<=?)", at, at - LEASE_MS),
    stmt(env, "UPDATE nc_job_dispatches SET status='interrupted',finished_at=?,error_code='execution_lease_expired' WHERE status='running' AND heartbeat_at<=?", at, at - LEASE_MS),
    stmt(env, "INSERT INTO nc_job_dispatches(id,cron,scheduled_at,status,started_at,heartbeat_at) VALUES(?,?,?,'running',?,?)", id, schedule.cron, schedule.scheduledTime, at, at),
  ])
  // Every job's row is kept in memory and written when it matters: the job
  // changed something, failed, or has been running long enough to need watching.
  const rows: Execution[] = jobs.map((job, ordinal) => ({ ordinal, job: job.name, status: 'not_started', startedAt: null, finishedAt: null, errorCode: null }))
  const written = new Set<number>()
  const persist = async (only: Execution[], extra: D1PreparedStatement[] = []) => {
    only.forEach(row => written.add(row.ordinal))
    await env.DB.batch([...record(env, id, only), ...extra])
  }
  let heartbeat = Promise.resolve()
  const timer = setInterval(() => {
    heartbeat = heartbeat.then(async () => {
      await stmt(env, "UPDATE nc_job_dispatches SET heartbeat_at=? WHERE id=? AND status='running'", clockInstant(env), id).run()
    }).catch(() => { /* A missing heartbeat is recovered as an expired lease. */ })
  }, 60_000)
  let failed = false, mark = await auditMark(env)
  try {
    for (const [index, job] of jobs.entries()) {
      const row = rows[index]
      row.status = 'running'; row.startedAt = clockInstant(env)
      let watch: ReturnType<typeof setTimeout> | undefined, slow = Promise.resolve()
      watch = setTimeout(() => { slow = persist(rows.slice(index)).catch(() => { /* Unwritten rows are recorded when the job ends. */ }) }, SLOW_MS)
      try {
        const result = await job.run()
        clearTimeout(watch); await slow
        // Some existing jobs report a handled failure without throwing. Keep
        // their established continuation behavior and report that failure too.
        const reportedFailure = result !== null && typeof result === 'object' && 'status' in result && result.status === 'failed'
        failed ||= reportedFailure
        Object.assign(row, { status: reportedFailure ? 'failed' : 'completed', finishedAt: clockInstant(env), errorCode: reportedFailure ? 'job_reported_failure' : null })
        const next = await auditMark(env), worked = next !== mark
        mark = next
        if (worked || reportedFailure || written.has(index)) await persist([row])
      } catch (error) {
        clearTimeout(watch); await slow
        const code = failureCode(error)
        Object.assign(row, { status: 'failed', finishedAt: clockInstant(env), errorCode: code })
        await persist(rows.slice(index), [stmt(env, "UPDATE nc_job_dispatches SET status='failed',finished_at=?,error_code=? WHERE id=? AND status='running'", clockInstant(env), code, id)])
        throw error
      }
    }
    await stmt(env, "UPDATE nc_job_dispatches SET status=?,finished_at=?,error_code=? WHERE id=? AND status='running'",
      failed ? 'failed' : 'completed', clockInstant(env), failed ? 'job_reported_failure' : null, id).run()
    // History beyond a week is dropped from the oldest end, a few rows an hour,
    // so clearing an old backlog never spends the day's write allowance.
    if (new Date(schedule.scheduledTime).getUTCMinutes() === 0) {
      const old = "SELECT seq FROM nc_job_dispatches WHERE seq<=(SELECT COALESCE(MAX(seq),0) FROM nc_job_dispatches)-? AND status<>'running' ORDER BY seq LIMIT ?"
      await env.DB.batch([
        stmt(env, `DELETE FROM nc_job_executions WHERE dispatch_id IN (SELECT id FROM nc_job_dispatches WHERE seq IN (${old}))`, KEEP_DISPATCHES, PRUNE_PER_RUN),
        stmt(env, `DELETE FROM nc_job_dispatches WHERE seq IN (${old})`, KEEP_DISPATCHES, PRUNE_PER_RUN),
      ])
    }
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
