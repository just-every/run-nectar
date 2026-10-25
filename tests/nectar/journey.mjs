// The first-release journey in a real browser, run from a disposable fresh
// clone through `rer`: setup, dev, then at 1440 pixels a whole billing cycle by
// hand (business and tax, catalog, customers, a subscription with a contract
// exception and a scheduled change, a usage file, a bill run approved and
// finalised, a credit, a payment, a reminder, an agent proposal and a Stripe
// move-in), every main screen again at 390 pixels, and finally export and
// restore into a second fresh clone. Every business is invented.
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readArchive } from '@runeditrun/rer/modules/portability'
import { command, devKey, serving, signIn } from './cli.mjs'

assert.equal(process.env.NECTAR_TEST_CHECKOUT, '1', 'Set NECTAR_TEST_CHECKOUT=1 only in a disposable fresh git clone')
const root = process.cwd()
const evidence = process.env.NECTAR_EVIDENCE_DIR ?? join(root, '.evidence')
await mkdir(evidence, { recursive: true })
await access(join(root, '.dev.vars')).then(() => { throw new Error('The journey needs an unconfigured fresh clone') }, error => { if (error.code !== 'ENOENT') throw error })
const freePort = async () => { const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve)); const { port } = socket.address(); await new Promise(resolve => socket.close(resolve)); return port }
const port = await freePort()
let origin = `http://127.0.0.1:${port}`
const scratch = await mkdtemp(join(tmpdir(), 'nectar-journey-'))
const fixtures = new URL('../fixtures/stripe/', import.meta.url)
const shots = []
let server, browser, auditSnapshot
const auditOnly = process.argv.includes('--audit-only')

async function shot(page, name) {
  const width = page.viewportSize().width
  await page.waitForLoadState('load')
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  assert.ok(overflow <= 0, `${name} scrolls sideways by ${overflow}px at ${width}`)
  assert.equal(await page.locator('main h1').count() > 0, true, `${name} has a heading`)
  const file = `${width}-${name}.jpg`
  await page.screenshot({ path: join(evidence, file), fullPage: true, type: 'jpeg', quality: 82 })
  shots.push({ viewport: width, screen: name, path: new URL(page.url()).pathname, file })
}

const form = (page, action) => page.locator(`form[action="/app/do/${action}"]`)
async function submit(page, locator, button) {
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), locator.getByRole('button', { name: button }).click()])
  const error = new URL(page.url()).searchParams.get('error')
  assert.equal(error, null, `${button}: ${error}`)
}

