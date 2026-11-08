import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
const execute = promisify(execFile)
import { paymentLinksEdge } from './payment-links.mjs'
import { totp } from './mfa.mjs'
import { applyPolicy } from './policy-helper.mjs'

export const harnessOptions = () => ({ stripeFetch: paymentLinksEdge().fetch, stripeSecret: 'synthetic-nectar-1' })

// Compile the shipped sample, then use its actual client over HTTP and real D1.
export async function sdkTypescriptFlow(h, owner, { onState = async () => {} } = {}) {
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'sdks/typescript/tsconfig.json'], { stdio: 'inherit' })
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'examples/typescript-sdk/tsconfig.json'], { stdio: 'inherit' })
  const { NectarClient, NectarApiError } = await import('../../examples/typescript-sdk/dist/sdks/typescript/src/index.js')
  const { meterThenGate, openExistingCheckout, issueHostedPortal } = await import('../../examples/typescript-sdk/dist/examples/typescript-sdk/src/index.js')
  const api = (path, body, status) => h.api(path, owner, body, status)
  const apiDocument=await api('openapi'),latest=apiDocument.info.version
  const oldest=apiDocument.paths['/api/nectar/customers'].get.parameters.find(p=>p.name==='Nectar-Version').schema.enum.find(v=>v!==latest)
  const headers = { cookie: owner, origin: h.origin, 'CF-Connecting-IP': '127.0.0.1' }
  const client = new NectarClient({ baseUrl: h.origin, headers })
  const refused = (operation, status, error) => assert.rejects(operation, value => value instanceof NectarApiError && value.status === status && (!error || value.body.error === error))
  const read = (path, query) => client.request({ method: 'GET', path, query })
  const write = (path, body, idempotencyKey) => client.request({ method: 'POST', path, body, idempotencyKey })
  await h.advanceClock('2026-09-05T12:00:00Z')
  await api('business.configure', { ...(await api('business')), timezone: 'UTC' })
  const external = 'synthetic-nectar-300', feature = 'synthetic-nectar-300-access'
  const body = { external_id: external, name: 'Synthetic SDK customer', billing_email: [external, 'example.test'].join('@') }
  const customer = (await write('customer.create', body, 'synthetic-nectar-300-customer')).id
  const meter = await api('meter.create', { code: 'synthetic-nectar-300-requests', name: 'SDK requests', unit_label: 'requests' })
  const product = (await api('product.create', { code: 'synthetic-nectar-300-product', name: 'SDK metered access' })).id
  const price = (await api('price.create', { product, kind: 'unit', meter: meter.id, unit_amount: '2', taxable: false })).id
  await api('feature.grant', { product, feature })
  await applyPolicy(h, owner, 'feature.policy', { product, feature, meter: meter.id, quota: '5', quota_policy: 'hard' })
  const subscription = (await api('subscription.create', { customer, start_date: '2026-09-01', anchor_day: 1, price: [price] })).id
  const usageKey = await api('credential.issue', { name: 'Synthetic SDK metering', scopes: ['usage'] })
  const readerKey = await api('credential.issue', { name: 'Synthetic SDK reader', scopes: ['prepare'], api_version: oldest })
  const usageClient = new NectarClient({ baseUrl: h.origin, headers: { authorization: `Bearer ${usageKey.key}` } })
  const reader = new NectarClient({ baseUrl: h.origin, headers: { authorization: `Bearer ${readerKey.key}` } })
  const event = { event_id: 'synthetic-nectar-300-event', customer: external, meter: meter.code, quantity: '1.125001', occurred_at: '2026-09-02T12:00:00Z' }
  const input = { event, feature, date: '2026-09-05', idempotencyKey: 'synthetic-nectar-300-usage' }
  const first = await meterThenGate(usageClient, input, reader)
  assert.equal(first.usage.accepted, 1)
  assert.equal(first.allowed, true)
  assert.equal(first.decision.allowed, true)
  assert.equal(first.decision.paths[0].quota.used, '1.125001')
  assert.equal(first.decision.paths[0].quota.remaining, '3.874999')
  const cli = await execute(process.execPath, ['examples/typescript-sdk/dist/examples/typescript-sdk/src/cli.js'], {
    env: { ...process.env, NECTAR_BASE_URL: h.origin, NECTAR_BEARER_TOKEN: usageKey.key, NECTAR_READ_BEARER_TOKEN: readerKey.key,
      NECTAR_EVENT_ID: event.event_id, NECTAR_CUSTOMER: event.customer, NECTAR_METER: event.meter, NECTAR_QUANTITY: event.quantity,
      NECTAR_OCCURRED_AT: event.occurred_at, NECTAR_FEATURE: feature, NECTAR_DATE: input.date, NECTAR_IDEMPOTENCY_KEY: input.idempotencyKey },
  })
  assert.equal(JSON.parse(cli.stdout).outcome, 'allowed', 'The compiled CLI runs its real metering and feature gate over HTTP')
  const replay = await meterThenGate(usageClient, input, reader)
  assert.deepEqual(replay, first, 'The runnable sample reuses the same event and request identity')
  const duplicate = await usageClient.usage.submit({ events: [event] }, { idempotencyKey: 'synthetic-nectar-300-duplicate' })
  assert.deepEqual([duplicate.accepted, duplicate.duplicates, duplicate.rejected], [0, 1, 0])
  await refused(() => usageClient.usage.submit({ events: [{ ...event, quantity: '8' }] }, { idempotencyKey: input.idempotencyKey }), 409, 'idempotency_key_reused')
  const changed = await usageClient.usage.submit({ events: [{ ...event, quantity: '8' }] }, { idempotencyKey: 'synthetic-nectar-300-changed' })
  assert.deepEqual([changed.accepted, changed.rejected], [0, 1])
  const denied = await meterThenGate(usageClient, { ...input, event: { ...event, event_id: 'synthetic-nectar-301-event', quantity: '3.874999', occurred_at: '2026-09-01T12:00:00Z' }, idempotencyKey: 'synthetic-nectar-301-usage' }, reader)
  assert.equal(denied.allowed, false, 'The same real sample denies the feature at its returned hard quota')
  assert.equal(denied.decision.paths[0].quota.used, '5')
  await refused(() => reader.usage.submit({ events: [event] }, { idempotencyKey: 'synthetic-nectar-302-forbidden' }), 403)
  await h.advanceClock('2026-10-01T12:00:00Z')
  const run = await api('billrun.prepare', { period: '2026-09' })
  const invoice = (await api(`runs/${run.id}`)).invoices.find(row => row.customer_id === customer).id
  await api('invoice.approve', { invoice, acknowledge: true })
  await api('invoice.finalise', { invoice, issue_date: '2026-10-01' })
  assert.equal((await read(`invoices/${invoice}`)).total_cents, 1000, 'Five exact units are billed once at two dollars through ordinary billing')
  const payment = (await api('payment.record', { customer, amount: '8', received_on: '2026-10-02', method: 'bank_transfer', reference: 'synthetic-nectar-300-payment' })).payment
  await api('payment.allocate', { payment, invoice, amount: '8' })
  const credit = (await api('credit.issue', { invoice, amount: '2', reason: 'Synthetic SDK annotation fixture' })).credit
  const kinds = { customer, subscription, price, invoice, payment, 'credit-note': credit }
  const accountantMember = await api('access.give', { email: ['synthetic-nectar-300-accountant', 'example.test'].join('@'), name: 'SDK accountant', role: 'accountant' })
  const accountantCookie = await h.signIn(accountantMember.email, { requested: true })
  const accountant = new NectarClient({ baseUrl: h.origin, headers: { cookie: accountantCookie, origin: h.origin } })
  const metadata = Object.fromEntries([
    ['app_account_id', 'synthetic-nectar-300-app'], ['', ''], [' padded key ', '  café, "quote"\n第二行  '],
    ['__proto__', 'literal prototype key'], ['constructor', 'literal constructor key'], ['special&=+?#', 'value&=+?#'],
    ...Array.from({ length: 44 }, (_, i) => [`synthetic-nectar-${i}`, `Exact value ${i}`]),
  ])
  for (const [kind, record] of Object.entries(kinds)) {
    const before = await client.metadata.get({ kind, record })
    const input = { kind, record, revision: before.revision, metadata }
    const options = { idempotencyKey: `synthetic-nectar-300-metadata-${kind}` }
    const saved = await client.metadata.write(input, options)
    assert.equal(saved.revision, before.revision + 1)
    assert.deepEqual(saved.metadata, metadata)
    assert.deepEqual(await client.metadata.write(input, options), saved)
    const current = await client.metadata.get({ kind, record })
    assert.deepEqual(current.metadata, metadata)
    assert.equal(current.history.length, 1, 'Replayed replacements append no revision')
    for (const observer of [reader, accountant]) {
      assert.deepEqual((await observer.metadata.get({ kind, record })).metadata, metadata)
      await refused(() => observer.metadata.write({ ...input, revision: current.revision, metadata: {} }, { idempotencyKey: `synthetic-nectar-300-deny-${kind}` }), 403)
    }
    for (const filter of [{ key: '', value: '' }, { key: ' padded key ', value: metadata[' padded key '] }, { key: '__proto__', value: metadata.__proto__ }]) {
      const found = await reader.metadata.list({ kind, filter })
      assert.deepEqual(found.data.map(row => row.id), [record])
      assert.deepEqual(found.data[0].metadata, metadata)
    }
    assert.deepEqual((await reader.metadata.list({ kind, filter: { key: ' padded key ', value: metadata[' padded key '].trim() } })).data, [], 'Exact filters never trim or normalize strings')
    await refused(() => client.metadata.write({ ...input, metadata: {} }, { idempotencyKey: `synthetic-nectar-300-stale-${kind}` }), 409)
    await refused(() => client.metadata.write({ ...input, revision: current.revision, metadata: { ...metadata, excess: '51st pair' } }, { idempotencyKey: `synthetic-nectar-300-cap-${kind}` }), 400)
    assert.deepEqual(await client.metadata.get({ kind, record }), current, 'Forbidden, stale and oversized writes change neither map nor history')
  }
  const pinned = await reader.requestResult({ method: 'GET', path: ['objects', 'customer'].join('/'), query: { limit: 1 } })
  assert.equal(pinned.version, readerKey.api_version)
  assert.equal('nextCursor' in pinned.data, true)
  const document = await api('openapi')
  const override = await reader.requestResult({ method: 'GET', path: ['objects', 'customer'].join('/'), query: { limit: 1 }, headers: { 'Nectar-Version': document.info.version } })
  assert.equal(override.version, document.info.version)
  assert.equal('next_cursor' in override.data, true)
  assert.equal((await reader.requestResult({ method: 'GET', path: ['objects', 'customer'].join('/'), query: { limit: 1 } })).version, readerKey.api_version, 'A per-call version override does not repin the credential')
  await api('credential.revoke', { key: usageKey.id })
  await api('credential.revoke', { key: readerKey.id })
  await refused(() => reader.metadata.get({ kind: 'customer', record: customer }), 401)
  await refused(() => usageClient.usage.submit({ events: [event] }, { idempotencyKey: input.idempotencyKey }), 401)
  await api('access.end', { member: accountantMember.id })
  await refused(() => accountant.metadata.get({ kind: 'customer', record: customer }), 401)
  assert.equal((await read(`invoices/${invoice}`)).total_cents, 1000, 'Annotations and refused credentials preserve issued money')
  const factor = await api('mfa.totp.start', {})
  await api('mfa.totp.confirm', { factor: factor.factor, code: totp(factor.secret, Date.parse('2026-10-01T12:00:00Z')) })
  await api('tax.review', { revision: (await api('business')).revision })
  const checkoutProduct = (await api('product.create', { code: 'synthetic-nectar-300-checkout-product', name: 'SDK checkout product' })).id
  const checkoutPrice = (await api('price.create', { product: checkoutProduct, kind: 'flat', unit_amount: '9.99', taxable: false })).id
  const link = await client.paymentLinks.create({ name: 'Synthetic SDK checkout', price: [checkoutPrice], quantity: ['1'], months: 1, auto_renew: true, notice_days: 7, uplift_percent: '0', confirm: true, confirm_single: true }, { idempotencyKey: 'synthetic-nectar-300-checkout' })
  const checkout = await openExistingCheckout(client, { baseUrl: h.origin, link: link.id, ownerInvoked: true })
  assert.equal(new URL(checkout.url).pathname, link.path)
  const offer = await h.raw(new URL(checkout.url).pathname, { headers: { accept: 'application/json' } })
  assert.equal(offer.status, 200)
  assert.equal((await offer.json()).terms.totalCents, 999, 'The SDK destination opens actual catalog checkout terms')
  await onState({ h, owner, path: new URL(checkout.url).pathname, label: 'sdk-checkout' })
  await write('portal.configure', { hosts: [h.origin], parents: [] }, 'synthetic-nectar-300-portal-config')
  const portal = await issueHostedPortal(client, { customer, origin: h.origin, ownerInvoked: true, idempotencyKey: 'synthetic-nectar-300-portal' })
  const destination = new URL(portal.url)
  assert.equal((await h.raw(destination.pathname + destination.search)).status, 200, 'The SDK destination opens the own-customer portal')
  await onState({ h, owner, path: destination.pathname + destination.search, label: 'sdk-portal' })
  await client.portal.sessions.revoke({ session: portal.id }, { idempotencyKey: 'synthetic-nectar-300-portal-revoke' })
  assert.equal((await h.raw(destination.pathname + destination.search)).status, 401, 'Revoked portal capability cannot be used through its SDK destination')
  const deniedClient = new NectarClient({ baseUrl: h.origin, headers: { origin: h.origin } })
  await refused(() => deniedClient.portal.sessions.issue({ customer, origin: h.origin, audience: 'hosted' }, { idempotencyKey: 'synthetic-nectar-300-portal-deny' }), 401)
  const erasedBody = { external_id: 'synthetic-nectar-303', name: 'Synthetic erased SDK person', billing_email: ['synthetic-nectar-303', 'example.test'].join('@') }
  const erased = (await write('customer.create', erasedBody, 'synthetic-nectar-303-customer')).id
  const erasure = await api('erasure.request', { customer: erased })
  const message = h.mails.at(-1)
  const erasurePath = new URL(`${message.text ?? ''} ${message.html ?? ''}`.match(/https?:\/\/[^\s"<]+\/erase\/[a-f0-9]{64}/)[0]).pathname
  assert.equal((await h.raw(erasurePath, { form: new URLSearchParams({ confirm: 'yes' }) })).status, 200)
  await api('erasure.approve', { request: erasure.id, confirm: true })
  const erasedReplay = await write('customer.create', erasedBody, 'synthetic-nectar-303-customer')
  assert.equal(erasedReplay.id, erased)
  for (const personal of Object.values(erasedBody)) assert.equal(JSON.stringify(erasedReplay).includes(personal), false, 'Replaying a captured SDK write cannot expose or restore an erased identity')
  console.log('TypeScript SDK sample: exact metering, deduplication, quota gate, version pin, six-kind metadata and current authority passed')
}
