// Runs the built Worker (dist/) with its own local D1 state in a temporary
// directory, and drives it only through public HTTP doors: the JSON API, the
// HTML form door and pages, signed in through ordinary email links.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workerEnvironment } from '../worker-environment.mjs'

async function freePort() {
  const socket = createServer()
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve))
  const { port } = socket.address()
  await new Promise(resolve => socket.close(resolve))
  return port
}

export async function harness() {
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const directory = await mkdtemp(join(tmpdir(), 'nectar-flows-'))
  const secret = () => randomBytes(32).toString('base64url')
  const vars = { AUTH_LOCAL: 'true', AUTH_ORIGIN: origin, OWNER_EMAIL: 'owner@example.test', SESSION_SECRET: secret(), SETUP_TOKEN: secret(), MAIL_PROVIDER: 'development', MAIL_FROM: 'auth@localhost.test', RER_DEV_KEY: secret() }
  await writeFile(join(directory, 'local.env'), Object.entries(vars).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 })
  const wrangler = 'node_modules/wrangler/bin/wrangler.js'
  const env = workerEnvironment()
  execFileSync(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', directory, '--config', 'dist/server/wrangler.json', '--env-file', join(directory, 'local.env')], { stdio: 'ignore', env })
  let output = ''
  const worker = spawn(process.execPath, [wrangler, 'dev', '--config', 'dist/server/wrangler.json', '--inspector-port', '0', '--local', '--persist-to', directory, '--ip', '127.0.0.1', '--port', String(port), '--env-file', join(directory, 'local.env')], { stdio: ['ignore', 'pipe', 'pipe'], env })
  for (const stream of [worker.stdout, worker.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-20_000) })
  const close = async () => {
    if (worker.exitCode === null) { worker.kill('SIGTERM'); await new Promise(resolve => worker.exitCode !== null ? resolve() : worker.once('exit', resolve)) }
    await rm(directory, { recursive: true, force: true })
  }
  try {
    let ready = false
    for (let attempt = 0; attempt < 240 && !ready; attempt++) {
      assert.equal(worker.exitCode, null, 'the Worker stays up')
      try { ready = (await fetch(`${origin}/health`)).ok } catch { await new Promise(resolve => setTimeout(resolve, 250)) }
    }
    assert.ok(ready, 'the Worker became healthy')
  } catch (error) { await close(); throw error }

  const devKey = { 'x-rer-dev-key': vars.RER_DEV_KEY }
  const raw = (path, { cookie, body, form, method, bearer, headers = {} } = {}) => fetch(origin + path, {
    method: method ?? (body !== undefined || form ? 'POST' : 'GET'), redirect: 'manual',
    headers: { 'CF-Connecting-IP': '127.0.0.1', ...(cookie ? { cookie } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...((body !== undefined || form) && !bearer ? { origin } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : form,
  })

  /** The JSON door: GET reads a view, a body POSTs an action. `who` is a cookie or { bearer }. Asserts the status and returns the JSON. */
  async function api(path, who, body, status = 200) {
    const auth = typeof who === 'string' ? { cookie: who } : who ?? {}
    const response = await raw(`/api/nectar/${path}`, { ...auth, body })
    const text = await response.text()
    assert.equal(response.status, status, `${path}: ${response.status} ${text.slice(0, 400)}`)
    return text ? JSON.parse(text) : null
  }

  /** The HTML form door: returns the redirect target after a 303. */
  async function submit(action, cookie, fields, returnTo = '/app') {
    const form = new FormData()
    form.set('returnTo', returnTo)
    for (const [name, value] of Object.entries(fields)) for (const item of [value].flat()) form.append(name, item)
    const response = await raw(`/app/do/${action}`, { cookie, form })
    assert.equal(response.status, 303, `${action}: ${response.status}`)
    return new URL(response.headers.get('location'), origin)
  }

  async function page(path, cookie, status = 200) {
    const response = await raw(path, { cookie })
    const text = await response.text()
    assert.equal(response.status, status, `${path}: ${response.status} ${text.slice(0, 300)}`)
    return text
  }

  /** Signs in through an ordinary email link from the key-gated development outbox. */
  async function signIn(email, { requested = false } = {}) {
    if (!requested) assert.equal((await raw('/auth/magic-link', { body: { email, returnTo: '/app' } })).status, 202)
    const listing = await (await fetch(`${origin}/__dev/outbox`, { headers: devKey })).text()
    for (const match of listing.matchAll(/href="(\/__dev\/outbox\?message=[^"]+)"/g)) {
      const detail = await (await fetch(origin + match[1].replaceAll('&amp;', '&'), { headers: devKey })).text()
      if (!detail.includes(email)) continue
      const link = detail.match(/href="([^"]*\/auth\/(?:confirm|accept)[^"]*token=[^"]+)"/)
      if (!link) continue
      const target = new URL(link[1].replaceAll('&amp;', '&'), origin)
      const confirmed = await raw(target.pathname, { body: { token: target.searchParams.get('token') } })
      assert.equal(confirmed.status, 303, `ordinary link confirmation: ${confirmed.status}`)
      return confirmed.headers.getSetCookie().map(line => line.split(';')[0]).join('; ')
    }
    throw new Error(`no sign-in message for ${email}`)
  }

  const redacted = () => Object.values(vars).reduce((text, value) => text.replaceAll(value, '[redacted]'), output)
  return { origin, vars, raw, api, submit, page, signIn, close, output: redacted }
}

export const file = (filename, content, type = 'application/octet-stream') => ({ filename, base64: Buffer.from(content).toString('base64'), type })
