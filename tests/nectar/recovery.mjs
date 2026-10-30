if (process.argv[2] === '--archive') {
 const journeys={
  "portal-journey": portalJourneyJourney,
  "erasure-archive": erasureArchiveJourney,
  "mfa-archive": mfaArchiveJourney,
  "metadata-restore": metadataRestoreJourney,
  "processor-archive": processorArchiveJourney,
 }
 const run=journeys[process.argv[3]]
 if(!run)throw new Error('Unknown archive journey')
 await run(process.argv[4])
 process.exit(0)
}
import { seedPendingPortalChange } from './portal-change-requests.mjs'
import { createServer } from 'node:net'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readArchive } from '@runeditrun/rer/modules/portability'
import { command } from './cli.mjs'
import { harness } from './harness.mjs'
import { applyPolicy } from './policy-helper.mjs'
import { totp } from './mfa.mjs'

assert.equal(process.env.NECTAR_TEST_CHECKOUT,'1','Recovery needs a disposable checkout')

const smoke=process.argv.includes('--smoke')
const root=process.cwd()
const socket=createServer()
await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve))
const port=socket.address().port
await new Promise(resolve=>socket.close(resolve))

let instant='2026-10-28T12:00:00Z'

await mkdir('exports',{recursive:true})

const setup=()=>command(root,['setup','--owner-email','owner@example.test','--non-interactive','--port',String(port)])

const rows=async path=>{
 const bytes=await readFile(path),items=[]
 let header
 for await(const record of readArchive(new ReadableStream({start(c){c.enqueue(bytes);c.close()}}))) {
  if(!header){header=record;for(const table of ['nc_invoices','nc_invoice_lines','nc_usage_events','nc_audit','nc_proposals','ik_jobs'])assert.ok(header.tables.some(row=>row.name===table),`${table} is declared in the real archive`);assert.ok(header.excludedTables.includes('oa_sessions'))}
  if(record.kind==='part')items.push(...record.items.map(({index,...item})=>item))
 }
 return items
}

const mfaKey=async()=>{const text=await readFile('.dev.vars','utf8');const value=text.match(/^MFA_KEY=(.+)$/m)?.[1];assert.ok(value,'Setup provides a factor sealing key');return value}

await setup()

const originalKey=await mfaKey()

const config=JSON.parse(await readFile('wrangler.jsonc','utf8'))

const databaseId=config.d1_databases.find(binding=>binding.binding==='DB').database_id

let h,owner,factor

async function start(key=originalKey){
 instant=new Date(Date.parse(instant)+60_000).toISOString()
 h=await harness({persistence:join(root,'.wrangler/state/v3'),databaseId,applyMigrations:false,localTime:instant,settings:{MFA_KEY:key}})
 owner=await h.signIn(h.vars.OWNER_EMAIL)
 await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
}

async function stop(){await h?.close();h=null}

const api=(path,body,status)=>h.api(path,owner,body,status)

const before='exports/before-erasure.rer',after='exports/erased.rer',restored='exports/restored.rer'

const refuseCorruptArchive=async path=>{
 const corrupted=(await readFile(path,'utf8')).replace('"kind":"part"','"kind":"bad"')
 assert.notEqual(corrupted,await readFile(path,'utf8'),'The test corrupts an actual archive part')
 await writeFile('exports/corrupt.rer',corrupted,{mode:0o600})
 await command(root,['import','--input','exports/corrupt.rer','--yes'],{refuse:true})
}
const assertRestoredInvoices=async archived=>{
 const invoices=archived.filter(item=>item.table==='nc_invoices'&&item.row.status==='issued')
 assert.ok(invoices.length>=2,'The real restore contains multiple independently issued invoices')
 for(const {row} of invoices){
  const invoice=await api(`invoices/${row.id}`)
  assert.equal(invoice.number,row.number)
  assert.equal(invoice.total_cents,row.total_cents)
  assert.deepEqual(invoice.calculation,JSON.parse(row.calculation_json),'Restored issued calculations agree with every archived source field')
 }
}


