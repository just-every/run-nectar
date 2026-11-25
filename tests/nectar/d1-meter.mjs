// Adds up the rows D1 reports reading and writing for every statement the Worker runs, and answers
// GET /__reads (add ?reset=1 to clear). A read-budget test wraps the emitted Worker with this module;
// production code never loads it. Local D1 reports the same meta.rows_read as hosted D1.
export const meterModule = inner => `import inner from './${inner}'
const log = [], real = new WeakMap()
const note = (sql, meta, batch) => log.push({ sql, read: meta?.rows_read ?? 0, written: meta?.rows_written ?? 0, batch })
function wrap(sql, statement) {
  const proxy = new Proxy(statement, { get(target, key) {
    if (key === 'bind') return (...values) => wrap(sql, target.bind(...values))
    if (key === 'all' || key === 'run') return async (...args) => { const result = await target[key](...args); note(sql, result.meta); return result }
    if (key === 'first') return async column => { const result = await target.all(); note(sql, result.meta); const row = result.results[0] ?? null; return column && row ? row[column] : row }
    if (key === 'raw') return async () => { const result = await target.all(); note(sql, result.meta); return result.results.map(row => Object.values(row)) }
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
  } })
  real.set(proxy, { sql, statement })
  return proxy
}
function counting(db) { return new Proxy(db, { get(target, key) {
  if (key === 'prepare') return sql => wrap(sql, target.prepare(sql))
  if (key === 'batch') return async statements => { const results = await target.batch(statements.map(s => real.get(s)?.statement ?? s)); results.forEach((result, i) => note(real.get(statements[i])?.sql ?? '?', result.meta, true)); return results }
  if (key === 'withSession') return (...args) => counting(target.withSession(...args))
  const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
} }) }
export default { ...inner,
  fetch: (request, env, ctx) => {
    const url = new URL(request.url)
    if (url.pathname === '/__reads') { const out = JSON.stringify(log); if (url.searchParams.get('reset')) log.length = 0; return new Response(out) }
    return inner.fetch(request, { ...env, DB: counting(env.DB) }, ctx)
  },
  scheduled: (event, env, ctx) => inner.scheduled(event, { ...env, DB: counting(env.DB) }, ctx) }
`
