if (process.argv[2] === '--browser') {
 const journeys={
  "clause-browser": clauseBrowserJourney,
  "customer-record-browser": customerRecordBrowserJourney,
  "customer-child-browser": customerChildBrowserJourney,
  "prepaid-topup-browser": prepaidTopupBrowserJourney,
  "prepaid-refund-browser": prepaidRefundBrowserJourney,
  "portal-prepaid-browser": portalPrepaidBrowserJourney,
  "payment-links-browser": paymentLinksBrowserJourney,
  "payment-retries-browser": paymentRetriesBrowserJourney,
  "portal-methods-browser": portalMethodsBrowserJourney,
 }
 const run=journeys[process.argv[3]]
 if(!run)throw new Error('Unknown browser journey')
 await run(process.argv[4])
 process.exit(0)
}
import { portalChangeRequestsFlow } from './portal-change-requests.mjs'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { harness } from './harness.mjs'

const evidence=process.env.NECTAR_EVIDENCE_DIR??'.evidence'

await mkdir(evidence,{recursive:true})

const h=await harness({assets:true}), origin=h.origin, shots=[]

const fixtures=new URL('../fixtures/stripe/',import.meta.url)

const scratch=await mkdtemp(join(tmpdir(),'nectar-browser-'))

let browser

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

try {
  assert.equal((await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})).status,303)
  const owner=await h.signIn(h.vars.OWNER_EMAIL)
  await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
  browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox']})
  const context=await browser.newContext({viewport:{width:1440,height:900}})
  await context.addCookies(owner.split('; ').map(pair=>{const i=pair.indexOf('=');return {name:pair.slice(0,i),value:pair.slice(i+1),url:origin}}))
  const desktop=await context.newPage()
  await cycle(desktop)
  await portalChangeRequestsFlow(h,owner)
  console.log('JOURNEY PASS desktop billing cycle')
  const phone=await(await browser.newContext({viewport:{width:390,height:844},storageState:await context.storageState()})).newPage()
  for(const entry of shots.filter(s=>s.viewport===1440)) {await phone.goto(origin+entry.path);await shot(phone,entry.screen)}
  await phone.goto(origin+'/app/receivables')
  const payment=form(phone,'payment.record')
  await payment.getByLabel('Customer',{exact:true}).selectOption({label:'Pinecrest Labs'})
  await payment.getByLabel('Amount ($)',{exact:true}).fill('50.00')
  await payment.getByLabel('Received on',{exact:true}).fill('2026-09-02')
  await payment.getByLabel('Reference',{exact:true}).fill('CHK-2001')
  await submit(phone,payment,'Record payment')
  await shot(phone,'receivables-after-payment')
  const recorded=(await h.api('payments',owner)).find(p=>p.reference==='CHK-2001')
  assert.equal(recorded.amount_cents,5000)
  console.log('JOURNEY PASS phone screens and payment')
} finally {await browser?.close();await h.close();await rm(scratch,{recursive:true,force:true})}