try {
 await start()
 await api('business.configure',{legal_name:'Cedar Software Inc',timezone:'UTC',invoice_prefix:'CD',payment_terms_days:30})
 await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'flat_rate',tax_rate:'10',tax_note:'Reviewed recovery billing'})
 await api('tax.review',{revision:(await api('business')).revision})
 const customer=(await api('customer.create',{external_id:'RECOVERY-PRIVATE',name:'Marigold Private LLC',billing_email:'private@recovery.example',address:'Private home address'})).id
 const product=(await api('product.create',{code:'recovery-service',name:'Recovery service'})).id
 const price=(await api('price.create',{product,kind:'flat',unit_amount:'100',taxable:true})).id
 await api('subscription.create',{customer,start_date:'2026-09-01',price:[price]})
 const run=(await api('billrun.prepare',{period:'2026-09'})).id
 const invoice=(await api(`runs/${run}`)).invoices.find(row=>row.customer_id===customer).id
 await api('invoice.approve',{invoice,acknowledge:true})
 await api('invoice.finalise',{invoice,issue_date:'2026-10-28'})
 await api('credit.issue',{invoice,amount:'10',reason:'Service adjustment'})
 const payment=(await api('payment.record',{customer,amount:'100',received_on:'2026-10-28',method:'bank_transfer',reference:'RECOVERY-WIRE'})).payment
 await api('payment.allocate',{payment,invoice,amount:'100'})
 const issued=await api(`invoices/${invoice}`)
 assert.deepEqual([issued.total_cents,issued.tax_cents,issued.balanceCents],[11000,1000,0])
 await api('note.add',{kind:'customer',record:customer,body:'Private recovery note'})
 await api('metadata.write',{kind:'customer',record:customer,revision:0,metadata:{private:'Private recovery metadata'}})
 const portalChange=await seedPendingPortalChange(h,owner,customer)
 await (await import('./metadata.mjs')).metadataFlow(h,owner)
 await api('mfa.policy',{scope:'all'})
 factor=await api('mfa.totp.start',{})
 await api('mfa.totp.confirm',{factor:factor.factor,code:totp(factor.secret,Date.parse(instant))})
 await stop()
 if(smoke) {
  await command(root,['export','--output',after])
  const archived=await rows(after)
  assert.ok(!archived.some(row=>row.table==='nc_portal_sessions'),'Customer runtime sessions stay out of portable archives')
  assert.ok(archived.some(row=>row.table==='nc_invoices'&&row.row.id===invoice))
  assert.ok(!JSON.stringify(archived).includes(factor.secret),'The exported factor stays sealed')
  await command(root,['reset','--yes'])
  await refuseCorruptArchive(after)
  await command(root,['import','--input',after,'--yes'])
  await command(root,['export','--output',restored])
  assert.deepEqual(await rows(restored),archived,'Every portable row survives real CLI export/reset/import')
  await setup()
  await start()
  await api('mfa.verify',{code:totp(factor.secret,Date.parse(instant))})
  assert.equal((await h.raw(`/portal/data?session=${portalChange.session.token}`)).status,401,'Restore never revives an old customer capability')
  const restoredInvoice=await api(`invoices/${invoice}`)
  assert.deepEqual([restoredInvoice.total_cents,restoredInvoice.tax_cents,restoredInvoice.balanceCents],[11000,1000,0])
  assert.equal(restoredInvoice.calculation.fingerprint,issued.calculation.fingerprint)
  await assertRestoredInvoices(archived)
  console.log('JOURNEY PASS public CLI billing export/reset/import and restored identity')
 } else {
 await command(root,['export','--output','public/exposed.rer'],{refuse:true})
 console.log('RECOVERY archive')
 await command(root,['export','--output',before])
 const original=await rows(before)
 const metadata=original.filter(row=>row.table==='nc_metadata_revisions')
 assert.deepEqual([...new Set(metadata.map(row=>row.row.kind))].sort(),['credit-note','customer','invoice','payment','price','subscription'])
 assert.ok(metadata.some(row=>row.row.revision>1))
 assert.ok(original.some(item=>item.table==='nc_portal_change_requests'&&item.row.id===portalChange.request.id),'Actual archive retains pending request evidence')
 assert.ok(JSON.stringify(original).includes('Private recovery note'))
 assert.ok(original.some(row=>row.table==='nc_mfa_factors'&&row.row.sealed_secret))
 assert.ok(!JSON.stringify(original).includes(factor.secret),'Factor plaintext stays out of the real archive')
 assert.ok(!JSON.stringify(original).includes(originalKey),'The sealing key stays in the installation')
 await start()
 await api('mfa.verify',{code:totp(factor.secret,Date.parse(instant))})
 const request=await api('erasure.request',{customer})
 const mail=h.mails.findLast(mail=>String(mail.text).includes('/erase/'))
 assert.deepEqual(mail.to,['private@recovery.example'])
 const path=new URL(mail.text.match(/https?:\/\/[^\s]+\/erase\/[a-f0-9]+/)[0]).pathname
 assert.equal((await h.raw(path,{form:new URLSearchParams({confirm:'yes'})})).status,200)
 assert.equal((await h.raw(path,{form:new URLSearchParams({confirm:'yes'})})).status,404)
 const verified=await api(`invoices/${invoice}`)
 assert.deepEqual(verified,issued,'Verification alone changes no financial evidence')
 const erasedReceipt=await api('erasure.approve',{request:request.id,confirm:true})
 assert.equal(erasedReceipt.receipt.changed.find(row=>row.kind==='nc_portal_change_requests').records,1)
 assert.equal((await h.raw(`/portal/change.request?session=${portalChange.session.token}`,{body:portalChange.body})).status,401,'Erasure withdraws the request capability')
 const retained=await api(`invoices/${invoice}`)
 assert.deepEqual([retained.total_cents,retained.tax_cents,retained.balanceCents],[11000,1000,0])
 assert.ok(!JSON.stringify(await api(`customers/${customer}`)).includes('Private recovery note'))
 await stop()
 console.log('RECOVERY archive')
 await command(root,['export','--output',after])
 const erased=await rows(after),serialized=JSON.stringify(erased)
 assert.ok(!erased.some(row=>row.table==='nc_portal_sessions'),'Customer runtime sessions stay out of privacy archives')
 assert.ok(!erased.some(row=>row.table==='nc_portal_change_requests'),'Erased requests never enter the anonymized restore')
 for(const value of ['private@recovery.example','RECOVERY-PRIVATE','Private home address','Private recovery note','Private recovery metadata'])assert.ok(!serialized.includes(value),'Erased personal data stays out of the real archive')
 assert.ok(erased.some(row=>row.table==='ik_d1_erasure_journal'))
 console.log('RECOVERY restore')
 await command(root,['reset','--yes'])
 await refuseCorruptArchive(after)
 await command(root,['import','--input',before,'--journal',after,'--yes'],{refuse:true})
 await command(root,['import','--input',after,'--yes'])
 await command(root,['import','--input',after,'--yes'],{refuse:true})
 await command(root,['export','--output',restored])
 assert.deepEqual(await rows(restored),erased,'Every portable row survives restore without resurrecting personal data')
 // Reapplying the declared setup upgrades the restored installation and keeps
 // its domain and applied migrations; a new factor key cannot open the factor.
 console.log('RECOVERY upgrade')
 await setup()
 const newKey=await mfaKey()
 await start(newKey)
 const held=await api('customers',undefined,403)
 assert.deepEqual([held.error,held.detail.reason],['mfa_enrollment_required','mfa_key_changed'])
 await stop()
 await start(originalKey)
 await api('mfa.verify',{code:totp(factor.secret,Date.parse(instant))})
 assert.equal((await h.raw(`/portal/data?session=${portalChange.session.token}`)).status,401,'Anonymized restore never revives an erased customer capability')
 await api('portal.session.issue',{customer,origin:h.origin,audience:'hosted'},404)
 const restoredInvoice=await api(`invoices/${invoice}`)
 assert.deepEqual([restoredInvoice.total_cents,restoredInvoice.tax_cents,restoredInvoice.balanceCents],[11000,1000,0])
 assert.deepEqual(restoredInvoice.calculation,retained.calculation,'Restore preserves the exact anonymized financial evidence')
 await assertRestoredInvoices(erased)
 await stop()
 console.log('JOURNEY PASS public CLI billing, erasure, restore, MFA custody and setup upgrade')
 }
} finally {await stop()}

