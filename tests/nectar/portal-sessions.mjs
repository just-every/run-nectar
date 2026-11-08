// PORT-005 round A: real Worker/D1, operator public doors issue a customer-only
// signed capability; all customer reads go through /portal, never an Actor.
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { totp } from './mfa.mjs'
import { portalPrivacyRetention } from './portal-privacy-retention.mjs'
import { portalCorrections } from './portal-corrections.mjs'

export async function seedPortalRecords(h, owner) {
  const customers = []
  const product = (await h.api('product.create', owner, { code: 'portal-platform', name: 'Analytics platform' })).id
  const price = (await h.api('price.create', owner, { product, kind: 'flat', unit_amount: '300', taxable: false })).id
  for (const [external_id, name, language] of [['PORT005-NW','Northwind Robotics','en'],['PORT005-PC','Pinecrest Labs','es-US'],['PORT005-EMPTY','Larch Studio','en']]) {
    const customer = (await h.api('customer.create', owner, { external_id, name, billing_email: `${external_id.toLowerCase()}@example.test`, language })).id
    customers.push(customer)
    if (customers.length <= 2) await h.api('subscription.create', owner, { customer, start_date: '2026-08-01', price: [price] })
  }
  const run = (await h.api('billrun.prepare', owner, { period: '2026-08' })).id
  const invoices = (await h.api(`runs/${run}`, owner)).invoices
  for (const invoice of invoices) {
    await h.api('invoice.approve', owner, { invoice: invoice.id, acknowledge: true })
    await h.api('invoice.finalise', owner, { invoice: invoice.id, issue_date: invoice.period_end })
  }
  const invoice = invoices.find(row => row.customer_id === customers[0])
  await h.api('credit.issue', owner, { invoice: invoice.id, amount: '25', reason: 'Service adjustment' })
  const payment = await h.api('payment.record', owner, { customer: customers[0], amount: '100', received_on: '2026-09-03', method: 'bank_transfer', reference: 'PRIVATE-REFERENCE', evidence: 'INTERNAL-BANK-EVIDENCE' })
  await h.api('payment.allocate', owner, { payment: payment.payment, invoice: invoice.id, amount: '100' })
  await h.api('note.add', owner, { kind: 'customer', record: customers[0], body: 'PRIVATE-OPERATOR-NOTE' })
  const charge = (await h.api('charge.add', owner, { customer: customers[0], amount: '55', description: 'PRIVATE-DRAFT-CHARGE', taxable: false, effective_date: '2026-09-05' })).charge
  const draft = (await h.api('invoice.manual', owner, { customer: customers[0], charges: [charge], service_date: '2026-09-05' })).id
  return { customers, invoices, invoice, draft }
}

