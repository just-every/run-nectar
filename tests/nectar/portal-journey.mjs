// PORT-005: use the real rer installation in a browser at desktop and phone,
// then export/reset/import. Customer capabilities and the signer never travel.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { readArchive } from '@runeditrun/rer/modules/portability'
import { command, devKey, signIn } from './cli.mjs'
import { seedPortalRecords } from './portal-sessions.mjs'
import { applyPolicy } from './policy-helper.mjs'

assert.equal(process.env.NECTAR_TEST_CHECKOUT, '1', 'Use a disposable fresh checkout')
const root = process.cwd(), scratch = await mkdtemp(join(tmpdir(), 'nectar-portal-'))
const evidence = process.env.NECTAR_EVIDENCE_DIR ?? join(root, '.evidence/portal')
await mkdir(evidence, { recursive: true })
await access(join(root, '.dev.vars')).then(() => { throw new Error('A fresh unconfigured checkout is required') }, error => { if (error.code !== 'ENOENT') throw error })
const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve)); const port = socket.address().port; await new Promise(resolve => socket.close(resolve))
const origin = `http://127.0.0.1:${port}`, entry = import.meta.resolve('@runeditrun/rer/internal/global/rer.mjs').replace('file://', '')
let server, cookie, browser
const h = { origin, async api(path, who, body, status = 200) {
  const response = await fetch(`${origin}/api/nectar/${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'manual', headers: { cookie, ...(body === undefined ? {} : { origin, 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await response.text(); assert.equal(response.status, status, `PORT-005 ${path}: ${text.slice(0,300)}`); return JSON.parse(text)
} }
async function start() {
  const child = spawn(process.execPath, [entry, 'dev', '--foreground', '--port', String(port)], { cwd: root, stdio: ['ignore','pipe','pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } })
  let output = ''; for (const stream of [child.stdout,child.stderr]) stream.on('data', bytes => { output += bytes })
  server = child
  for (let attempt = 0; !output.includes('RER_READY'); attempt++) { assert.equal(child.exitCode, null, 'PORT-005 dev remains running: ' + output.replace(/RER_OPEN [^\n]+/g, 'RER_OPEN [redacted]').replace(/(token=|rer-dev=|RER_DEV_KEY=|PORTAL_KEY=)[^&\s"']+/g, '$1[redacted]').slice(-3500)); assert.ok(attempt < 1200, 'PORT-005 dev becomes ready'); await new Promise(resolve => setTimeout(resolve,250)) }
  cookie = await signIn(origin, await devKey(root))
  await fetch(origin + '/setup', { method: 'POST', redirect: 'manual', headers: { cookie, origin, 'content-type': 'application/x-www-form-urlencoded' }, body: 'confirm=yes' })
}
async function stop() { if (!server) return; const child = server; server = null; if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit',resolve)) } }
const issue = (customer, audience = 'hosted') => h.api('portal.session.issue', cookie, { customer, origin, audience, ...(audience === 'embedded' ? { parent: origin } : {}) })
const shot = async (page, name) => { await page.waitForLoadState('load'); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `PORT-005 ${name} fits`); await page.screenshot({ path: join(evidence, `${page.viewportSize().width}-${name}.jpg`), fullPage: true, type: 'jpeg', quality: 82 }) }
try {
  await mkdir('exports', { recursive: true })
  const answers = 'exports/portal-answers.json'
  await writeFile(answers, JSON.stringify({ OWNER_EMAIL: 'owner@example.test' }), { mode: 0o600 })
  await command(root, ['setup','--answers',answers,'--non-interactive','--port',String(port)])
  console.log('PORT-005 disposable installation set up')
  const key = (await readFile('.dev.vars','utf8')).match(/^PORTAL_KEY=(.+)$/m)?.[1]
  assert.ok(key && key.length >= 32, 'PORT-005 setup generates the dedicated signer')
  await start()
  console.log('PORT-005 real dev server ready')
  await h.api('business.configure',cookie,{ legal_name:'Cedar Software Inc',timezone:'America/Los_Angeles',invoice_prefix:'CD',payment_terms_days:30 })
  await applyPolicy(h,cookie,'tax.declare',{ tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Reviewed portal journey' })
  await h.api('tax.review',cookie,{ revision:(await h.api('business',cookie)).revision })
  const { customers, invoice } = await seedPortalRecords(h,cookie)
  await h.api('portal.configure',cookie,{ hosts:[origin],parents:[origin] })
  const session = await issue(customers[0]), spanish = await issue(customers[1]), empty = await issue(customers[2]), revoked = await issue(customers[0])
  await h.api('portal.session.revoke',cookie,{ session:revoked.id })
  browser = await chromium.launch({ headless:true,args:['--use-mock-keychain','--password-store=basic'] })
  const context = await browser.newContext(), page = await context.newPage()
  for (const width of [1440,390]) {
    await page.setViewportSize({ width,height:950 })
    await page.goto(session.url)
    await page.getByRole('heading',{ name:'Billing overview' }).waitFor()
    assert.match(await page.locator('main').innerText(), /Northwind Robotics/)
    assert.doesNotMatch(await page.locator('main').innerText(), /Pinecrest|PRIVATE-|INTERNAL-/)
    await shot(page,'overview')
    await page.locator(`a[href*="/portal/invoices/${invoice.id}"]`).click()
    await page.getByRole('heading',{ name:'Charges' }).waitFor()
    assert.match(await page.locator('main').innerText(), /USD 175\.00/)
    await shot(page,'invoice-credit-payment')
    await page.getByRole('link',{ name:'All invoices' }).click()
    await page.getByRole('heading',{ name:'Billing overview' }).waitFor()
    await page.goto(spanish.url)
    await page.getByRole('heading',{ name:'Resumen de facturación' }).waitFor()
    await shot(page,'spanish-overview')
    await page.locator('main h2 a').click()
    await page.getByRole('heading',{ name:'Cargos' }).waitFor()
    await shot(page,'spanish-invoice')
    await page.goto(empty.url)
    assert.match(await page.locator('main').innerText(), /No issued invoices/)
    await shot(page,'empty')
    const refusal = await page.goto(revoked.url)
    assert.equal(refusal.status(),401)
    await page.getByRole('heading',{ name:'Billing session unavailable' }).waitFor()
    await shot(page,'refused')
  }
  await browser.close(); browser = null
  console.log('PORT-005 desktop/phone browser states passed')
  await stop()
  const archive = join(scratch,'portal.rer')
  await command(root,['export','--output',archive])
  const bytes = await readFile(archive), records = []
  for await (const record of readArchive(new ReadableStream({ start(controller) { controller.enqueue(bytes);controller.close() } }))) records.push(record)
  assert.ok(!JSON.stringify(records).includes(key), 'PORT-005 dedicated signing key excluded from archive')
  assert.ok(!JSON.stringify(records).includes(session.token), 'PORT-005 bearer tokens excluded from archive')
  const items = records.filter(record => record.kind === 'part').flatMap(record => record.items)
  assert.ok(!items.some(item => item.table === 'nc_portal_sessions'), 'PORT-005 live sessions are not portable')
  assert.ok(items.some(item => item.table === 'nc_portal_policy'), 'PORT-005 owner-approved policy remains portable')
  console.log('PORT-005 archive excludes key and live sessions')
  await command(root,['reset','--yes'])
  await command(root,['import','--input',archive,'--yes'])
  await command(root,['setup','--answers',answers,'--non-interactive','--port',String(port)])
  const restoredVars = await readFile('.dev.vars','utf8')
  assert.notEqual(restoredVars.match(/^PORTAL_KEY=(.+)$/m)?.[1],key, 'PORT-005 restored installation generates a fresh signer')
  // Even deliberately restoring the old key cannot revive archived sessions.
  await writeFile('.dev.vars', restoredVars.replace(/^PORTAL_KEY=.*$/m, `PORTAL_KEY=${key}`), { mode:0o600 })
  await start()
  assert.equal((await fetch(session.url)).status,401, 'PORT-005 restore under same key does not resurrect session custody')
  const fresh = await issue(customers[0])
  const response = await fetch(`${origin}/portal/data?session=${encodeURIComponent(fresh.token)}`)
  assert.equal(response.status,200)
  assert.deepEqual((await response.json()).invoices.map(row => [row.total_cents,row.credited_cents,row.paid_cents,row.balance_cents]),[[30000,2500,10000,17500]], 'PORT-005 financial records survive and a new session sees the exact restored figures')
  console.log('PORT-005 desktop/phone customer browser and key/session exclusion plus same-key archive restore passed')
} finally { if (browser) await browser.close(); await stop(); await rm(scratch,{ recursive:true,force:true }) }