// portal-journey: retained public-door assertions with one shared entry point.
async function portalJourneyJourney(mode) {
// PORT-005: use the real rer installation in a browser at desktop and phone,
// then export/reset/import. Customer capabilities and the signer never travel.
const { default: assert } = await import('node:assert/strict')
const { spawn } = await import('node:child_process')
const { createServer } = await import('node:net')
const { access, mkdir, mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const { chromium } = await import('@playwright/test')
const { readArchive } = await import('@runeditrun/rer/modules/portability')
const { command, devKey, signIn } = await import('./cli.mjs')
const { seedPortalRecords } = await import('./portal-sessions.mjs')
const { applyPolicy } = await import('./policy-helper.mjs')
const { populateErasureKinds } = await import('./erasure-record-kinds.mjs')
const { file } = await import('./harness.mjs')

assert.equal(process.env.NECTAR_TEST_CHECKOUT, '1', 'Use a disposable fresh checkout')
const root = process.cwd(), scratch = await mkdtemp(join(tmpdir(), 'nectar-portal-'))
const evidence = process.env.NECTAR_EVIDENCE_DIR ?? join(root, '.evidence/portal')
await mkdir(evidence, { recursive: true })
await access(join(root, '.dev.vars')).then(() => { throw new Error('A fresh unconfigured checkout is required') }, error => { if (error.code !== 'ENOENT') throw error })
const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve)); const port = socket.address().port; await new Promise(resolve => socket.close(resolve))
const origin = `http://127.0.0.1:${port}`, entry = import.meta.resolve('@runeditrun/rer/internal/global/rer.mjs').replace('file://', '')
let server, cookie, browser, runtimeOrigin, completed = false
const h = { origin, raw(path, { cookie: who, form, method = form ? 'POST' : 'GET', headers = {} } = {}) {
  const scheduled=path.startsWith('/cdn-cgi/local/scheduled')
  assert.ok(!scheduled||runtimeOrigin,'PORT-005 rer dev exposes its owned runtime transport for provider Cron')
  return fetch((scheduled?runtimeOrigin:origin) + (scheduled?path.replace('/cdn-cgi/local/scheduled','/cdn-cgi/handler/scheduled'):path), { method, redirect: 'manual', headers: { ...(who ? { cookie: who } : {}), ...(form ? { origin } : {}), ...headers }, body: form })
}, async api(path, who, body, status = 200) {
  const response = await fetch(`${origin}/api/nectar/${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'manual', headers: { cookie, ...(body === undefined ? {} : { origin, 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await response.text(); assert.equal(response.status, status, `PORT-005 ${path}: ${text.slice(0,300)}`); return JSON.parse(text)
} }
async function start() {
  const child = spawn(process.execPath, [entry, 'dev', '--foreground', '--port', String(port)], { cwd: root, stdio: ['ignore','pipe','pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } })
  let output = ''; for (const stream of [child.stdout,child.stderr]) stream.on('data', bytes => { output += bytes })
  server = child
  for (let attempt = 0; !output.includes('RER_READY'); attempt++) { assert.equal(child.exitCode, null, 'PORT-005 dev remains running: ' + output.replace(/RER_OPEN [^\n]+/g, 'RER_OPEN [redacted]').replace(/(token=|rer-dev=|RER_DEV_KEY=|PORTAL_KEY=)[^&\s"']+/g, '$1[redacted]').slice(-3500)); assert.ok(attempt < 1200, 'PORT-005 dev becomes ready'); await new Promise(resolve => setTimeout(resolve,250)) }
  runtimeOrigin=output.replace(/\x1b\[[0-9;]*m/g,'').match(/Local:\s+(http:\/\/127\.0\.0\.1:\d+)/)?.[1]
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
  browser = await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox'], headless:true,args:['--no-sandbox','--use-mock-keychain','--password-store=basic'] })
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
  const pendingResponse=await h.raw(`/portal/answer-proposal?session=${session.token}`,{form:new URLSearchParams({invoice:invoice.id,question:'What is the total?',credit_amount:'5',reason:'Customer-requested service review'})})
  assert.equal(pendingResponse.status,303,'PORT-005 customer proposal prepares without issuing a credit')
  const pendingId=new URL(pendingResponse.headers.get('location'),origin).pathname.split('/').at(-1)
  assert.equal((await h.api(`proposals/${pendingId}`,cookie)).created_by_kind,'customer')
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
  const restoredProposal=await h.api(`proposals/${pendingId}`,cookie)
  assert.equal(restoredProposal.status,'pending')
  assert.equal(restoredProposal.created_by_kind,'customer','PORT-005 archives preserve honest customer provenance and pending human approval')
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
  console.log('PORT-005 imported source capture applied; populating retention families')
  const rich = await populateErasureKinds(h, cookie, customer.id)
  console.log('PORT-005 complete retention families populated')
  await h.api('contact.add', cookie, { customer: customer.id, name: 'Portal private contact Aurelia', email: 'aurelia@portal-archive.example' })
  await h.api('note.add', cookie, { kind: 'customer', record: customer.id, body: 'Portal private archive note' })
  await h.api('metadata.write', cookie, { kind: 'customer', record: customer.id, revision: 0, metadata: { personal: 'Portal private archive metadata' } })
  const privacySession = await issue(customer.id), privacyPath = `/portal/privacy?session=${encodeURIComponent(privacySession.token)}`
  const beforeErasure = join(scratch, 'privacy-before.rer'), afterErasure = join(scratch, 'privacy-after.rer'), restored = join(scratch, 'privacy-restored.rer')
  await stop()
  await command(root, ['export', '--output', beforeErasure])
  assert.ok(JSON.stringify(await archiveItems(beforeErasure)).includes('Portal private contact Aurelia'), 'PORT-005 pre-erasure archive really contains the planted contact')
  await start()
  browser = await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox'], headless: true, args: ['--no-sandbox','--use-mock-keychain','--password-store=basic'] })
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

}

// erasure-archive: retained public-door assertions with one shared entry point.
async function erasureArchiveJourney(mode) {
// GOV-005: public rer commands over a real populated installation. Use a
// disposable checkout only; the journey deliberately resets and restores it.
const { default: assert } = await import('node:assert/strict')
const { spawn } = await import('node:child_process')
const { createServer } = await import('node:net')
const { access,appendFile,mkdir,mkdtemp,readFile,rm,writeFile } = await import('node:fs/promises')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const { readArchive } = await import('@runeditrun/rer/modules/portability')
const { command,devKey,signIn } = await import('./cli.mjs')
const { file } = await import('./harness.mjs')
const { applyPolicy } = await import('./policy-helper.mjs')
const { seedPendingPortalChange } = await import('./portal-change-requests.mjs')
const { stripeHistoryCapture } = await import('../fixtures/stripe-history.mjs')
assert.equal(process.env.NECTAR_TEST_CHECKOUT,'1','Use only a disposable checkout')
const root=process.cwd(),scratch=await mkdtemp(join(tmpdir(),'nectar-erasure-archive-'))
await access(join(root,'.dev.vars')).then(()=>{throw new Error('A fresh unconfigured checkout is required')},e=>{if(e.code!=='ENOENT')throw e})
const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r))
const origin=`http://127.0.0.1:${port}`,entry=import.meta.resolve('@runeditrun/rer/internal/global/rer.mjs').replace('file://','')
let server,cookie,serverOutput=()=>''
async function start(){
 const child=spawn(process.execPath,[entry,'dev','--foreground','--port',String(port)],{cwd:root,stdio:['ignore','pipe','pipe'],env:{...process.env,WRANGLER_SEND_METRICS:'false'}})
 let output='';serverOutput=()=>output;for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{output+=b})
 server=child
 for(let attempt=0;attempt<600;attempt++){assert.equal(child.exitCode,null,'GOV-005 dev remains alive: '+output.replace(/RER_OPEN [^\n]+/g,'RER_OPEN [redacted]').replace(/(token=|rer-dev=|RER_DEV_KEY=)[^&\s"']+/g,'$1[redacted]').slice(-3000));if(output.includes('RER_READY'))break;await new Promise(r=>setTimeout(r,250));assert.ok(attempt<599,'GOV-005 dev becomes ready')}
 console.log('GOV-005 real rer dev ready')
 cookie=await signIn(origin,await devKey(root))
}
async function stop(){if(!server)return;const child=server;server=null;if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Owned dev process did not stop')),30000).unref())])}}
async function api(path,who,body,status=200){const response=await fetch(`${origin}/api/nectar/${path}`,{method:body===undefined?'GET':'POST',headers:{cookie:who??cookie,...(body===undefined?{}:{origin,'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});if(response.status!==status)console.error(serverOutput().replace(/RER_OPEN [^\n]+/g,'RER_OPEN [redacted]').replace(/(token=|rer-dev=|RER_DEV_KEY=)[^&\s"']+/g,'$1[redacted]').slice(-4000));assert.equal(response.status,status,`GOV-005 ${path} status`);return response.json()}
const rows=async path=>{const bytes=await readFile(path),records=[];for await(const record of readArchive(new ReadableStream({start(c){c.enqueue(bytes);c.close()}})))records.push(record);return records}
const items=records=>records.filter(r=>r.kind==='part').flatMap(r=>r.items).map(({index,...item})=>item)
try{
 await mkdir('exports',{recursive:true});await writeFile('exports/erasure-answers.json',JSON.stringify({OWNER_EMAIL:'owner@example.test'}),{mode:0o600})
 await command(root,['setup','--answers','exports/erasure-answers.json','--non-interactive','--port',String(port)])
 await appendFile(join(root,'.dev.vars'),'\nNECTAR_LOCAL_TIME=2026-10-28T09:00:00Z\n')
 await start()
 await fetch(origin+'/setup',{method:'POST',redirect:'manual',headers:{cookie,origin,'content-type':'application/x-www-form-urlencoded'},body:'confirm=yes'})
 await api('business.configure',cookie,{legal_name:'Cedar Software Inc',timezone:'America/Los_Angeles',invoice_prefix:'CD',payment_terms_days:30})
 const h={api,origin,raw:(path,{body,headers={}}={})=>fetch(origin+path,{method:body===undefined?'GET':'POST',redirect:'manual',headers:{...(body===undefined?{}:{origin,'content-type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)})};await applyPolicy(h,cookie,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Reviewed GOV-005 archive journey'})
 await api('tax.review',cookie,{revision:(await api('business',cookie)).revision})
 const capture=Object.fromEntries(await Promise.all(['manifest','customers','products','prices','subscriptions','invoices','meters'].map(async name=>[name,file(`${name}.json`,await readFile(new URL(`../fixtures/stripe/${name}.json`,import.meta.url)),'application/json')])))
 const preview=await api('import.preview',cookie,capture);await api('import.apply',cookie,{...capture,fingerprint:preview.fingerprint})
 const customer=(await api('customers',cookie)).find(c=>c.external_id==='cus_NcAtlasFreight01')
 await api('contact.add',cookie,{customer:customer.id,name:'Amelia Privatecontact',email:'amelia.private@gov005.example'})
 const keyed=await fetch(`${origin}/api/nectar/note.add`,{method:'POST',headers:{cookie,origin,'content-type':'application/json','idempotency-key':'gov005-archive-note'},body:JSON.stringify({kind:'customer',record:customer.id,body:'private imported customer note GOV005'})});assert.equal(keyed.status,200)
 await api('metadata.write',cookie,{kind:'customer',record:customer.id,revision:0,metadata:{private:'private metadata GOV005'}})
 const historyCapture=stripeHistoryCapture()
 const historyFiles=Object.fromEntries(Object.entries(historyCapture).map(([name,value])=>[name,file(`${name}.json`,JSON.stringify(value),'application/json')]))
 const historyPreview=await api('import.preview',cookie,historyFiles);await api('import.apply',cookie,{...historyFiles,fingerprint:historyPreview.fingerprint})
 const historicalCustomer=(await api('customers',cookie)).find(c=>c.external_id==='synthetic-nectar-1')
 const historicRevenue=await api(`revenue?from=2026-07&to=2027-02&customer=${historicalCustomer.id}`,cookie)
 assert.equal(historicRevenue.openingCents,800000)
 const portalChange=await seedPendingPortalChange(h,cookie,customer.id)
 const currentPolicy=(await api('retention',cookie)).policy
 const policy=await api('retention.policy.prepare',cookie,{...currentPolicy,revision:currentPolicy.revision,enabled:true,save_kind:'discount',save_percent:50,save_months:2,winback_enabled:false})
 await api('retention.policy.decide',cookie,{request:policy.request,decision:'approved',confirm_single:true})
 const peer=(await api('customer.create',cookie,{external_id:'synthetic-nectar-archive-peer',name:'Retained peer',billing_email:(await api('me',cookie)).email})).id
 const peerSub=(await api('subscription.create',cookie,{customer:peer,start_date:'2026-01-01',price:[portalChange.prices[0]],quantity:['10']})).id
 const term=await api('term.prepare',cookie,{subscription:peerSub,revision:(await api(`subscriptions/${peerSub}`,cookie)).revision,term_start:'2026-01-01',months:24,auto_renew:true,notice_days:30,uplift_percent:'0'})
 await api('term.decide',cookie,{term:term.term,decision:'approved',confirm_single:true})
 const portalSession=()=>api('portal.session.issue',cookie,{customer:peer,origin,audience:'hosted'})
 const liveSession=await portalSession()
 const renewalPath=session=>`/portal/renewal/${peerSub}?session=${session.token}`
 const view=async session=>{const r=await h.raw(renewalPath(session),{headers:{accept:'application/json'}});assert.equal(r.status,200);return r.json()}
 const liveOffer=await view(liveSession)
 assert.equal(liveOffer.save.percent,50,'A real approved policy permits the live portal save before export')
 await stop()
 const before=join(scratch,'before.rer'),after=join(scratch,'after.rer'),restored=join(scratch,'restored.rer')
 await command(root,['export','--output',before]);assert.ok(JSON.stringify(items(await rows(before))).includes('Amelia Privatecontact'))
 assert.ok(items(await rows(before)).some(item=>item.table==='nc_portal_change_requests'&&item.row.id===portalChange.request.id),'The actual archive includes non-executable pending request evidence')
 assert.ok(!items(await rows(before)).some(i=>i.table==='nc_portal_retention_authority'),'Policy evidence exports without executable portal retention authority')
 assert.ok(!items(await rows(before)).some(i=>i.table==='nc_idempotency'),'DEV-002 the idempotency replay store never enters an archive')
 await start()
 const request=await api('erasure.request',cookie,{customer:customer.id})
 await api('erasure.verify',cookie,{request:request.id,reason:'Billing mailbox unreachable; independently compared signed company records',evidence:file('independent-check.txt','Independent verification of the owner request','text/plain')})
 const erased=await api('erasure.approve',cookie,{request:request.id,confirm:true})
 assert.ok(erased.receipt.changed.some(r=>r.kind==='nc_incumbent_invoices'))
 assert.equal(erased.receipt.changed.find(r=>r.kind==='nc_portal_change_requests').records,1)
 assert.equal((await h.raw(`/portal/change.request?session=${portalChange.session.token}`,{body:portalChange.body})).status,401,'Erasure withdraws the real request capability')
 const day=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(erased.receipt.approvedAt))
 assert.equal(erased.receipt.retained.legacyAnchor,day,'GOV-005 missing legacy issue/payment dates use the approval business-local date')
 assert.match(erased.receipt.retained.legacyDateRule,/unavailable/,'GOV-005 the receipt identifies missing legacy date evidence')
 assert.equal(erased.receipt.retained.until,`${Number(day.slice(0,4))+7}${day.slice(4)}`,'GOV-005 legacy financial custody expires seven calendar years after approval')
 const historicalRequest=await api('erasure.request',cookie,{customer:historicalCustomer.id})
 await api('erasure.verify',cookie,{request:historicalRequest.id,reason:'Independently checked historical account owner',evidence:file('historical-owner.txt','Signed owner history request','text/plain')})
 const historicalErasure=await api('erasure.approve',cookie,{request:historicalRequest.id,confirm:true})
 assert.equal(historicalErasure.receipt.retained.legacyAnchor,null)
 assert.ok(historicalErasure.receipt.changed.some(row=>row.kind==='nc_incumbent_history'))
 assert.deepEqual((await api(`revenue?from=2026-07&to=2027-02&customer=${historicalCustomer.id}`,cookie)).months,historicRevenue.months)
 await stop();await command(root,['export','--output',after])
 const archived=items(await rows(after)),privateValues=[customer.billing_email,customer.address,customer.external_id,'Amelia Privatecontact','amelia.private@gov005.example','private imported customer note GOV005','private metadata GOV005',historicalCustomer.billing_email,historicalCustomer.external_id,'synthetic-nectar-private-7'].filter(Boolean)
 for(const item of archived){const serialized=JSON.stringify(item);for(const value of privateValues)assert.ok(!serialized.includes(value),`GOV-005 archive ${item.table} removes personal text`)
  if(item.kind==='row')for(const [column,value] of Object.entries(item.row)){if(typeof value==='object'&&value?.blob){const decoded=Buffer.from(value.blob,'base64').toString();for(const personal of privateValues)assert.ok(!decoded.includes(personal),`GOV-005 retained blob ${item.table}.${column} has no erased personal data`)}}
 }
 assert.ok(!archived.some(r=>r.table==='nc_portal_change_requests'),'Erased requests never enter the anonymized restore')
 assert.ok(archived.some(r=>r.kind==='row'&&r.table==='nc_incumbent_revenue'),'MOVE-007 anonymous revenue schedules are in the actual archive')
 assert.ok(archived.some(r=>r.kind==='row'&&r.table==='ik_d1_erasure_journal'),'GOV-005 import custody retirement is journalled')
 await command(root,['reset','--yes'])
 await command(root,['import','--input',before,'--journal',after,'--yes'],{refuse:true})
 await command(root,['import','--input',after,'--yes'])
 await command(root,['export','--output',restored])
 assert.deepEqual(items(await rows(restored)),archived,'GOV-005 the post-erasure archive restores only anonymized records and exact retained financial custody')
 await start()
 assert.equal((await h.raw(renewalPath(liveSession),{headers:{accept:'application/json'}})).status,401,'An archived installation never restores its old customer session')
 const restoredSession=await portalSession(),restoredView=await view(restoredSession)
 assert.equal(restoredView.save,null,'Retained policy evidence cannot restore portal save execution authority')
 assert.equal((await h.raw(renewalPath(restoredSession),{body:{basis:restoredView.basis,confirm:'save',offer:liveOffer.save.id}})).status,409)
 assert.equal((await h.raw(renewalPath(restoredSession),{body:{basis:restoredView.basis,confirm:'cancel'}})).status,200,'Retention reapproval is never required to cancel renewal')
 assert.equal((await api(`subscriptions/${peerSub}`,cookie)).renewal.terms[0].auto_renew,0)
 console.log('GOV-005 real rer export, reset and import, old-archive refusal, anonymous restore and inactive portal retention authority passed')
}finally{await stop();await rm(scratch,{recursive:true,force:true})}

}

// mfa-archive: retained public-door assertions with one shared entry point.
async function mfaArchiveJourney(mode) {
// GOV-007: real rer setup/dev/export/reset/import in a disposable fresh checkout
// (needs 15 GiB free for rer dev's temporary files: point TMPDIR at a large volume).
// The archive carries the authenticator secret only sealed under MFA_KEY (no
// per-session check rows); a restore under another key puts the owner back at
// enrollment with the reason shown, and the original key opens it again.
const { default: assert } = await import('node:assert/strict')
const { spawn } = await import('node:child_process')
const { createServer } = await import('node:net')
const { access, mkdir, mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const { readArchive } = await import('@runeditrun/rer/modules/portability')
const { command, devKey, signIn } = await import('./cli.mjs')
const { totp } = await import('./mfa.mjs')
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

}

// metadata-restore: retained public-door assertions with one shared entry point.
async function metadataRestoreJourney(mode) {
// DEV-005: public rer export/reset/import/export custody in a populated,
// disposable checkout. Run after the metadata browser journey has stopped.
const { default: assert } = await import('node:assert/strict')
const { readFile,mkdtemp,rm } = await import('node:fs/promises')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const { readArchive } = await import('@runeditrun/rer/modules/portability')
const { command } = await import('./cli.mjs')
assert.equal(process.env.NECTAR_TEST_CHECKOUT,'1','Use only a disposable populated checkout')
const root=process.cwd(),scratch=await mkdtemp(join(tmpdir(),'nectar-metadata-'))
const read=async path=>{const bytes=await readFile(path),records=[];for await(const record of readArchive(new ReadableStream({start(c){c.enqueue(bytes);c.close()}})))records.push(record);return records}
const items=records=>records.filter(r=>r.kind==='part').flatMap(r=>r.items).map(({index,...item})=>item)
try{
 const beforeFile=join(scratch,'before.rer'),afterFile=join(scratch,'after.rer')
 await command(root,['export','--output',beforeFile])
 const before=items(await read(beforeFile))
 const metadata=before.filter(r=>r.kind==='row'&&r.table==='nc_metadata_revisions')
 assert.deepEqual([...new Set(metadata.map(r=>r.row.kind))].sort(),['credit-note','customer','invoice','payment','price','subscription'])
 assert.ok(metadata.some(r=>r.row.revision>1),'history is populated before restore')
 // Reset's public removal inventory is limited to this disposable installation.
 await command(root,['reset','--yes'])
 await command(root,['import','--input',beforeFile,'--yes'])
 await command(root,['export','--output',afterFile])
 const after=items(await read(afterFile))
 assert.deepEqual(after,before,'DEV-005 every portable original and metadata revision survives the empty-destination restore')
 assert.deepEqual(after.filter(r=>r.kind==='row'&&r.table==='nc_metadata_revisions'),metadata)
 console.log('DEV-005 rer export/reset/import/export preserves all six metadata kinds, exact strings, history and financial originals')
}finally{await rm(scratch,{recursive:true,force:true})}

}

// processor-archive: retained public-door assertions with one shared entry point.
async function processorArchiveJourney(mode) {
const { remittanceFile, remittanceFixtures } = await import('./remittance-files.mjs')
const { file } = await import('./harness.mjs')
// Public processor capture, statutory removal and actual rer archive restore.
const { default: assert } = await import('node:assert/strict')
const { access, mkdir, mkdtemp, readFile, rm } = await import('node:fs/promises')
const { join, relative } = await import('node:path')
const { readArchive } = await import('@runeditrun/rer/modules/portability')
const { harness } = await import('./harness.mjs')
const { command } = await import('./cli.mjs')
const { processorSetup, processorEventFlow } = await import('./processor-events.mjs')
const { processorCashEdge, processorCashFlow } = await import('./processor-cash.mjs')
const { processorCashReturnEdge, processorCashReturnFlow } = await import('./processor-cash-return.mjs')
const { importedCashEdge, processorCashImportedFlow } = await import('./processor-cash-imported.mjs')
const { totp } = await import('./mfa.mjs')

const eventKinds=['nc_processor_events','nc_processor_transactions','nc_processor_objects','nc_processor_failures','nc_processor_reversals']
const cashKinds=['nc_processor_events','nc_processor_cash_applications','nc_processor_cash_balances','nc_processor_cash_transactions','nc_processor_cash_unmatched','nc_processor_cash_escalations']
const returnKinds=['nc_processor_cash_returns']
const importedKinds=['nc_processor_cash_imported_applications','nc_processor_cash_imported_takeovers']
const nativeKinds=[...new Set([...eventKinds,...cashKinds])]
const remittanceKinds=['nc_remittances','nc_remittance_allocations']
const sourceKinds=[...nativeKinds,...returnKinds,...importedKinds,...remittanceKinds,'nc_remittance_source_keys']
const priorDay=day=>new Date(Date.parse(`${day}T12:00:00Z`)-86400000).toISOString()

/** Reuse in the existing processor journey; targets already passed the real
 * verified erasure door. Receipts count custody which ordinary views conceal. */
async function processorFinancialRemovalFlow(h,owner,{targets,finance,peer}) {
 const api=(path,body,status)=>h.api(path,owner,body,status)
 const requests=await api('erasures')
 const groups=targets.map(target=>({...target,request:requests.find(row=>row.customer_id===target.customer&&row.status==='complete')}))
 for(const group of groups)assert.ok(group.request?.retain_until,'Issued processor money has a retention deadline')
 groups.sort((a,b)=>a.request.retain_until.localeCompare(b.request.retain_until))
 const peerBefore=peer?await api(`processor-events?customer=${peer}`):null
 if(peerBefore)assert.ok(peerBefore.events.length&&peerBefore.cashApplications.length,'The unaffected peer has real processor custody')
 for(const deadline of [...new Set(groups.map(group=>group.request.retain_until))]) {
  const due=groups.filter(group=>group.request.retain_until===deadline)
  await h.advanceClock(priorDay(deadline))
  await h.api('erasure.purge',finance,{},403)
  assert.deepEqual((await api('erasure.purge',{})).removed,[],'Owner removal refuses premature destruction')
  for(const group of due)if(group.invoice)await api(`invoices/${group.invoice}`)
  await h.advanceClock(`${deadline}T12:00:00Z`)
  await h.api('erasure.purge',finance,{},403)
  const removed=(await api('erasure.purge',{})).removed
  for(const group of due){
   assert.ok(removed.includes(group.request.id),'The owner removes every due group at its deadline')
   if(group.invoice)await api(`invoices/${group.invoice}`,undefined,404)
   const completed=(await api('erasures')).find(row=>row.id===group.request.id)
   const removal=JSON.parse(completed.receipt_json).removal
   for(const kind of group.kinds)assert.ok(removal.records.some(row=>row.kind===kind&&row.records>0),`Due removal includes populated ${kind}`)
   assert.ok(removal.retainedLegalIdentityRemoved)
   assert.ok((await api('audit')).some(row=>row.action==='erasure.financial.remove'&&row.subject===group.request.id))
  }
  if(peerBefore)assert.deepEqual(await api(`processor-events?customer=${peer}`),peerBefore,'Peer processor sources remain exact after each removal')
 }
 assert.deepEqual((await api('erasure.purge',{})).removed,[],'Repeating removal creates no second destruction')
 return groups.map(group=>group.customer)
}

async function archiveItems(path) {
 const bytes=await readFile(path),items=[]
 for await(const record of readArchive(new ReadableStream({start(controller){controller.enqueue(bytes);controller.close()}}))) {
  if(record.kind==='part')items.push(...record.items.map(({index,...item})=>item))
 }
 return items
}
const sources=items=>items.filter(item=>item.kind==='row'&&sourceKinds.includes(item.table))

// Observe the ordinary enrollment response, then present that factor through
// the real verification route after restarting. Secrets never enter archives.
function observeOwnerEnrollment(h,owner,state) {
 const api=h.api
 h.api=async(...args)=>{
  const result=await api(...args)
  if(args[0]==='mfa.totp.start'&&args[1]===owner)state.secret=result.secret
  return result
 }
}
async function restoredOwner(h,state,instant) {
 const owner=await h.signIn(h.vars.OWNER_EMAIL)
 if(state.secret)await h.api('mfa.verify',owner,{code:totp(state.secret,Date.parse(instant))})
 observeOwnerEnrollment(h,owner,state)
 return owner
}

async function erase(h,owner,customer) {
 const email=(await h.api(`customers/${customer}`,owner)).billing_email,start=h.mails.length
 const request=await h.api('erasure.request',owner,{customer})
 const message=h.mails.slice(start).find(mail=>[mail.to].flat().includes(email))
 assert.ok(message,'Erasure verifies the original billing mailbox')
 const path=new URL(`${message.text??''} ${message.html??''}`.match(/https?:\/\/[^\s"<]+\/erase\/[a-f0-9]{64}/)[0]).pathname
 assert.equal((await h.raw(path,{form:new URLSearchParams({confirm:'yes'})})).status,200)
 await h.api('erasure.approve',owner,{request:request.id,confirm:true})
}

// A separate live customer proves the sweep does not consume another customer's
// applications, observed balance or transfer history in the same account.
async function cashPeer(h,owner,edge) {
 const api=(path,body)=>h.api(path,owner,body)
 const customer=(await api('customer.create',{external_id:'synthetic-nectar-91',name:'Synthetic peer',billing_email:'synthetic-nectar-91@example.test'})).id
 const charge=(await api('charge.add',{customer,amount:'90',description:'Peer service',effective_date:'2026-10-28',taxable:false})).charge
 const invoice=(await api('invoice.manual',{customer,charges:[charge],service_date:'2026-10-28'})).id
 await api('invoice.approve',{invoice,acknowledge:true})
 await api('invoice.finalise',{invoice,issue_date:'2026-10-28'})
 const remote='synthetic-nectar-native-customer-3',account_ref='synthetic-nectar-native-account-1'
 await api('collection.customer.bind',{customer,account_ref,stripe_customer_ref:remote,confirm:true})
 const issued=await api(`invoices/${invoice}`)
 await api('processor.event.consume',{account_ref,event_ref:edge.fund(remote,9500,issued.number)})
 assert.equal((await api(`invoices/${invoice}`)).paidCents,9000)
 return customer
}

async function processorArchiveJourney() {
 assert.equal(process.env.NECTAR_TEST_CHECKOUT,'1','Use only a disposable checkout: this journey resets local state')
 const root=process.cwd()
 // Never reset an existing local installation, even when the opt-in is present.
 for(const path of ['.dev.vars','.wrangler/state'])await access(join(root,path)).then(()=>{throw new Error('A fresh unconfigured checkout is required')},error=>{if(error.code!=='ENOENT')throw error})
 await mkdir(join(root,'exports'),{recursive:true})
 const scratch=await mkdtemp(join(root,'exports','processor-archive-'))
 const empty=join(scratch,'empty.rer'),populated=join(scratch,'populated.rer'),purged=join(scratch,'purged.rer')
 const restored=join(scratch,'restored.rer'),restoredPurged=join(scratch,'restored-purged.rer')
 let h
 try {
  // Let the real CLI create and ledger every migration before the Worker opens
  // exactly that binding. Product rows are created exclusively through HTTP.
  const only=mode
  const config=JSON.parse(await readFile(join(root,'wrangler.jsonc'),'utf8'))
  const persistence=join(root,'.wrangler/state/v3'),databaseId=config.d1_databases.find(binding=>binding.binding==='DB').database_id
  if(!only){
  await command(root,['export','--output',empty])
  const setup=await processorSetup(undefined,{persistence,databaseId,applyMigrations:false})
  h=setup.h
  const {owner,edge}=setup
  const enrollment={}
  observeOwnerEnrollment(h,owner,enrollment)
  const events=await processorEventFlow(h,owner,edge)
  const cashEdge=processorCashEdge()
  // A second runtime swaps only the paid network edge, sharing the same real
  // installation. No SQL copies, injected business rows or alternate API exist.
  let settings={...h.vars}
  await h.close();h=null
  h=await harness({assets:true,persistence,databaseId,applyMigrations:false,settings,localTime:'2026-10-28T10:00:00Z',stripeFetch:cashEdge.fetch,stripeSecret:'synthetic-nectar-1',stripeSecondarySecret:'synthetic-nectar-2'})
  const cashOwner=await restoredOwner(h,enrollment,'2026-10-28T10:00:00Z')
  const cash=await processorCashFlow(h,cashOwner,{cashEdge})
  const peer=await cashPeer(h,cashOwner,cashEdge)
  await erase(h,cashOwner,cash.customer)
  settings={...h.vars};await h.close();h=null
  await command(root,['export','--output',populated])
  const before=await archiveItems(populated),captured=sources(before)
  for(const kind of nativeKinds)assert.ok(captured.some(item=>item.table===kind),`Actual archive includes populated ${kind}`)
  for(const customer of [events.customer,cash.customer])assert.ok(captured.some(item=>item.row.customer_id===customer),'Erased financial custody remains in the archive until due')
  h=await harness({assets:true,persistence,databaseId,applyMigrations:false,settings,localTime:'2027-01-13T12:00:00Z'})
  const removalOwner=await restoredOwner(h,enrollment,'2027-01-13T12:00:00Z')
  const finance=await h.signIn(events.people.finance.email)
  const removed=await processorFinancialRemovalFlow(h,removalOwner,{finance,peer,targets:[{customer:events.customer,invoice:events.invoice,kinds:eventKinds},{customer:cash.customer,invoice:cash.invoices[0],kinds:cashKinds}]})
  await h.close();h=null
  await command(root,['export','--output',purged])
  const after=await archiveItems(purged)
  assert.ok(!sources(after).some(item=>removed.includes(item.row.customer_id)),'A real export proves no due processor custody survives hidden in storage')
  assert.deepEqual(sources(after),captured.filter(item=>!removed.includes(item.row.customer_id)),'Every peer and account-level processor source remains exact')
  await command(root,['reset','--yes'])
  await command(root,['import','--input',populated,'--yes'])
  await command(root,['export','--output',restored])
  assert.deepEqual(sources(await archiveItems(restored)),captured,'Actual rer restore preserves every populated processor source exactly')
  await command(root,['reset','--yes'])
  const refused=await command(root,['import','--input',populated,'--journal',relative(root,purged),'--yes'],{refuse:true})
  assert.match(refused,/later_journal|erased_row|erasure_epoch/,'The trusted later journal refuses older financial custody for a privacy reason')
  await command(root,['import','--input',purged,'--yes'])
  await command(root,['export','--output',restoredPurged])
  assert.deepEqual(sources(await archiveItems(restoredPurged)),sources(after),'Restoring the post-removal archive cannot resurrect purged processor custody')
  }
  if(!only||only==='returns')await additionalArchivePhase(root,scratch,{label:'returns',persistence,databaseId,edge:processorCashReturnEdge(),requiredKinds:returnKinds,
   async populate(worker,who,provider){
    const result=await processorCashReturnFlow(worker,who,{cashReturnEdge:provider})
    const peer=await cashPeer(worker,who,provider)
    await erase(worker,who,result.customer)
    return {customer:result.customer,peer,financeEmail:'synthetic-nectar-return-finance@example.test'}
   }})
  if(!only||only==='imported')await additionalArchivePhase(root,scratch,{label:'imported',persistence,databaseId,edge:importedCashEdge(),requiredKinds:importedKinds,localTime:'2026-10-28T10:00:00Z',
   async populate(worker,who,provider){
    const result=await processorCashImportedFlow(worker,who,{cashEdge:provider,keepFinancial:true})
    await worker.api('access.give',who,{email:'synthetic-nectar-archive-finance@example.test',name:'Archive finance',role:'finance'})
    await worker.signIn('synthetic-nectar-archive-finance@example.test',{requested:true})
    return {...result,financeEmail:'synthetic-nectar-archive-finance@example.test'}
   }})
  if(only==='remittances')await additionalArchivePhase(root,scratch,{label:'remittances',persistence,databaseId,edge:processorCashEdge(),requiredKinds:remittanceKinds,localTime:'2026-10-28T10:00:00Z',
   async populate(worker,who){
    const api=(path,body,status)=>worker.api(path,who,body,status)
    const {customer,issue}=await remittanceFixtures(worker,who),invoice=await issue('10.00')
    const source=remittanceFile([['synthetic-nectar-930','2026-10-15','USD','25.00','synthetic-nectar-901','','']])
    const receipt=(await api('remittance.upload',{file:source})).id
    const prepared=await api('remittance.preview',{receipt})
    const confirmed=await api('remittance.confirm',{receipt,fingerprint:prepared.fingerprint,confirm:true})
    const allocation=await api('remittance.allocate.preview',{receipt,invoice:invoice.id,amount:'10.00'})
    await api('remittance.allocate',{receipt,invoice:invoice.id,amount:'10.00',fingerprint:allocation.fingerprint,confirm:true})
    const financeEmail=['synthetic-nectar-931','example.test'].join('@')
    await api('access.give',{email:financeEmail,name:'Synthetic finance',role:'finance'})
    await worker.signIn(financeEmail,{requested:true})
    const request=await api('erasure.request',{customer})
    await api('erasure.verify',{request:request.id,reason:'Independent archive customer verification',evidence:file('synthetic-nectar-932.txt','Synthetic signed verification')})
    await api('erasure.approve',{request:request.id,confirm:true})
    await worker.assertStorageExcludes(['synthetic-nectar-901','synthetic-nectar-930'])
    return {customer,financeEmail,async restoreCheck(restored,owner,removed=false){
     await restored.api('remittance.upload',owner,{file:source},409)
     await restored.api('remittance.confirm',owner,{receipt,fingerprint:prepared.fingerprint,confirm:true},removed?404:409)
     const payments=await restored.api('payments',owner)
     assert.equal(payments.filter(p=>p.customer_id===customer).length,removed?0:1)
     if(!removed)assert.equal(payments.find(p=>p.id===confirmed.payment).amount_cents,2500)
    }}
   }})
  console.log(`Processor archive${only?` ${only} phase`:''}: public capture, exact rer restore, owner-only due removal, unchanged peers and older-archive refusal passed`)
 } finally {await h?.close();await rm(scratch,{recursive:true,force:true})}
}

// Return-only and imported originals need separate installations: their real
// frozen report journeys each reserve the owner's one October snapshot.
async function additionalArchivePhase(root,scratch,{label,persistence,databaseId,edge,requiredKinds,populate,localTime}) {
 const path=name=>join(scratch,`${label}-${name}.rer`)
 let h
 try {
  await command(root,['reset','--yes'])
  await command(root,['export','--output',path('empty')])
  const setup=await processorSetup(edge,{persistence,databaseId,applyMigrations:false,...localTime?{localTime}:{}})
  h=setup.h
  const enrollment={};observeOwnerEnrollment(h,setup.owner,enrollment)
  const target=await populate(h,setup.owner,edge)
  const settings={...h.vars}
  await h.close();h=null
  await command(root,['export','--output',path('populated')])
  const captured=sources(await archiveItems(path('populated')))
  for(const kind of requiredKinds)assert.ok(captured.some(item=>item.table===kind&&item.row.customer_id===target.customer),`Actual ${label} archive includes populated ${kind}`)
  h=await harness({assets:true,persistence,databaseId,applyMigrations:false,settings,localTime:'2026-11-02T12:00:00Z'})
  const owner=await restoredOwner(h,enrollment,'2026-11-02T12:00:00Z'),finance=await h.signIn(target.financeEmail)
  await processorFinancialRemovalFlow(h,owner,{finance,peer:target.peer,targets:[{customer:target.customer,kinds:requiredKinds}]})
  if(target.restoreCheck)await target.restoreCheck(h,owner,true)
  await h.close();h=null
  await command(root,['export','--output',path('purged')])
  const removed=sources(await archiveItems(path('purged')))
  assert.ok(!removed.some(item=>item.row.customer_id===target.customer),`Actual ${label} export contains no expired processor custody`)
  assert.deepEqual(removed,captured.filter(item=>item.row.customer_id!==target.customer),`${label} removal preserves all peer processor sources`)
  await command(root,['reset','--yes'])
  await command(root,['import','--input',path('populated'),'--yes'])
  await command(root,['export','--output',path('restored')])
  assert.deepEqual(sources(await archiveItems(path('restored'))),captured,`Actual rer restore preserves every populated ${label} processor source`)
  if(target.restoreCheck){
   h=await harness({assets:true,persistence,databaseId,applyMigrations:false,settings,localTime:'2026-11-02T12:00:00Z'})
   assert.equal((await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Restored owner'}})).status,303)
   await target.restoreCheck(h,await restoredOwner(h,enrollment,'2026-11-02T12:00:00Z'))
  }
 } finally {await h?.close()}
}

if(process.argv[1]===new URL(import.meta.url).pathname)await processorArchiveJourney()

}
