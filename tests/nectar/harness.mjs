// Runs the built Worker (dist/) on Miniflare with its own in-memory D1, and
// drives it only through public HTTP doors: the JSON API, the HTML form door
// and pages, signed in through ordinary email links. Mail is the network edge:
// the Worker sends through Resend's API, which this fake answers and records.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { httpListener } from './http-listener.mjs'

// Wrangler's own Miniflare and SQL splitter, so the runtime matches `rer build`.
const wrangler = createRequire(import.meta.url)('wrangler')
const { Miniflare, convertV4MiniflareOptions } = createRequire(createRequire(import.meta.url).resolve('wrangler'))('miniflare')

export async function harness({ assets = false, localTime, hostname = '127.0.0.1', stripeFetch, stripeSecret, stripeSecondarySecret, quickbooksFetch, webhookFetch, persistence, databaseId='nectar', applyMigrations=true } = {}) {
  const secret = () => randomBytes(32).toString('base64url')
  const vars = { AUTH_LOCAL: 'true', OWNER_EMAIL: 'owner@example.test', SESSION_SECRET: secret(), SETUP_TOKEN: secret(), MFA_KEY: secret(), PORTAL_KEY: secret(), MAIL_PROVIDER: 'resend', MAIL_API_KEY: 'test-only-resend-key', MAIL_FROM: 'auth@example.test' }
  if(localTime)vars.NECTAR_LOCAL_TIME=localTime
  if(stripeSecret)vars.STRIPE_BILLING_SECRET=stripeSecret
  if(stripeSecondarySecret)vars.STRIPE_SECONDARY_SECRET_KEY=stripeSecondarySecret
  if(quickbooksFetch)Object.assign(vars,{QUICKBOOKS_ACCESS_TOKEN:'synthetic-nectar-qbo',QUICKBOOKS_ENVIRONMENT:'sandbox',QUICKBOOKS_COMPANY_ID:'synthetic-nectar-company'})
  const chunks = (await readdir('dist/server', { recursive: true })).filter(path => path.endsWith('.js') && path !== 'index.js')
  const mails = [], mailResponses = []
  let nativeMailFetch=null
  const outboundService = async request => {
    if(nativeMailFetch&&new URL(request.url).hostname==='api.sendgrid.com')return nativeMailFetch(request)
    if (new URL(request.url).hostname==='receiver.nectar-app.com'&&webhookFetch)return webhookFetch(request)
    if (new URL(request.url).hostname==='api.stripe.com'&&stripeFetch)return stripeFetch(request)
    if (new URL(request.url).hostname==='sandbox-quickbooks.api.intuit.com'&&quickbooksFetch)return quickbooksFetch(request)
    if (request.url !== 'https://api.resend.com/emails') return new Response('Unexpected outbound request', { status: 599 })
    const message=await request.json();mails.push(message)
    const index=mailResponses.findIndex(response=>!response.to||[message.to].flat().includes(response.to))
    const queued=index<0?undefined:mailResponses.splice(index,1)[0]
    if (queued) return Response.json(queued.body, { status: queued.status })
    return Response.json({ id: `test-${mails.length}` })
  }
  let mf, db
  // WebAuthn refuses IP-address relying parties, so preserve the requested hostname.
  const listener = await httpListener(() => mf.ready, hostname)
  const { origin } = listener
  vars.AUTH_ORIGIN = origin
  const options = {
    // Omitting port lets workerd bind a fresh port 0 on every runtime start.
    cf: false, unsafeTriggerHandlers: true, host: '127.0.0.1', modulesRoot: 'dist/server', modules: ['index.js', ...chunks].map(path => ({ type: 'ESModule', path: `dist/server/${path}` })), compatibilityDate: '2026-09-08', compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: databaseId }, ...(persistence?{resourcePersistencePath:persistence}:{}), bindings: vars, outboundService,
    ...(assets ? { assets: { directory: 'dist/client', binding: 'ASSETS', run_worker_first: true, routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true } } } : {}),
  }
  const close = () => Promise.all([listener.close(), mf?.dispose()])
  let setupPhase='worker-ready'
  const trace=()=>{if(process.env.NECTAR_HARNESS_TRACE)console.log('HARNESS',setupPhase)}
  try {
    mf = new Miniflare(convertV4MiniflareOptions(options))
    trace();await mf.ready
    setupPhase='database-binding';trace()
    // Every committed migration, as `rer setup` leaves a database.
    db = await mf.getD1Database('DB');trace()
    for (const name of (applyMigrations?await readdir('migrations/core'):[]).filter(name => name.endsWith('.sql')).sort()) {
      setupPhase=`migration:${name}`;trace()
      await db.batch(wrangler.unstable_splitSqlQuery(await readFile(`migrations/core/${name}`, 'utf8')).map(query => db.prepare(query)))
    }
    setupPhase='health';trace()
    assert.ok((await fetch(`${origin}/health`)).ok, 'the Worker is healthy')
  } catch (error) { console.error('HARNESS setup failure',setupPhase,error.message);await close(); throw error }

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

  /** Signs in through the newest ordinary email link sent to `email`. */
  async function signIn(email, { requested = false } = {}) {
    if (!requested) assert.equal((await raw('/auth/magic-link', { body: { email, returnTo: '/app' } })).status, 202)
    for (const mail of mails.toReversed()) {
      if (![mail.to].flat().some(to => to.includes(email))) continue
      const link = `${mail.html ?? ''} ${mail.text ?? ''}`.match(/(https?:\/\/[^\s"<]*\/auth\/(?:confirm|accept)[^\s"<]*token=[^\s"<&]+)/)
      if (!link) continue
      const target = new URL(link[1].replaceAll('&amp;', '&'), origin)
      const confirmed = await raw(target.pathname, { body: { token: target.searchParams.get('token') } })
      assert.equal(confirmed.status, 303, `ordinary link confirmation: ${confirmed.status}`)
      return confirmed.headers.getSetCookie().map(line => line.split(';')[0]).join('; ')
    }
    throw new Error(`no sign-in message for ${email}`)
  }

  // Storage fault injection only: business records still use public HTTP doors.
  async function rejectAudit(action) {
    await db.prepare('DROP TRIGGER IF EXISTS synthetic_nectar_audit_failure').run()
    if (action) {
      assert.match(action,/^[a-z.]+$/)
      await db.prepare(`CREATE TRIGGER synthetic_nectar_audit_failure BEFORE INSERT ON nc_audit WHEN NEW.action='${action}' BEGIN SELECT RAISE(ABORT,'synthetic-nectar-audit-unavailable'); END`).run()
    }
  }

  // Required sensitive-data evidence after public capture operations, without
  // exposing any stored values in assertion messages or evidence output.
  async function assertStorageExcludes(values) {
    const tables=(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'").all()).results
    for(const {name} of tables){
      const serialized=JSON.stringify((await db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all()).results)
      assert.ok(values.every(value=>!serialized.includes(value)),`Sensitive input excluded from ${name}`)
    }
  }

  async function advanceClock(instant){assert.ok(Number.isFinite(Date.parse(instant)));vars.NECTAR_LOCAL_TIME=instant;await mf.setOptions(convertV4MiniflareOptions({...options,bindings:{...vars}}));await mf.ready;db=await mf.getD1Database('DB')}
  async function configureMail({provider,apiKey,from},transport) {
    Object.assign(vars,{MAIL_PROVIDER:provider,MAIL_API_KEY:apiKey,MAIL_FROM:from});nativeMailFetch=transport
    await mf.setOptions(convertV4MiniflareOptions({...options,bindings:{...vars}}));await mf.ready;db=await mf.getD1Database('DB')
  }
  return { configureMail,origin, vars, raw, api, submit, page, signIn, close, mails, mailResponses,advanceClock,rejectAudit,assertStorageExcludes, dispatch: async request => mf.dispatchFetch(request.url, { redirect: 'manual', method: request.method, headers: Object.fromEntries(request.headers), ...(!['GET','HEAD'].includes(request.method) ? { body: await request.arrayBuffer() } : {}) }) }
}

export const file = (filename, content, type = 'application/octet-stream') => ({ filename, base64: Buffer.from(content).toString('base64'), type })
