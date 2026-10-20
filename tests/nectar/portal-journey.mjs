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
import { populateErasureKinds } from './erasure-record-kinds.mjs'
import { file } from './harness.mjs'

assert.equal(process.env.NECTAR_TEST_CHECKOUT, '1', 'Use a disposable fresh checkout')
const root = process.cwd(), scratch = await mkdtemp(join(tmpdir(), 'nectar-portal-'))
const evidence = process.env.NECTAR_EVIDENCE_DIR ?? join(root, '.evidence/portal')
await mkdir(evidence, { recursive: true })
await access(join(root, '.dev.vars')).then(() => { throw new Error('A fresh unconfigured checkout is required') }, error => { if (error.code !== 'ENOENT') throw error })
const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve)); const port = socket.address().port; await new Promise(resolve => socket.close(resolve))
const origin = `http://127.0.0.1:${port}`, entry = import.meta.resolve('@runeditrun/rer/internal/global/rer.mjs').replace('file://', '')
let server, cookie, browser, completed = false
const h = { origin, raw(path, { cookie: who, form, method = form ? 'POST' : 'GET', headers = {} } = {}) {
  return fetch(origin + path, { method, redirect: 'manual', headers: { ...(who ? { cookie: who } : {}), ...(form ? { origin } : {}), ...headers }, body: form })
}, async api(path, who, body, status = 200) {
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
const archiveItems = async path => {
  const bytes = await readFile(path), records = []
  for await (const record of readArchive(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } }))) records.push(record)
  return records.filter(record => record.kind === 'part').flatMap(record => record.items).map(({ index, ...item }) => item)
}
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

  // Repeat GOV-005 archive custody for a request originating at the customer
  // portal, including actual imported originals and every current family.
  const capture = Object.fromEntries(await Promise.all(['manifest','customers','products','prices','subscriptions','invoices','meters'].map(async name => [name, file(`${name}.json`, await readFile(new URL(`../fixtures/stripe/${name}.json`, import.meta.url)), 'application/json')])))
  const preview = await h.api('import.preview', cookie, capture)
  await h.api('import.apply', cookie, { ...capture, fingerprint: preview.fingerprint })
  const customer = (await h.api('customers', cookie)).find(row => row.external_id === 'cus_NcAtlasFreight01')
  assert.ok(customer, 'PORT-005 archive journey has a real imported customer')
  const rich = await populateErasureKinds(h, cookie, customer.id)
  await h.api('contact.add', cookie, { customer: customer.id, name: 'Portal private contact Aurelia', email: 'aurelia@portal-archive.example' })
  await h.api('note.add', cookie, { kind: 'customer', record: customer.id, body: 'Portal private archive note' })
  await h.api('metadata.write', cookie, { kind: 'customer', record: customer.id, revision: 0, metadata: { personal: 'Portal private archive metadata' } })
  const privacySession = await issue(customer.id), privacyPath = `/portal/privacy?session=${encodeURIComponent(privacySession.token)}`
  const beforeErasure = join(scratch, 'privacy-before.rer'), afterErasure = join(scratch, 'privacy-after.rer'), restored = join(scratch, 'privacy-restored.rer')
  await stop()
  await command(root, ['export', '--output', beforeErasure])
  assert.ok(JSON.stringify(await archiveItems(beforeErasure)).includes('Portal private contact Aurelia'), 'PORT-005 pre-erasure archive really contains the planted contact')
  await start()
  browser = await chromium.launch({ headless: true, args: ['--use-mock-keychain','--password-store=basic'] })
  const privacyPage = await browser.newPage()
  const beforeRequests = await h.api('erasures', cookie)
  for (const width of [1440,390]) {
    await privacyPage.setViewportSize({ width, height: 950 })
    assert.equal((await privacyPage.goto(origin + privacyPath)).status(), 200)
    await shot(privacyPage, 'privacy-request')
  }
  await privacyPage.getByRole('button', { name: 'Request personal-data erasure' }).click()
  await privacyPage.getByRole('heading', { name: 'Request recorded. Verification is still required.' }).waitFor()
  const erasure = (await h.api('erasures', cookie)).find(row => !beforeRequests.some(old => old.id === row.id))
  assert.equal(erasure.customer_id, customer.id, 'PORT-005 real customer form binds the imported customer')
  await h.api('erasure.approve', cookie, { request: erasure.id, confirm: true }, 409)
  const evidenceText = 'PORT-005 independently checked signed customer account records'
  await h.api('erasure.verify', cookie, { request: erasure.id, reason: 'Billing mailbox unreachable; independently checked signed account records', evidence: file('portal-verification.txt', evidenceText, 'text/plain') })
  assert.equal(await (await h.raw(`/app/erasures/${erasure.id}/evidence`, { cookie })).text(), evidenceText)
  const approved = await h.api('erasure.approve', cookie, { request: erasure.id, confirm: true })
  for (const kind of [...rich.receiptKinds, 'nc_incumbent_invoices', 'nc_portal_sessions']) assert.ok(approved.receipt.changed.some(row => row.kind === kind && row.records > 0), `PORT-005 imported customer receipt enumerates ${kind}`)
  assert.ok(approved.receipt.importCustody.receiptId)
  assert.equal(approved.receipt.verification.evidence.status, 'verification file withdrawn after erasure')
  assert.equal((await h.raw(`/app/erasures/${erasure.id}/evidence`, { cookie })).status, 404)
  assert.equal((await fetch(privacySession.url)).status, 401, 'PORT-005 erasure withdraws the real customer session')
  await h.api('portal.session.issue', cookie, { customer: customer.id, origin, audience: 'hosted' }, 404)
  const retainedBeforeRestore = await h.api(`customers/${customer.id}`, cookie)
  for (const width of [1440,390]) {
    await privacyPage.setViewportSize({ width, height: 950 })
    assert.equal((await privacyPage.goto(privacySession.url)).status(), 401)
    await shot(privacyPage, 'privacy-erased-session')
  }
  await browser.close(); browser = null
  await stop()
  await command(root, ['export', '--output', afterErasure])
  const anonymized = await archiveItems(afterErasure)
  const personalValues = [customer.billing_email, customer.address, customer.external_id, 'Portal private contact Aurelia', 'aurelia@portal-archive.example', 'Portal private archive note', 'Portal private archive metadata', evidenceText, ...rich.privateValues].filter(Boolean)
  for (const item of anonymized) {
    for (const value of personalValues) assert.ok(!JSON.stringify(item).includes(value), `PORT-005 archive ${item.table} withdraws personal text`)
    if (item.kind === 'row') for (const value of Object.values(item.row)) if (value && typeof value === 'object' && value.blob) {
      const decoded = Buffer.from(value.blob, 'base64').toString()
      for (const personal of personalValues) assert.ok(!decoded.includes(personal), `PORT-005 archive ${item.table} withdraws personal blob bytes`)
    }
  }
  assert.ok(anonymized.some(item => item.table === 'ik_d1_erasure_journal'), 'PORT-005 imported erasure has a portable custody journal')
  assert.ok(!anonymized.some(item => item.table === 'nc_portal_sessions'), 'PORT-005 erased and unrelated runtime sessions stay out of privacy archives')
  await command(root, ['reset', '--yes'])
  await command(root, ['import', '--input', beforeErasure, '--journal', afterErasure, '--yes'], { refuse: true })
  await command(root, ['import', '--input', afterErasure, '--yes'])
  await command(root, ['export', '--output', restored])
  assert.deepEqual(await archiveItems(restored), anonymized, 'PORT-005 post-erasure restore preserves exact anonymized records, receipts and retained financial custody')
  await command(root, ['setup', '--answers', answers, '--non-interactive', '--port', String(port)])
  await start()
  assert.equal((await fetch(privacySession.url)).status, 401, 'PORT-005 privacy archive restore never resurrects customer sessions')
  await h.api('portal.session.issue', cookie, { customer: customer.id, origin, audience: 'hosted' }, 404)
  const restoredReceipt = (await h.api('erasures', cookie)).find(row => row.id === erasure.id)
  assert.deepEqual(JSON.parse(restoredReceipt.receipt_json), approved.receipt, 'PORT-005 operator receipt survives the real anonymized restore')
  assert.deepEqual(await h.api(`customers/${customer.id}`, cookie), retainedBeforeRestore, 'PORT-005 restored customer retains exact anonymous financial records')
  console.log('PORT-005 populated customer privacy request, full erasure archive, old-archive refusal and anonymous financial restore passed')
  completed = true
} finally {
  if (browser) await browser.close()
  await stop()
  if (completed) await rm(scratch, { recursive: true, force: true })
  else console.error(`PORT-005 failure evidence retained in ${scratch}`)
}