export async function portalSessionsFlow(h, owner) {
  const instant = Date.parse('2026-10-21T09:00:00Z')
  await h.advanceClock(new Date(instant).toISOString())
  const records = await seedPortalRecords(h, owner), { customers, invoice, invoices } = records
  const configure = (hosts = [h.origin], parents = ['https://app.example.com']) => h.api('portal.configure', owner, { hosts, parents })
  const issue = (customer = customers[0], fields = {}) => h.api('portal.session.issue', owner, { customer, origin: h.origin, audience: 'hosted', ...fields })
  const open = (session, path = '/portal', headers = {}) => h.raw(`${path}?session=${encodeURIComponent(session.token)}`, { headers })
  await h.api('portal.session.issue', owner, { customer: customers[0], origin: h.origin, audience: 'hosted' }, 403)
  for (const hosts of [['https://billing.example.com/path'], ['https://*.example.com'], ['http://untrusted.example.com'], ['https://owner:password@billing.example.com']]) await h.api('portal.configure', owner, { hosts, parents: [] }, 400)
  await configure()
  await h.api('portal.configure', owner, { hosts:[h.origin],parents:[],brand_color:'red;display:none' },400)
  await h.api('portal.session.issue', owner, { customer: customers[0], origin: 'https://unapproved.example.com', audience: 'hosted' }, 403)
  await h.api('portal.session.issue', owner, { customer: customers[0], origin: h.origin, audience: 'embedded', parent: 'https://evil.example.com' }, 403)
  const session = await issue()
  assert.equal(session.expiresAt, instant + 15 * 60 * 1000, 'PORT-005 fixed fifteen-minute lifetime')
  assert.notEqual(session.token, h.vars.SESSION_SECRET, 'PORT-005 dedicated signer')
  const overview = await open(session, '/portal/data')
  assert.equal(overview.status, 200)
  assert.equal(overview.headers.get('cache-control'), 'no-store')
  assert.equal(overview.headers.get('referrer-policy'), 'no-referrer')
  const data = await overview.json()
  assert.deepEqual(data.customer, { name: 'Northwind Robotics', language: 'en', currency: 'USD' })
  assert.deepEqual(data.invoices.map(row => [row.id,row.total_cents,row.credited_cents,row.paid_cents,row.balance_cents]), [[invoice.id,30000,2500,10000,17500]], 'PORT-005 original total = credited + allocated + owed')
  const detail = await open(session, `/portal/invoices/${invoice.id}`)
  assert.equal(detail.status, 200)
  const html = await detail.text()
  for (const amount of ['USD 300.00','USD 25.00','USD 100.00','USD 175.00']) assert.ok(html.includes(amount), `PORT-005 exact ${amount}`)
  assert.doesNotMatch(html, /Pinecrest|PRIVATE-|INTERNAL-|calculation_json|actor|api\/nectar/)
  const foreign = invoices.find(row => row.customer_id === customers[1])
  assert.equal((await open(session, `/portal/invoices/${foreign.id}`)).status, 404, 'PORT-005 foreign invoice refused')
  assert.equal((await open(session, `/portal/invoices/${records.draft}`)).status, 404, 'PORT-005 even an own-customer unissued invoice is refused')
  assert.equal((await open(session, '/portal/invoices/unknown')).status, 404)
  assert.equal((await open(session, '/portal/unknown')).status, 404)
  // Customer identity comes only from the signed session, never a query selector.
  const selected = await h.raw(`/portal/data?session=${encodeURIComponent(session.token)}&customer=${customers[1]}`)
  assert.equal((await selected.json()).customer.name, 'Northwind Robotics')
  assert.equal((await h.raw('/portal', { cookie: owner })).status, 401, 'PORT-005 operator cookies are not customer sessions')
  const agent = { bearer: (await h.api('credential.issue', owner, { name: 'Portal reader', scopes: ['prepare'] })).key }
  assert.equal((await h.raw('/portal', agent)).status, 401, 'PORT-005 operator API key is not a customer session')
  assert.equal((await h.raw(`/api/nectar/customers`, { bearer: session.token })).status, 401, 'PORT-005 customer token never grants operator API access')
  for (const action of ['portal.configure','portal.session.issue','portal.session.revoke']) await h.api(action, agent, {}, 403)
  await h.api('access.give', owner, { email: 'portal-finance@example.test', name: 'Fiona Finance', role: 'finance' })
  const finance = await h.signIn('portal-finance@example.test', { requested: true })
  for (const action of ['portal.configure','portal.session.issue','portal.session.revoke']) await h.api(action, finance, {}, 403)
  assert.equal((await h.raw('/portal?session=' + session.token, { method: 'POST', body: { customer: customers[1] } })).status, 405, 'PORT-005 customer door is read-only')
  const [body, mac] = session.token.split('.')
  const claims = JSON.parse(Buffer.from(body, 'base64url'))
  // Even a correctly signed token cannot change the session's recorded scope.
  const signed = value => { const part = Buffer.from(JSON.stringify(value)).toString('base64url'); return `${part}.${createHmac('sha256', h.vars.PORTAL_KEY).update(`nectar-portal-v1.${part}`).digest('base64url')}` }
  for (const changed of [{ ...claims, customer: customers[1] }, { ...claims, audience: 'embedded', parent: 'https://app.example.com' }, { ...claims, origin: 'https://billing.example.com' }, { ...claims, iss: 'https://other-install.example.com' }]) assert.equal((await open({ token: signed(changed) })).status, 401)
  assert.equal((await open({ token: `${body}.${mac[0] === 'A' ? 'B' : 'A'}${mac.slice(1)}` })).status, 401, 'PORT-005 forged signature refused')
  assert.equal((await h.raw('/portal?session=bad')).status, 401)
  assert.equal((await h.raw(`/portal?session=${session.token}&session=${session.token}`)).status, 401)
  const embedded = await issue(customers[0], { audience: 'embedded', parent: 'https://app.example.com' })
  assert.match((await open(embedded)).headers.get('content-security-policy'), /frame-ancestors https:\/\/app\.example\.com;/, 'PORT-005 exact approved parent in CSP')
  assert.match((await open(session)).headers.get('content-security-policy'), /frame-ancestors 'none'/)
  const branded = await issue(customers[0], { origin: h.origin })
  // Host comes from the request URL. Forwarded host headers cannot alter it.
  assert.equal((await open(branded, '/portal', { 'x-forwarded-host': 'billing.example.com' })).status, 200)
  await configure(['https://billing.example.com'])
  const brandedOnly = await issue(customers[0], { origin: 'https://billing.example.com' })
  assert.equal((await open(brandedOnly)).status, 401, 'PORT-005 a session for another host is refused here')
  assert.equal((await open(session)).status, 401, 'PORT-005 owner policy revision revokes old sessions on next request')
  await configure()
  const revoked = await issue()
  await h.api('portal.session.revoke', owner, { session: revoked.id })
  assert.equal((await open(revoked)).status, 401, 'PORT-005 explicit revocation is immediate')
  const audit = JSON.stringify(await h.api('audit', owner))
  assert.ok(!audit.includes(revoked.token) && !audit.includes(h.vars.PORTAL_KEY), 'PORT-005 neither token nor signing key in audit')
  const spanish = await issue(customers[1])
  const spanishPage = await open(spanish)
  const spanishHtml = await spanishPage.text()
  assert.match(spanishHtml, /lang="es-US"/)
  assert.match(spanishHtml, /Resumen de facturación/)
  assert.ok(spanishHtml.includes('USD 300.00'), 'PORT-005 Spanish keeps exact original figures')
  assert.doesNotMatch(spanishHtml, /Northwind|PRIVATE-/)
  const empty = await issue(customers[2])
  assert.match(await (await open(empty)).text(), /No issued invoices/)
  const originalKey = h.vars.PORTAL_KEY
  const rotate = await issue()
  h.vars.PORTAL_KEY = 'another-installation-key-with-32-bytes'; await h.advanceClock(new Date(instant).toISOString())
  assert.equal((await open(rotate)).status, 401, 'PORT-005 rotated key refuses old signatures')
  delete h.vars.PORTAL_KEY; await h.advanceClock(new Date(instant).toISOString())
  assert.equal((await open(rotate)).status, 401, 'PORT-005 missing dedicated key fails closed')
  await h.api('portal.session.issue', owner, { customer: customers[0], origin: h.origin, audience: 'hosted' }, 503)
  h.vars.PORTAL_KEY = originalKey; await h.advanceClock(new Date(instant).toISOString())
  assert.equal((await open(rotate)).status, 200)
  // Inherited GOV-005: approval withdraws all runtime capabilities, while an
  // unrelated customer's session and financial records remain usable.
  const erased = await issue(customers[2]), erasedAgain = await issue(customers[2])
  const privacyPath=`/portal/privacy?session=${erased.token}`
  const beforeRequests=await h.api('erasures',owner),beforeMail=h.mails.length
  assert.equal((await h.raw(privacyPath)).status,200,'PORT-005 own-customer privacy request page')
  assert.deepEqual(await h.api('erasures',owner),beforeRequests,'PORT-005 viewing privacy records no request')
  assert.equal((await h.raw(privacyPath,{form:new URLSearchParams({confirm:'yes'}),headers:{origin:'https://evil.example.com'}})).status,403,'PORT-005 cross-origin privacy post refused')
  assert.equal((await h.raw(privacyPath,{form:new URLSearchParams({confirm:'yes',customer:customers[1]})})).status,400,'PORT-005 submitted customer selector refused')
  assert.equal((await h.raw(privacyPath,{form:new URLSearchParams({confirm:'yes',claimed_email:'other@example.test'})})).status,400,'PORT-005 customer cannot substitute verification recipient')
  assert.equal(h.mails.length,beforeMail,'PORT-005 refused requests send nothing')
  const requested=await h.raw(privacyPath,{form:new URLSearchParams({confirm:'yes'})})
  assert.equal(requested.status,303)
  const erasure=(await h.api('erasures',owner)).find(row=>!beforeRequests.some(before=>before.id===row.id))
  assert.equal(erasure.customer_id,customers[2],'PORT-005 request identity comes only from the signed session')
  await h.api('erasure.approve',owner,{request:erasure.id,confirm:true},409)
  assert.equal((await open(erased)).status,200,'PORT-005 requesting does not erase records')
  const ownStatus=await (await h.raw(privacyPath)).text()
  assert.match(ownStatus,/Request recorded/)
  assert.doesNotMatch(ownStatus,/token_hash|recipient|provider_ref|requested_by|@example|Northwind|Pinecrest/,'PORT-005 customer status omits private custody and foreign records')
  for(const action of ['approve','verify','purge']) assert.equal((await h.raw(`/portal/erasure.${action}?session=${erased.token}`,{form:new URLSearchParams({request:erasure.id})})).status,405,'PORT-005 customer receives no owner erasure authority')
  const mail = h.mails.findLast(mail => String(mail.text).includes('/erase/'))
  assert.deepEqual(mail.to,['port005-empty@example.test'],'PORT-005 confirmation goes only to the billing address on file')
  const erasurePath = new URL(mail.text.match(/https?:\/\/[^\s]+\/erase\/[a-f0-9]+/)[0]).pathname
  assert.equal((await h.raw(erasurePath, { form: new URLSearchParams({ confirm: 'yes' }) })).status, 200)
  assert.equal((await h.raw(erasurePath, { form: new URLSearchParams({ confirm: 'yes' }) })).status, 404,'PORT-005 verification is single-use')
  assert.equal((await open(erased)).status,200,'PORT-005 verification alone does not erase')
  const receipt = await h.api('erasure.approve', owner, { request: erasure.id, confirm: true })
  assert.equal(receipt.receipt.changed.find(row => row.kind === 'nc_portal_sessions').records, 3)
  for (const dead of [empty,erased,erasedAgain]) assert.equal((await open(dead)).status, 401, 'PORT-005 erased customer session withdrawn')
  assert.equal((await open(rotate)).status, 200, 'PORT-005 unrelated session survives erasure')
  await h.api('portal.session.issue', owner, { customer: customers[2], origin: h.origin, audience: 'hosted' }, 404)
  await portalCorrections(h,owner,rotate,invoice.id)
  const expiry = await issue()
  await h.advanceClock(new Date(expiry.expiresAt - 1).toISOString())
  assert.equal((await open(expiry)).status, 200)
  await h.advanceClock(new Date(expiry.expiresAt).toISOString())
  assert.equal((await open(expiry)).status, 401, 'PORT-005 expired at the exact deadline')
  await portalPrivacyRetention(h,owner)
  await h.api('mfa.policy', owner, { scope: 'all' })
  const factor = await h.api('mfa.totp.start', owner, {})
  await h.api('mfa.totp.confirm', owner, { factor: factor.factor, code: totp(factor.secret, expiry.expiresAt) })
  const fresh = await issue()
  await h.advanceClock(new Date(expiry.expiresAt + 16 * 60 * 1000).toISOString())
  for (const [action, body] of [['portal.configure', { hosts: [h.origin], parents: [] }], ['portal.session.issue', { customer: customers[0], origin: h.origin, audience: 'hosted' }], ['portal.session.revoke', { session: fresh.id }]]) assert.equal((await h.api(action, owner, body, 403)).error, 'mfa_step_up_required', `PORT-005 fresh-factor custody for ${action}`)
  console.log('PORT-005 signed customer sessions, own figures, credit correction parity, customer privacy custody, allowlists, revocation and expiry passed')
}

