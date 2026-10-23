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
