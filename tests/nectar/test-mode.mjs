import assert from 'node:assert/strict'
import { applyPolicy } from './policy-helper.mjs'
import { publishPrice } from './price-helper.mjs'

export const sandboxTimezone = ['America', 'Los_Angeles'].join('/')
export const harnessOptions = () => ({ localTime: '2026-10-01T12:00:00Z' })
const address = n => `synthetic-nectar-${n}${String.fromCharCode(64)}example.test`
const round = (n, d) => Number((n + d / 2n) / d)

// One native sanity journey: reviewed copy, independent annual clocks, exact
// cents, source isolation and both sides of the authority boundary.
export async function testModeFlow(h, owner, { onState = async () => {}, copyCatalog, createSecond, advanceSecond } = {}) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: 'CA', tax_mode: 'flat_rate', tax_rate: '7.25', tax_note: 'Synthetic reviewed sandbox basis' })
  const product = async n => (await api('product.create', { code: `synthetic-nectar-${n}`, name: `Synthetic plan ${n}` })).id
  const flatProduct = await product(810), seatProduct = await product(811), arrearsProduct = await product(812)
  const flat = (await publishPrice(h, owner, { product: flatProduct, kind: 'flat', unit_amount: '1200.01', taxable: true, billing_interval: 'annual', billing_timing: 'advance' })).id
  const seat = (await publishPrice(h, owner, { product: seatProduct, kind: 'seat', unit_amount: '19.995', taxable: true, billing_interval: 'annual', billing_timing: 'advance' })).id
  const arrears = (await publishPrice(h, owner, { product: arrearsProduct, kind: 'flat', unit_amount: '24.01', taxable: false, billing_interval: 'annual', billing_timing: 'arrears' })).id
  const excludedProduct = await product(813)
  const excluded = (await publishPrice(h, owner, { product: excludedProduct, kind: 'flat', currency: 'EUR', unit_amount: '10', taxable: false })).id
  const unreviewed = (await api('sandbox')).source
  assert.equal(unreviewed.copyReady, false)
  await api('sandbox.catalog.copy', { source_fingerprint: unreviewed.sourceFingerprint, confirm: true }, 409)
  await api('tax.review', { revision: (await api('business')).revision })
  const staleSource = (await api('sandbox')).source
  const laterProduct = await product(814)
  await publishPrice(h, owner, { product: laterProduct, kind: 'flat', unit_amount: '1', taxable: false })
  assert.equal((await api('sandbox.catalog.copy', { source_fingerprint: staleSource.sourceFingerprint, confirm: true }, 409)).error, 'sandbox_source_changed')
  const source = (await api('sandbox')).source
  assert.ok(source.excluded.some(p => p.id === excluded), 'Unsupported live currency is disclosed, not copied')
  await api('sandbox.catalog.copy', { source_fingerprint: source.sourceFingerprint, confirm: false }, 400)
  await h.rejectAudit('sandbox.catalog.copy')
  await api('sandbox.catalog.copy', { source_fingerprint: source.sourceFingerprint, confirm: true }, 500)
  await h.rejectAudit()
  assert.equal((await api('sandbox')).catalogs.length, 0, 'Failed audit leaves no partial copy')
  const copied = await (copyCatalog ? copyCatalog(source) : api('sandbox.catalog.copy', { source_fingerprint: source.sourceFingerprint, confirm: true }))
  assert.equal((await api('sandbox.catalog.copy', { source_fingerprint: source.sourceFingerprint, confirm: true })).id, copied.id, 'Copy replay reuses the immutable source')
  const catalog = (await api('sandbox')).catalogs.find(c => c.id === copied.id)
  assert.equal(catalog.sourceFingerprint, source.sourceFingerprint)
  assert.equal(catalog.configuration.timezone, sandboxTimezone)
  assert.equal(catalog.configuration.tax.rate, '7.25')
  const copiedPrice = id => catalog.prices.find(p => p.sourceId === id).id
  assert.ok(catalog.prices.every(p => p.id !== p.sourceId && p.id !== excluded))
  const start = '2027-01-31T08:00:00Z'
  const fields = { catalog: copied.id, label: 'Synthetic sandbox one', clock: start, trial_end: '2027-02-15', price: [copiedPrice(flat), copiedPrice(seat), copiedPrice(arrears)], quantity: ['1', '3', '1'] }
  const first = await api('sandbox.customer.create', fields)
  const secondFields = { ...fields, label: 'Synthetic sandbox two', price: [copiedPrice(seat)], quantity: ['2'] }
  const secondUrl = await (createSecond ? createSecond(secondFields) : h.submit('sandbox.customer.create', owner, secondFields, '/app/settings/test-mode/{id}'))
  assert.equal(secondUrl.searchParams.get('error'), null)
  const secondId = secondUrl.pathname.split('/').at(-1)
  const read = id => api(`sandbox/customers/${id}`)
  const initialSecond = await read(secondId)
  assert.equal((await read(first.id)).previews.length, 0, 'Trial produces no premature billed service')
  // Live catalog changes neither mutate nor invalidate an existing copy.
  await publishPrice(h, owner, { product: flatProduct, kind: 'flat', unit_amount: '2400', taxable: true, billing_interval: 'annual', billing_timing: 'advance' })
  await api('price.retire', { price: flat })
  await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: 'CA', tax_mode: 'flat_rate', tax_rate: '5', tax_note: 'Synthetic later live tax basis' })
  await api('tax.review', { revision: (await api('business')).revision })
  const live = (await api('customer.create', { external_id: 'synthetic-nectar-815', name: 'Synthetic live customer', billing_email: address(815) })).id
  const liveSub = (await api('subscription.create', { customer: live, start_date: '2026-10-01', trial_end: '2026-10-10', price: [seat], quantity: ['2'] })).id
  const financialCustomer = (await api('customer.create', { external_id: 'synthetic-nectar-816', name: 'Synthetic live billing', billing_email: address(816) })).id
  const financialSub = (await api('subscription.create', { customer: financialCustomer, start_date: '2026-10-01', price: [seat], quantity: ['1'] })).id
  const run = await api('billrun.prepare', { period: '2026-10' })
  const invoice = (await api(`runs/${run.id}`)).invoices.find(i => i.subscription_id === financialSub)
  assert.ok(invoice)
  await api('invoice.approve', { invoice: invoice.id, acknowledge: true })
  await api('invoice.finalise', { invoice: invoice.id, issue_date: '2026-10-01' })
  const liveState = async () => Promise.all(['business', 'catalog', 'customers', `subscriptions/${liveSub}?include_state=true`, `invoices/${invoice.id}`, 'invoices', 'payments', 'runs', 'proposals', 'notices', 'webhooks'].map(path => api(path)))
  const untouched = await liveState()
  const mailbox = address(817)
  await api('access.give', { email: mailbox, name: 'Synthetic developer', role: 'developer' })
  const developer = await h.signIn(mailbox, { requested: true }), beforeMail = h.mails.length
  await onState({ label: 'copied-catalog', path: '/app/settings/test-mode', owner, first: first.id, second: secondId })
  const firstAdvance = { customer: first.id, revision: 1, clock: '2027-02-15T08:00:00Z', confirm: true }
  assert.equal((await h.api('sandbox.clock.advance', developer, firstAdvance)).addedPreviews, 1)
  let state = await read(first.id)
  assert.equal(state.previews[0].dueDate, '2027-02-15')
  const expected = (unitMicros, quantity, days, denominator) => round(BigInt(unitMicros) * BigInt(quantity) * BigInt(days) * 100n, 1_000_000n * BigInt(denominator))
  const firstFixed = expected(1_200_010_000, 1, 350, 365), firstSeats = expected(19_995_000, 3, 350, 365)
  const checkRating = (preview, fixed, seats, other) => {
    const lines = preview.rating.lines
    if (fixed !== null) assert.equal(lines.find(l => l.priceId === copiedPrice(flat)).amountCents, fixed)
    if (seats !== null) assert.equal(lines.find(l => l.priceId === copiedPrice(seat)).amountCents, seats)
    if (other !== null) assert.equal(lines.find(l => l.priceId === copiedPrice(arrears)).amountCents, other)
    const subtotal = (fixed ?? 0) + (seats ?? 0) + (other ?? 0), tax = round(BigInt((fixed ?? 0) + (seats ?? 0)) * 725n, 10000n)
    assert.equal(preview.rating.subtotalCents, subtotal)
    assert.equal(preview.rating.taxCents, tax)
    assert.equal(preview.rating.totalCents, subtotal + tax)
    assert.deepEqual(preview.rating.exceptions, [])
    assert.equal(preview.inputs.timezone, sandboxTimezone)
    assert.equal(preview.inputs.tax.rate, '7.25', 'Saved copy keeps reviewed tax after a live change')
  }
  checkRating(state.previews[0], firstFixed, firstSeats, null)
  assert.deepEqual(state.previews[0].period, { start: '2027-02-15', end: '2028-01-31' })
  assert.equal((await h.api('sandbox.clock.advance', developer, firstAdvance, 409)).error, 'sandbox_clock_stale')
  const annual = { customer: first.id, revision: 2, clock: '2028-02-29T08:00:00Z', confirm: true }
  await h.rejectAudit('sandbox.clock.advance')
  await h.api('sandbox.clock.advance', developer, annual, 500)
  await h.rejectAudit()
  assert.deepEqual(await read(first.id), state, 'Clock and all due previews roll back together on audit failure')
  const concurrent = await Promise.all([h.raw('/api/nectar/sandbox.clock.advance', { cookie: developer, body: annual }), h.raw('/api/nectar/sandbox.clock.advance', { cookie: developer, body: annual })])
  assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 409], 'Exactly one concurrent revision wins')
  await Promise.all(concurrent.map(r => r.text()))
  state = await read(first.id)
  assert.equal(state.clock_at, Date.parse(annual.clock))
  assert.equal(state.revision, 3)
  assert.equal(state.history.length, 3)
  assert.equal(state.previews.length, 3, 'One stub advance, one annual renewal and one arrears preview')
  const annualAdvance = state.previews.find(p => p.dueDate === '2028-01-31' && p.inputs.billing.terms.timing === 'advance')
  const annualArrears = state.previews.find(p => p.dueDate === '2028-01-31' && p.inputs.billing.terms.timing === 'arrears')
  checkRating(annualAdvance, 120001, 5999, null)
  checkRating(annualArrears, null, null, expected(24_010_000, 1, 350, 365))
  assert.deepEqual(annualAdvance.period, { start: '2028-01-31', end: '2029-01-31' })
  assert.deepEqual(await read(secondId), initialSecond, 'Another sandbox customer has its own unchanged clock and previews')
  const advanceFields = { customer: secondId, revision: '1', clock: '2027-02-15T08:00:00Z', confirm: 'yes' }
  const formAdvance = await (advanceSecond ? advanceSecond(advanceFields, developer) : h.submit('sandbox.clock.advance', developer, advanceFields, `/app/settings/test-mode/${secondId}`))
  assert.equal(formAdvance.searchParams.get('error'), null)
  const second = await read(secondId)
  assert.equal(second.previews[0].rating.totalCents, expected(19_995_000, 2, 350, 365) + round(BigInt(expected(19_995_000, 2, 350, 365)) * 725n, 10000n))
  const stableFirst = await read(first.id), stableSecond = await read(secondId)
  await h.api('sandbox.clock.advance', developer, { ...annual, revision: 3, clock: start }, 409)
  await h.api('sandbox.clock.advance', developer, { ...annual, customer: live, revision: 1 }, 404)
  await api('sandbox.customer.create', { ...fields, price: [seat], quantity: ['1'] }, 404)
  await api('sandbox.customer.create', { ...fields, customer: live }, 400)
  await api('subscription.create', { customer: first.id, start_date: '2027-01-31', price: [seat] }, 404)
  await api('subscription.create', { customer: live, start_date: '2026-10-01', price: [copiedPrice(seat)] }, 404)
  await api(`customers/${first.id}`, undefined, 404)
  for (const action of ['billrun.prepare', 'invoice.finalise', 'payment.record', 'credit.issue', 'subscription.create', 'collection.confirm', 'business.configure']) await h.api(action, developer, {}, 403)
  const credential = await api('credential.issue', { name: 'Synthetic sandbox refusal', scopes: ['prepare'] })
  for (const action of ['sandbox.catalog.copy', 'sandbox.customer.create', 'sandbox.clock.advance']) await h.api(action, { bearer: credential.key }, {}, 403)
  await h.api('sandbox', { bearer: credential.key }, undefined, 403)
  await api('credential.revoke', { key: credential.id })
  await h.api('sandbox', { bearer: credential.key }, undefined, 401)
  await onState({ label: 'thirteen-month-clock', path: `/app/settings/test-mode/${first.id}`, owner, first: first.id, second: secondId })
  assert.deepEqual(await read(first.id), stableFirst)
  assert.deepEqual(await read(secondId), stableSecond)
  // Reload the Worker at the same production instant; only public sandbox
  // commands advanced customer time, and D1 must retain every saved result.
  await h.advanceClock(harnessOptions().localTime)
  assert.deepEqual(await read(first.id), stableFirst, 'Worker reload retains the persisted sandbox clock and immutable previews')
  assert.deepEqual(await read(secondId), stableSecond)
  const nowLive = await liveState()
  assert.deepEqual(nowLive, untouched, 'Live catalog, customers, subscriptions, invoices, money, jobs, notices and production clock stay unchanged')
  assert.equal(nowLive[3].state, 'trialing', 'Sandbox time does not end a production trial')
  // Only ordinary access and sign-in messages were added, never sandbox notices.
  assert.equal(h.mails.length, beforeMail, 'Sandbox operations send no mail')
  const member = (await api('members')).find(m => m.email === mailbox)
  await api('access.end', { member: member.id })
  await h.api('sandbox.clock.advance', developer, { ...annual, revision: 3, clock: '2028-03-01T08:00:00Z' }, 401)
  assert.deepEqual(await read(first.id), stableFirst, 'Ended membership cannot advance a retained sandbox')
  // Copied catalog names can contain personal text. Ordinary erasure must
  // withdraw that text from sandbox copies without losing prices or cents.
  const privateName = catalog.prices.find(p => p.sourceId === flat).label
  const person = (await api('customer.create', { external_id: 'synthetic-nectar-818', name: privateName, billing_email: address(818) })).id
  const namedSandbox = await api('sandbox.customer.create', { ...fields, label: privateName })
  const erasure = await api('erasure.request', { customer: person })
  const message = h.mails.findLast(m => [m.to].flat().includes(address(818)))
  const link = new URL(`${message.text ?? ''} ${message.html ?? ''}`.match(/https?:\/\/[^\s"<]+\/erase\/[a-f0-9]{64}/)[0])
  assert.equal((await h.raw(link.pathname, { form: new URLSearchParams({ confirm: 'yes' }) })).status, 200)
  await api('erasure.approve', { request: erasure.id, confirm: true })
  const redacted = await read(first.id)
  assert.ok(!JSON.stringify(redacted).includes(privateName), 'An erased person is absent from copied price labels and saved preview descriptions')
  assert.ok(!(await read(namedSandbox.id)).label.includes(privateName), 'Synthetic customer labels participate in incidental identity erasure')
  assert.deepEqual(redacted.previews.map(p => p.rating.totalCents), stableFirst.previews.map(p => p.rating.totalCents), 'Erasure preserves exact sandbox preview money')
  await api('sandbox.catalog.copy', { source_fingerprint: source.sourceFingerprint, confirm: true }, 409)
  await api('sandbox.clock.advance', { customer: person, revision: 1, clock: annual.clock, confirm: true }, 404)
  await onState({ label: 'privacy-redacted-clock', path: `/app/settings/test-mode/${first.id}`, owner, first: first.id, second: secondId })
  console.log('DEV-004 testModeFlow: reviewed immutable copy, independent thirteen-month annual previews, exact cents, atomic stale and concurrent refusal, live isolation and current developer authority passed')
}