// Public-door portal-embedding checks share this retained journey module.
const portalEmbeddingJourneys = await (async () => {
// PORT-005: a real HTTPS merchant application frames the built Nectar Worker.
// Local TLS and reserved loopback hostnames replace hosting only; billing, auth and data remain real.
const { default: assert } = await import('node:assert/strict')
const { execFileSync } = await import('node:child_process')
const { createServer } = await import('node:https')
const { mkdtemp, readFile, rm, mkdir } = await import('node:fs/promises')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const { chromium } = await import('@playwright/test')
const { portalApp } = await import('../../examples/portal/app.mjs')
const { csvRows } = await import('./financial-reports.mjs')

async function seedPortalIntervals(h, owner, customers) {
  const api=(path,body)=>h.api(path,owner,body)
  const meter=(await api('meter.create',{code:'portal-calendar-calls',name:'Portal calendar calls',unit_label:'calls'})).id
  const prices=[]
  for(const [suffix,kind,amount,interval,timing] of [['annual','flat','12000','annual','advance'],['usage','unit','2','monthly','arrears']]){
    const product=(await api('product.create',{code:`portal-calendar-${suffix}`,name:`Portal calendar ${suffix}`})).id
    prices.push((await api('price.create',{product,kind,unit_amount:amount,taxable:false,billing_interval:interval,billing_timing:timing,...(kind==='unit'?{meter}:{})})).id)
  }
  const subscriptions=[]
  for(const [index,customer] of customers.slice(0,2).entries()){
    subscriptions.push((await api('subscription.create',{customer,start_date:'2025-10-01',term_months:24,price:prices})).id)
    await api('usage.submit',{events:[{event_id:`synthetic-portal-calendar-${index+1}`,customer:index?'PORT005-PC':'PORT005-NW',meter:'portal-calendar-calls',quantity:index?'900':'3',occurred_at:'2026-09-15T12:00:00Z'}]})
  }
  return {subscription:subscriptions[0],foreign:subscriptions[1],prices}
}

async function portalIntervalProjection(h, owner, session, origin, fixture) {
  const open=path=>h.dispatch(new Request(`${origin}${path}${path.includes('?')?'&':'?'}session=${session.token}`))
  const state=async()=>({audit:await h.api('audit',owner),runs:await h.api('runs',owner),invoices:await h.api('invoices',owner)})
  const before=await state()
  const endpoint=`/portal/subscriptions/${fixture.subscription}/upcoming`
  const response=await open(endpoint+'?period=2026-10')
  assert.equal(response.status,200,'Customer calendar preview supports annual advance and monthly arrears')
  const preview=await response.json()
  assert.equal(preview.billingMonth,'2026-10')
  assert.deepEqual((await (await open(endpoint)).json()).invoices,preview.invoices,'Default customer month uses the business clock')
  assert.equal(preview.invoices.length,1,'One customer invoice composes every service window due on the same day')
  assert.deepEqual(preview.invoices.map(row=>row.calculation.totalCents).sort((a,b)=>a-b),[1200600])
  const operator=await h.api(`subscriptions/${fixture.subscription}/upcoming?period=2026-10`,owner)
  for(const row of preview.invoices){
    const source=operator.invoices.find(invoice=>invoice.period.start===row.period.start&&invoice.period.end===row.period.end)
    assert.ok(source)
    assert.equal(row.calculation.fingerprint,source.calculation.fingerprint)
    assert.equal(row.calculation.totalCents,source.calculation.totalCents)
    assert.equal(row.billingTerms,null)
    assert.deepEqual(row.servicePeriods.map(part=>[part.period.start,part.period.end,part.terms.timing]).sort(),[['2026-09-01','2026-10-01','arrears'],['2026-10-01','2027-10-01','advance']])
    assert.equal(row.billingDueDate,'2026-10-01')
    assert.equal(row.calculation.inputs,undefined,'Customer reads never return saved raw inputs')
    assert.equal(row.calculation.exceptions,undefined,'Operator exceptions remain private')
    assert.equal(row.billingWindow,undefined,'Internal component claims are not a customer read model')
    assert.ok(row.calculation.lines.every(line=>line.evidence===undefined))
  }
  assert.doesNotMatch(JSON.stringify(preview),/PRIVATE-|INTERNAL-|synthetic-portal-calendar-2/)
  const csv=await open(`/portal/usage.csv?subscription=${fixture.subscription}&period=2026-10`)
  assert.equal(csv.status,200)
  const usageRows=csvRows(await csv.text())
  assert.deepEqual(usageRows.map(row=>({meter:row.meter,from:row.period_start,to:row.period_end,quantity:Number(row.quantity),earlier:Number(row.earlier_quantity)})),[
    {meter:'portal-calendar-calls',from:'2026-09-01',to:'2026-10-01',quantity:3,earlier:0},
  ],'Usage CSV exports only the actual metered service window, with no invented annual fee usage row')
  assert.equal(preview.invoices[0].meters.length,1,'Only the metered service has a usage projection')
  for(const path of [`/portal/subscriptions/${fixture.foreign}/upcoming?period=invalid`,`/portal/upcoming?subscription=${fixture.foreign}&period=2026-10`,`/portal/usage.csv?subscription=${fixture.foreign}&period=2026-10`])
    assert.equal((await open(path)).status,404,'Foreign subscriptions are refused before calendar or period reads')
  assert.deepEqual(await state(),before,'Customer calendar and CSV reads create no billing or audit records')
  return preview
}

async function portalEmbeddingFlow(h, owner) {
  const scratch = await mkdtemp(join(tmpdir(),'nectar-portal-tls-'))
  const evidence = process.env.NECTAR_EVIDENCE_DIR
  let server, browser, active, hosted, embedded
  try {
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(scratch,'key.pem'),'-out',join(scratch,'cert.pem'),'-days','1','-subj','/CN=billing.localhost','-addext','subjectAltName=DNS:billing.localhost,DNS:app.localhost,DNS:other.localhost'],{stdio:'ignore'})
    let portalOrigin, appOrigin, app
    server = createServer({ key:await readFile(join(scratch,'key.pem')),cert:await readFile(join(scratch,'cert.pem')) },async (incoming,outgoing) => {
      try {
        const origin = `https://${incoming.headers.host}`
        const chunks=[];for await (const bytes of incoming) chunks.push(bytes)
        const request = new Request(origin+incoming.url,{ method:incoming.method,headers:incoming.headers,...(!['GET','HEAD'].includes(incoming.method)?{body:Buffer.concat(chunks)}:{}) })
        const response = origin === portalOrigin ? await h.dispatch(request) : [appOrigin,appOrigin.replace('app.','other.')].includes(origin) ? await app(request) : new Response(null,{status:404})
        outgoing.writeHead(response.status,Object.fromEntries(response.headers))
        outgoing.end(Buffer.from(await response.arrayBuffer()))
      } catch(error) { console.error('PORT-005 HTTPS transport:',String(error.message).replace(/session=[^&\s]+/g,'session=[redacted]'));outgoing.writeHead(500);outgoing.end('Local HTTPS transport failed') }
    })
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
    const port = server.address().port
    portalOrigin = `https://billing.localhost:${port}`;appOrigin=`https://app.localhost:${port}`
    app = portalApp({ portalOrigin,sessionForRequest:async()=>active,name:'Fieldnote' })
    await h.advanceClock('2026-10-21T09:00:00Z')
    const { customers,invoice,invoices } = await seedPortalRecords(h,owner)
    const intervals=await seedPortalIntervals(h,owner,customers)
    await h.api('portal.configure',owner,{ hosts:[portalOrigin],parents:[appOrigin],brand_name:'Fieldnote Billing',brand_color:'#245c46' })
    const issue = (customer,audience) => h.api('portal.session.issue',owner,{ customer,origin:portalOrigin,audience,...(audience==='embedded'?{parent:appOrigin}:{}) })
    const calendarSession=await issue(customers[0],'hosted')
    const preview=await portalIntervalProjection(h,owner,calendarSession,portalOrigin,intervals)
    assert.ok(preview.invoices.every(row=>row.state==='preview'))
    const run=await h.api('billrun.prepare',owner,{period:'2026-10'})
    const drafts=(await h.api(`runs/${run.id}`,owner)).invoices.filter(row=>row.customer_id===customers[0])
    const intervalDrafts=[]
    for(const draft of drafts){
      const source=await h.api(`invoices/${draft.id}`,owner)
      if(source.subscription_id!==intervals.subscription)continue
      intervalDrafts.push(source)
      await h.api('invoice.approve',owner,{invoice:draft.id,acknowledge:true})
      await h.api('invoice.finalise',owner,{invoice:draft.id,issue_date:'2026-10-01'})
    }
    assert.equal(intervalDrafts.length,1)
    const frozen=await portalIntervalProjection(h,owner,calendarSession,portalOrigin,intervals)
    assert.ok(frozen.invoices.every(row=>row.state==='issued'))
    assert.deepEqual(frozen.invoices.map(row=>row.calculation),preview.invoices.map(row=>row.calculation),'Ordinary issue preserves the customer calculation for each real window')
    await h.api('usage.submit',owner,{events:[{event_id:'synthetic-portal-calendar-late',customer:'PORT005-NW',meter:'portal-calendar-calls',quantity:'7',occurred_at:'2026-09-20T12:00:00Z'}]})
    assert.deepEqual((await portalIntervalProjection(h,owner,calendarSession,portalOrigin,intervals)).invoices,frozen.invoices,'Late ingestion cannot rewrite issued customer usage or annual charges')
    browser = await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,headless:true,args:['--no-sandbox','--use-mock-keychain','--password-store=basic']})
    const context = await browser.newContext({ignoreHTTPSErrors:true}),page=await context.newPage()
    const shot = async name => {
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`PORT-005 ${name} fits merchant app`)
      if (evidence) { await mkdir(evidence,{recursive:true});await page.screenshot({path:join(evidence,`${page.viewportSize().width}-${name}.jpg`),type:'jpeg',quality:82,fullPage:true}) }
    }
    for (const width of [1440,390]) {
      await h.advanceClock('2026-10-21T09:00:00Z')
      await page.setViewportSize({width,height:844})
      hosted=await issue(customers[0],'hosted');embedded=await issue(customers[0],'embedded');active=embedded
      assert.equal((await h.dispatch(new Request(hosted.url))).status,200,'PORT-005 branded request dispatch preserves its public origin')
      await page.goto(appOrigin+'/billing')
      const frame=page.frameLocator('iframe')
      await frame.getByRole('heading',{name:'Billing overview',exact:true}).waitFor()
      assert.match(await frame.locator('main').innerText(),/Northwind Robotics/)
      assert.doesNotMatch(await frame.locator('main').innerText(),/Pinecrest|PRIVATE-|INTERNAL-/)
      assert.equal(await frame.locator('html').evaluate(node=>node.scrollWidth>innerWidth),false,'PORT-005 embedded portal fits phone and desktop')
      await shot('sample-app-overview')
      await frame.locator(`a[href*="/portal/invoices/${invoice.id}"]`).click()
      await frame.getByRole('heading',{name:'Charges',exact:true}).waitFor()
      assert.match(await frame.locator('main').innerText(),/USD 175\.00/)
      await shot('sample-app-invoice')
      await frame.getByRole('link',{name:'Privacy request',exact:true}).click()
      await frame.getByRole('heading',{name:'Privacy request',exact:true}).waitFor()
      await shot('sample-app-privacy')
      const response=await page.goto(hosted.url)
      assert.equal(response.status(),200,'PORT-005 actual branded hostname reaches the Worker')
      assert.equal(new URL(page.url()).hostname,'billing.localhost')
      assert.match(await page.title(),/Fieldnote Billing/)
      assert.equal(await page.locator('.merchant').innerText(),'Fieldnote Billing')
      assert.equal(await page.locator('.merchant').evaluate(node=>getComputedStyle(node).borderTopColor),'rgb(36, 92, 70)','PORT-005 merchant accent is rendered')
      assert.equal(await page.locator('a[href="/app"],img[src*="/brand/"]').count(),0,'PORT-005 no operator navigation or Nectar mark on branded customer pages')
      await shot('branded-overview')
      await page.locator(`a[href*="/portal/invoices/${invoice.id}"]`).click()
      await page.getByRole('heading',{name:'Charges',exact:true}).waitFor()
      await shot('branded-invoice')
      await page.goto(`${portalOrigin}/portal/upcoming?session=${hosted.token}&subscription=${intervals.subscription}&period=2026-10`)
      await page.getByRole('heading',{name:'Usage and upcoming invoice',exact:true}).waitFor()
      assert.equal(await page.locator('main section.card').count(),1,'Customer page renders one composed invoice with both actual service windows')
      assert.equal(await page.getByRole('heading',{name:'Issued invoice',exact:true}).count(),1)
      assert.equal(await page.locator('input[name="period"]').inputValue(),'2026-10','Refresh keeps the due month rather than replacing it with the first service month')
      const upcomingText=await page.locator('main').innerText()
      assert.match(upcomingText,/USD 12,000\.00/)
      assert.match(upcomingText,/USD 6\.00/)
      assert.match(upcomingText,/September 1, 2026 – October 1, 2026/)
      assert.match(upcomingText,/October 1, 2026 – October 1, 2027/)
      assert.doesNotMatch(upcomingText,/Pinecrest|PRIVATE-|INTERNAL-/)
      await shot('branded-mixed-calendar')
      const foreign=invoices.find(row=>row.customer_id===customers[1])
      assert.equal((await page.goto(`${portalOrigin}/portal/invoices/${foreign.id}?session=${hosted.token}`)).status(),404,'PORT-005 branded host refuses foreign invoice')
      await shot('branded-foreign-refused')
      const security=[];page.on('console',message=>{if(message.type()==='error')security.push(message.text())})
      active=embedded
      await page.goto(appOrigin.replace('app.','other.')+'/billing');await page.waitForLoadState('networkidle')
      assert.ok(security.some(text=>text.includes('frame-ancestors')),'PORT-005 browser enforces signed parent origin')
      await shot('unapproved-parent-refused')
      security.length=0;active=hosted
      await page.goto(appOrigin+'/billing');await page.waitForLoadState('networkidle')
      assert.ok(security.some(text=>text.includes('frame-ancestors')),'PORT-005 hosted sessions cannot be framed')
      await shot('hosted-framing-refused')
      active=await issue(customers[1],'embedded')
      await page.goto(appOrigin+'/billing')
      await frame.getByRole('heading',{name:'Resumen de facturación',exact:true}).waitFor()
      assert.match(await frame.locator('main').innerText(),/Pinecrest Labs/)
      assert.doesNotMatch(await frame.locator('main').innerText(),/Northwind/)
      await shot('sample-app-spanish')
      await frame.getByRole('link',{name:'Solicitud de privacidad',exact:true}).click()
      const privacyResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/portal/privacy')
      await frame.getByRole('button',{name:'Solicitar eliminación de datos personales'}).click()
      const submitted=await privacyResponse
      assert.equal(submitted.status(),303,'PORT-005 embedded privacy form uses the ordinary scoped redirect')
      assert.equal(submitted.request().headers().origin,portalOrigin,'PORT-005 native form proves its exact origin')
      assert.ok(!submitted.request().headers().referer?.includes('session='),'PORT-005 native form never discloses a session in its referrer')
      await frame.getByRole('heading',{name:'Solicitud registrada.',exact:false}).first().waitFor()
      await shot('sample-app-spanish-privacy-requested')
      await h.advanceClock(new Date(hosted.expiresAt).toISOString())
      assert.equal((await page.goto(hosted.url)).status(),401,'PORT-005 branded expired session is refused at its exact deadline')
      await shot('branded-expired')
      const rejected=page.waitForResponse(response=>response.url().startsWith(portalOrigin+'/portal?')&&response.status()===401)
      active=embedded;await page.goto(appOrigin+'/billing');await rejected
      await shot('sample-app-expired')
    }
    console.log('PORT-005 real sample app, merchant branding, HTTPS host binding, customer isolation, parent CSP, privacy form and expiry passed at 1440/390')
  } finally { if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(scratch,{recursive:true,force:true}) }
}

return { portalEmbeddingFlow }
})()
export const { portalEmbeddingFlow } = portalEmbeddingJourneys