// clause-browser: retained public-door assertions with one shared entry point.
async function clauseBrowserJourney(mode) {
const { reconciliationFlow } = await import('./reconciliation.mjs')
const { commitments } = await import('./commitments.mjs')
const { seedPortalRecords } = await import('./portal-sessions.mjs')
const { portalCorrections } = await import('./portal-corrections.mjs')
const { entitlementQuotasFlow } = await import('./entitlement-quotas.mjs')
const { portalAnswersFlow } = await import('./portal-answers.mjs')
const { prepaidBrowser } = await import('./prepaid.mjs')
const { nativeCollectionFlow,harnessOptions: nativeOptions } = await import('./native-collection.mjs')
// Focused real-browser use of a clause's own public pages and native forms.
const { default: assert } = await import('node:assert/strict')
const { chromium } = await import('@playwright/test')
const { mkdir, writeFile } = await import('node:fs/promises')
const { harness } = await import('./harness.mjs')
const { applyPolicy } = await import('./policy-helper.mjs')
const { erasureFlow } = await import('./erasure.mjs')
const { moveCollectionFlow,moveCollectionHarnessOptions: collectionOptions } = await import('./move-history.mjs')
const { moveHistoryFlow } = await import('./move-history.mjs')
const { intervalsFlow } = await import('./intervals.mjs')
const { contractEntitySetup } = await import('./contract-setup.mjs')
const { intervalCancellationFlow } = await import('./interval-cancel.mjs')
const { numberingEntitiesFlow } = await import('./numbering-entities.mjs')
const kind=mode,directory=process.env.NECTAR_EVIDENCE_DIR??`.evidence/${kind}`
assert.ok(['assurance','entitlements','portal-usage','erasure','history','collection','numbering','intervals','cancellation','entity-setup','prepaid','native-collection'].includes(kind))
await mkdir(directory,{recursive:true})
const captures=[]
const h=await harness({assets:true,...(kind==='collection'?collectionOptions():kind==='native-collection'?nativeOptions():{})});let browser
try {
  await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})
  const owner=await h.signIn(h.vars.OWNER_EMAIL)
  await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
  await h.api('business.configure',owner,{legal_name:'Alder Research Software',timezone:'UTC',invoice_prefix:'ALDER',payment_terms_days:30})
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Reviewed focused browser journey'})
  await h.api('tax.review',owner,{revision:(await h.api('business',owner)).revision})
  browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{}),args:['--no-sandbox','--use-mock-keychain','--password-store=basic','--no-sandbox']})
  const context=await browser.newContext()
  await context.addCookies(owner.split('; ').map(value=>{const i=value.indexOf('=');return {name:value.slice(0,i),value:value.slice(i+1),url:h.origin}}))
  const page=await context.newPage()
  const shot=async(label,path)=>{
    if(path)await page.goto(h.origin+path)
    assert.ok(await page.locator('main h1').count(),label)
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${label} fits at ${page.viewportSize().width}`)
    await page.screenshot({path:`${directory}/${page.viewportSize().width}-${label}.png`,fullPage:true})
    captures.push({label,width:page.viewportSize().width,path:new URL(page.url()).pathname+new URL(page.url()).search.replace(/session=[^&]+/g,'session=[redacted]'),file:`${page.viewportSize().width}-${label}.png`})
    console.log(`BROWSER ${page.viewportSize().width} ${label}`)
  }
  const both = async (label,path,prepare) => {
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:950})
      if(path)await page.goto(h.origin+path)
      if(prepare)await prepare()
      await shot(label)
    }
  }
  const form = action => page.locator(`form[action="/app/do/${action}"]`)
  const submit = async locator => {
    await Promise.all([page.waitForNavigation({waitUntil:'load'}),locator.getByRole('button').first().click()])
    const url=new URL(page.url())
    assert.equal(url.searchParams.get('error'),null,`Native form submission ${url.pathname}: ${url.searchParams.get('error')}`)
  }
  if(kind==='assurance') {
    await reconciliationFlow(h,owner,async state=>{
      await both(`assurance-${state.label}`,state.path,async()=>{
        if(state.label==='assignee-demoted') {
          const approve=page.locator('form[action="/app/do/proposal.decide"]').filter({has:page.locator('input[name="decision"][value="approved"]')})
          await Promise.all([page.waitForNavigation({waitUntil:'load'}),approve.getByRole('button',{name:'Approve',exact:true}).click()])
          assert.equal(new URL(page.url()).searchParams.get('error'),'assurance_owner_unavailable')
          assert.match(await page.locator('[role="alert"]').innerText(),/assurance owner unavailable/)
        }
        const iconOnly=await page.locator('button,a,[role="button"]').evaluateAll(nodes=>nodes.filter(n=>getComputedStyle(n).display!=='none'&&!n.textContent.trim()&&n.querySelector('svg,img')).map(n=>n.getAttribute('aria-label')||n.getAttribute('title')||''))
        assert.deepEqual(iconOnly,[],'proposal screens contain no icon-only controls requiring a tooltip')
      })
    })
  }
  else if(kind==='entitlements') {
    await entitlementQuotasFlow(h,owner,{onState:async state=>{
      if(!state.label?.startsWith('numeric-'))return
      await both(state.label,`/app/customers/${state.customer}#ents`,async()=>{
        await page.reload()
        const section=page.locator('section[aria-labelledby="ents"]')
        const text=await section.innerText()
        assert.ok(text.includes(state.allowed ? `Numeric limit: ${state.limit}.` : 'Denied'),'The rendered entitlement matches the current API decision')
        await section.scrollIntoViewIfNeeded()
        await page.screenshot({path:`${directory}/${page.viewportSize().width}-${state.label}-detail.png`})
      })
      if(state.label==='numeric-approved')await both('numeric-policy','/app/catalog',async()=>{
        const policy=form('feature.policy').filter({has:page.locator(`input[name="product"][value="${state.product}"]`)})
        assert.equal(await policy.locator('input[name="numeric_limit"]').inputValue(),state.limit)
        await policy.scrollIntoViewIfNeeded()
        await page.screenshot({path:`${directory}/${page.viewportSize().width}-numeric-policy-detail.png`})
        // Every catalog control has a visible text label; there are no icon-only controls.
        assert.equal(await page.locator('button').evaluateAll(nodes=>nodes.filter(node=>!node.textContent.trim()).length),0)
      })
    }})
  }
  else if(kind==='portal-usage'){
    await context.clearCookies()
    const number=async text=>{
      const language=await page.locator('html').getAttribute('lang')
      const parts=new Intl.NumberFormat(language==='es-US'?'es-US':'en-US').formatToParts(1234.5)
      const group=parts.find(part=>part.type==='group')?.value,decimal=parts.find(part=>part.type==='decimal')?.value??'.'
      return Number((group?text.replaceAll(group,''):text).replace(decimal,'.').replace(/[^0-9.-]/g,''))
    }
    const customerPath=state=>`/portal/upcoming?session=${encodeURIComponent(state.session.token)}&subscription=${state.subscription}&period=${state.period}`
    await entitlementQuotasFlow(h,owner,{onState:async state=>{
      await both(`quota-${state.code}-${state.used}`,customerPath(state))
    }})
    await commitments(h,owner,{onState:async state=>{
      await both(`commitment-${state.label}`,customerPath(state),async()=>{
        await Promise.all([page.waitForNavigation(),page.getByRole('button').click()])
        assert.ok(await page.locator('section.card').count())
        const cards=page.locator('section.card').filter({has:page.locator('h2').filter({hasText:/^(Minimum commitment|Compromiso mínimo)$/})})
        assert.equal(await cards.count(),state.commitments.length)
        for(const [index,window] of state.commitments.entries()){
          const values=await cards.nth(index).locator('dd').allTextContents()
          for(const [field,key] of ['nominalMinimumCents','minimumCents','earnedCents','trueUpCents','remainingCents'].entries())assert.equal(Math.round(await number(values[field])*100),window[key],'Rendered English and Spanish commitment figures equal exact customer facts')
        }
        assert.equal(await page.locator('button:not(:has-text("Refresh")):not(:has-text("Actualizar"))').count(),0,'Every control has a visible label')
      })
      if(state.commitments.some(window=>window.invoices.length)){
        await both(`commitment-${state.label}-invoice`,customerPath(state),async()=>{
          await page.locator('a[href^="/portal/invoices/"]').first().click()
          assert.equal(await page.locator('a[href^="/app/"]').count(),0)
        })
      }
    }})
    const records=await seedPortalRecords(h,owner)
    const session=await h.api('portal.session.issue',owner,{customer:records.customers[0],origin:h.origin,audience:'hosted'})
    await portalCorrections(h,owner,session,records.invoice.id,async state=>{
      await both(`correction-${state.kind}-${state.state}`,customerPath(state))
      if(state.state==='issued')await both(`explanation-${state.kind}`,`/portal/adjustments?session=${encodeURIComponent(state.session.token)}`)
    })
    await portalAnswersFlow(h,owner,async state=>{
      await both(`answer-${state.topic}`,`/portal/answers?${new URLSearchParams({session:state.session.token,invoice:state.invoice,question:state.question})}`)
    })
  }
  else if(kind==='prepaid')await prepaidBrowser({h,owner,page,context,both,form,submit})
  else if(kind==='native-collection')await nativeCollectionFlow(h,owner,{prepareRecovery:async request=>{const row=(await h.api('native-collections',owner)).find(r=>r.id===request);await page.goto(h.origin+`/app/invoices/${row.invoice_id}`);const review=form('collection.recovery.prepare').filter({has:page.locator(`input[name="request"][value="${request}"]`)});await submit(review);return (await h.api('native-collections',owner)).find(r=>r.id===request)},confirmRecovery:async payload=>{const row=(await h.api('native-collections',owner)).find(r=>r.id===payload.request);await page.goto(h.origin+`/app/invoices/${row.invoice_id}`);const review=form('collection.recovery.confirm').filter({has:page.locator(`input[name="recovery"][value="${payload.recovery}"]`)});await review.locator('input[name="confirm"]').check();await submit(review);return (await h.api('native-collections',owner)).find(r=>r.id===row.id)},confirm:async payload=>{await page.goto(h.origin+`/app/invoices/${(await h.api('native-collections',owner)).find(row=>row.id===payload.request).invoice_id}`);const consent=form('collection.confirm').filter({has:page.locator(`input[name="request"][value="${payload.request}"]`)}).filter({has:page.locator('button')});await consent.locator('input[name="confirm"]').check();await submit(consent);return (await h.api('native-collections',owner)).find(row=>row.id===payload.request)},onState:async state=>{await both(`native-${state.label}-${state.request?.id??state.invoice}`,`/app/invoices/${state.invoice}#collection`)}})
  else if(kind==='entity-setup')await contractEntitySetup(h,owner,{
    decideSetup:async(payload,actor)=>{
      assert.equal(actor,owner)
      await page.goto(h.origin+`/app/proposals/${payload.proposal}`)
      const decision=form('proposal.decide').filter({has:page.locator('input[name="decision"][value="approved"]')})
      await submit(decision)
      const saved=await h.api(`proposals/${payload.proposal}`,owner)
      assert.equal(saved.status,'approved')
      return {id:saved.id,...saved.result}
    },
    onState:async state=>{
      if(state.proposal)await both(`${state.label}-proposal`,`/app/proposals/${state.proposal}`)
      if(state.customer)await both(`${state.label}-customer`,`/app/customers/${state.customer}`)
      if(state.invoice)await both(`${state.label}-invoice`,`/app/invoices/${state.invoice}`)
    }
  })
  else if(kind==='cancellation')await cancellationBrowser({h,owner,context,page,both,form,submit})
  else if(kind==='numbering')await numberingEntitiesFlow(h,owner,{onState:async state=>{
    if(state.label==='entity-revenue'){
      await both('entity-revenue-consolidated','/app/revenue?from=2026-09&to=2026-09')
      for(const entity of [...state.entities,'business','imported']){
        await page.goto(h.origin+'/app/revenue?from=2026-09&to=2026-09')
        const selector=page.locator('form[method="get"]').filter({has:page.locator('select[name="entity"]')})
        await selector.locator('select[name="entity"]').selectOption(entity)
        await submit(selector)
        assert.equal(new URL(page.url()).searchParams.get('entity'),entity)
        await both(`entity-revenue-${entity}`,new URL(page.url()).pathname+new URL(page.url()).search)
      }
      for(const [index,invoice]of state.invoices.entries())await both(`entity-revenue-source-${index}`,`/app/revenue/${invoice}?from=2026-09&to=2026-09&entity=${state.entities[index]}`)
      return
    }
    await both(`numbering-${state.label}`,'/app/numbering')
    if(state.label==='entities')await both('numbering-entity-identity','/app/numbering',async()=>{
      await page.locator('details').filter({has:form('entity.update').filter({has:page.locator(`input[name="entity"][value="${state.entities[0]}"]`)})}).locator('summary').first().click()
    })
    if(state.label==='configured')await both('numbering-source-capture','/app/numbering',async()=>{
      const capture=form('invoice.series.capture')
      await capture.locator('xpath=ancestor::details[1]/summary').click()
      await capture.locator('select[name="entity"]').selectOption(state.entities[0])
      await capture.locator('select[name="source_invoice"]').selectOption(state.source)
      await capture.locator('textarea[name="capture"]').fill(JSON.stringify(state.settings.capture,null,2))
      await capture.locator('input[name="confirm"]').check()
    })
    if(state.label==='issued') {
      for(const [index,invoice]of state.invoices.slice(0,2).entries())await both(`numbering-issued-entity-${index+1}`,`/app/invoices/${invoice}`)
      await page.goto(h.origin+'/app/numbering')
      const filter=page.locator('form[method="get"][action="/app/numbering"]')
      await filter.locator('select[name="entity"]').selectOption(state.entities[0])
      await submit(filter)
      assert.equal(new URL(page.url()).searchParams.get('entity'),state.entities[0])
      await both('numbering-filtered-register',new URL(page.url()).pathname+new URL(page.url()).search)
      await both('numbering-customer',`/app/customers/${state.customers[0]}`)
    }
  }})
  else if(kind==='intervals') {
    await intervalsFlow(h,owner,{onState:async(label,subscription,invoice)=>{
      const detail=await h.api(`subscriptions/${subscription}`,owner),source=await h.api(`invoices/${invoice}`,owner)
      const suffix=label==='cadence-issued'?`${source.calculation.inputs.billing.terms.unit}-${source.calculation.inputs.billing.terms.count}`:label.replace('-issued','')
      await both(`intervals-${suffix}-subscription`,`/app/subscriptions/${subscription}?preview_period=${source.issue_date.slice(0,7)}#upcoming`)
      await both(`intervals-${suffix}-invoice`,`/app/invoices/${invoice}`)
      if(label==='annual-issued') {
        await both('intervals-catalog','/app/catalog')
        await both('intervals-customer',`/app/customers/${detail.customer_id}?preview_period=2027-01`)
        await both('intervals-run',`/app/billing/${source.bill_run_id}`)
        await both('intervals-billing','/app/billing')
        await both('intervals-revenue',`/app/revenue?from=2026-01&to=2028-01&customer=${detail.customer_id}`)
        await both('intervals-revenue-source',`/app/revenue/${invoice}?from=2026-01&to=2028-01&customer=${detail.customer_id}`)
        await both('intervals-mrr',`/app/reports/mrr?period=2026-01&customer=${detail.customer_id}`)
        await both('intervals-mrr-source',`/app/reports/mrr/${invoice}?period=2026-01&customer=${detail.customer_id}`)
        await both('intervals-retention','/app/retention')
      }
    }})
    await nativeIntervalForms({h,owner,page,both,form,submit})
  }
  else if(kind==='erasure')await erasureFlow(h,owner,async state=>{
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:950})
      await shot(state.label,state.path)
    }
  })
  else if(kind==='collection')await moveCollectionFlow(h,owner,{
    prepare:async(customer,invoice)=>{
      await page.goto(h.origin+`/app/customers/${customer}`)
      await page.locator('select[name="invoice"]').selectOption(invoice)
      await Promise.all([page.waitForURL('**/app/customers/**'),page.getByRole('button',{name:'Review original invoice',exact:true}).click()])
      return (await h.api(`customers/${customer}`,owner)).importedCollections.find(row=>row.invoice_id===invoice)
    },
    execute:async(customer,request)=>{
      await page.goto(h.origin+`/app/customers/${customer}`)
      const form=page.locator('form[action="/app/do/imported.collection.execute"]').filter({has:page.locator(`input[value="${request.id}"]`)})
      await form.locator('input[name="disable_auto_advance"]').check()
      await form.locator('input[name="confirm"]').check()
      await Promise.all([page.waitForURL('**/app/customers/**'),form.getByRole('button').click()])
      return (await h.api(`customers/${customer}`,owner)).importedCollections.find(row=>row.id===request.id)
    },
    finalize:async(customer,request)=>{
      await page.goto(h.origin+`/app/customers/${customer}`)
      const form=page.locator('form[action="/app/do/imported.collection.finalize"]').filter({has:page.locator(`input[value="${request.id}"]`)})
      await form.locator('input[name="confirm"]').check()
      await Promise.all([page.waitForURL('**/app/customers/**'),form.getByRole('button').click()])
      return (await h.api(`customers/${customer}`,owner)).importedCollections.find(row=>row.id===request.id)
    },
    onState:async state=>{for(const width of [1440,390]){await page.setViewportSize({width,height:950});await shot(`collection-${state.label}`,`/app/customers/${state.customer}`)}}
  })
  else await moveHistoryFlow(h,owner,{onState:async state=>{
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:950})
      if(state.label==='preview') {
        await shot('import-upload','/app/import')
        for(const [name,value]of Object.entries(state.capture))await page.locator(`input[name="${name}"]`).setInputFiles({name:`${name}.json`,mimeType:'application/json',buffer:Buffer.from(JSON.stringify(value))})
        await Promise.all([page.waitForURL('**/app/import/preview'),page.getByRole('button',{name:'Preview the move',exact:true}).click()])
        await shot('import-preview')
      } else {
        const paths=[['customer-history',`/app/customers/${state.customer}`],['import-applied','/app/import'],['mrr-history',`/app/reports/mrr?period=2026-06&customer=${state.customer}`],['billings',`/app/reports/billings?period=${state.period}&customer=${state.customer}`],['billings-source',`/app/reports/billings/${state.annual}?period=${state.period}&customer=${state.customer}`],['collections-source',`/app/reports/collections/${state.payment}?period=${state.period}&customer=${state.customer}`],['revenue',`/app/revenue?from=2026-07&to=2027-02&customer=${state.customer}`],['revenue-source',`/app/revenue/${state.annual}?from=2026-07&to=2027-02&customer=${state.customer}`],['frozen-report',`/app/report-deliveries/${state.delivery}`]]
        for(const [label,path]of paths)await shot(label,path)
      }
    }
  }})
  await writeFile(`${directory}/screens.json`,JSON.stringify({kind,captures},null,2))
} finally {await browser?.close();await h.close()}

