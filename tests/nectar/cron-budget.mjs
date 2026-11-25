// Workers Free gives every tool on an account 5,000,000 D1 rows read and 100,000 rows written a day.
// A small company's Nectar runs the minute cron 1,440 times: a quiet minute, and the hourly sweep of
// dated facts, must cost the same however long the history is. Rows are D1's own meta.rows_read and
// meta.rows_written through the emitted Worker, on thirty subscriptions with two invoices each, a webhook
// endpoint, and thirty days of dispatcher history. Ceilings are generous: a regression is a multiple.
import assert from 'node:assert/strict'
import { totp } from './mfa.mjs'

const MINUTE = 60_000, DAY = 86_400_000
const QUIET_READS = 150, QUIET_WRITES = 20
const SWEEP_READS = 6_000, SWEEP_WRITES = 400
// A day of the minute cron: 1,440 quiet minutes plus 24 sweeps, against a tenth of the free read allowance and under a third of the write one.
const DAILY_READS = 500_000, DAILY_WRITES = 30_000

export const harnessOptions = () => ({
  meter: true, localTime: '2026-10-01T10:00:00Z',
  webhookFetch: async () => new Response(null, { status: 204 }),
})

const copies = [
  ['nc_customers', ['id', 'external_id', 'billing_email'], "id NOT LIKE '%-copy%'"],
  ['nc_subscriptions', ['id', 'customer_id', 'external_id'], "id NOT LIKE '%-copy%'"],
  ['nc_items', ['id', 'subscription_id'], "id NOT LIKE '%-copy%'"],
  ['nc_invoices', ['id', 'customer_id', 'subscription_id', 'number', 'public_token'], "id NOT LIKE '%-copy%'"],
]

