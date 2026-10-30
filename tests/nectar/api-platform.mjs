export { harnessOptions } from './sdk-typescript.mjs'
export const businessTimezone='UTC'
import assert from 'node:assert/strict'
import { generateClient } from './openapi-client.mjs'

// DEV-002: the published OpenAPI document generates a working client; every
// write replays by Idempotency-Key; every list door pages by cursor; and dated
// versions follow the credential unless a request header names one.
export async function apiPlatformFlow(h, owner) {
  // Dispatch accepts registered own names only, even for an ordinary member.
  // Keep bodies and planted binding values out of assertion diagnostics.
  await h.api('access.give', owner, { email: 'dispatch-member@example.test', name: 'Dispatch Member', role: 'developer' })
  const member = await h.signIn('dispatch-member@example.test', { requested: true })
  const unknown = await h.raw('/api/nectar/unknown.dispatch', { cookie: member, body: {} })
  const unknownBody = await unknown.text()
  assert.equal(unknown.status, 404)
  assert.ok(unknownBody === '{"error":"not_found"}', 'unknown action has the stable refusal')
  const refusals = []
  for (const name of ['constructor', '__proto__', 'hasOwnProperty']) {
    const response = await h.raw(`/api/nectar/${name}`, { cookie: member, body: {} })
    const body = await response.text()
    const privateContent = ['SESSION_SECRET', 'SETUP_TOKEN', 'MAIL_API_KEY', 'MFA_KEY', 'PORTAL_KEY']
      .some(key => body.includes(key) || body.includes(h.vars[key]))
    refusals.push({ name, status: response.status, unknown: body === unknownBody, privateContent })
  }
  assert.ok(refusals.every(r => r.status === unknown.status && r.unknown && !r.privateContent),
    `inherited action names use the unknown-name refusal: ${JSON.stringify(refusals)}`)
  const registered = await h.raw('/api/nectar/notification.preferences', { cookie: member, body: { mentions: true } })
  assert.equal(registered.status, 200, 'registered action still executes for the member')
  assert.ok((await registered.json()).preferences?.mentions === true, 'registered action returns its saved result')
  console.log('Dispatch sanity passed: member constructor, __proto__, hasOwnProperty refused; registered action works; no binding content')

  assert.equal((await h.raw('/api/nectar/openapi')).status, 401, 'DEV-002 the document is for signed-in members and credentials')
  const document = await h.api('openapi', owner)
  const latest = document.info.version
  const ORIGINAL = document.paths['/api/nectar/customers'].get.parameters.find(p=>p.name==='Nectar-Version').schema.enum.find(version=>version!==latest)
  assert.ok(ORIGINAL,'The public document offers backward-compatible negotiation')
  assert.notEqual(latest, ORIGINAL)
  const operations = Object.values(document.paths).flatMap(Object.values)
  assert.equal(new Set(operations.map(o => o.operationId)).size, operations.length, 'DEV-002 operation ids are unique')
  for (const operation of operations.filter(o => o.requestBody)) assert.ok(operation.parameters.some(p => p.name === 'Idempotency-Key'), `${operation.operationId} documents Idempotency-Key`)

  // The full billing cycle through the generated client, each write sent twice.
  const client = generateClient(document, { headers: { cookie: owner, origin: h.origin, 'CF-Connecting-IP': '127.0.0.1' } })
  let keys = 0
  const write = async (operation, body) => {
    const key = `dev002-${operation}-${++keys}`
    const first = await client[operation]({ body, 'Idempotency-Key': key })
    assert.equal(first.status, 200, `${operation}: ${JSON.stringify(first.body)}`)
    assert.equal(first.headers.get('idempotent-replayed'), null)
    const again = await client[operation]({ body, 'Idempotency-Key': key })
    assert.equal(again.status, 200, `${operation} replay`)
    assert.equal(again.headers.get('idempotent-replayed'), 'true', `DEV-002 ${operation} replays the original result`)
    assert.deepEqual(again.body, first.body, `DEV-002 ${operation} replay is the original result`)
    return first.body
  }
  const read = async (operation, args) => {
    const response = await client[operation](args)
    assert.equal(response.status, 200, `${operation}: ${JSON.stringify(response.body)}`)
    return response.body
  }
  const customer = (await write('customerCreate', { external_id: 'DEV002-CLIENT', name: 'Spruce Client Works', billing_email: 'ap@spruce-client.example' })).id
  const firBody = { external_id: 'DEV002-CLIENT-2', name: 'Fir Client Works', billing_email: 'ap@fir-client.example' }
  const firCreated = await write('customerCreate', firBody), fir = firCreated.id
  assert.equal(firCreated.external_id, firBody.external_id)
  const product = (await write('productCreate', { code: 'dev002-platform', name: 'Generated client platform' })).id
  const price = (await write('priceCreate', { product, kind: 'flat', unit_amount: '120', taxable: false })).id
  const subscription = (await write('subscriptionCreate', { customer, start_date: '2026-08-01', price: [price] })).id
  const run = (await write('billrunPrepare', { period: '2026-08' })).id
  const invoice = (await read('getRun', { id: run })).invoices.find(row => row.customer_id === customer)
  await write('invoiceApprove', { invoice: invoice.id, acknowledge: true })
  await write('invoiceFinalise', { invoice: invoice.id, issue_date: invoice.period_end })
  for (const [index, amount] of [['1', '70'], ['2', '50']]) {
    const payment = (await write('paymentRecord', { customer, amount, received_on: '2026-09-02', method: 'check', reference: `DEV002-CHK-${index}`, evidence: 'Generated client deposit' })).payment
    await write('paymentAllocate', { payment, invoice: invoice.id, amount })
  }
  await write('billrunPrepare', { period: '2026-09' })
  for (const title of ['Confirm remittance address', 'Send W-9']) await write('taskCreate', { customer, invoice: invoice.id, title, due_date: '2026-09-30' })
  const issued = await read('getInvoice', { id: invoice.id })
  assert.equal(issued.status, 'issued')
  assert.equal(issued.total_cents, 12000)
  const ledger = (await read('getCustomer', { id: customer })).ledger
  assert.ok(['DEV002-CHK-1', 'DEV002-CHK-2'].every(reference => JSON.stringify(ledger).includes(reference)))
  // No second record from any replay.
  assert.equal((await read('getCustomers')).filter(c => c.external_id.startsWith('DEV002-CLIENT')).length, 2)
  assert.deepEqual((await read('getRuns')).map(r => r.period).sort(), ['2026-08', '2026-09'])
  assert.equal((await read('getPayments')).filter(p => p.reference.startsWith('DEV002-CHK-')).length, 2)
  assert.equal((await read('getTasks')).length, 2)
  assert.equal((await read('getInvoices', { customer })).data.length, 1)
  // A key belongs to one request: different input under it is refused, and it stays usable by no one else's record.
  const reused = await client.customerCreate({ body: { external_id: 'DEV002-OTHER', name: 'Other', billing_email: 'ap@other.example' }, 'Idempotency-Key': 'dev002-customerCreate-1' })
  assert.deepEqual([reused.status, reused.body.error], [409, 'idempotency_key_reused'])
  assert.equal((await client.customerCreate({ body: {}, 'Idempotency-Key': 'x'.repeat(256) })).status, 400)
  // A failed write releases its key: the corrected request runs once.
  const failed = await client.customerCreate({ body: { external_id: 'DEV002-RETRY', name: 'Retry Works' }, 'Idempotency-Key': 'dev002-retry' })
  assert.deepEqual([failed.status, failed.body.error], [400, 'missing_billing_email'])
  const retried = await client.customerCreate({ body: { external_id: 'DEV002-RETRY', name: 'Retry Works', billing_email: 'ap@retry.example' }, 'Idempotency-Key': 'dev002-retry' })
  assert.deepEqual([retried.status, retried.headers.get('idempotent-replayed')], [200, null])

  // Every list door pages by cursor; doors that are not lists refuse paging.
  const owned = await h.api('credential.issue', owner, { name: 'DEV-002 original', scopes: ['prepare'], api_version: ORIGINAL })
  const current = await h.api('credential.issue', owner, { name: 'DEV-002 latest', scopes: ['prepare'] })
  await h.api('note.add', owner, { kind: 'customer', record: customer, body: 'Generated client note one' })
  await h.api('note.add', owner, { kind: 'customer', record: customer, body: 'Generated client note two' })
  // Traverse populated public customer, payment and note lists. Internal
  // route inventories do not define the public pagination contract.
  for (const path of ['customers','payments',`notes/customer/${customer}`]) {
    const full=await h.api(path,owner),seen=[]
    let page=await h.api(`${path}?limit=1`,owner)
    while(true) {
      seen.push(...page.data)
      if(!page.next_cursor)break
      page=await h.api(`${path}?limit=1&cursor=${encodeURIComponent(page.next_cursor)}`,owner)
      assert.ok(seen.length<=full.length,'Public cursor traversal terminates without repetition')
    }
    assert.deepEqual(seen.map(r=>r.id),full.map(r=>r.id),'Every public row appears in order exactly once')
  }

  // Dated versions: pinned per credential, overridden per call by the header.
  assert.deepEqual([owned.api_version, current.api_version], [ORIGINAL, latest])
  const cursorField = async (bearer, version) => {
    const response = await h.raw('/api/nectar/customers?limit=1', { bearer, headers: version ? { 'nectar-version': version } : {} })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(response.headers.get('nectar-version'), version ?? (bearer === owned.key ? ORIGINAL : latest))
    assert.equal(body.data.length, 1)
    return Object.keys(body).filter(k => /cursor/i.test(k))
  }
  assert.deepEqual(await cursorField(owned.key), ['nextCursor'], 'DEV-002 an original-version credential reads the original field name')
  assert.deepEqual(await cursorField(current.key), ['next_cursor'], 'DEV-002 a latest-version credential reads the renamed field')
  assert.deepEqual(await cursorField(owned.key, latest), ['next_cursor'], 'DEV-002 a header overrides the pinned version for one call')
  assert.deepEqual(await cursorField(current.key, ORIGINAL), ['nextCursor'], 'DEV-002 a header names an earlier version for one call')
  assert.deepEqual(await cursorField(owned.key), ['nextCursor'], 'DEV-002 the override lasted one call')
  assert.equal((await (await h.raw('/api/nectar/customers', { bearer: owned.key, headers: { 'nectar-version': '2020-01-01' } })).json()).error, 'unknown_api_version')
  assert.equal(Object.keys(await h.api('invoices?limit=1', owner)).includes('next_cursor'), true, 'DEV-002 members read the latest version')
  await h.api('credential.version', owner, { key: owned.id, api_version: latest })
  const repinned = await h.raw('/api/nectar/customers?limit=1', { bearer: owned.key })
  assert.deepEqual([repinned.headers.get('nectar-version'), Object.keys(await repinned.json()).includes('next_cursor')], [latest, true], 'DEV-002 a repinned credential answers in its new version')
  assert.equal((await h.api('credentials', owner)).find(k => k.id === owned.id).api_version, latest)
  assert.ok((await h.api('audit', owner)).some(e => e.action === 'credential.version' && e.subject === owned.id))
  await h.page('/app/access', owner)

  // GOV-005: a stored result keeps none of an erased customer's personal values.
  await h.api('erasure.request', owner, { customer: fir })
  const mail = h.mails.at(-1)
  const link = new URL(`${mail.text ?? ''} ${mail.html ?? ''}`.match(/https?:\/\/[^\s"<]+\/erase\/[a-f0-9]{64}/)[0]).pathname
  assert.equal((await h.raw(link, { form: new URLSearchParams({ confirm: 'yes' }) })).status, 200)
  await h.api('erasure.approve', owner, { request: (await h.api('erasures', owner)).find(row => row.customer_id === fir).id, confirm: true })
  const replay = await client.customerCreate({ body: firBody, 'Idempotency-Key': 'dev002-customerCreate-2' })
  assert.deepEqual([replay.status, replay.headers.get('idempotent-replayed')], [200, 'true'])
  assert.equal(replay.body.id, fir)
  assert.ok(!/Fir Client Works|fir-client\.example|DEV002-CLIENT-2/.test(JSON.stringify(replay.body)), 'DEV-002 GOV-005 erasure redacts stored results')
}