async function cycle(page) {
  // Business identity, timezone and the declared tax policy, reviewed by the owner.
  await page.goto(`${origin}/app`)
  assert.equal(new URL(page.url()).pathname, '/app/settings')
  const identity = form(page, 'business.configure')
  await identity.getByLabel('Legal name', { exact: true }).fill('Riverbend Software Inc')
  await identity.getByLabel('Billing address', { exact: true }).fill('1 River Rd, Sacramento, CA 95814')
  await identity.getByLabel('Billing email (shown on invoices)', { exact: true }).fill('billing@riverbend.example')
  await identity.getByLabel('Billing timezone', { exact: true }).selectOption('America/Los_Angeles')
  await identity.getByLabel('Invoice number prefix', { exact: true }).fill('RB')
  await submit(page, identity, 'Save and continue')
  const tax = form(page, 'tax.declare')
  await tax.getByLabel('State', { exact: true }).selectOption('CA')
  await tax.getByLabel('Policy', { exact: true }).selectOption('flat_rate')
  await tax.getByLabel('Rate (%) for a flat rate', { exact: true }).fill('8.25')
  await tax.getByLabel('Basis for this declaration', { exact: true }).fill('Advised by our CPA, September 2026')
  await submit(page, tax, 'Prepare tax policy')
  const confirmation = form(page, 'policy.decide').filter({ has: page.locator('input[value="approved"]') })
  await confirmation.getByLabel('I confirm this exact policy change as the single approver').check()
  await submit(page, confirmation, 'Confirm single-approver change')
  await submit(page, form(page, 'tax.review'), 'I have reviewed this tax policy')

  // Catalog: products, price versions and a meter.
  await page.goto(`${origin}/app/catalog`)
  const meter = form(page, 'meter.create')
  await meter.getByLabel('Code (the meter name in usage files)', { exact: true }).fill('events')
  await meter.getByLabel('Name', { exact: true }).fill('Processed events')
  await meter.getByLabel('Unit', { exact: true }).fill('events')
  await submit(page, meter, 'Add meter')
  for (const [code, name] of [['core', 'Core plan'], ['seats', 'Seats'], ['events', 'Event processing']]) {
    const product = form(page, 'product.create')
    await product.getByLabel('Code', { exact: true }).fill(code)
    await product.getByLabel('Name', { exact: true }).fill(name)
    await submit(page, product, 'Add product')
  }
  await shot(page, 'catalog-products')
  for (const [name, kind, amount, extra] of [['Core plan', 'flat', '499', 'Monthly'], ['Seats', 'seat', '30'], ['Event processing', 'unit', '0.0004']]) {
    const price = page.locator('article.product', { has: page.getByRole('heading', { name: new RegExp(`^${name}`) }) }).locator('form[action="/app/do/price.create"]').filter({ has: page.getByRole('button', { name: 'Add price version', exact: true }) })
    await price.getByLabel('Kind', { exact: true }).selectOption(kind)
    await price.getByLabel('Unit price ($)', { exact: true }).fill(amount)
    if (kind === 'unit') await price.getByLabel('Meter (per unit only)', { exact: true }).selectOption({ label: 'events (events)' })
    if (extra) await price.getByLabel('Name for this price', { exact: true }).fill(extra)
    await submit(page, price, 'Add price version')
  }
  const grant = page.locator('article.product', { has: page.getByRole('heading', { name: /^Event processing/ }) }).locator('form[action="/app/do/feature.grant"]')
  await grant.getByLabel('Feature code', { exact: true }).fill('api_access')
  await submit(page, grant, 'Grant feature')
  await shot(page, 'catalog')

  // Customers, a subscription with a contract exception approved, and a trial subscription.
  for (const [id, name, email, exempt] of [['NW-1001', 'Northwind Robotics', 'ap@northwind.example', ''], ['PC-2002', 'Pinecrest Labs', 'billing@pinecrest.example', 'CA-RESALE-88']]) {
    await page.goto(`${origin}/app/customers`)
    const customer = form(page, 'customer.create')
    await customer.getByLabel('Customer ID', { exact: true }).fill(id)
    await customer.getByLabel('Name', { exact: true }).fill(name)
    await customer.getByLabel('Billing email', { exact: true }).fill(email)
    if (exempt) { await customer.getByLabel('Tax exempt', { exact: true }).check(); await customer.getByLabel('Exemption certificate reference', { exact: true }).fill(exempt) }
    await submit(page, customer, 'Add customer')
    const subscription = form(page, 'subscription.create')
    await subscription.getByLabel('Start date', { exact: true }).fill(exempt ? '2026-07-15' : '2026-07-01')
    if (exempt) {
      await subscription.getByLabel('Trial ends', { exact: true }).fill('2026-07-29')
      await subscription.getByLabel('Price 1', { exact: true }).selectOption({ label: await subscription.getByLabel('Price 1', { exact: true }).locator('option').filter({ hasText: /^Core plan(?: — Monthly)? v1:/ }).textContent() })
    } else {
      await subscription.getByLabel('Billing day of the month (1–28)', { exact: true }).fill('1')
      await subscription.getByLabel('Price 1', { exact: true }).selectOption({ label: await subscription.getByLabel('Price 1', { exact: true }).locator('option').filter({ hasText: /^Core plan(?: — Monthly)? v1:/ }).textContent() })
      await subscription.getByLabel('Price 2', { exact: true }).selectOption({ label: await subscription.getByLabel('Price 2', { exact: true }).locator('option').filter({ hasText: /^Seats(?: — Monthly)? v1:/ }).textContent() })
      await subscription.locator('.pair').nth(1).getByLabel('Seats (per-seat prices)', { exact: true }).fill('5')
      await subscription.getByLabel('Price 3', { exact: true }).selectOption({ label: await subscription.getByLabel('Price 3', { exact: true }).locator('option').filter({ hasText: /^Event processing(?: — Monthly)? v1:/ }).textContent() })
      await subscription.getByLabel('Kind', { exact: true }).selectOption('discount_percent')
      await subscription.getByLabel('Value', { exact: true }).fill('10')
      await subscription.getByLabel('From', { exact: true }).fill('2026-07-01')
      await subscription.getByLabel('Note', { exact: true }).fill('Launch partner')
      await subscription.getByLabel('Contract clause (quote it)', { exact: true }).fill('§4.2 Customer receives a ten percent (10%) discount on platform and seat fees.')
    }
    await submit(page, subscription, 'Start subscription')
    if (!exempt) {
      await submit(page, page.locator('form[action="/app/do/amendment.decide"]').filter({ has: page.locator('input[value="approved"]') }), 'Approve')
      await shot(page, 'subscription')
    }
  }
  await page.goto(`${origin}/app/customers`)
  await shot(page, 'customers')

  // A usage file with a duplicate and a bad row.
  await page.goto(`${origin}/app/usage?period=2026-07`)
  const rows = ['event_id,customer,meter,quantity,occurred_at', 'e-001,NW-1001,events,1000000,2026-07-02T10:00:00-07:00', 'e-002,NW-1001,events,2345678.5,2026-07-15T12:00:00-07:00', 'e-003,NW-1001,events,1000,2026-07-31T23:30:00-07:00', 'e-001,NW-1001,events,1000000,2026-07-02T10:00:00-07:00', 'e-006,NW-1001,events,1,2026-07-03 10:00', 'e-004,NW-1001,events,500,2026-08-01T00:30:00-07:00']
  await writeFile(join(scratch, 'july.csv'), rows.join('\n') + '\n')
  const upload = form(page, 'usage.submit')
  await upload.getByLabel('Usage file (CSV)', { exact: true }).setInputFiles(join(scratch, 'july.csv'))
  await submit(page, upload, 'Import usage')
  await page.goto(`${origin}/app/usage?period=2026-07`)
  await assert.doesNotReject(page.getByText('3,346,678.5 events').first().waitFor())
  await shot(page, 'usage')

  // The July bill run: prepared, reviewed, approved and finalised.
  await page.goto(`${origin}/app/billing`)
  const prepare = form(page, 'billrun.prepare')
  await prepare.getByLabel('Month', { exact: true }).fill('2026-07')
  await submit(page, prepare, 'Prepare draft')
  await page.getByRole('heading', { name: 'July 2026 bill run' }).waitFor()
  await shot(page, 'bill-run')
  await submit(page, form(page, 'invoice.approve'), 'Approve clean drafts')
  const finalise = form(page, 'invoice.finalise')
  await finalise.getByLabel('Invoice date (default today)', { exact: true }).fill('2026-08-15')
  await submit(page, finalise, 'Finalize approved')
  await page.getByRole('link', { name: 'Northwind Robotics' }).first().click()
  await page.getByRole('heading', { name: /^Invoice RB-/ }).waitFor()
  const invoiceUrl = page.url()

  // Receivables: a payment recorded, allocated, and a credit note.
  await page.goto(`${origin}/app/receivables`)
  const payment = form(page, 'payment.record')
  await payment.getByLabel('Customer', { exact: true }).selectOption({ label: 'Northwind Robotics' })
  await payment.getByLabel('Amount ($)', { exact: true }).fill('1000.00')
  await payment.getByLabel('Received on', { exact: true }).fill('2026-08-20')
  await payment.getByLabel('Reference', { exact: true }).fill('WIRE-7781')
  await submit(page, payment, 'Record payment')
  await page.goto(invoiceUrl)
  const allocate = form(page, 'payment.allocate')
  await allocate.getByLabel('Amount ($)', { exact: true }).fill('1000.00')
  await submit(page, allocate, 'Allocate payment')
  const credit = form(page, 'credit.issue')
  await credit.getByLabel('Credit amount ($)', { exact: true }).fill('500.00')
  await credit.getByLabel('Reason', { exact: true }).fill('Service credit for the 12 July outage')
  await submit(page, credit, 'Issue credit note')
  await shot(page, 'invoice')
  await page.goto(`${origin}/app/receivables`)
  await submit(page, form(page, 'reminder.prepare').first(), 'Draft reminder')
  await submit(page, form(page, 'reminder.approve').first(), 'Approve recipient and wording')
  await shot(page, 'receivables')

  // A scheduled change, previewed before approval.
  await page.goto(`${origin}/app/customers`)
  await page.getByRole('link', { name: 'Northwind Robotics' }).click()
  await page.locator('a[href^="/app/subscriptions/"]').first().click()
  const change = form(page, 'change.prepare')
  await change.getByLabel('Change', { exact: true }).selectOption({ label: 'Seats v1 × 5' })
  await change.getByLabel('New price', { exact: true }).selectOption({ label: 'Seats v1: $30.00 per seat' })
  await change.getByLabel('Seats', { exact: true }).fill('8')
  await change.getByLabel('Effective date', { exact: true }).fill('2026-08-16')
  await submit(page, change, 'Preview change')
  await shot(page, 'subscription-change')
  await submit(page, form(page, 'change.decide').filter({ has: page.locator('input[value="approved"]') }), 'Approve this preview')

  // An agent credential, and a contract-terms proposal the owner approves.
  await page.goto(`${origin}/app/access`)
  await page.getByLabel('Name', { exact: true }).last().fill('Finance agent')
  await page.getByRole('button', { name: 'Issue credential' }).click()
  const key = (await page.locator('code.secret').textContent()).trim()
  await page.goto(`${origin}/app/access`)
  await shot(page, 'access')
  const pinecrest = (await (await fetch(`${origin}/api/nectar/customers`, { headers: { authorization: `Bearer ${key}` } })).json()).find(c => c.external_id === 'PC-2002')
  const subscription = (await (await fetch(`${origin}/api/nectar/customers/${pinecrest.id}`, { headers: { authorization: `Bearer ${key}` } })).json()).subscriptions[0]
  const proposed = await fetch(`${origin}/api/nectar/proposal.create`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'amendment', title: 'Pinecrest renewal: 20% discount', payload: { subscription: subscription.id, kind: 'discount_percent', value: '20', effective_from: '2026-09-15', note: 'Renewal discount' }, evidence: { clauses: [{ quote: 'From 15 September 2026 the subscription fee is reduced by twenty percent (20%).', reference: 'Renewal order form, §2' }], ambiguities: ['No end date is stated; proposed without one.'] } }) })
  assert.equal(proposed.status, 200)
  await page.goto(`${origin}/app/proposals`)
  await shot(page, 'proposals')
  await page.getByRole('link', { name: 'Pinecrest renewal: 20% discount' }).click()
  await shot(page, 'proposal')
  await submit(page, form(page, 'proposal.decide').filter({ has: page.locator('input[value="approved"]') }), 'Approve')

  // Move in from Stripe: preview, apply.
  await page.goto(`${origin}/app/import`)
  for (const [label, name] of [['Manifest (manifest.json)', 'manifest'], ['Customers (GET /v1/customers)', 'customers'], ['Products (GET /v1/products)', 'products'], ['Prices (GET /v1/prices)', 'prices'], ['Subscriptions (GET /v1/subscriptions?status=all)', 'subscriptions'], ['Invoices (GET /v1/invoices), for shadow comparison', 'invoices'], ['Billing meters (GET /v1/billing/meters), for metered prices', 'meters']]) {
    await page.getByLabel(label).setInputFiles(new URL(`${name}.json`, fixtures).pathname)
  }
  await page.getByRole('button', { name: 'Preview the move' }).click()
  await page.getByRole('heading', { name: 'Move-in preview' }).waitFor()
  await shot(page, 'movein-preview')
  await Promise.all([page.waitForURL(/\/app\/import\?notice=Saved/), page.getByRole('button', { name: 'Apply this exact move' }).click()])
  await shot(page, 'movein')
  for (const [path, name] of [['/app', 'home'], ['/app/more', 'more'], ['/app/exports', 'exports'], ['/app/audit', 'audit'], ['/app/settings', 'settings']]) { await page.goto(origin + path); await shot(page, name) }
}