async function nativeIntervalForms({h,owner,page,both,form,submit}) {
  await h.advanceClock('2034-01-01T20:00:00Z')
  await page.goto(h.origin+'/app/catalog')
  let fields=form('meter.create')
  await fields.locator('[name="code"]').fill('browser-calendar-calls')
  await fields.locator('[name="name"]').fill('Browser calendar calls')
  await fields.locator('[name="unit_label"]').fill('calls')
  await submit(fields)
  const meter=(await h.api('catalog',owner)).meters.find(row=>row.code==='browser-calendar-calls')
  assert.ok(meter)
  const prices=[]
  for(const row of [
    {code:'browser-calendar-annual',name:'Annual research platform',kind:'flat',amount:'1200',interval:'annual',timing:'advance'},
    {code:'browser-calendar-usage',name:'Monthly research usage',kind:'unit',amount:'2',interval:'month',timing:'arrears'},
  ]) {
    fields=form('product.create')
    await fields.locator('[name="code"]').fill(row.code)
    await fields.locator('[name="name"]').fill(row.name)
    await submit(fields)
    const product=(await h.api('catalog',owner)).products.find(product=>product.code===row.code)
    assert.ok(product)
    fields=form('price.create').filter({has:page.locator(`input[name="product"][value="${product.id}"]`)}).filter({has:page.locator('input[name="unit_amount"]')})
    await fields.locator('[name="kind"]').selectOption(row.kind)
    await fields.locator('[name="unit_amount"]').fill(row.amount)
    await fields.locator('[name="billing_interval"]').selectOption(row.interval)
    await fields.locator('[name="interval_count"]').fill('1')
    await fields.locator('[name="billing_timing"]').selectOption(row.timing)
    if(row.kind==='unit')await fields.locator('[name="meter"]').selectOption(meter.id)
    await fields.locator('[name="taxable"]').uncheck()
    await both(`forms-${row.code}-price`)
    await submit(fields)
    const price=(await h.api('catalog',owner)).prices.find(price=>price.product_id===product.id)
    assert.ok(price,'Submitting the native catalog form creates a real immutable price')
    assert.deepEqual([price.billing.unit,price.billing.count,price.billing.timing],row.kind==='flat'?['month',12,'advance']:['month',1,'arrears'])
    prices.push(price.id)
  }
  await both('forms-interval-catalog','/app/catalog')
  await page.goto(h.origin+'/app/customers')
  fields=form('customer.create')
  await fields.locator('[name="external_id"]').fill('synthetic-nectar-browser-calendar')
  await fields.locator('[name="name"]').fill('Calendar Field Research')
  await fields.locator('[name="billing_email"]').fill('field@browser-calendar.example')
  await both('forms-interval-new-customer')
  await submit(fields)
  const customer=(await h.api('customers',owner)).find(row=>row.external_id==='synthetic-nectar-browser-calendar')
  assert.ok(customer)
  fields=form('subscription.create')
  await fields.locator('[name="start_date"]').fill('2034-01-01')
  await fields.locator('[name="term_months"]').selectOption('12')
  await fields.locator('[name="billing_anchor_date"]').fill('2034-01-01')
  await fields.locator('select[name="price"]').nth(0).selectOption(prices[0])
  await fields.locator('select[name="price"]').nth(1).selectOption(prices[1])
  await both('forms-interval-new-subscription')
  await submit(fields)
  const subscription=new URL(page.url()).pathname.split('/').at(-1)
  const detail=await h.api(`subscriptions/${subscription}`,owner)
  assert.equal(detail.contract_end_date,'2035-01-01')
  assert.deepEqual(detail.items.map(item=>item.price_id).sort(),[...prices].sort())
  await both('forms-interval-upcoming',`/app/subscriptions/${subscription}?preview_period=2034-01#upcoming`)
  await both('forms-interval-customer',`/app/customers/${customer.id}?preview_period=2034-01`)
  const issue = async (month,expected) => {
    await page.goto(h.origin+'/app/billing')
    const prepare=form('billrun.prepare')
    await prepare.locator('[name="period"]').fill(month)
    await both(`forms-interval-${month}-prepare`)
    await submit(prepare)
    const run=new URL(page.url()).pathname.split('/').at(-1)
    const invoice=(await h.api(`runs/${run}`,owner)).invoices.find(invoice=>invoice.customer_id===customer.id)
    assert.ok(invoice)
    assert.equal(invoice.total_cents,expected)
    await both(`forms-interval-${month}-run`,`/app/billing/${run}`)
    await page.goto(h.origin+`/app/invoices/${invoice.id}`)
    await both(`forms-interval-${month}-draft`)
    const approve=form('invoice.approve')
    if(await approve.locator('[name="acknowledge"]').count())await approve.locator('[name="acknowledge"]').check()
    await submit(approve)
    assert.equal((await h.api(`invoices/${invoice.id}`,owner)).status,'approved')
    await both(`forms-interval-${month}-approved`)
    const finalize=form('invoice.finalise')
    await finalize.locator('[name="issue_date"]').fill(`${month}-01`)
    await submit(finalize)
    const issued=await h.api(`invoices/${invoice.id}`,owner)
    assert.equal(issued.status,'issued')
    assert.equal(issued.total_cents,expected)
    await both(`forms-interval-${month}-issued`)
    return issued
  }
  const annual=await issue('2034-01',120000)
  await h.api('usage.submit',owner,{events:[{event_id:'synthetic-nectar-browser-calendar-usage',customer:'synthetic-nectar-browser-calendar',meter:'browser-calendar-calls',quantity:'3',occurred_at:'2034-01-15T12:00:00Z'}]})
  await h.advanceClock('2034-02-01T20:00:00Z')
  const usage=await issue('2034-02',600)
  assert.deepEqual([usage.period_start,usage.period_end],['2034-01-01','2034-02-01'])
  const source=await h.api(`revenue/${annual.id}`,owner)
  assert.deepEqual(source.schedules[0].entries.map(entry=>entry.amountCents),Array(12).fill(10000))
  await both('forms-interval-final-customer',`/app/customers/${customer.id}?preview_period=2034-02`)
  await both('forms-interval-revenue',`/app/revenue?from=2034-01&to=2034-12&customer=${customer.id}`)
  await both('forms-interval-revenue-source',`/app/revenue/${annual.id}?from=2034-01&to=2034-12&customer=${customer.id}`)
  await both('forms-interval-mrr',`/app/reports/mrr?period=2034-01&customer=${customer.id}`)
  await both('forms-interval-billings',`/app/reports/billings?period=2034-01&customer=${customer.id}`)
  await both('forms-interval-billings-source',`/app/reports/billings/${annual.id}?period=2034-01&customer=${customer.id}`)
  await both('forms-interval-retention-cadence','/app/retention',async()=>{
    await form('retention.policy.prepare').locator('[name="save_price_id"]').selectOption(prices[0])
    await form('retention.policy.prepare').locator('[name="pause_price_id"]').selectOption(prices[0])
    await form('retention.policy.prepare').locator('[name="winback_price_id"]').selectOption(prices[0])
  })
}


async function cancellationBrowser({h,owner,context,page,both,form,submit}) {
  const subscriptions = new Map(), preparedModes = new Set(), decidedKinds = new Set()
  const asActor = async actor => context.addCookies(actor.split('; ').map(value=>{
    const index=value.indexOf('=')
    return {name:value.slice(0,index),value:value.slice(index+1),url:h.origin}
  }))
  await intervalCancellationFlow(h,owner,{
    prepareCancellation:async payload=>{
      await asActor(owner)
      const before=await h.api(`subscriptions/${payload.subscription}`,owner)
      const previous=new Set(before.cancellations.map(row=>row.id))
      await page.goto(h.origin+`/app/subscriptions/${payload.subscription}`)
      const cancel=form('subscription.cancel')
      await cancel.locator('[name="mode"]').selectOption(payload.mode)
      await cancel.locator('[name="effective_date"]').fill(payload.effective_date)
      await cancel.locator('[name="reason"]').fill(payload.reason)
      if(!preparedModes.has(payload.mode)) {
        await both(`cancellation-native-${payload.mode}-prepare`)
        preparedModes.add(payload.mode)
      }
      await submit(cancel)
      const after=await h.api(`subscriptions/${payload.subscription}`,owner)
      const request=after.cancellations.find(row=>!previous.has(row.id))
      if(!request)return {id:after.id,endDate:after.end_date}
      subscriptions.set(request.id,payload.subscription)
      return {id:after.id,cancellation:request.id,status:request.status,endDate:request.effective_date,
        credits:request.plan.plan.credits,amountCents:request.plan.plan.amountCents}
    },
    decideCancellation:async(payload,actor)=>{
      const subscription=subscriptions.get(payload.cancellation)
      assert.ok(subscription)
      await asActor(actor)
      try {
        await page.goto(h.origin+`/app/subscriptions/${subscription}`)
        const decision=form('subscription.cancel.decide').filter({has:page.locator(`input[name="cancellation"][value="${payload.cancellation}"]`)}).filter({has:page.locator(`input[name="decision"][value="${payload.decision}"]`)})
        assert.equal(await decision.count(),1)
        if(!decidedKinds.has(payload.decision)) {
          await both(`cancellation-native-${payload.decision}-review`)
          decidedKinds.add(payload.decision)
        }
        await submit(decision)
        const after=await h.api(`subscriptions/${subscription}`,actor),request=after.cancellations.find(row=>row.id===payload.cancellation)
        assert.equal(request.status,payload.decision)
        return {id:subscription,cancellation:request.id,status:request.status,endDate:after.end_date}
      } finally {await asActor(owner)}
    },
    onState:async state=>{
      await asActor(state.owner)
      const subject=state.index===undefined?'control':state.paid===0?'unpaid':state.paid===1188000?'paid':'part-paid'
      const label=`cancellation-${subject}-${state.label}`
      await both(`${label}-subscription`,`/app/subscriptions/${state.subscription}?preview_period=2026-07#lifecycle`)
      await both(`${label}-original-invoice`,`/app/invoices/${state.invoice}`)
      if(state.label==='pending-credit'&&state.index===2) {
        await asActor(state.finance)
        await both(`${label}-finance-credit-plan`,`/app/subscriptions/${state.subscription}#lifecycle`)
        await asActor(state.owner)
      }
      if(['approved','reactivated','restart-issued'].includes(state.label)&&state.index===2)await both(`${label}-customer-credit`,`/app/customers/${state.customer}?preview_period=2026-07`)
      if(state.label==='reactivated')await both(`${label}-upcoming`,`/app/subscriptions/${state.subscription}?preview_period=2026-07#upcoming`)
      if(state.label==='stale') {
        await asActor(state.finance)
        await page.goto(h.origin+`/app/subscriptions/${state.subscription}`)
        const decision=form('subscription.cancel.decide').filter({has:page.locator(`input[name="cancellation"][value="${state.request}"]`)}).filter({has:page.locator('input[name="decision"][value="approved"]')})
        await Promise.all([page.waitForNavigation({waitUntil:'load'}),decision.getByRole('button').click()])
        const refused=new URL(page.url())
        assert.equal(refused.searchParams.get('error'),'cancellation_stale')
        await both(`${label}-refused`,refused.pathname+refused.search)
        await asActor(state.owner)
      }
      if(state.restartInvoice) {
        await both(`${label}-restart-invoice`,`/app/invoices/${state.restartInvoice}`)
        await both(`${label}-revenue-source`,`/app/revenue/${state.invoice}?from=2026-01&to=2026-12&customer=${state.customer}`)
      }
    },
  })
}

}