export async function cronBudgetFlow(h, owner) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  let instant = Date.parse('2026-10-01T10:00:00Z')
  const tick = async (time = instant + 5 * MINUTE) => assert.equal((await h.raw(`/cdn-cgi/local/scheduled?time=${time}&cron=${encodeURIComponent('* * * * *')}`)).status, 200)
  const reads = async () => {
    const log = await (await h.raw('/__reads?reset=1')).json()
    return { read: log.reduce((n, row) => n + row.read, 0), written: log.reduce((n, row) => n + row.written, 0),
      top: Object.entries(log.reduce((by, row) => ({ ...by, [row.sql.replace(/\s+/g, ' ').slice(0, 90)]: (by[row.sql.replace(/\s+/g, ' ').slice(0, 90)] ?? 0) + row.read }), {})).sort((a, b) => b[1] - a[1]).slice(0, 3) }
  }
  await api('business.configure', { ...await api('business'), timezone: 'UTC' })
  const factor = await api('mfa.totp.start', {})
  await api('mfa.totp.confirm', { factor: factor.factor, code: totp(factor.secret, instant) })
  await api('webhook.register', { url: 'https://receiver.nectar-app.com/budget', consent: true })
  const product = (await api('product.create', { code: 'synthetic-nectar-budget-1', name: 'Synthetic budget plan' })).id
  const price = (await api('price.create', { product, kind: 'flat', unit_amount: '100', taxable: false })).id
  await api('feature.grant', { product, feature: 'synthetic-nectar-budget-feature' })
  const subscriptions = []
  for (let index = 0; index < 3; index++) {
    const customer = (await api('customer.create', { external_id: `synthetic-nectar-budget-${index}`, name: `Synthetic budget customer ${index}`, billing_email: `budget-${index}@example.test` })).id
    subscriptions.push((await api('subscription.create', { customer, start_date: '2026-09-01', anchor_day: 1, price: [price] })).id)
  }
  // Thirty days of invoices: September's issued on 1 October, October's on 1 November, through the public doors.
  for (const [period, day] of [['2026-09', '2026-10-01'], ['2026-10', '2026-11-01']]) {
    if (period === '2026-10') { instant = Date.parse('2026-11-01T10:00:00Z'); await h.advanceClock(new Date(instant).toISOString()); await api('mfa.verify', { code: totp(factor.secret, instant) }) }
    const run = await api('billrun.prepare', { period })
    for (const { id } of (await api(`runs/${run.id}`)).invoices) {
      await api('invoice.approve', { invoice: id, acknowledge: true })
      await api('invoice.finalise', { invoice: id, issue_date: day })
    }
  }
  // Ten copies of that book: thirty subscriptions and sixty issued invoices.
  await h.db.exec('PRAGMA foreign_keys=OFF')
  for (let copy = 1; copy <= 9; copy++) for (const [table, changed, where] of copies) {
    const columns = (await h.db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all()).results.map(row => row.name)
    const select = columns.map(name => changed.includes(name) ? `${name}||'-copy${copy}'` : name).join(',')
    await h.db.prepare(`INSERT INTO ${table}(${columns.join(',')}) SELECT ${select} FROM ${table} WHERE ${where}`).run()
  }
  assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM nc_subscriptions WHERE billing_mode='live'").first()).n, 30)
  assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM nc_invoices WHERE status='issued'").first()).n, 60)
  // Thirty days of the dispatcher's own history, as a real installation holds it.
  for (let offset = 0; offset < 30 * 1440; offset += 5000) {
    const last = Math.min(offset + 4999, 30 * 1440 - 1)
    await h.db.prepare(`WITH RECURSIVE s(i) AS (SELECT ${offset} UNION ALL SELECT i+1 FROM s WHERE i<${last}) INSERT INTO nc_job_dispatches(id,cron,scheduled_at,status,started_at,heartbeat_at,finished_at) SELECT 'h'||i,'* * * * *',i*60000,'completed',i*60000,i*60000,i*60000+1 FROM s`).run()
  }
  // The first minutes settle the book: every subscription's state is observed once, every event delivered.
  await tick(); await tick(); await tick()
  await reads()

  await tick()
  const quiet = await reads()
  assert.ok(quiet.read <= QUIET_READS && quiet.written <= QUIET_WRITES, `a quiet minute read ${quiet.read} and wrote ${quiet.written} rows: ${JSON.stringify(quiet.top)}`)

  // An hour later the sweep of dated facts runs once, over every subscription and every customer's entitlements.
  instant += 61 * MINUTE; await h.advanceClock(new Date(instant).toISOString())
  await tick()
  const sweep = await reads()
  assert.ok(sweep.read <= SWEEP_READS && sweep.written <= SWEEP_WRITES, `the hourly sweep read ${sweep.read} and wrote ${sweep.written} rows: ${JSON.stringify(sweep.top)}`)
  await tick()
  const after = await reads()
  assert.ok(after.read <= QUIET_READS, `the minute after a sweep read ${after.read} rows: ${JSON.stringify(after.top)}`)

  const readsPerDay = quiet.read * 1440 + sweep.read * 24, writesPerDay = quiet.written * 1440 + sweep.written * 24
  assert.ok(readsPerDay <= DAILY_READS && writesPerDay <= DAILY_WRITES, `a day of the minute cron reads ${readsPerDay} and writes ${writesPerDay} rows`)

  // The next local day sweeps again; on the hour the clean-up trims the history it keeps, a few rows at a time.
  instant = Date.parse('2026-11-02T10:00:00Z'); await h.advanceClock(new Date(instant).toISOString())
  await tick(); await tick(instant + 6 * MINUTE)
  assert.ok((await reads()).read <= SWEEP_READS + QUIET_READS, 'the first minutes of a new day stay within the sweep ceiling')
  const held = (await h.db.prepare('SELECT COUNT(*) n FROM nc_job_dispatches').first()).n
  await tick(instant)
  const trim = await reads()
  const trimmed = held - (await h.db.prepare('SELECT COUNT(*) n FROM nc_job_dispatches').first()).n
  assert.ok(trimmed > 0 && trimmed <= 100 + 1 && trim.read <= 2_000 && trim.written <= 1_000, `the hourly clean-up removed ${trimmed} dispatches, read ${trim.read} and wrote ${trim.written} rows`)
  console.log(`cronBudgetFlow: a quiet minute read ${quiet.read} and wrote ${quiet.written} rows, an hourly sweep read ${sweep.read} and wrote ${sweep.written}`)
}
