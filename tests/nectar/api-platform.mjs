export { harnessOptions } from './sdk-typescript.mjs'
export const businessTimezone='UTC'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { API_DOORS, LIST_DOORS } from '../../src/nectar/doors.ts'
import { generateClient } from './openapi-client.mjs'

const ORIGINAL = '2026-10-01'

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

  assert.equal(spawnSync(process.execPath, ['scripts/api-fields.mjs', '--check'], { encoding: 'utf8' }).status, 0, 'DEV-002 action body fields are generated from the current handlers')
  assert.equal((await h.raw('/api/nectar/openapi')).status, 401, 'DEV-002 the document is for signed-in members and credentials')
  const document = await h.api('openapi', owner)
  assert.equal(document.openapi, '3.1.0')
  const latest = document.info.version
  assert.notEqual(latest, ORIGINAL)
  const operations = Object.values(document.paths).flatMap(Object.values)
  assert.equal(new Set(operations.map(o => o.operationId)).size, operations.length, 'DEV-002 operation ids are unique')
  assert.ok(operations.length >= API_DOORS.length + 80)
  assert.deepEqual(Object.keys(document.paths['/api/nectar/customer.create'].post.requestBody.content['application/json'].schema.properties).filter(k => ['external_id', 'name', 'billing_email'].includes(k)).sort(), ['billing_email', 'external_id', 'name'])
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
  const listPaths = { notes: `notes/customer/${customer}`, metadataObjects: 'objects/customer' }
  const rowsOf = body => Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : null
  const doors = []
  for (const [pattern, name] of API_DOORS) {
    const path = listPaths[name] ?? (/\(/.test(pattern) ? null : pattern.replace(/^\^|\$$/g, ''))
    if (!path || name === 'invoices') continue
    const response = await h.raw(`/api/nectar/${path}`, { cookie: owner })
    doors.push([name, path, response.ok ? rowsOf(await response.json()) : null, response.status])
  }
  assert.deepEqual(doors.filter(([name, , rows]) => !!rows !== LIST_DOORS.includes(name)).map(([name]) => name), [], 'DEV-002 a door pages exactly when it returns rows')
  const paged = []
  for (const [name, path, full, status] of doors) {
    if (status !== 200) continue
    if (!LIST_DOORS.includes(name)) { assert.equal((await h.api(`${path}?limit=1`, owner, undefined, 400)).error, 'not_a_list'); continue }
    if (full.length < 2) continue
    const limit = Math.min(100, Math.max(1, Math.ceil(full.length / 3) - (full.length % 3 === 0 ? 1 : 0)))
    const seen = []
    let page = await h.api(`${path}?limit=${limit}`, owner)
    for (let guard = 0; ; guard++) {
      assert.ok(page.data.length <= limit && guard < 10, `${name} page ${guard}`)
      seen.push(...page.data)
      if (!page.next_cursor) break
      page = await h.api(`${path}?limit=${limit}&cursor=${encodeURIComponent(page.next_cursor)}`, owner)
    }
    assert.ok(seen.length === full.length && seen.length > limit, `DEV-002 ${name} pages cover the list`)
    paged.push(name)
    assert.deepEqual(seen.map(r => r.id ?? r.seq), full.map(r => r.id ?? r.seq), `DEV-002 ${name} pages follow the list order once each`)
    const second = (await h.api(`${path}?limit=${limit}`, owner)).next_cursor
    assert.equal((await h.api(`${path}?limit=${limit + 1}&cursor=${encodeURIComponent(second)}`, owner, undefined, 400)).error, 'cursor_query_mismatch')
  }

  assert.ok(paged.length >= 7, `DEV-002 paged ${paged.join(' ')}`)

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
  assert.match(await h.page('/app/access', owner), /API version/)

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

// Public-door invoice-pagination checks share this retained journey module.
const invoicePaginationJourneys = await (async () => {
const { default: assert } = await import('node:assert/strict')

// DEV-002: traverse a real issued-invoice snapshot across a later issue.
async function invoicePaginationFlow(h, owner) {
  const customer = (await h.api('customer.create', owner, { external_id: 'DEV002-PAGES', name: 'Cedar Invoice Archive', billing_email: 'ap@cedar-archive.example' })).id
  const other = (await h.api('customer.create', owner, { external_id: 'DEV002-OTHER', name: 'Maple Invoice Archive', billing_email: 'ap@maple-archive.example' })).id
  const prepare = async (customerId, label) => {
    const charge = (await h.api('charge.add', owner, { customer: customerId, amount: '1.00', description: label, taxable: false, effective_date: '2026-01-05' })).charge
    return (await h.api('invoice.manual', owner, { customer: customerId, charges: [charge], service_date: '2026-01-05' })).id
  }
  const issue = async id => {
    await h.api('invoice.approve', owner, { invoice: id, acknowledge: true })
    await h.api('invoice.finalise', owner, { invoice: id, issue_date: '2026-01-05' })
  }
  // This draft predates every invoice in the snapshot. Creation time cannot
  // substitute for the immutable issue sequence when bounding later pages.
  const lateDraft = await prepare(customer, 'Issue after snapshot starts')
  const invoiceIds = []
  for (let index = 0; index < 250; index++) {
    const id = await prepare(customer, `Archive service ${index + 1}`)
    await issue(id)
    invoiceIds.push(id)
  }
  const foreignInvoice = await prepare(other, 'Separate customer service')
  await issue(foreignInvoice)
  const base = `invoices?customer=${encodeURIComponent(customer)}`
  const first = await h.api(`${base}&limit=100`, owner)
  assert.equal(first.data.length, 100)
  assert.equal(typeof first.next_cursor, 'string')
  assert.ok(first.next_cursor.length > 0)
  assert.ok(first.data.every(row => row.customer_id === customer && row.number))
  assert.ok(!first.data.some(row => row.id === lateDraft), 'drafts are absent from issued listings')
  assert.deepEqual((await h.api(base, owner)).data, first.data, 'default page size uses the same first 100 invoices')
  const unfiltered = await h.api('invoices', owner)
  assert.equal(unfiltered.data.length, 100)
  assert.ok(unfiltered.data.every(row => row.number), 'unfiltered listings also contain issued invoices')

  await issue(lateDraft)
  const secondPath = `${base}&limit=100&cursor=${encodeURIComponent(first.next_cursor)}`
  const second = await h.api(secondPath, owner)
  assert.equal(second.data.length, 100)
  assert.equal(typeof second.next_cursor, 'string')
  assert.ok(second.next_cursor.length > 0)
  assert.deepEqual(await h.api(secondPath, owner), second, 'replaying a cursor preserves the snapshot and order')
  const third = await h.api(`${base}&limit=100&cursor=${encodeURIComponent(second.next_cursor)}`, owner)
  assert.equal(third.data.length, 50)
  assert.equal(third.next_cursor, null)
  const snapshot = [...first.data, ...second.data, ...third.data]
  assert.equal(new Set(snapshot.map(row => row.id)).size, 250, 'no duplicate invoices between pages')
  assert.deepEqual(snapshot.map(row => row.id).sort(), [...invoiceIds].sort(), 'all original invoices appear exactly once, with no later issue')
  const ascending = snapshot[0].id === invoiceIds[0]
  assert.deepEqual(snapshot.map(row => row.id), ascending ? invoiceIds : [...invoiceIds].reverse(), 'pages preserve the immutable issue order')
  assert.equal(new Set(snapshot.map(row => row.number)).size, 250)
  assert.ok(snapshot.every(row => row.customer_id === customer))

  // A fresh traversal includes the later issue, while the saved cursor above
  // remains tied to its original snapshot.
  const fresh = await h.api(`${base}&limit=100`, owner)
  const freshSecond = await h.api(`${base}&limit=100&cursor=${encodeURIComponent(fresh.next_cursor)}`, owner)
  const freshThird = await h.api(`${base}&limit=100&cursor=${encodeURIComponent(freshSecond.next_cursor)}`, owner)
  assert.deepEqual([fresh.data.length, freshSecond.data.length, freshThird.data.length], [100, 100, 51])
  assert.equal(freshThird.next_cursor, null)
  const current = [...fresh.data, ...freshSecond.data, ...freshThird.data]
  assert.deepEqual(current.map(row => row.id).sort(), [...invoiceIds, lateDraft].sort())
  const issueOrder = [...invoiceIds, lateDraft]
  assert.deepEqual(current.map(row => row.id), ascending ? issueOrder : issueOrder.reverse(), 'the older draft sorts by its later issue, rather than draft creation')
  assert.equal(new Set(current.map(row => row.number)).size, 251, 'issued numbers remain unique across page boundaries')
  const foreign = await h.api(`invoices?customer=${encodeURIComponent(other)}&limit=100`, owner)
  assert.deepEqual(foreign.data.map(row => row.id), [foreignInvoice])
  assert.ok(foreign.data.every(row => row.customer_id === other))
  assert.equal(foreign.next_cursor, null)

  for (const limit of ['0', '101', '-1', '1.5', 'invalid'])
    await h.api(`${base}&limit=${limit}`, owner, undefined, 400)
  await h.api(`${base}&limit=100&cursor=not-a-cursor`, owner, undefined, 400)
  await h.api(`${base}&limit=100&cursor=${encodeURIComponent(first.next_cursor + 'tampered')}`, owner, undefined, 400)
  await h.api(`${base}&limit=50&cursor=${encodeURIComponent(first.next_cursor)}`, owner, undefined, 400)
  await h.api(`invoices?customer=${encodeURIComponent(other)}&limit=100&cursor=${encodeURIComponent(first.next_cursor)}`, owner, undefined, 400)
  await h.api(`invoices?limit=100&cursor=${encodeURIComponent(first.next_cursor)}`, owner, undefined, 400)
  await h.api(`${base}&limit=100`, undefined, undefined, 401)
  await h.api(secondPath, undefined, undefined, 401)
  await h.api('access.give', owner, { email: 'pagination-accountant@example.test', name: 'Archive Accountant', role: 'accountant' })
  const accountant = await h.signIn('pagination-accountant@example.test', { requested: true })
  assert.deepEqual(await h.api(secondPath, accountant), second, 'accountants can traverse the same issued snapshot')
  assert.deepEqual((await h.api(`${base}&limit=100`, accountant)).data, fresh.data)
  console.log('DEV-002 250 issued invoices traverse without gaps or duplicates; later issue, customer filters and bound cursors passed')
  return { customer, invoiceIds: [...invoiceIds, lateDraft] }
}

return { invoicePaginationFlow }
})()
export const { invoicePaginationFlow } = invoicePaginationJourneys