// customer-record-browser: retained public-door assertions with one shared entry point.
async function customerRecordBrowserJourney(mode) {
// CUS-001 current customer composition, native customer lookup and exact scoped sources.
const { default: assert } = await import('node:assert/strict')
const {mkdir,writeFile} = await import('node:fs/promises')
const {chromium} = await import('@playwright/test')
const {harness} = await import('./harness.mjs')
const {applyPolicy} = await import('./policy-helper.mjs')
const {customerSearchFlow,harnessOptions} = await import('./customer-search.mjs')
const directory=process.env.NECTAR_EVIDENCE_DIR??'.evidence/customer-record'
const hostedFocus=process.env.NECTAR_BROWSER_FOCUS==='hosted'
await mkdir(directory,{recursive:true})
const h=await harness({assets:true,...harnessOptions()}),captures=[]
let browser
try{
  await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})
  const owner=await h.signIn(h.vars.OWNER_EMAIL)
  await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
  await h.api('business.configure',owner,{legal_name:'Alder Research Software',timezone:'UTC',invoice_prefix:'ALDER',payment_terms_days:30})
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Reviewed customer record journey'})
  await h.api('tax.review',owner,{revision:(await h.api('business',owner)).revision})
  browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,headless:true,args:['--no-sandbox','--use-mock-keychain','--password-store=basic']})
  const context=await browser.newContext(),page=await context.newPage()
  const customerContext=await browser.newContext(),customerPage=await customerContext.newPage()
  await customerPage.route('https://checkout.stripe.com/**',route=>route.abort())
  await context.addCookies(owner.split('; ').map(value=>{const i=value.indexOf('=');return {name:value.slice(0,i),value:value.slice(i+1),url:h.origin}}))
  const shot=async(label,width)=>{
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${label} fits ${width}`)
    const iconOnly=await page.locator('a,button,[role=button]').evaluateAll(nodes=>nodes.filter(n=>!n.textContent.trim()&&n.querySelector('svg,img')).map(n=>n.outerHTML));assert.deepEqual(iconOnly,[])
    if(hostedFocus&&!label.startsWith('hosted-'))return
    if(hostedFocus){const target=label.endsWith('-operator')?page.getByRole('heading',{name:'Hosted payment setup',exact:true}):page.locator('#saved-payment-methods');await target.scrollIntoViewIfNeeded()}
    const focusNames=label==='ach-before-verification'?['Verify an external ACH payment']:label.endsWith('customer')?['Payment receipts','Verified external ACH payments','Refund lifecycle','Saved payment methods']:[]
    for(const name of focusNames){const heading=page.getByRole('heading',{name,exact:true});if(await heading.count()===1)await heading.locator('..').screenshot({path:`${directory}/${width}-${label}-${name.toLowerCase().replaceAll(' ','-')}.png`})}
    const file=`${width}-${label}.png`;await page.screenshot({path:`${directory}/${file}`,fullPage:!hostedFocus});captures.push({width,label,file});console.log('BROWSER',width,label)
  }
  await customerSearchFlow(h,owner,async({customer,query,kind})=>{
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:950})
      assert.equal((await page.goto(h.origin+'/app/customers')).status(),200)
      const form=page.getByRole('search',{name:'Customer lookup'})
      await form.locator('[name=search]').fill(query??'billing@marigold.example')
      await Promise.all([page.waitForNavigation({waitUntil:'load'}),form.getByRole('button',{name:'Search',exact:true}).click()])
      const link=page.locator(`a[href="/app/customers/${customer}"]`);assert.equal(await link.count(),1)
      await shot(`${kind??'billing'}-search`,width)
      await Promise.all([page.waitForNavigation({waitUntil:'load'}),link.click()])
      assert.equal(new URL(page.url()).pathname,`/app/customers/${customer}`)
      await shot(`${kind??'billing'}-customer`,width)
      if(kind==='full-cycle'){
        const receipt=page.locator('main a[href^="/app/payments/"][href$="/receipt"]').first()
        await Promise.all([page.waitForNavigation({waitUntil:'load'}),receipt.click()])
        assert.equal(new URL(page.url()).pathname.endsWith('/receipt'),true)
        await shot('payment-receipt-source',width)
      }
    }
  },{prepareHosted:async({customer,binding,method})=>{
    await page.goto(h.origin+`/app/customers/${customer}`)
    const detail=page.locator('#saved-payment-methods details');await detail.locator('summary').click()
    const form=detail.locator('form');await form.locator('[name=binding]').selectOption(binding);await form.locator('[name=method]').selectOption(method);await form.locator('[name=confirm]').check()
    for(const width of [1440,390]){await page.setViewportSize({width,height:950});await shot(`hosted-${method}-prepare`,width)}
    await Promise.all([page.waitForNavigation({waitUntil:'load'}),form.getByRole('button').first().click()])
    assert.equal(new URL(page.url()).searchParams.get('error'),null)
    return (await h.api(`customers/${customer}`,owner)).billingRecord.hostedSetups.find(row=>row.status==='prepared'&&row.method===method)
  },hostedState:async({session,customer,setup,state,method})=>{
    for(const width of [1440,390]){
      await customerPage.setViewportSize({width,height:950});assert.equal((await customerPage.goto(h.origin+`/portal/payment-methods?session=${encodeURIComponent(session.token)}`)).status(),state==='refused'?401:200)
      assert.equal(await customerPage.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
      assert.equal(await customerPage.locator('a,button').evaluateAll(nodes=>nodes.filter(node=>!node.textContent.trim()).length),0,'All controls have visible labels')
      const card=customerPage.locator('section').filter({has:customerPage.locator(`input[value="${setup}"]`)});if(['prepared','open'].includes(state))assert.equal(await card.count(),1)
      await customerPage.screenshot({path:`${directory}/${width}-hosted-${method}-${state}.png`,fullPage:true})
      console.log('BROWSER',width,'hosted',method,state)
      await page.setViewportSize({width,height:950});await page.goto(h.origin+`/app/customers/${customer}`);await shot(`hosted-${method}-${state}-operator`,width)
    }
  },startHosted:async({session,setup})=>{
    await customerPage.goto(h.origin+`/portal/payment-methods?session=${encodeURIComponent(session.token)}`)
    const form=customerPage.locator('form').filter({has:customerPage.locator(`input[value="${setup}"]`)});await form.locator('[name=confirm]').check();await form.locator('[name=make_default]').check()
    const response=customerPage.waitForResponse(r=>new URL(r.url()).pathname==='/portal/payment-methods/start');await form.getByRole('button').first().click({noWaitAfter:true});const result=await response
    assert.equal(result.status(),303);const url=result.headers().location;assert.equal(new URL(url).hostname,'checkout.stripe.com')
    const cookies=await customerContext.cookies();assert.ok(cookies.some(cookie=>cookie.name==='nectar_setup_return'&&cookie.httpOnly&&cookie.sameSite==='Lax'))
    assert.equal((await customerPage.goto(h.origin+'/portal/payment-methods')).status(),200);return {status:'open',url,cookie:cookies.filter(cookie=>cookie.name==='nectar_setup_return').map(cookie=>`${cookie.name}=${cookie.value}`).join('; ')}
  },finishHosted:async({session,setup})=>{
    assert.equal((await customerPage.goto(h.origin+'/portal/payment-methods')).status(),200)
    const form=customerPage.locator('form').filter({has:customerPage.locator(`input[value="${setup}"]`)});await form.locator('[name=confirm]').check()
    const [completed]=await Promise.all([customerPage.waitForNavigation({waitUntil:'load'}),form.getByRole('button').first().click()]);assert.equal(completed.status(),200);assert.equal(new URL(customerPage.url()).pathname,'/portal/payment-methods/finish');for(const width of [1440,390]){await customerPage.setViewportSize({width,height:950});await customerPage.screenshot({path:`${directory}/${width}-hosted-return-complete.png`,fullPage:true})};return {status:'complete'}
  },recordAch:async({customer,input})=>{
    await page.goto(h.origin+`/app/customers/${customer}`)
    for(const width of [1440,390]){await page.setViewportSize({width,height:950});await shot('ach-before-verification',width)}
    const form=page.locator('form[action="/app/do/payment.ach_evidence.record"]')
    await form.locator('[name=invoice]').selectOption(input.invoice)
    await form.locator('[name=account_ref]').selectOption(input.account_ref)
    await form.locator('[name=payment_intent_ref]').fill(input.payment_intent_ref)
    await form.locator('[name=confirm]').check()
    await Promise.all([page.waitForNavigation({waitUntil:'load'}),form.getByRole('button').first().click()])
    assert.equal(new URL(page.url()).searchParams.get('error'),null)
    return (await h.api(`customers/${customer}`,owner)).billingRecord.achPaymentEvidence.at(-1)
  },refreshMethods:async({customer})=>{
    await page.goto(h.origin+`/app/customers/${customer}`)
    for(const width of [1440,390]){await page.setViewportSize({width,height:950});await shot('saved-methods-before-refresh',width)}
    const form=page.locator('form[action="/app/do/customer.payment_methods.refresh"]')
    await Promise.all([page.waitForNavigation({waitUntil:'load'}),form.getByRole('button').first().click()])
    assert.equal(new URL(page.url()).searchParams.get('error'),null)
    return (await h.api(`customers/${customer}`,owner)).billingRecord.savedPaymentMethods
  }})
  await writeFile(`${directory}/screens.json`,JSON.stringify({journey:'CUS-001 current customer record',captures},null,2))
}finally{await browser?.close();await h.close()}

}

// customer-child-browser: retained public-door assertions with one shared entry point.
async function customerChildBrowserJourney(mode) {
// CUS-001 child ownership and write-off source end states, over public journeys.
const { default: assert } = await import('node:assert/strict')
const {mkdir} = await import('node:fs/promises')
const {chromium} = await import('@playwright/test')
const {harness} = await import('./harness.mjs')
const {applyPolicy} = await import('./policy-helper.mjs')
const directory=process.env.NECTAR_EVIDENCE_DIR??'.evidence/customer-children'
await mkdir(directory,{recursive:true})
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,headless:true,args:['--no-sandbox','--use-mock-keychain','--password-store=basic']})
async function journey(file,run){
  const module=await import(`./${file}.mjs`),h=await harness({assets:true,...(module.harnessOptions?.()??{})})
  try{
    await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})
    const owner=await h.signIn(h.vars.OWNER_EMAIL)
    await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
    await h.api('business.configure',owner,{legal_name:'Cedar Software Inc',timezone:'America/Los_Angeles',invoice_prefix:'CD',payment_terms_days:30})
    await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Reviewed customer source journey'})
    await h.api('tax.review',owner,{revision:(await h.api('business',owner)).revision})
    const context=await browser.newContext(),page=await context.newPage()
    await context.addCookies(owner.split('; ').map(value=>{const i=value.indexOf('=');return {name:value.slice(0,i),value:value.slice(i+1),url:h.origin}}))
    const both=async(label,customer)=>{
      for(const width of [1440,390]){
        await page.setViewportSize({width,height:950})
        assert.equal((await page.goto(h.origin+`/app/customers/${customer}`)).status(),200)
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${label} fits ${width}`)
        const iconOnly=await page.locator('a,button,[role=button]').evaluateAll(nodes=>nodes.filter(n=>!n.textContent.trim()&&n.querySelector('svg,img')).map(n=>n.outerHTML));assert.deepEqual(iconOnly,[])
        await page.screenshot({path:`${directory}/${width}-${label}.png`,fullPage:true});console.log('BROWSER',width,label)
        const focus=label.startsWith('child-')?page.locator('main article > dl.figures'):page.getByRole('heading',{name:label==='customer-writeoff-recovery'?'Write-offs and recoveries':'Subscription history',exact:true}).locator('..')
        for(let index=0;index<await focus.count();index++)await focus.nth(index).screenshot({path:`${directory}/${width}-${label}-focus-${index}.png`})
      }
    }
    await run(module,h,owner,both)
    await context.close()
  }finally{await h.close()}
}
try{
 await journey('hierarchies',async(m,h,owner,both)=>{
   const result=await m.hierarchiesFlow(h,owner,{onState:async state=>{if(state.label==='parent-card-collected')await both('child-ledgers-parent-card',state.parent)}})
   await both('child-erasure-retained-ledgers',result.parent)
 })
 await journey('lifecycle',async(m,h,owner,both)=>{const result=await m.lifecycleFlow(h,owner);await both('customer-subscription-history',result.customer)})
 await journey('write-offs',async(m,h,owner,both)=>m.writeOffFlow(h,owner,{onRecord:async({customer})=>both('customer-writeoff-recovery',customer)}))
}finally{await browser.close()}

}

