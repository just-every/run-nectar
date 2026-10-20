// GOV-007: real rer setup/dev/export/reset/import in a disposable fresh checkout
// (needs 15 GiB free for rer dev's temporary files: point TMPDIR at a large volume).
// The archive carries the authenticator secret only sealed under MFA_KEY (no
// per-session check rows); a restore under another key puts the owner back at
// enrollment with the reason shown, and the original key opens it again.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readArchive } from '@runeditrun/rer/modules/portability'
import { command, devKey, signIn } from './cli.mjs'
import { totp } from './mfa.mjs'
assert.equal(process.env.NECTAR_TEST_CHECKOUT, '1', 'Use only a disposable checkout')
const root = process.cwd(), scratch = await mkdtemp(join(tmpdir(), 'nectar-mfa-archive-'))
await access(join(root, '.dev.vars')).then(() => { throw new Error('A fresh unconfigured checkout is required') }, e => { if (e.code !== 'ENOENT') throw e })
const socket = createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r))
const origin = `http://127.0.0.1:${port}`, entry = import.meta.resolve('@runeditrun/rer/internal/global/rer.mjs').replace('file://', '')
let server, cookie
async function start() {
  const child = spawn(process.execPath, [entry, 'dev', '--foreground', '--port', String(port)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } })
  let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { output += b })
  server = child
  for (let attempt = 0; !output.includes('RER_READY'); attempt++) { assert.equal(child.exitCode, null, 'GOV-007 dev remains alive: ' + output.replace(/RER_OPEN [^\n]+/g, 'RER_OPEN [redacted]').replace(/(token=|rer-dev=|RER_DEV_KEY=|MFA_KEY=)[^&\s"']+/g, '$1[redacted]').slice(-3000)); assert.ok(attempt < 600, 'GOV-007 dev becomes ready'); await new Promise(r => setTimeout(r, 250)) }
  cookie = await signIn(origin, await devKey(root))
  await fetch(origin + '/setup', { method: 'POST', redirect: 'manual', headers: { cookie, origin, 'content-type': 'application/x-www-form-urlencoded' }, body: 'confirm=yes' })
}
async function stop() { if (!server) return; const child = server; server = null; if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise(r => child.once('exit', r)) } }
async function api(path, body, status = 200) {
  const response = await fetch(`${origin}/api/nectar/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, ...(body === undefined ? {} : { origin, 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await response.text()
  assert.equal(response.status, status, `GOV-007 ${path}: ${text.slice(0, 300)}`)
  return JSON.parse(text)
}
const items = async path => { const bytes = await readFile(path), records = []; for await (const record of readArchive(new ReadableStream({ start(c) { c.enqueue(bytes); c.close() } }))) records.push(record); return records.filter(r => r.kind === 'part').flatMap(r => r.items) }
const setKey = async value => { const vars = await readFile('.dev.vars', 'utf8'); await writeFile('.dev.vars', vars.replace(/^MFA_KEY=.*$/m, `MFA_KEY=${value}`), { mode: 0o600 }) }
try {
  await mkdir('exports', { recursive: true }); await writeFile('exports/mfa-answers.json', JSON.stringify({ OWNER_EMAIL: 'owner@example.test' }), { mode: 0o600 })
  await command(root, ['setup', '--answers', 'exports/mfa-answers.json', '--non-interactive', '--port', String(port)])
  const original = (await readFile('.dev.vars', 'utf8')).match(/^MFA_KEY=(.+)$/m)?.[1]
  assert.ok(original && original.length >= 32, 'GOV-007 setup generates a dedicated MFA_KEY')
  await start()
  await api('business.configure', { legal_name: 'Cedar Software Inc', timezone: 'America/Los_Angeles', invoice_prefix: 'CD', payment_terms_days: 30 })
  await api('mfa.policy', { scope: 'all' })
  const started = await api('mfa.totp.start', {})
  await api('mfa.totp.confirm', { factor: started.factor, code: totp(started.secret, Date.now()) })
  await api('customers')
  await stop()
  const archive = join(scratch, 'mfa.rer')
  await command(root, ['export', '--output', archive])
  const rows = await items(archive), factor = rows.find(r => r.table === 'nc_mfa_factors')
  assert.match(factor.row.sealed_secret, /^v1\.[\w-]+\.[\w-]+$/, 'GOV-007 the archive carries the sealed secret')
  assert.ok(!JSON.stringify(rows).includes(started.secret), 'GOV-007 the plain secret never enters the archive')
  assert.ok(!rows.some(r => ['nc_mfa_sessions', 'nc_mfa_challenges'].includes(r.table)), 'GOV-007 session checks never enter the archive')
  assert.equal(rows.filter(r => r.table === 'nc_mfa_recovery').length, 10)

  // Restore without the key (setup generates a new one): back at enrollment, with the reason shown.
  const restore = async () => { await command(root, ['reset', '--yes']); await command(root, ['import', '--input', archive, '--yes']); await command(root, ['setup', '--answers', 'exports/mfa-answers.json', '--non-interactive', '--port', String(port)]) }
  await restore()
  assert.notEqual((await readFile('.dev.vars', 'utf8')).match(/^MFA_KEY=(.+)$/m)?.[1], original, 'GOV-007 the restored copy lacks the original key')
  await start()
  const held = await api('customers', undefined, 403)
  assert.deepEqual([held.error, held.detail.reason], ['mfa_enrollment_required', 'mfa_key_changed'])
  assert.match(await (await fetch(`${origin}/app/security`, { headers: { cookie } })).text(), /MFA key this copy does not hold/)
  await stop()

  // The same archive under the original key opens the sealed secret again.
  await restore()
  await setKey(original)
  await start()
  assert.equal((await api('customers', undefined, 403)).error, 'mfa_required')
  await new Promise(r => setTimeout(r, 31000))
  await api('mfa.verify', { code: totp(started.secret, Date.now()) })
  await api('customers')
  console.log('GOV-007 sealed archive, keyless restore to enrollment with reason, and same-key restore passed')
} finally { await stop(); await rm(scratch, { recursive: true, force: true }) }