async function auditCycle(page) {
  const api = async (action, body) => {
    const response = body === undefined ? await page.request.get(origin+'/api/nectar/'+action) : await page.request.post(origin+'/api/nectar/'+action,{headers:{origin},data:body})
    assert.equal(response.status(),200,action)
    return response.json()
  }
  await api('business.configure',{legal_name:'Synthetic Audit Company',timezone:'UTC',invoice_prefix:'SA',payment_terms_days:30})
  const policy=await api('tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Synthetic reviewed audit journey'})
  await api('policy.decide',{request:policy.request,decision:'approved',confirm_single:true})
  await api('tax.review',{revision:(await api('business')).revision})
  await page.goto(origin+'/app/customers')
  const customerForm=form(page,'customer.create')
  await customerForm.getByLabel('Customer ID',{exact:true}).fill('synthetic-nectar-audit')
  await customerForm.getByLabel('Name',{exact:true}).fill('Synthetic Audit Customer')
  await customerForm.getByLabel('Billing email',{exact:true}).fill('audit@example.test')
  const before=await api('audit'),start=Date.now()
  await submit(page,customerForm,'Add customer')
  const customer=(await api('customers')).find(c=>c.external_id==='synthetic-nectar-audit')
  const created=(await api('audit')).filter(r=>!before.some(old=>old.seq===r.seq))
  assert.equal(created.length,1)
  assert.equal(created[0].action,'customer.create');assert.equal(created[0].subject,customer.id)
  assert.equal(created[0].actor,'owner@example.test');assert.ok(created[0].at>=start&&created[0].at<=Date.now())
  assert.equal(JSON.parse(created[0].detail).externalId,'synthetic-nectar-audit')
  const charge=await api('charge.add',{customer:customer.id,amount:'125',description:'Synthetic audit service',effective_date:'2026-01-05'})
  const manual=await api('invoice.manual',{customer:customer.id,charges:[charge.charge],service_date:'2026-01-05'})
  await api('invoice.approve',{invoice:manual.id,acknowledge:true})
  await api('invoice.finalise',{invoice:manual.id,issue_date:'2026-01-06'})
  await api('access.give',{email:'audit-accountant@example.test',name:'Audit Accountant',role:'accountant'})
  const ownerTrail=await api('audit')
  const key=await devKey(root)
  const accountantContext=await browser.newContext()
  try {
    const response=await accountantContext.request.get(origin+'/auth/dev/enter?as=audit-accountant%40example.test&returnTo=%2Fapp',{headers:{'x-rer-dev-key':key},maxRedirects:0})
    assert.equal(response.status(),303,'ordinary local invited-person sign-in')
    const accountant=await accountantContext.newPage()
    assert.deepEqual(await (await accountant.request.get(origin+'/api/nectar/audit')).json(),ownerTrail)
    for (const [who,name] of [[page,'owner'],[accountant,'accountant']]) {
      const document=await (await who.request.get(origin+`/app/billing/${manual.run}.json`)).json()
      const invoice=document.invoices.find(r=>r.id===manual.id)
      for(const action of ['invoice.manual','invoice.approve','invoice.issue']) {
        const expected=ownerTrail.find(r=>r.action===action&&r.subject===manual.id)
        assert.deepEqual(invoice.audit.find(r=>r.action===action),{at:expected.at,actor:expected.actor,action,detail:JSON.parse(expected.detail)})
      }
      for(const width of [1440,390]) {
        await who.setViewportSize({width,height:844})
        for(const [path,label] of [['/app/audit','audit'],[`/app/invoices/${manual.id}`,'invoice']]) {
          await who.goto(origin+path)
          await who.locator('details').evaluateAll(nodes=>nodes.forEach(n=>n.open=true))
          if(label==='audit')for(const value of ['customer create','invoice issue',manual.id])assert.ok((await who.locator('main').innerText()).includes(value),value)
          const iconOnly=await who.locator('a,button').evaluateAll(nodes=>nodes.filter(n=>!n.textContent.trim()&&n.querySelector('svg')).map(n=>n.outerHTML))
          assert.deepEqual(iconOnly,[],`${name} ${label}: controls have visible words`)
          await shot(who,`${name}-${label}`)
        }
      }
    }
  } finally {await accountantContext.close()}
  auditSnapshot=await api('audit')
  assert.deepEqual(auditSnapshot,ownerTrail,'all role and page reads leave the trail unchanged')
}