// prepaid-topup-browser: retained public-door assertions with one shared entry point.
async function prepaidTopupBrowserJourney(mode) {
// Real portal consent and independent native approval over prepaidTopupFlow.
// The application is the built Worker/D1; only Stripe's network edge is fake.
const { default: assert } = await import('node:assert/strict')
const { mkdir, writeFile } = await import('node:fs/promises')
const { chromium } = await import('@playwright/test')
const { harness } = await import('./harness.mjs')
const { prepaidTopupFlow, harnessOptions } = await import('./prepaid-topup.mjs')

const directory=process.env.NECTAR_EVIDENCE_DIR??'.evidence/prepaid-topup'
await mkdir(directory,{recursive:true})
const h=await harness({assets:true,...harnessOptions()}),captures=[]
let browser
const safePath=value=>{
  const url=new URL(value)
  for(const name of [...url.searchParams.keys()])if(/session|token|secret|code|key/i.test(name))url.searchParams.set(name,'[redacted]')
  return url.pathname+url.search
}
try {
  assert.equal((await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})).status,303)
  const owner=await h.signIn(h.vars.OWNER_EMAIL)
  await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
  await h.api('business.configure',owner,{legal_name:'Alder Research Software',timezone:'UTC',invoice_prefix:'ALDER',payment_terms_days:30})
  browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,headless:true,args:['--no-sandbox','--use-mock-keychain','--password-store=basic']})
  const operatorContext=await browser.newContext(),customerContext=await browser.newContext()
  const operator=await operatorContext.newPage(),customer=await customerContext.newPage()
  const asActor=async cookie=>{
    await operatorContext.clearCookies()
    await operatorContext.addCookies(cookie.split('; ').map(value=>{const i=value.indexOf('=');return {name:value.slice(0,i),value:value.slice(i+1),url:h.origin}}))
  }
  await asActor(owner)
  const visit=async(page,path)=>{
    const response=await page.goto(h.origin+path)
    assert.equal(response.status(),200,'The native public page is available')
    assert.match(response.headers()['content-type'],/text\/html/,'The customer opens the HTML quote, not its JSON representation')
  }
  const both=async(page,label,path,prepare)=>{
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:950})
      if(path)await visit(page,path)
      if(prepare)await prepare()
      assert.ok(await page.locator('main h1').count(),`${label} has its public heading`)
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${label} fits ${width}`)
      const file=`${width}-${label}.png`
      await page.screenshot({path:`${directory}/${file}`,fullPage:true})
      captures.push({label,width,path:safePath(page.url()),file})
      console.log(`BROWSER ${width} ${label}`)
    }
  }
  const submit=async(page,form)=>{
    await Promise.all([page.waitForNavigation({waitUntil:'load'}),form.getByRole('button').click()])
    assert.equal(new URL(page.url()).searchParams.get('error'),null,'The exact native decision succeeds')
    assert.equal(await page.locator('main h1').count(),1)
  }
  const portalPath=(row,session)=>`/portal/prepaid-topups/${row.authorization.id}?session=${encodeURIComponent(session.token)}`
  const portalQuote=async(row,session)=>{
    const response=await h.raw(portalPath(row,session))
    assert.equal(response.status,200)
    return response.json()
  }
  const representative=row=>[1,3].includes(row.n)
  await prepaidTopupFlow(h,owner,{
    acceptAuthorization:async({row,session})=>{
      await visit(customer,portalPath(row,session))
      const accept=customer.locator('form').filter({has:customer.locator('input[name="accept"]')})
      assert.equal(await accept.count(),1)
      assert.equal(await accept.locator('input[name="basis_hash"]').inputValue(),row.authorization.basis)
      assert.equal(await accept.locator('input[name="authorization"]').inputValue(),row.authorization.id)
      assert.equal(await accept.locator('input[name="accept"]').isChecked(),false,'Consent starts unchecked')
      if(representative(row))await both(customer,`customer-${row.n}-quote-awaiting`)
      await accept.locator('input[name="accept"]').check()
      if(representative(row))await both(customer,`customer-${row.n}-explicit-consent`)
      await submit(customer,accept)
      const accepted=await portalQuote(row,session)
      assert.equal(accepted.status,'pending')
      assert.equal(accepted.basis,row.authorization.basis)
      assert.equal(await customer.locator('input[name="accept"]').count(),0,'An accepted quote cannot be accepted again')
      if(representative(row))await both(customer,`customer-${row.n}-accepted`)
    },
    approveAuthorization:async({row,finance})=>{
      await asActor(finance)
      try {
        await visit(operator,`/app/prepaid/${row.subscription}`)
        const card=operator.locator(`article[id="topup-${row.authorization.id}"]`)
        const approve=card.locator('form[action="/app/do/prepaid.topup.decide"]').filter({has:operator.locator('input[name="decision"][value="approved"]')})
        assert.equal(await approve.locator('input[name="basis_hash"]').inputValue(),row.authorization.basis)
        assert.equal(await approve.locator('input[name="confirm_single"]').count(),0,'Finance approves independently of the owner who prepared the quote')
        if(representative(row))await both(operator,`finance-${row.n}-exact-approval`,null,async()=>{
          const details=card.locator('details')
          if(await details.getAttribute('open')===null)await details.locator('summary').click()
        })
        await submit(operator,approve)
        const approved=(await h.api(`prepaid/topup-authorizations?subscription=${row.subscription}`,finance)).find(value=>value.id===row.authorization.id)
        assert.equal(approved.status,'active')
        assert.equal(approved.acceptance.basis,row.authorization.basis)
        if(representative(row))await both(operator,`finance-${row.n}-active-policy`)
      } finally {await asActor(owner)}
    },
    revokeAuthorization:async({row,session})=>{
      await visit(customer,portalPath(row,session))
      assert.equal((await portalQuote(row,session)).status,'active')
      await both(customer,'customer-active-before-revocation')
      const revoke=customer.locator('form[action^="/portal/prepaid-topup.revoke?"]')
      assert.equal(await revoke.locator('input[name="authorization"]').inputValue(),row.authorization.id)
      await submit(customer,revoke)
      assert.equal((await portalQuote(row,session)).status,'revoked')
      assert.equal(await customer.locator('form').count(),0,'Revoked authorization offers neither accept nor revoke again')
      await both(customer,'customer-revoked-quote')
    },
    onState:async state=>{
      await asActor(owner)
      if(state.label==='active'){
        if(representative(state.row)){
          await both(customer,`customer-${state.row.n}-active-quote`,portalPath(state.row,state.session))
          await both(operator,`owner-${state.row.n}-authorization-source`,`/app/prepaid/topup-authorizations/${state.row.authorization.id}`)
        }
        return
      }
      if(state.row){
        await both(operator,`owner-${state.label}-ledger`,`/app/prepaid/${state.row.subscription}`)
        await both(operator,`owner-${state.label}-source`,`/app/prepaid/topup-authorizations/${state.row.authorization.id}`)
      }
      if(state.claim?.invoice_id){
        await both(operator,`owner-${state.label}-purchase-invoice`,`/app/invoices/${state.claim.invoice_id}`)
        const sourceRow=state.row??state.rows.find(row=>row.subscription===state.claim.subscription_id)
        assert.ok(sourceRow,'The purchase belongs to its exact subscription')
        const ledger=await h.api(`prepaid/${sourceRow.subscription}`,owner)
        const lot=ledger.grants.find(grant=>grant.purchaseInvoice===state.claim.invoice_id)
        const entry=ledger.entries.find(entry=>entry.kind==='grant'&&entry.grantId===lot?.id)
        if(entry)await both(operator,`owner-${state.label}-grant-source`,`/app/prepaid/${sourceRow.subscription}/entries/${encodeURIComponent(entry.id)}`)
      }
      if(state.label==='uncertain'){
        const form=operator.locator('form[action="/app/do/prepaid.topup.reconcile"]').filter({has:operator.locator(`input[name="claim"][value="${state.claim.id}"]`)})
        await visit(operator,`/app/prepaid/${state.row.subscription}`)
        await both(operator,'owner-uncertain-reconciliation')
        await submit(operator,form)
        assert.equal((await h.api(`prepaid/topup-claims?subscription=${state.row.subscription}`,owner)).find(claim=>claim.id===state.claim.id).status,'uncertain')
        await both(operator,'owner-reconciled-still-uncertain')
      }
      if(state.label==='refusals'){
        for(const row of state.rows.slice(1,4))await both(operator,`owner-${row.n}-refused-policy`,`/app/prepaid/${row.subscription}`)
      }
    },
  })
  await writeFile(`${directory}/screens.json`,JSON.stringify({journey:'customer-authorized-prepaid-topup',captures},null,2))
} catch(error) {
  console.error(String(error?.stack??error).replace(/([?&]session=)[^&\s"'<>]+/g,'$1[redacted]'))
  process.exitCode=1
} finally {await browser?.close();await h.close()}

}

// prepaid-refund-browser: retained public-door assertions with one shared entry point.
async function prepaidRefundBrowserJourney(mode) {
// Native finance approval and read-only recovery over the real Worker/D1 flow.
// Only the original Stripe capture/refund network edge is synthetic.
const { default: assert } = await import('node:assert/strict')
const { mkdir, writeFile } = await import('node:fs/promises')
const { chromium } = await import('@playwright/test')
const { harness } = await import('./harness.mjs')
const { prepaidRefundFlow, harnessOptions } = await import('./prepaid-refunds.mjs')

const directory=process.env.NECTAR_EVIDENCE_DIR??'.evidence/prepaid-refunds'
await mkdir(directory,{recursive:true})
const h=await harness({assets:true,...harnessOptions()}),captures=[]
let browser
try {
  assert.equal((await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})).status,303)
  const owner=await h.signIn(h.vars.OWNER_EMAIL)
  await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
  await h.api('business.configure',owner,{legal_name:'Alder Research Software',timezone:'UTC',invoice_prefix:'ALDER',payment_terms_days:30})
  browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,headless:true,args:['--no-sandbox','--use-mock-keychain','--password-store=basic']})
  // The independent finance navigation may wait at Stripe while the owner
  // inspects the reserved ledger in a separate ordinary signed-in context.
  const ownerContext=await browser.newContext(),financeContext=await browser.newContext()
  const customerContext=await browser.newContext()
  const operator=await ownerContext.newPage(),financePage=await financeContext.newPage(),customerPage=await customerContext.newPage()
  const asActor=async(context,cookie)=>{
    await context.clearCookies()
    await context.addCookies(cookie.split('; ').map(value=>{const i=value.indexOf('=');return {name:value.slice(0,i),value:value.slice(i+1),url:h.origin}}))
  }
  await asActor(ownerContext,owner)
  const visit=async(page,path)=>{
    const response=await page.goto(h.origin+path)
    assert.equal(response.status(),200,'The native public page is available')
    assert.match(response.headers()['content-type'],/text\/html/)
  }
  const both=async(page,label,path,prepare)=>{
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:950})
      if(path)await visit(page,path)
      if(prepare)await prepare()
      assert.equal(await page.locator('main h1').count(),1)
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${label} fits ${width}`)
      const file=`${width}-${label}.png`
      await page.screenshot({path:`${directory}/${file}`,fullPage:true})
      const url=new URL(page.url());if(url.searchParams.has('session'))url.searchParams.set('session','[redacted]')
      captures.push({label,width,path:url.pathname+url.search,file})
      console.log(`BROWSER ${width} ${label}`)
    }
  }
  const submit=async(page,form)=>{
    await Promise.all([page.waitForNavigation({waitUntil:'load'}),form.getByRole('button').click()])
    assert.equal(new URL(page.url()).searchParams.get('error'),null,'The native decision succeeds')
    assert.equal(await page.locator('main h1').count(),1)
  }
  const card=(page,refund)=>page.locator(`article[id="refund-${refund.id}"]`)
  const readRefund=async(row,refund,actor=owner)=>{
    const saved=(await h.api(`prepaid/refunds?subscription=${row.subscription}`,actor)).find(value=>value.id===refund.id)
    assert.ok(saved,'The action refers to the same durable refund')
    return saved
  }
  const openEvidence=async(page,refund)=>{
    const disclosure=card(page,refund).locator('details').filter({has:page.locator('summary').filter({hasText:'Frozen approval quote and reason'})})
    if(await disclosure.getAttribute('open')===null)await disclosure.locator('summary').click()
    const quote=JSON.parse(await disclosure.locator('dd code').first().textContent())
    assert.deepEqual(quote,refund.quote,'The rendered review preserves the exact original capture and unused value')
  }
  const readerContext=await browser.newContext(),readerPage=await readerContext.newPage()
  await prepaidRefundFlow(h,owner,{
    onSharedState:async({row,refund,readers,sales})=>{
      for(const {role,who} of [...readers,{role:'sales',who:sales}]){
        await asActor(readerContext,who)
        await both(readerPage,`${role}-shared-refund-customer`,`/app/customers/${row.customer}`)
        if(role!=='sales')await both(readerPage,`${role}-shared-refund-invoice`,`/app/invoices/${row.invoice}`)
        assert.ok(!(await readerPage.locator('main').textContent()).includes(refund.reason))
      }
    },
    onTypedState:async({label,row,refund,readers,finance})=>{
      for(const {role,who} of readers){
        await asActor(readerContext,who)
        await both(readerPage,`${role}-${row.n}-${label}`,refund.source)
        assert.equal(await card(readerPage,refund).locator('form').count(),0)
        assert.equal(await readerPage.locator('a[download]').count(),0)
        assert.ok(!(await readerPage.locator('main').textContent()).includes('Synthetic unused paid service returned to its original card'))
      }
      if(label==='typed-pending'){
        await both(readerPage,'collections-refund-list',`/app/prepaid/refunds?customer=${row.customer}`)
        await both(readerPage,'collections-customer-refund-entry',`/app/customers/${row.customer}`)
        assert.ok(await readerPage.locator(`a[href="/app/prepaid/refunds?customer=${row.customer}"]`).count())
        await asActor(readerContext,readers.find(reader=>reader.role==='accountant').who)
        await both(readerPage,'accountant-refund-list-export',`/app/prepaid/refunds?subscription=${row.subscription}`)
        const [download]=await Promise.all([readerPage.waitForEvent('download'),readerPage.getByRole('link',{name:'Export refund lifecycle CSV'}).click()])
        assert.equal(await download.failure(),null)
      }
      if(label==='typed-refunded'&&row.n===1){
        await asActor(financeContext,finance);await visit(financePage,refund.source)
        const [download]=await Promise.all([financePage.waitForEvent('download'),financePage.getByRole('link',{name:/Download processor proof/}).click()])
        assert.equal(await download.failure(),null)
        const stream=await download.createReadStream(),chunks=[]
        for await(const chunk of stream)chunks.push(chunk)
        assert.equal(JSON.parse(Buffer.concat(chunks)).proof,'succeeded-refund-and-balance-debit')
      }
    },
    approveRefund:async({row,refund,finance})=>{
      await asActor(financeContext,finance)
      await visit(financePage,refund.source)
      const approve=card(financePage,refund).locator('form[action="/app/do/prepaid.refund.decide"]').filter({has:financePage.locator('input[name="decision"][value="approved"]')})
      assert.equal(await approve.locator('input[name="refund"]').inputValue(),refund.id)
      assert.equal(await approve.locator('input[name="basis_hash"]').inputValue(),refund.basis)
      assert.equal(await approve.locator('input[name="confirm_single"]').count(),0)
      await both(financePage,`finance-${row.n}-exact-refund-approval`,null,()=>openEvidence(financePage,refund))
      await submit(financePage,approve)
      const saved=await readRefund(row,refund,finance)
      assert.ok(['refunded','uncertain'].includes(saved.status))
      await both(financePage,`finance-${row.n}-${saved.status}`)
      return saved
    },
    reconcileRefund:async({row,refund,expectedStatus})=>{
      await visit(operator,refund.source)
      const reconcile=card(operator,refund).locator('form[action="/app/do/prepaid.refund.reconcile"]')
      assert.equal(await reconcile.locator('input[name="refund"]').inputValue(),refund.id)
      await both(operator,`owner-${row.n}-check-existing-${expectedStatus}`)
      await submit(operator,reconcile)
      const saved=await readRefund(row,refund)
      assert.equal(saved.status,expectedStatus)
      if(expectedStatus==='refunded')assert.equal(await card(operator,refund).locator('form').count(),0,'Recovered refunds offer no second refund attempt')
      await both(operator,`owner-${row.n}-checked-${expectedStatus}`)
      return saved
    },
    onState:async({label,rows,refund,portalSession,portalSource,language})=>{
      if(label==='customer-refund'){await both(customerPage,`customer-${language}-shared-refund-invoice`,`/portal/invoices/${rows[0].invoice}?session=${encodeURIComponent(portalSession.token)}`);await both(customerPage,`customer-${language}-refunded-ledger`,`/portal/prepaid?session=${encodeURIComponent(portalSession.token)}`);await both(customerPage,`customer-${language}-refunded-source`,`${portalSource}?session=${encodeURIComponent(portalSession.token)}`);return}
      const row=rows.find(row=>row.subscription===refund.quote.subscription)
      assert.ok(row)
      await both(operator,`owner-${row.n}-${label}-ledger`,`/app/prepaid/${row.subscription}`)
      await both(operator,`owner-${row.n}-${label}-refund-source`,refund.source,()=>openEvidence(operator,refund))
      if(label==='prepared'){
        await both(operator,'owner-original-paid-purchase',`/app/invoices/${row.invoice}`)
        const grant=row.before.entries.find(entry=>entry.kind==='grant')
        assert.ok(grant?.href)
        await both(operator,'owner-original-paid-grant',grant.href)
      }
      if(['refunded','reconciled'].includes(label)){
        const state=await h.api(`prepaid/${row.subscription}`,owner),entry=state.entries.find(entry=>entry.kind==='refund')
        assert.ok(entry?.href)
        await both(operator,`owner-${row.n}-liability-reversal-source`,entry.href)
        await both(operator,`owner-${row.n}-unchanged-original-purchase`,`/app/invoices/${row.invoice}`)
        const query=`?period=2026-11&customer=${row.customer}`
        const report=await h.api(`reports/refunds${query}`,owner),contribution=report.entries.find(entry=>entry.sourceReference===refund.id)
        assert.ok(contribution?.href)
        await both(operator,`owner-${row.n}-cash-refund-report`,`/app/reports/refunds${query}`)
        assert.ok(await operator.locator(`a[href="${contribution.href}"]`).count(),'Cash totals link to their refund source')
        await both(operator,`owner-${row.n}-cash-refund-report-source`,contribution.href)
        assert.equal(await operator.locator('#refund-evidence').count(),1)
        await both(operator,`owner-${row.n}-remaining-credit-report`,`/app/reports/credit-balances?customer=${row.customer}`)
        await both(operator,`owner-${row.n}-unchanged-revenue`,`/app/revenue?period=2026-11&customer=${row.customer}`)
        await both(operator,`owner-${row.n}-purchase-revenue-source`,`/app/revenue/${row.invoice}?period=2026-11`)
      }
    },
  })
  await writeFile(`${directory}/screens.json`,JSON.stringify({journey:'unused-paid-prepaid-refund',captures},null,2))
} catch(error) {
  console.error(String(error?.stack??error))
  process.exitCode=1
} finally {await browser?.close();await h.close()}

}

