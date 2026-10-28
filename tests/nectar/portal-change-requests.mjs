import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { applyPolicy } from './policy-helper.mjs'
import { publishPrice } from './price-helper.mjs'
import { file } from './harness.mjs'

export const harnessOptions = () => ({ assets: true })

export async function seedPortalChangeRecords(h, owner, customer) {
  const product = (await h.api('product.create', owner, { code: 'synthetic-nectar-portal-change', name: 'Team workspace' })).id
  const prices = []
  for (const [unit_amount, nickname] of [['30','Team standard'],['10','Team basic']]) prices.push((await publishPrice(h, owner, { product, kind: 'seat', unit_amount, nickname, taxable: false })).id)
  if (!customer) customer = (await h.api('customer.create', owner, { external_id: 'synthetic-nectar-portal-change', name: 'Cedar customer', billing_email: (await h.api('me', owner)).email })).id
  const subscription = (await h.api('subscription.create', owner, { customer, start_date: '2020-01-01', price: [prices[0]], quantity: ['10'] })).id
  return { product, prices, customer, subscription }
}

export async function seedPendingPortalChange(h, owner, customer) {
  const records = await seedPortalChangeRecords(h, owner, customer)
  await applyPolicy(h, owner, 'portal.change.policy', { prices: records.prices, minimum_seats: 5, pause_allowed: false })
  await h.api('portal.configure', owner, { hosts: [h.origin], parents: [] })
  const session = await h.api('portal.session.issue', owner, { customer: records.customer, origin: h.origin, audience: 'hosted' })
  const response = await h.raw(`/portal/changes/${records.subscription}?session=${session.token}`, { headers: { accept: 'application/json' } })
  assert.equal(response.status, 200)
  const options = await response.json()
  const body = { subscription: records.subscription, item: options.item, target_price: records.prices[1], quantity: 10, basis: options.basis, policy_revision: options.policy.revision, confirm: true }
  const submitted = await h.raw(`/portal/change.request?session=${session.token}`, { body })
  assert.equal(submitted.status, 200)
  return { ...records, session, body, request: await submitted.json() }
}

