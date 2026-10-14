import { fileURLToPath as __rerTestEntryPath } from 'node:url';
const __rerTestEntry = __rerTestEntryPath(import.meta.resolve('@runeditrun/rer/internal/global/rer.mjs'));
const __rerTestEntryArgs = args => args[1] === 'dev' && !args.some(arg => ['--foreground', '--detach', '--stop', '--help'].includes(arg)) ? [...args, '--foreground'] : args;
// Drives the public `rer` commands of a checkout. Failures show
// the command's output with dev keys and sign-in tokens redacted.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'

const env = () => ({ ...process.env, WRANGLER_SEND_METRICS: 'false' })
const redact = output => output.replace(/(rer-dev=|token=|RER_DEV_KEY=)[^&\s"']+/g, '$1[redacted]').slice(-4000)

export async function command(root, args, { refuse = false } = {}) {
  const child = spawn(process.execPath, __rerTestEntryArgs([__rerTestEntry, ...args]), { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: env() })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk })
  const code = await new Promise(resolve => child.once('exit', resolve))
  if (refuse) assert.notEqual(code, 0, `${args[0]} must refuse`)
  else assert.equal(code, 0, `rer ${args[0]} failed (exit ${code}):\n${redact(output)}`)
  return output
}

/** Starts a managed dev or preview server and waits for RER_READY. */
export async function serving(root, verb, port, extra = []) {
  const child = spawn(process.execPath, __rerTestEntryArgs([__rerTestEntry, verb, '--port', String(port), ...extra]), { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: env() })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk })
  for (let attempt = 0; attempt < 1200; attempt++) {
    if (child.exitCode !== null) throw new Error(`${verb} stopped before readiness (exit ${child.exitCode}):\n${redact(output)}`)
    if (output.includes('RER_READY')) {
      return {
        output: () => output,
        open: () => output.match(/RER_OPEN (\S+)/)?.[1],
        async stop() {
          await command(root, [verb, '--stop'])
          await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve))
        },
      }
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  child.kill('SIGTERM')
  throw new Error(`${verb} readiness timeout`)
}

export async function devKey(root) {
  return (await readFile(`${root}/.rer/local/dev-key.env`, 'utf8')).trim().split('=')[1]
}

/** An ordinary emailed sign-in link from the key-gated local outbox. */
export async function signIn(origin, key, email, { form = false } = {}) {
  let action = '/auth/magic-link'
  if (form) {
    const page = await fetch(`${origin}/signin`)
    assert.equal(page.status, 200)
    const html = await page.text()
    action = html.match(/<form method="post" action="([^"]+)"/)?.[1]
    assert.ok(action?.startsWith('/') && !action.startsWith('//'), 'the actual sign-in page supplies a local form')
  }
  const requested = await fetch(origin + action, { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' }, body: form ? new URLSearchParams({ email, returnTo: '/app' }) : JSON.stringify({ email, returnTo: '/app' }) })
  assert.equal(requested.status, form ? 303 : 202)
  const listing = await (await fetch(`${origin}/__dev/outbox`, { headers: { 'x-rer-dev-key': key } })).text()
  for (const match of listing.matchAll(/href="(\/__dev\/outbox\?message=[^"]+)"/g)) {
    const detail = await (await fetch(origin + match[1].replaceAll('&amp;', '&'), { headers: { 'x-rer-dev-key': key } })).text()
    const link = detail.includes(email) && detail.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)
    if (!link) continue
    const token = new URL(link[1].replaceAll('&amp;', '&'), origin).searchParams.get('token')
    const confirmed = await fetch(`${origin}/auth/confirm`, { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ token }) })
    assert.equal(confirmed.status, 303)
    return confirmed.headers.getSetCookie().map(line => line.split(';')[0]).join('; ')
  }
  throw new Error(`no sign-in message for ${email}`)
}