// portal-prepaid-browser: retained public-door assertions with one shared entry point.
async function portalPrepaidBrowserJourney(mode) {
// Real customer-session pages over the prepaid public-door business journey.
const { default: assert } = await import('node:assert/strict')
const { chromium } = await import('@playwright/test')
const { mkdir, writeFile } = await import('node:fs/promises')
const { harness } = await import('./harness.mjs')
const { applyPolicy } = await import('./policy-helper.mjs')
const { portalPrepaidFlow } = await import('./portal-prepaid.mjs')

const directory=process.env.NECTAR_EVIDENCE_DIR??'.evidence/portal-prepaid'
await mkdir(directory,{recursive:true})
const captures=[],tokens=new Set()
const h=await harness({assets:true})
let browser,failure,complete=false
const safe=text=>{
  for(const token of tokens)text=text.replaceAll(token,'[redacted]').replaceAll(encodeURIComponent(token),'[redacted]')
  return text.replace(/session=[^&\s"'<>]+/g,'session=[redacted]')
}
try {
  await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})
  const owner=await h.signIn(h.vars.OWNER_EMAIL)
  await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
  await h.api('business.configure',owner,{legal_name:'Alder Research Software',timezone:'UTC',invoice_prefix:'ALDER',payment_terms_days:30})
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Reviewed focused customer portal browser journey'})
  await h.api('tax.review',owner,{revision:(await h.api('business',owner)).revision})
  browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,headless:true,args:['--no-sandbox','--use-mock-keychain','--password-store=basic']})
  // No operator cookies: all browser reads use only the issued customer capability.
  const context=await browser.newContext(),page=await context.newPage()
  page.setDefaultTimeout(15000)
  const navigate=async(path,session)=>{
    const url=new URL(path,h.origin)
    url.searchParams.set('session',session.token)
    const response=await page.goto(url.href)
    assert.equal(response?.status(),200,`Customer page ${path}`)
    assert.equal(new URL(page.url()).pathname,path)
  }
  const click=async(locator,path)=>{
    const [response]=await Promise.all([page.waitForNavigation({waitUntil:'load'}),locator.click()])
    assert.equal(response?.status(),200,`Native customer navigation to ${path}`)
    assert.equal(new URL(page.url()).pathname,path)
  }
  const shot=async(label,language,denomination)=>{
    assert.equal(await page.locator('html').getAttribute('lang'),language)
    assert.ok(await page.locator('main h1').isVisible(),label)
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${label} fits at ${page.viewportSize().width}`)
    assert.equal(await page.locator('a[href^="/app/"]').count(),0,'Customer pages expose no operator navigation')
    assert.doesNotMatch(await page.locator('main').innerText(),/portal\.prepaid\.|untranslated_key|provider_ref|synthetic-nectar-payment-|PRIVATE-|INTERNAL-/)
    const width=page.viewportSize().width,file=`${width}-${language}-${denomination}-${label}.png`
    await page.screenshot({path:`${directory}/${file}`,fullPage:true})
    const url=new URL(page.url())
    url.searchParams.set('session','[redacted]')
    captures.push({label,width,language,denomination,path:safe(url.pathname+url.search),file})
    console.log(`BROWSER ${width} ${language} ${denomination} ${label}`)
  }
  // Assert the visible financial values against the exact public projection,
  // including typed quantities; an amount of units is never formatted as USD.
  const lotCard=async(lot,language)=>{
    const card=page.locator('section.card').filter({has:page.locator(`a[href^="${lot.href}?"]`)})
    assert.equal(await card.count(),1)
    const locale=language==='en'?'en-US':language,plain=text=>text.replace(/[\u00a0\u202f]/g,' ')
    const money=cents=>plain(new Intl.NumberFormat(locale,{style:'currency',currency:'USD',currencyDisplay:'code'}).format(cents/100))
    const quantity=(n,text)=>lot.kind==='money'?money(n):`${plain(new Intl.NumberFormat(locale,{maximumFractionDigits:6}).format(Number(text)))} ${lot.unitLabel}`
    const values=await card.locator('dd').allTextContents()
    assert.equal(values[0],quantity(lot.remainingN,lot.remainingQuantity))
    assert.equal(values[1],quantity(lot.availableN,lot.availableQuantity))
    assert.equal(values[2],money(lot.liabilityCents))
    if(lot.meterCode)assert.ok((await card.innerText()).includes(lot.meterCode))
    if(lot.purchaseInvoice)assert.ok((await card.innerText()).includes(lot.purchaseInvoice.number))
  }
  await portalPrepaidFlow(h,owner,{onState:async({row,units,moneySession,unitSession,money,unitData})=>{
    tokens.add(moneySession.token);tokens.add(unitSession.token)
    for(const scenario of [
      {denomination:'money',customer:row.customer,session:moneySession,data:money},
      {denomination:'units',customer:units.customer,session:unitSession,data:unitData},
    ]) {
      const original=await h.api(`customers/${scenario.customer}`,owner)
      const language=async value=>{
        const customer=await h.api(`customers/${scenario.customer}`,owner)
        if(customer.language===value)return
        await h.api('customer.update',owner,{customer:customer.id,revision:customer.revision,name:customer.name,billing_email:customer.billing_email,address:customer.address,language:value})
      }
      assert.ok(scenario.data.lots.length,'The customer has actual retained prepaid sources')
      try {
        for(const locale of ['en','es-US']) {
          await language(locale)
          for(const width of [1440,390]) {
            await page.setViewportSize({width,height:950})
            await navigate('/portal',scenario.session)
            await shot('portal-home',locale,scenario.denomination)
            await click(page.locator('a[href^="/portal/prepaid?"]').first(),'/portal/prepaid')
            for(const lot of scenario.data.lots)await lotCard(lot,locale)
            await shot('prepaid-home',locale,scenario.denomination)
            for(const [index,lot]of scenario.data.lots.entries()) {
              if(index)await navigate('/portal/prepaid',scenario.session)
              await click(page.locator(`a[href^="${lot.href}?"]`),lot.href)
              await lotCard(lot,locale)
              assert.equal(await page.locator('section.card').count(),1+lot.entries.length,'Every retained ledger event is visible')
              await shot(`source-${index+1}`,locale,scenario.denomination)
            }
          }
        }
      } finally {await language(original.language)}
    }
  }})
  complete=true
} catch(error) {
  failure=new Error(safe(error instanceof Error?error.stack??error.message:String(error)))
} finally {
  await writeFile(`${directory}/screens.json`,JSON.stringify({kind:'portal-prepaid',complete,captures},null,2)+'\n')
  await browser?.close()
  await h.close()
}
if(failure)throw failure

}

// payment-links-browser: retained public-door assertions with one shared entry point.
async function paymentLinksBrowserJourney(mode) {
// Native owner and signed-out customer forms over the same public journey.
const { default: assert } = await import('node:assert/strict')
const { mkdir } = await import('node:fs/promises')
const { chromium } = await import('@playwright/test')
const { harness } = await import('./harness.mjs')
const { applyPolicy } = await import('./policy-helper.mjs')
const { harnessOptions, paymentLinksFlow } = await import('./payment-links.mjs')

const directory=process.env.NECTAR_EVIDENCE_DIR??'.evidence/payment-links'
await mkdir(directory,{recursive:true})
const h=await harness({...harnessOptions(),assets:true})
let browser
const captures=[]
try {
  await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})
  const owner=await h.signIn(h.vars.OWNER_EMAIL)
  await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
  await h.api('business.configure',owner,{legal_name:'Cedar Software Inc',timezone:'America/Los_Angeles',invoice_prefix:'CD',payment_terms_days:30})
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Synthetic browser journey'})
  await h.api('tax.review',owner,{revision:(await h.api('business',owner)).revision})
  browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,headless:true,args:['--no-sandbox','--use-mock-keychain','--password-store=basic']})
  const operatorContext=await browser.newContext(),customerContext=await browser.newContext()
  await operatorContext.addCookies(owner.split(';').map(value=>{const [name,...rest]=value.trim().split('=');return {name,value:rest.join('='),url:h.origin}}))
  const operator=await operatorContext.newPage(),customer=await customerContext.newPage()
  await customer.route('https://checkout.stripe.com/**',route=>route.abort())
  const capture=async(page,name)=>{
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:844})
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Customer and management page fits the viewport')
      const file=`${width}-${name}.png`;await page.screenshot({path:`${directory}/${file}`,fullPage:true});captures.push(file)
      const attribution=page.getByRole('heading',{name:'Signup attribution',exact:true});if(await attribution.count())await attribution.first().locator('..').screenshot({path:`${directory}/${width}-${name}-attribution.png`})
      for(const [action,label] of [['payment_link.create','create-policy'],['payment_link.approve','approve-policy'],['payment_link.activate','activate-policy']]){
        const forms=page.locator(`form[action="/app/do/${action}"]`)
        for(let index=0;index<await forms.count();index++)await forms.nth(index).locator('..').screenshot({path:`${directory}/${width}-${name}-${label}-${index}.png`})
      }
      const iconOnly=await page.locator('a,button,[role=button]').evaluateAll(nodes=>nodes.filter(n=>!n.textContent.trim()&&n.querySelector('svg,img')&&!n.getAttribute('aria-describedby')).length);assert.equal(iconOnly,0)
    }
  }
  let created=0,started=0
  await paymentLinksFlow(h,owner,{interaction:{
    cancelRenewal:async({cancelPath})=>{
      await customer.goto(h.origin+cancelPath);await capture(customer,'cancellation-confirmation')
      const response=customer.waitForResponse(value=>new URL(value.url()).pathname===cancelPath&&value.request().method()==='POST')
      await customer.locator('button[name=confirm][value=cancel]').click();assert.equal((await response).status(),200)
      await capture(customer,'cancellation-complete')
    },
    approvePolicy:async({finance,pending})=>{
      const financeContext=await browser.newContext();await financeContext.addCookies(finance.split(';').map(value=>{const [name,...rest]=value.trim().split('=');return {name,value:rest.join('='),url:h.origin}}))
      const financePage=await financeContext.newPage();await financePage.goto(h.origin+'/app/payment-links');await capture(financePage,'independent-policy-approval')
      const form=financePage.locator('form[action="/app/do/payment_link.approve"]').filter({has:financePage.locator(`input[name=link][value="${pending.id}"]`)})
      await form.locator('[name=confirm]').check();await Promise.all([financePage.waitForNavigation(),form.getByRole('button').click()]);assert.equal(new URL(financePage.url()).searchParams.has('error'),false)
      await capture(financePage,'independent-policy-approved');await financeContext.close()
    },
    activatePolicy:async({pending})=>{
      await operator.goto(h.origin+'/app/payment-links')
      const form=operator.locator('form[action="/app/do/payment_link.activate"]').filter({has:operator.locator(`input[name=link][value="${pending.id}"]`)})
      await form.locator('[name=confirm]').check();await capture(operator,'approved-policy-activation')
      await Promise.all([operator.waitForNavigation(),form.getByRole('button').click()]);assert.equal(new URL(operator.url()).searchParams.has('error'),false)
      await capture(operator,'approved-policy-active')
    },
    action:async({action,payload})=>{
      const before=await h.api('payment-links',owner)
      await operator.goto(`${h.origin}/app/payment-links`)
      if(action==='payment_link.deactivate') {
        const form=operator.locator('form').filter({has:operator.locator(`input[name=link][value="${payload.link}"]`)})
        const response=operator.waitForResponse(value=>value.url().endsWith('/app/do/payment_link.deactivate')&&value.request().method()==='POST')
        await form.getByRole('button').click();assert.equal((await response).status(),303)
        await operator.waitForURL('**/app/payment-links**');return {id:payload.link}
      }
      const forms=operator.locator('form[action="/app/do/payment_link.create"]'),form=payload.kind==='one_time'?forms.nth(1):forms.nth(0)
      await form.locator('[name=name]').fill(payload.name)
      if(payload.kind==='one_time') {
        await form.locator('[name=amount]').fill(payload.amount);await form.locator('[name=description]').fill(payload.description)
        if(payload.taxable)await form.locator('[name=taxable]').check()
      } else {
        for(let index=0;index<payload.price.length;index++){await form.locator('[name=price]').nth(index).selectOption(payload.price[index]);await form.locator('[name=quantity]').nth(index).fill(payload.quantity[index]??'1')}
        await form.locator('[name=trial_days]').fill(String(payload.trial_days??0));await form.locator('[name=months]').fill(String(payload.months));await form.locator('[name=auto_renew]').selectOption(String(payload.auto_renew));await form.locator('[name=notice_days]').fill(String(payload.notice_days));await form.locator('[name=uplift_percent]').fill(payload.uplift_percent);if(payload.confirm_single)await form.locator('[name=confirm_single]').check()
        if(payload.promotion_code)await form.locator('[name=promotion_code]').fill(payload.promotion_code)
      }
      if(payload.max_uses)await form.locator('[name=max_uses]').fill(String(payload.max_uses))
      await form.locator('[name=confirm]').check()
      if(created++===0)await capture(operator,'owner-create')
      if(payload.kind==='one_time')await capture(operator,'owner-create-one-time')
      const response=operator.waitForResponse(value=>value.url().endsWith('/app/do/payment_link.create')&&value.request().method()==='POST')
      await form.getByRole('button').click();assert.equal((await response).status(),303)
      await operator.waitForURL('**/app/payment-links**')
      const link=(await h.api('payment-links',owner)).find(row=>!before.some(old=>old.id===row.id));assert.ok(link)
      return {id:link.id,path:link.path,revision:link.revision}
    },
    start:async({id,language,payload})=>{
      await customer.goto(`${h.origin}/pay-links/${id}?language=${language}`)
      const form=customer.locator('form[action$="/start"]')
      await form.locator('[name=name]').fill(payload.name);await form.locator('[name=billing_email]').fill(payload.billing_email);await form.locator('[name=address]').fill(payload.address)
      await form.locator('[name=confirm]').check();if(payload.make_default)await form.locator('[name=make_default]').check()
      const accepted=await form.evaluate(element=>Object.fromEntries(new FormData(element)))
      started++;await capture(customer,`${language}-consent-${started}`)
      const response=customer.waitForResponse(value=>value.url().endsWith(`/pay-links/${id}/start`)&&value.request().method()==='POST')
      await form.getByRole('button').click();const posted=await response;assert.equal(posted.status(),303)
      const cookies=await customerContext.cookies(),headers=await posted.allHeaders()
      const idMatch=headers['set-cookie']?.match(/Path=\/pay-links\/attempts\/([\w-]+)/)
      const attempt=idMatch?.[1];assert.ok(attempt,'The new signup returns its scoped cookie path')
      const saved=cookies.find(value=>value.name==='nectar_payment_link'&&value.path===`/pay-links/attempts/${attempt}`);assert.ok(saved)
      const cookieHeader=`${saved.name}=${saved.value}`
      const state=await (await h.raw(`/pay-links/attempts/${attempt}`,{cookie:cookieHeader,headers:{accept:'application/json'}})).json()
      await customer.goto(`${h.origin}/pay-links/attempts/${attempt}`);await capture(customer,`return-${state.status}-${started}`)
      return {body:{...state,url:headers.location,returnPath:`/pay-links/attempts/${attempt}`},cookie:cookieHeader,payload:accepted}
    },
    post:async({attempt,operation})=>{
      const path=`/pay-links/attempts/${attempt.body.id}`
      await customer.goto(h.origin+path)
      let form=customer.locator(`form[action="${path}/${operation}"]`)
      if(operation==='reconcile'&&!await form.count())form=customer.locator(`form[action="${path}/finish"]`)
      if(operation==='cancellation'){
        const response=customer.waitForResponse(value=>new URL(value.url()).pathname===`${path}/cancellation`&&value.request().method()==='POST')
        await form.getByRole('button').click();const posted=await response;assert.equal(posted.status(),303)
        return {cancelUrl:new URL((await posted.allHeaders()).location,h.origin).href}
      }
      if(await form.count()) {
        const formAction=await form.getAttribute('action')
        const response=customer.waitForResponse(value=>new URL(value.url()).pathname===formAction&&value.request().method()==='POST')
        await form.getByRole('button').click();assert.equal((await response).status(),303)
      }else{const replay=await h.raw(`${path}/${operation}`,{cookie:attempt.cookie,body:{confirm:true}});assert.equal(replay.status,200)}
      const response=await h.raw(path,{cookie:attempt.cookie,headers:{accept:'application/json'}});assert.equal(response.status,200);return response.json()
    },
  },onState:async({completed,state,cancelPath})=>{
    if(cancelPath){await customer.goto(h.origin+cancelPath);await capture(customer,'cancelled-scope');return}
    await customer.goto(`${h.origin}/pay-links/attempts/${completed.id}`);await capture(customer,state)
    await operator.goto(`${h.origin}/app/customers/${completed.customer}`);await capture(operator,`${state}-customer`)
    if(completed.payment){await operator.goto(`${h.origin}/app/payments/${completed.payment}/receipt`);await capture(operator,`${state}-receipt`)}
  }})
  await customer.goto(`${h.origin}/pay-links/unknown`);await capture(customer,'refused')
  console.log('payment-links browser screens:',captures.length)
} finally {await browser?.close();await h.close()}

}

// payment-retries-browser: retained public-door assertions with one shared entry point.
async function paymentRetriesBrowserJourney(mode) {
const { default: assert } = await import('node:assert/strict')
const { execFileSync } = await import('node:child_process')
const { mkdir } = await import('node:fs/promises')
const { chromium } = await import('@playwright/test')
const { harness } = await import('./harness.mjs')
const { applyPolicy } = await import('./policy-helper.mjs')
const { paymentRetriesFlow,retryPlanChurnFlow,harnessOptions } = await import('./payment-retries.mjs')
if(process.env.NECTAR_JOURNEY_RUN)console.log(`JOURNEY RUN ${process.env.NECTAR_JOURNEY_RUN} HEAD ${execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()}`)
const directory=process.env.NECTAR_EVIDENCE_DIR??'.evidence/payment-retries'
await mkdir(directory,{recursive:true})
const h=await harness(harnessOptions());let browser
try{
 await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})
 const owner=await h.signIn(h.vars.OWNER_EMAIL)
 await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
 await h.api('business.configure',owner,{legal_name:'Cedar Software Inc',timezone:'UTC',invoice_prefix:'RETRY',payment_terms_days:30})
 await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Reviewed retry journey'})
 await h.api('tax.review',owner,{revision:(await h.api('business',owner)).revision})
 browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,headless:true,args:['--no-sandbox','--use-mock-keychain','--password-store=basic']})
 const context=await browser.newContext();await context.addCookies(owner.split('; ').map(part=>{const at=part.indexOf('=');return {name:part.slice(0,at),value:part.slice(at+1),url:h.origin}}))
 const page=await context.newPage(),customer=await (await browser.newContext()).newPage(),seen=new Set()
 const shot=async(target,label)=>{
  if(seen.has(label))return;seen.add(label)
  for(const width of [1440,390]){
   await target.setViewportSize({width,height:1000})
   assert.equal(await target.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${label} fits ${width}`)
   const icons=await target.locator('a,button,[role=button]').evaluateAll(nodes=>nodes.filter(n=>!n.textContent.trim()&&n.querySelector('svg,img')&&!n.getAttribute('aria-describedby')).map(n=>n.outerHTML))
   assert.deepEqual(icons,[],'Icon controls have descriptive tooltips')
   await target.screenshot({path:`${directory}/${width}-${label}.png`,fullPage:true})
   if(label==='recovery-report'||label.startsWith('churn-'))for(const title of ['Failed payments and recovered revenue','By decline reason','By retry attempt','By dunning step','Involuntary churn','Published retry comparison']){const section=target.getByRole('heading',{name:title,exact:true}).locator('..');await section.screenshot({path:`${directory}/${width}-${label}-${title.toLowerCase().replaceAll(' ','-')}.png`})}
   if(await target.locator('#payment-retries').count())await target.locator('#payment-retries').screenshot({path:`${directory}/${width}-${label}-detail.png`})
   if(await target.locator('#automatic-collection').count())await target.locator('#automatic-collection').screenshot({path:`${directory}/${width}-${label}-detail.png`})
   console.log('BROWSER',width,label)
  }
 }
 await (mode==='churn'?retryPlanChurnFlow:paymentRetriesFlow)(h,owner,{
  assignSegment:async input=>{
   await page.goto(h.origin+'/app/settings#payment-retries')
   const details=page.locator(`[data-retry-customer="${input.customer}"]`)
   await details.locator('summary').click()
   const form=details.locator('form')
   assert.equal(await form.locator('[name=customer_revision]').inputValue(),input.customer_revision)
   assert.equal(await form.locator('[name=revision]').inputValue(),input.revision??'')
   await form.locator('[name=segment]').fill(input.segment)
   await form.locator('[name=confirm]').check()
   await shot(page,input.segment?`segment-form-${input.segment}`:'segment-clear-form')
   await Promise.all([page.waitForNavigation(),form.getByRole('button').click()])
   assert.equal(new URL(page.url()).searchParams.has('error'),false)
   const saved=page.locator(`[data-retry-customer="${input.customer}"]`)
   const revision=await saved.locator('[name=revision]').inputValue()
   assert.equal(await saved.locator('[name=segment]').inputValue(),input.segment)
   await saved.locator('summary').click();await shot(page,input.segment?`segment-saved-${input.segment}`:'segment-cleared')
   return {customer:input.customer,segment:input.segment||null,revision}
  },
  prepareCollection:async input=>{
   await page.goto(h.origin+`/app/invoices/${input.invoice}`)
   const details=page.locator('#automatic-collection details');await details.locator('summary').click()
   const form=details.locator('form');await form.locator('[name=issue_date]').fill(input.issue_date)
   if(input.mandate_ref)await form.locator('[name=mandate_ref]').fill(input.mandate_ref)
   if(input.enable_retries)await form.locator('[name=enable_retries]').check()
   await shot(page,input.mandate_ref?'prepare-bank':'prepare-card')
   await Promise.all([page.waitForNavigation(),form.getByRole('button').click()])
   assert.equal(new URL(page.url()).searchParams.has('error'),false)
   return (await h.api('automatic-collections',owner)).find(r=>r.invoice===input.invoice)
  },
  acceptCollection:async({path,request})=>{
   await customer.goto(h.origin+path)
   await shot(customer,request.method==='us_bank_account'?'consent-spanish':request.quote.retryPolicy?'consent-english-retries':'consent-english')
   const form=customer.locator('form').filter({has:customer.locator('[name=accept]')});await form.locator('[name=accept]').check()
   await Promise.all([customer.waitForNavigation(),form.getByRole('button').click()])
   assert.equal(new URL(customer.url()).searchParams.has('error'),false)
   await shot(customer,request.method==='us_bank_account'?'accepted-spanish':request.quote.retryPolicy?'accepted-english-retries':'accepted-english')
  },
  onState:async state=>{
   if(state.state==='consent')return
   if(state.state==='report'||state.state.startsWith('churn-')){
    await page.goto(h.origin+'/app/reports/recovery');await page.getByText('Configured policy comparisons',{exact:true}).click();await shot(page,state.state==='report'?'recovery-report':state.state)
    await page.goto(h.origin+'/app/settings#payment-retries');await page.locator('#payment-retries > details > summary').first().click();await shot(page,'retry-settings')
   }else{await page.goto(h.origin+`/app/invoices/${state.id}`);await shot(page,state.state)}
  }
 })
}finally{await browser?.close();await h.close()}

}

