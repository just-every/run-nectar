// Scheduled assurance (AGENT-010): the same comparisons as the explicit scan, on every daily tick.
// A tick only opens or rechecks cases. It grants no approval, adjustment or outbound-send authority.
import type { Bindings } from '../auth.server'
import { actorLabel, requireCapability, type Actor } from './actor'
import { business } from './business'
import { clockInstant } from './clock'
import { all, commit, NectarError, newId, one, stmt } from './core'
import { localDate } from './dates'
import { scanCases } from './assurance'

// A tick that never wrote its outcome is treated as interrupted once this much time has passed.
const STALE_MS = 10 * 60_000
const SYSTEM = 'system:assurance'
const scheduler: Actor = { id: SYSTEM, kind: 'agent', name: 'Scheduled assurance', email: '', role: null, sessionId: null, capabilities: new Set(['read', 'propose']) }

export async function runAssurance(env: Bindings, scheduledTime = clockInstant(env)) {
  const b = await business(env)
  if (!b) return { status: 'unconfigured' }
  const day = localDate(scheduledTime, b.timezone)
  if (await one(env, "SELECT 1 FROM nc_assurance_runs WHERE status='running' AND started_at<?", scheduledTime - STALE_MS))
    await commit(env, [stmt(env, "UPDATE nc_assurance_runs SET status='interrupted',finished_at=? WHERE status='running' AND started_at<?", scheduledTime, scheduledTime - STALE_MS)],
      { actor: SYSTEM, action: 'assurance.run.interrupt', subject: day })
  const id = newId()
  try {
    await commit(env, [stmt(env, "INSERT INTO nc_assurance_runs(id,business_day,scheduled_at,status,started_at) VALUES(?,?,?,'running',?)", id, day, scheduledTime, scheduledTime)],
      { actor: SYSTEM, action: 'assurance.run.start', subject: id, detail: { day } })
  } catch (error) { if (error instanceof NectarError && error.code === 'already_exists') return { status: 'running' }; throw error }
  const finish = (status: string, values: { owner?: string; compared?: number; opened?: number; rechecked?: number; error?: string }) =>
    commit(env, [stmt(env, "UPDATE nc_assurance_runs SET status=?,owner_id=?,compared=?,opened=?,rechecked=?,error_code=?,finished_at=? WHERE id=? AND status='running'",
      status, values.owner ?? null, values.compared ?? null, values.opened ?? null, values.rechecked ?? null, values.error ?? null, scheduledTime, id)],
      { actor: SYSTEM, action: 'assurance.run.finish', subject: id, detail: { status, ...values } })
  let owner: string | undefined
  try {
    // Cases belong to the installation's first active owner until a person reassigns them.
    owner = (await one(env, "SELECT id FROM nc_members WHERE status='active' AND role='owner' ORDER BY created_at,id LIMIT 1"))?.id
    if (!owner) throw new NectarError('assurance_owner_unavailable', 409)
    // Every month that holds a recorded source control is compared, so an old case is rechecked as well as a new one.
    const months = (await all(env, 'SELECT DISTINCT substr(day,1,7) AS month FROM nc_usage_controls ORDER BY month')).map(row => row.month as string)
    const result = await scanCases(env, scheduler, months, owner, 'scheduled')
    await finish('completed', { owner, compared: result.compared, opened: result.opened.length, rechecked: result.rechecked.length })
    return { id, status: 'completed', ...result }
  } catch (error) {
    // The outcome is saved without failing the rest of the day's jobs; the next tick retries from the records.
    await finish('failed', { ...(owner ? { owner } : {}), error: error instanceof NectarError ? error.code : 'unexpected_error' })
    return { id, status: 'failed' }
  }
}

export async function assuranceRuns(env: Bindings, actor: Actor) {
  requireCapability(actor, 'read')
  return await all(env, 'SELECT * FROM nc_assurance_runs ORDER BY started_at DESC,id DESC')
}