// One seeded sanity journey covers the customer request, merchant review and
// unsafe attempts through HTTP, then uses the actual forms without operator cookies.
export async function portalChangeRequestsFlow(h, owner) {
  await h.advanceClock('2026-10-28T09:00:00Z')
  const records = await seedPortalChangeRecords(h, owner), { customer, subscription, prices } = records
  const email = role => `${role}-${h.vars.OWNER_EMAIL}`
  await h.api('access.give', owner, { email: email('reviewer'), name: 'Policy reviewer', role: 'finance' })
  const finance = await h.signIn(email('reviewer'), { requested: true })
  const agent = { bearer: (await h.api('credential.issue', owner, { name: 'Request reader', scopes: ['prepare'] })).key }
  await h.api('portal.configure', owner, { hosts: [h.origin], parents: [] })
  const issue = id => h.api('portal.session.issue', owner, { customer: id, origin: h.origin, audience: 'hosted' })
  const session = await issue(customer)
  const options = async (who = session, sub = subscription, status = 200) => {
    const response = await h.raw(`/portal/changes/${sub}?session=${who.token}`, { headers: { accept: 'application/json' } })
    assert.equal(response.status, status)
    return status === 200 ? response.json() : response.text()
  }
  assert.deepEqual((await options()).targets, [], 'Unapproved choices are unavailable')
  const restriction = { prices, minimum_seats: 5, pause_allowed: false }
  for (const who of [finance, agent]) await h.api('portal.change.policy', who, restriction, 403)
  const prepared = await h.api('portal.change.policy', owner, restriction)
  assert.deepEqual((await options()).targets, [], 'Preparation grants no customer authority')
  await h.api('policy.decide', owner, { request: prepared.request, decision: 'approved', confirm_single: true }, 409)
  await h.api('policy.decide', agent, { request: prepared.request, decision: 'approved' }, 403)
  await h.api('policy.decide', finance, { request: prepared.request, decision: 'approved' })
  const terms = await h.api('contract.prepare', owner, { subscription, revision: (await h.api(`subscriptions/${subscription}`, owner)).revision, clause: 'synthetic-nectar-private-terms', commitments: [{ from: '2026-10-01', to: '2026-12-01', minimum: '400', taxable: false }] })
  await h.api('contract.decide', finance, { contract: terms.contract, decision: 'approved' })
  const bill = (await h.api('billrun.prepare', owner, { period: '2026-09' })).id
  const invoice = (await h.api(`runs/${bill}`, owner)).invoices.find(i => i.subscription_id === subscription)
  await h.api('invoice.approve', owner, { invoice: invoice.id, acknowledge: true })
  await h.api('invoice.finalise', owner, { invoice: invoice.id, issue_date: '2026-10-01' })
  const money = async () => {
    const sub = await h.api(`subscriptions/${subscription}`, owner)
    return { items: sub.items, changes: sub.changes, planChanges: sub.planChanges, lifecycle: sub.lifecycle, invoices: await h.api(`invoices/${invoice.id}`, owner), ledger: (await h.api(`customers/${customer}`, owner)).ledger }
  }
  const before = await money(), mailsBefore = h.mails.length
  const displayed = await options()
  assert.deepEqual(displayed.targets.map(p => p.id), prices.slice().sort())
  assert.equal(displayed.policy.minimumSeats, 5)
  assert.equal(displayed.policy.pauseAllowed, false)
  assert.doesNotMatch(JSON.stringify(displayed), /synthetic-nectar-private-terms|source_json|token_hash|prepared_by|prices_json/)
  const body = { subscription, item: displayed.item, target_price: prices[1], quantity: 10, basis: displayed.basis, policy_revision: displayed.policy.revision, confirm: true }
  const post = async (payload = body, status = 200, who = session, headers = {}) => {
    const response = await h.raw(`/portal/change.request?session=${who.token}`, { body: payload, headers })
    assert.equal(response.status, status, `Customer request returned ${response.status}`)
    return response.json()
  }
  for (const attempt of [{ ...body, confirm: false }, { ...body, customer: customer }, { ...body, operation: 'pause' }, { ...body, operation: 'cancel' }]) await post(attempt, 400)
  await post(body, 403, session, { origin: 'https://unapproved.example.test' })
  assert.equal((await post({ ...body, quantity: 4 }, 409)).error, 'seat_minimum')
  const foreignProduct = (await h.api('product.create', owner, { code: 'synthetic-nectar-foreign-plan', name: 'Private foreign plan' })).id
  const foreignPrice = (await h.api('price.create', owner, { product: foreignProduct, kind: 'seat', unit_amount: '1', taxable: false })).id
  await post({ ...body, target_price: foreignPrice }, 409)
  const other = (await h.api('customer.create', owner, { external_id: 'synthetic-nectar-foreign-customer', name: 'Foreign customer', billing_email: h.vars.OWNER_EMAIL })).id
  const foreign = await issue(other)
  await options(foreign, subscription, 404)
  await post(body, 404, foreign)
  await post({ ...body, item: 'synthetic-nectar-foreign-item' }, 404)
  const noSession = await h.raw('/portal/change.request', { cookie: owner, body })
  assert.equal(noSession.status, 401)
  await h.rejectAudit('portal.change.request')
  const failed = await h.raw(`/portal/change.request?session=${session.token}`, { body })
  assert.equal(failed.status, 500)
  assert.equal((await options()).requests.length, 0, 'Audit failure rolls back request custody')
  await h.rejectAudit(null)
  const requested = await Promise.all([post(), post(), post()])
  assert.equal(new Set(requested.map(r => r.id)).size, 1, 'Concurrent replay retains one request')
  assert.equal(requested[0].status, 'pending')
  assert.equal(requested[0].belowContractMinimum, true, 'A downgrade below the signed minimum waits for a person')
  const own = (await options()).requests
  assert.equal(own.length, 1)
  const status = await (await h.raw(`/portal/changes?session=${session.token}`, { headers: { accept: 'application/json' } })).json()
  assert.deepEqual(status.requests, requested.slice(0,1), 'Own request status is available independently of current change eligibility')
  assert.deepEqual(own[0], { ...requested[0], current: true })
  assert.deepEqual((await h.raw(`/portal/changes?session=${foreign.token}`, { headers: { accept: 'application/json' } })).status, 200)
  assert.deepEqual(await (await h.raw(`/portal/changes?session=${foreign.token}`, { headers: { accept: 'application/json' } })).json(), { subscriptions: [], requests: [] })
  const audits = (await h.api('audit', owner)).filter(r => r.action === 'portal.change.request')
  assert.equal(audits.length, 1)
  assert.match(audits[0].actor, /^customer:portal:/)
  assert.ok(!JSON.stringify(audits).includes(session.token), 'Audit stores no customer capability')
  assert.deepEqual(await money(), before, 'Requests and all refusals change no plan or money')
  assert.equal(h.mails.length, mailsBefore, 'Requests send no message')

  let browser
  const evidence = process.env.NECTAR_EVIDENCE_DIR
  if (evidence) await mkdir(evidence, { recursive: true })
  try {
    browser = await chromium.launch({ headless: true, ...(existsSync('/usr/bin/chromium') ? { executablePath: '/usr/bin/chromium' } : {}), args: ['--no-sandbox','--use-mock-keychain','--password-store=basic'] })
    const context = await browser.newContext({ viewport: { width: 1440, height: 950 } }), page = await context.newPage()
    const capture = async name => {
      if (!evidence) return
      for (const width of [1440,390]) {
        await page.setViewportSize({ width, height: 950 })
        await page.screenshot({ path: `${evidence}/${name}-${width}.png`, fullPage: true })
      }
      await page.setViewportSize({ width: 1440, height: 950 })
    }
    await page.goto(`${h.origin}/portal/changes/${subscription}?session=${session.token}`)
    await page.getByRole('heading', { name: 'Plan change requests' }).waitFor()
    assert.equal(await page.getByRole('button', { name: /pause|cancel/i }).count(), 0, 'Forbidden pause has no option')
    assert.match(await page.locator('main').innerText(), /Below|below your signed minimum/)
    await capture('english-pending')
    await page.getByLabel('Requested plan and unit price').selectOption(prices[0])
    await page.getByLabel('Seats', { exact: true }).fill('5')
    await page.getByRole('button', { name: 'Request downgrade review' }).click()
    await page.getByRole('heading', { name: 'Plan change requests' }).waitFor()
    assert.equal((await options()).requests.length, 2, 'The native form records the exact seat reduction for review')
    await capture('english-seat-request')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    const currentCustomer = await h.api(`customers/${customer}`, owner)
    await h.api('customer.update', owner, { customer, revision: currentCustomer.revision, name: currentCustomer.name, billing_email: currentCustomer.billing_email, language: 'es-US' })
    await page.reload()
    assert.equal(await page.locator('html').getAttribute('lang'), 'es-US')
    await page.getByRole('heading', { name: 'Solicitudes de cambio de plan' }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Solicitar revisión del cambio' }).count(), 1)
    assert.match(await page.locator('main').innerText(), /USD 30.00/)
    await capture('spanish-pending')
    const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 950 } })
    await ownerContext.addCookies(owner.split('; ').map(pair => { const [name,...value] = pair.split('='); return { name, value: value.join('='), url: h.origin } }))
    const operatorPage = await ownerContext.newPage()
    await operatorPage.goto(`${h.origin}/app/settings/portal-changes`)
    await operatorPage.getByRole('heading', { name: 'Merchant restrictions' }).waitFor()
    assert.equal(await operatorPage.getByRole('heading', { name: /Cedar customer/ }).count(), 2)
    if (evidence) for (const width of [1440,390]) { await operatorPage.setViewportSize({ width, height: 950 }); await operatorPage.screenshot({ path: `${evidence}/merchant-review-${width}.png`, fullPage: true }) }
    assert.equal((await h.api('portal-changes', finance)).requests.length, 2)
    await h.api('access.give', owner, { email: email('collections'), name: 'Collection operator', role: 'collections' })
    const collections = await h.signIn(email('collections'), { requested: true })
    await h.api('portal-changes', collections, undefined, 403)
    assert.equal((await h.raw('/app/settings/portal-changes', { cookie: collections })).status, 403)
  } finally { if (browser) await browser.close() }
  assert.deepEqual(await money(), before, 'The customer form also changes no plan or money')

  const stalePolicy = await options()
  await applyPolicy(h, owner, 'portal.change.policy', { prices: [prices[0]], minimum_seats: 7, pause_allowed: false })
  await post({ ...body, basis: stalePolicy.basis, policy_revision: stalePolicy.policy.revision }, 409)
  const staleTerms = await options()
  const additional = await h.api('contract.prepare', owner, { subscription, revision: (await h.api(`subscriptions/${subscription}`, owner)).revision, clause: 'synthetic-nectar-updated-terms', commitments: [{ from: '2026-12-01', to: '2027-01-01', minimum: '250', taxable: false }] })
  await h.api('contract.decide', finance, { contract: additional.contract, decision: 'approved' })
  await post({ ...body, basis: staleTerms.basis, policy_revision: staleTerms.policy.revision, target_price: prices[0], quantity: 7 }, 409)
  assert.ok((await options()).requests.every(r => !r.current), 'Old requests remain evidence, never renewed authority')
  const revoked = await issue(customer)
  await h.api('portal.session.revoke', owner, { session: revoked.id })
  await post(body, 401, revoked)
  const expires = await issue(customer)
  await h.advanceClock(new Date(expires.expiresAt).toISOString())
  await post(body, 401, expires)
  const fresh = await issue(customer)
  const erasure = await h.api('erasure.request', owner, { customer })
  await h.api('erasure.verify', owner, { request: erasure.id, reason: 'Independently checked signed customer records', evidence: file('synthetic-nectar-proof.txt','Synthetic independently verified request','text/plain') })
  const erased = await h.api('erasure.approve', owner, { request: erasure.id, confirm: true })
  assert.equal(erased.receipt.changed.find(r => r.kind === 'nc_portal_change_requests').records, 2)
  await post(body, 401, fresh)
  assert.equal((await h.api('portal-changes', owner)).requests.length, 0)
  assert.equal((await h.api(`invoices/${invoice.id}`, owner)).total_cents, before.invoices.total_cents, 'Erasure retains original financial facts')
  console.log('PORT-003 pending requests, exact source and approved restrictions, replay, native bilingual forms, refusal and erasure custody passed')
}