// portal-methods-browser: retained public-door assertions with one shared entry point.
async function portalMethodsBrowserJourney(mode) {
const {cardExpiryNoticesFlow,harnessOptions: expiryOptions} = await import('./card-expiry-notices.mjs')
const { default: assert } = await import('node:assert/strict')
const {mkdir} = await import('node:fs/promises')
const {chromium} = await import('@playwright/test')
const {harness} = await import('./harness.mjs')
const {applyPolicy} = await import('./policy-helper.mjs')
const {customerSearchFlow,harnessOptions} = await import('./customer-search.mjs')
const {lifecycleFlow,harnessOptions: lifecycleOptions} = await import('./card-lifecycle.mjs')
const directory=process.env.NECTAR_EVIDENCE_DIR??'.evidence/portal-methods'
await mkdir(directory,{recursive:true})
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,headless:true,args:['--no-sandbox','--use-mock-keychain','--password-store=basic']})
async function installation(options) {
 const h=await harness({assets:true,...options})
 await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})
 const owner=await h.signIn(h.vars.OWNER_EMAIL)
 await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
 await h.api('business.configure',owner,{legal_name:'Alder Analytics',timezone:'UTC',invoice_prefix:'ALDER',payment_terms_days:30})
 await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Reviewed portal methods journey'})
 await h.api('tax.review',owner,{revision:(await h.api('business',owner)).revision})
 return {h,owner}
}
let h
try {
 const initial=await installation(harnessOptions());h=initial.h;const owner=initial.owner
 const operator=await browser.newContext(),customer=await browser.newContext(),op=await operator.newPage(),page=await customer.newPage()
 await operator.addCookies(owner.split('; ').map(value=>{const i=value.indexOf('=');return {name:value.slice(0,i),value:value.slice(i+1),url:h.origin}}))
 const shot=async(page,label)=>{
  for(const width of [1440,390]) {
   await page.setViewportSize({width,height:950})
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${label} fits ${width}`)
   assert.equal(await page.locator('a,button').evaluateAll(nodes=>nodes.filter(n=>!n.textContent.trim()).length),0)
   const changed=page.locator('#saved-payment-methods')
   if(await changed.count())await changed.screenshot({path:`${directory}/${width}-${label}.png`})
   else await page.screenshot({path:`${directory}/${width}-${label}.png`,fullPage:true})
  }
 }
 await customerSearchFlow(h,owner,async()=>{},{
  prepareMethodAction:async({customer,binding,setup,operation})=>{
   await op.goto(`${h.origin}/app/customers/${customer}`)
   const detail=op.locator('#saved-payment-methods details').filter({has:op.locator('form[action="/app/do/portal.method.prepare"]')})
   await detail.locator('summary').click()
   const form=detail.locator('form').filter({has:op.locator(`input[name=setup][value="${setup}"]`)})
   await form.locator('[name=operation]').selectOption(operation);await form.locator('[name=confirm]').check()
   await shot(op,`owner-${operation}-prepared`)
   await Promise.all([op.waitForNavigation(),form.getByRole('button').click()])
   assert.equal(new URL(op.url()).searchParams.get('error'),null)
   const session=await h.api('portal.session.issue',owner,{customer,origin:h.origin,audience:'hosted'})
   const response=await h.raw(`/portal/payment-methods/actions?session=${encodeURIComponent(session.token)}`)
   return (await response.json()).find(row=>row.status==='prepared'&&row.setup===setup&&row.operation===operation)
  },
  confirmMethodAction:async({session,action,operation})=>{
   await page.goto(`${h.origin}/portal/payment-methods?session=${encodeURIComponent(session.token)}`)
   const form=page.locator(`[data-method-action="${action}"] form`)
   await form.locator('[name=confirm]').check()
   await shot(page,`customer-${operation}-${action.slice(0,6)}`)
   const [response]=await Promise.all([page.waitForNavigation(),form.getByRole('button').click()])
   assert.equal(response.status(),200)
   const result=await h.raw(`/portal/payment-methods/actions?session=${encodeURIComponent(session.token)}`)
   return (await result.json()).find(row=>row.id===action)
  },
  methodState:async({customer,session,operation,state})=>{
   const response=await page.goto(`${h.origin}/portal/payment-methods?session=${encodeURIComponent(session.token)}`)
   assert.equal(response.status(),state==='refused'?401:200)
   await shot(page,`portal-${operation}-${state}`)
   await op.goto(`${h.origin}/app/customers/${customer}`);await shot(op,`owner-${operation}-${state}`)
  }
 })
 await h.close();h=null
 const lifecycle=await installation(lifecycleOptions());h=lifecycle.h
 const lifecycleContext=await browser.newContext(),record=await lifecycleContext.newPage()
 await lifecycleContext.addCookies(lifecycle.owner.split('; ').map(value=>{const i=value.indexOf('=');return {name:value.slice(0,i),value:value.slice(i+1),url:h.origin}}))
 await lifecycleFlow(h,lifecycle.owner,{onState:async({customer,state})=>{await record.goto(`${h.origin}/app/customers/${customer}`);await shot(record,`lifecycle-${state}`)}})
 await h.close();h=null
 const expiry=await installation(expiryOptions());h=expiry.h
 const expiryContext=await browser.newContext(),review=await expiryContext.newPage(),message=await expiryContext.newPage()
 await expiryContext.addCookies(expiry.owner.split('; ').map(value=>{const i=value.indexOf('=');return {name:value.slice(0,i),value:value.slice(i+1),url:h.origin}}))
 await cardExpiryNoticesFlow(h,expiry.owner,{onState:async({customer,state,notice,updateLink})=>{
  if(state==='expired'){
   assert.equal((await message.goto(updateLink)).status(),401)
   await shot(message,'expiry-link-expired');return
  }
  await review.goto(`${h.origin}/app/customers/${customer}`)
  await review.locator('#card-expiry-notices summary').click()
  await shot(review,`expiry-${state}`)
  if(notice.preview){
   await message.setContent(notice.preview.html)
   await shot(message,'expiry-email')
   const link=message.getByRole('link')
   assert.ok(await link.evaluate(node=>node.getBoundingClientRect().height>=44))
   const href=await link.getAttribute('href')
   await message.goto(href);await shot(message,'expiry-update-link')
  }
 }})
 console.log('PORT-004 and PAY-005 native forms and end states passed at 1440 and 390')
} finally {await h?.close();await browser.close()}

}