const MAIN = ['home', 'customers', 'subscription', 'catalog', 'usage', 'bill-run', 'invoice', 'receivables', 'proposals', 'proposal', 'movein', 'exports', 'settings', 'access', 'more', 'audit']

try {
  // Setup answers live inside the checkout (ignored exports/ folder), private to this user.
  await mkdir(join(root, 'exports'), { recursive: true })
  await writeFile(join(root, 'exports/answers.json'), JSON.stringify({ OWNER_EMAIL: 'owner@example.test' }), { mode: 0o600 })
  await chmod(join(root, 'exports/answers.json'), 0o600)
  await command(root, ['setup', '--answers', 'exports/answers.json', '--non-interactive', '--port', String(port)])
  server = await serving(root, 'dev', port)
  const open = server.open()
  assert.ok(open, 'dev prints a signed-in owner URL')
  origin = new URL(open).origin
  browser = await chromium.launch({ args: ['--use-mock-keychain', '--password-store=basic'] })
  const desktop = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
  await desktop.goto(open)
  await desktop.waitForURL(url => /^\/(app|setup)/.test(url.pathname))
  if (new URL(desktop.url()).pathname === '/setup') {
    await desktop.getByRole('checkbox').check()
    await desktop.getByRole('button', { name: 'Finish setup' }).click()
  }
  if(auditOnly) await auditCycle(desktop)
  else await cycle(desktop)
  if (!auditOnly) {
  // The same screens at phone width, and one piece of work done there.
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await desktop.context().storageState() })).newPage()
  for (const entry of shots.filter(entry => entry.viewport === 1440 && MAIN.includes(entry.screen))) { await phone.goto(origin + entry.path); await shot(phone, entry.screen) }
  await phone.goto(`${origin}/app/receivables`)
  const payment = form(phone, 'payment.record')
  await payment.getByLabel('Customer', { exact: true }).selectOption({ label: 'Pinecrest Labs' })
  await payment.getByLabel('Amount ($)', { exact: true }).fill('50.00')
  await payment.getByLabel('Received on', { exact: true }).fill('2026-09-02')
  await payment.getByLabel('Reference', { exact: true }).fill('CHK-2001')
  await submit(phone, payment, 'Record payment')
  await shot(phone, 'receivables-after-payment')
  }
  await browser.close(); browser = null
  await server.stop(); server = null

  // Leave with the data: export, refuse a corrupt or second import, restore into a fresh clone, export equal.
  await command(root, ['export', '--output', 'public/exposed.rer'], { refuse: true })
  await command(root, ['export', '--output', 'exports/journey.rer'])
  const read = async path => { const data = await readFile(path), records = []; for await (const record of readArchive(new ReadableStream({ start(controller) { controller.enqueue(data); controller.close() } }))) records.push(record); return records }
  const items = records => records.filter(record => record.kind === 'part').flatMap(record => record.items).map(({ index, ...item }) => item)
  const before = await read(join(root, 'exports/journey.rer'))
  for (const table of ['nc_invoices', 'nc_invoice_lines', 'nc_usage_events', 'nc_audit', 'nc_proposals', 'ik_jobs']) assert.ok(before[0].tables.some(entry => entry.name === table), `${table} is in the archive`)
  assert.ok(before[0].excludedTables.includes('oa_sessions'))
  const issued = items(before).filter(item => item.kind === 'row' && item.table === 'nc_invoices' && item.row.status === 'issued')
  assert.ok(issued.length >= (auditOnly?1:2) && issued.every(row => JSON.parse(row.row.calculation_json).inputs && row.row.approved_fingerprint))
  if(auditOnly) {
    const exported=items(before).filter(item=>item.kind==='row'&&item.table==='nc_audit').map(item=>item.row).sort((a,b)=>b.seq-a.seq)
    assert.deepEqual(exported,auditSnapshot,'real rer export retains every audit row and every field unchanged')
    await writeFile(join(evidence,'audit-results.json'),JSON.stringify({auditRows:exported.length,shots},null,2))
    console.log(`AUDIT_JOURNEY_PASS ${exported.length} exact audit rows; ${shots.length} browser screens`)
  } else {
  const target = join(scratch, 'restored')
  const clone = spawn('git', ['clone', '--quiet', '--no-local', root, target], { stdio: 'ignore' })
  assert.equal(await new Promise(resolve => clone.once('exit', resolve)), 0)
  await command(target, ['install'])
  await mkdir(join(target, 'exports'), { recursive: true })
  await copyFile(join(root, 'exports/journey.rer'), join(target, 'exports/journey.rer'))
  await writeFile(join(target, 'exports/corrupt.rer'), (await readFile(join(target, 'exports/journey.rer'), 'utf8')).replace('"kind":"part"', '"kind":"bad"'), { mode: 0o600 })
  await command(target, ['import', '--input', 'exports/corrupt.rer', '--yes'], { refuse: true })
  await command(target, ['import', '--input', 'exports/journey.rer', '--yes'])
  await command(target, ['import', '--input', 'exports/journey.rer', '--yes'], { refuse: true })
  await command(target, ['export', '--output', 'exports/restored.rer'])
  assert.deepEqual(items(await read(join(target, 'exports/restored.rer'))), items(before), 'every portable row survives an empty-target restore')
  // The restored installation serves the issued invoices with their calculation evidence.
  const restorePort = await freePort()
  await writeFile(join(target, 'exports/answers.json'), JSON.stringify({ OWNER_EMAIL: 'owner@example.test' }), { mode: 0o600 })
  await command(target, ['setup', '--answers', 'exports/answers.json', '--non-interactive', '--port', String(restorePort)])
  server = await serving(target, 'dev', restorePort)
  const restoredOrigin = `http://127.0.0.1:${restorePort}`
  const cookie = await signIn(restoredOrigin, await devKey(target))
  assert.equal((await fetch(`${restoredOrigin}/setup`, { method: 'POST', redirect: 'manual', headers: { cookie, origin: restoredOrigin, 'content-type': 'application/x-www-form-urlencoded' }, body: 'confirm=yes' })).status, 303)
  for (const row of issued) {
    const invoice = await (await fetch(`${restoredOrigin}/api/nectar/invoices/${row.row.id}`, { headers: { cookie } })).json()
    assert.equal(invoice.number, row.row.number); assert.equal(invoice.total_cents, row.row.total_cents)
    assert.equal(invoice.calculation.fingerprint, row.row.approved_fingerprint)
  }
  await server.stop(); server = null
  await writeFile(join(evidence, 'manifest.json'), JSON.stringify({ commit: process.env.NECTAR_COMMIT ?? null, business: 'Riverbend Software Inc (synthetic)', scenario: 'First billing cycle: setup, catalog, customers, subscription with an approved exception, usage file, July bill run approved and finalised, payment, credit, reminder, scheduled change, agent proposal, Stripe move-in; then every main screen at phone width.', design: '12ui D.png (bill-run review)', shots }, null, 2))
  console.log(`JOURNEY_PASS ${shots.length} screenshots; restore round trip equal`)
  }
} finally {
  if (browser) await browser.close().catch(() => {})
  if (server) await server.stop().catch(() => {})
  await rm(scratch, { recursive: true, force: true })
}
