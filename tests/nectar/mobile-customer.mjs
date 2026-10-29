// Native customer journeys use real touch input, Worker routes and D1.
// Processor and mail substitutions remain at the existing network edges.
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { harness, file } from './harness.mjs'
import { applyPolicy } from './policy-helper.mjs'
import { paymentLinksFlow, harnessOptions as linkOptions } from './payment-links.mjs'
import { customerSearchFlow, harnessOptions as methodOptions } from './customer-search.mjs'
import { dunningSequenceFlow, harnessOptions as dunningOptions } from './dunning-sequences.mjs'
import { cardExpiryNoticesFlow, harnessOptions as expiryOptions } from './card-expiry-notices.mjs'
import { seedPortalRecords } from './portal-sessions.mjs'
import { portalChangeRequestsFlow } from './portal-change-requests.mjs'
import { portalRenewalFlow } from './portal-renewal.mjs'
import { portalPrepaidFlow } from './portal-prepaid.mjs'
import { portalAnswersFlow } from './portal-answers.mjs'
import { portalCorrections } from './portal-corrections.mjs'
import { retryMethodsFlow, retryAuthenticationFlow, harnessOptions as retryOptions } from './retry-methods.mjs'
import { prepaidTopupFlow, harnessOptions as topupOptions } from './prepaid-topup.mjs'
import { automaticCollectionFlow, harnessOptions as automaticOptions } from './automatic-collection.mjs'

const directory = process.env.NECTAR_EVIDENCE_DIR
if (directory) await mkdir(directory, { recursive: true })
const browser = await chromium.launch({ headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
  args: ['--no-sandbox', '--use-mock-keychain', '--password-store=basic'] })
const seen = new Set()
const proofContexts = new Map()
let taps = 0, states = 0

async function fit(page, label) {
  assert.deepEqual(page.viewportSize(), { width: 390, height: 844 })
  assert.equal(await page.evaluate(() => innerWidth), 390, `${label} uses the phone layout viewport`)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > 390), false, `${label} has no sideways scroll`)
  assert.deepEqual(await page.evaluate(() => ({ touch: navigator.maxTouchPoints > 0, coarse: matchMedia('(pointer: coarse)').matches })), { touch: true, coarse: true }, `${label}: a touch browser performs the journey`)
  const icons = await page.locator('a,button,[role=button]').evaluateAll(nodes => nodes.filter(n => !n.textContent.trim() && n.querySelector('svg,img') && !n.getAttribute('aria-describedby')).length)
  assert.equal(icons, 0, `${label} has no unexplained icon controls`)
  states++
  if (directory && !seen.has(label)) {
    seen.add(label)
    // Render the actual current HTML independently: resizing the customer's
    // context for proof must never change its mobile or touch emulation.
    const html = await page.evaluate(() => {
      const copy = document.documentElement.cloneNode(true)
      const originals = document.querySelectorAll('input,textarea,option,details')
      copy.querySelectorAll('input,textarea,option,details').forEach((node, index) => {
        const original = originals[index]
        if (node.tagName === 'INPUT') {
          node.setAttribute('value', original.value)
          node.toggleAttribute('checked', original.checked)
        } else if (node.tagName === 'TEXTAREA') node.textContent = original.value
        else if (node.tagName === 'OPTION') node.toggleAttribute('selected', original.selected)
        else node.toggleAttribute('open', original.open)
      })
      return '<!doctype html>' + copy.outerHTML
    })
    for (const width of [390, 1440]) {
      if (!proofContexts.has(width)) proofContexts.set(width, await browser.newContext({ viewport: { width, height: 844 }, isMobile: width === 390, hasTouch: width === 390 }))
      const context = proofContexts.get(width), proof = await context.newPage()
      try {
        await context.clearCookies(); await context.addCookies(await page.context().cookies())
        if (page.url() === 'about:blank') await proof.setContent(html)
        else {
          await proof.route('**/*', route => route.request().isNavigationRequest() ? route.fulfill({ contentType: 'text/html', body: html }) : route.continue())
          await proof.goto(page.url())
        }
        await proof.screenshot({ path: `${directory}/${width}-${label}.png`, fullPage: true })
      } finally { await proof.close() }
    }
  }
}
async function tap(control) { await control.tap(); taps++ }
async function confirm(form, name = 'confirm') {
  const checkbox = form.locator(`[name=${name}]`)
  if (!await checkbox.isChecked()) await tap(checkbox)
  assert.equal(await checkbox.isChecked(), true)
}
async function submit(page, form, label, status = 200) {
  await fit(page, `${label}-before`)
  const [response] = await Promise.all([page.waitForNavigation(), tap(form.getByRole('button').first())])
  assert.equal(response.status(), status, label)
  await fit(page, `${label}-after`)
}
async function installation(options, journey) {
  const h = await harness({ ...options, assets: true })
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true })
  try {
    await h.raw('/auth/bootstrap', { body: { token: h.vars.SETUP_TOKEN, displayName: 'Nectar Owner' } })
    const owner = await h.signIn(h.vars.OWNER_EMAIL)
    await h.raw('/setup', { cookie: owner, form: new URLSearchParams({ confirm: 'yes' }) })
    await h.api('business.configure', owner, { legal_name: 'Cedar Software Inc', timezone: 'UTC', invoice_prefix: 'MOB', payment_terms_days: 30 })
    await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: 'CA', tax_mode: 'no_tax', tax_note: 'Reviewed native mobile journey' })
    await h.api('tax.review', owner, { revision: (await h.api('business', owner)).revision })
    const page = await context.newPage()
    await page.route('https://checkout.stripe.com/**', route => route.abort())
    await journey(h, owner, page, context)
  } finally { await context.close(); await h.close() }
}

async function nativePaymentLinks() {
  await installation(linkOptions(), async (h, owner, page, context) => {
    await paymentLinksFlow(h, owner, { interaction: {
      start: async ({ id, language, payload }) => {
        await page.goto(`${h.origin}/pay-links/${id}?language=${language}`)
        assert.equal(await page.locator('html').getAttribute('lang'), language)
        const offer = await (await h.raw(`/pay-links/${id}?language=${language}`, { headers: { accept: 'application/json' } })).json()
        const text = await page.locator('main').innerText()
        for (const cents of [offer.terms.subtotalCents, offer.terms.taxCents, offer.terms.totalCents]) {
          const amount = new Intl.NumberFormat(language, { style: 'currency', currency: 'USD', currencyDisplay: 'code' }).format(cents / 100).replaceAll('\u00a0', ' ')
          assert.ok(text.includes(amount), 'The native consent shows the exact independently checked offer figures')
        }
        const form = page.locator('form[action$="/start"]')
        for (const name of ['name', 'billing_email', 'address']) {
          await tap(form.locator(`[name=${name}]`)); await form.locator(`[name=${name}]`).fill(payload[name])
        }
        await confirm(form)
        if (payload.make_default) await confirm(form, 'make_default')
        const accepted = await form.evaluate(element => Object.fromEntries(new FormData(element)))
        await fit(page, `link-${language}-consent`)
        const [posted] = await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === `/pay-links/${id}/start` && r.request().method() === 'POST'), page.waitForNavigation().catch(error => {
          assert.match(error.message, /ERR_FAILED|ERR_ABORTED/)
        }), tap(form.getByRole('button'))])
        assert.equal(posted.status(), 303)
        const headers = await posted.allHeaders(), attempt = headers['set-cookie'].match(/Path=\/pay-links\/attempts\/([\w-]+)/)[1]
        const saved = (await context.cookies()).find(c => c.name === 'nectar_payment_link' && c.path === `/pay-links/attempts/${attempt}`)
        assert.ok(saved)
        const cookie = `${saved.name}=${saved.value}`
        const body = await (await h.raw(`/pay-links/attempts/${attempt}`, { cookie, headers: { accept: 'application/json' } })).json()
        await page.goto(`${h.origin}/pay-links/attempts/${attempt}`); await fit(page, `link-return-${body.status}`)
        return { body: { ...body, url: headers.location }, cookie, payload: accepted }
      },
      post: async ({ attempt, operation }) => {
        const path = `/pay-links/attempts/${attempt.body.id}`
        await page.goto(h.origin + path)
        let form = page.locator(`form[action="${path}/${operation}"]`)
        if (operation === 'reconcile' && !await form.count()) form = page.locator(`form[action="${path}/finish"]`)
        await fit(page, `link-${operation}`)
        if (await form.count()) {
          const action = await form.getAttribute('action')
          const [posted] = await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === action && r.request().method() === 'POST'), page.waitForNavigation(), tap(form.getByRole('button'))])
          assert.equal(posted.status(), 303)
          if (operation === 'cancellation') return { cancelUrl: new URL((await posted.allHeaders()).location, h.origin).href }
          await page.goto(h.origin + path); await fit(page, `link-${operation}-result`)
        } else {
          // Completed operations expose no second submit control; replay remains read-only in effect.
          assert.equal((await h.raw(`${path}/${operation}`, { cookie: attempt.cookie, body: { confirm: true } })).status, 200)
        }
        return (await h.raw(path, { cookie: attempt.cookie, headers: { accept: 'application/json' } })).json()
      },
      cancelRenewal: async ({ cancelPath }) => {
        await page.goto(h.origin + cancelPath)
        assert.equal(await page.locator('form').count(), 1, 'Cancellation needs one confirmation')
        await submit(page, page.locator('form'), 'link-cancellation')
      },
    }, onState: async ({ completed, state, cancelPath, customer }) => {
      await page.goto(h.origin + (cancelPath ?? `/pay-links/attempts/${completed.id}`))
      await fit(page, `link-${state}`)
      if (state === 'complete') assert.ok((await page.locator('main').innerText()).includes('USD 144.38'), 'The completed signup retains its exact monthly total')
      if (state === 'one-time-complete') {
        const text = await page.locator('main').innerText()
        assert.ok(text.includes('USD 52.76'), 'The paid return shows the independently computed tax-inclusive capture')
        assert.ok(text.includes(customer.billingRecord.receipts.find(row => row.payment === completed.payment).number), 'The paid return identifies its actual receipt')
      }
    } })
  })
}

async function nativeMethods() {
  await installation(methodOptions(), async (h, owner, page, context) => {
    const path = session => `${h.origin}/portal/payment-methods?session=${encodeURIComponent(session.token)}`
    const confirmMethodAction = async ({ session, action, operation, customer, expectedStatus = 200 }) => {
      await page.goto(path(session))
      const form = page.locator(`[data-method-action="${action}"] form`)
      const actions = await (await h.raw(`/portal/payment-methods/actions?session=${encodeURIComponent(session.token)}`)).json()
      const record = await h.api(`customers/${customer}`, owner)
      const selected = actions.find(row => row.id === action)
      const setup = record.billingRecord.hostedSetups.find(row => row.id === selected.setup)
      assert.ok((await form.locator('..').innerText()).includes(setup.paymentMethod.last4), 'Method choice identifies the exact saved instrument')
      await confirm(form); await submit(page, form, `method-action-${selected.operation}-${operation}-${expectedStatus}`, expectedStatus)
      const response = await h.raw(`/portal/payment-methods/actions?session=${encodeURIComponent(session.token)}`)
      return (await response.json()).find(row => row.id === action)
    }
    await customerSearchFlow(h, owner, async () => {}, {
      startHosted: async ({ session, setup, method }) => {
        await page.goto(path(session))
        const form = page.locator(`form:has(input[name=setup][value="${setup}"])`)
        await confirm(form); await confirm(form, 'make_default'); await fit(page, `method-${method}-consent`)
        const [posted] = await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === '/portal/payment-methods/start' && r.request().method() === 'POST'), page.waitForNavigation().catch(error => {
          assert.match(error.message, /ERR_FAILED|ERR_ABORTED/)
        }), tap(form.getByRole('button'))])
        assert.equal(posted.status(), 303)
        const headers = await posted.allHeaders(), cookie = (await context.cookies()).find(c => c.name === 'nectar_setup_return')
        assert.ok(cookie)
        return { status: 'open', url: headers.location, cookie: `${cookie.name}=${cookie.value}` }
      },
      finishHosted: async ({ session, setup, method }) => {
        await page.goto(path(session))
        const form = page.locator(`form:has(input[name=setup][value="${setup}"])`)
        await confirm(form); await submit(page, form, `method-${method}-finish`)
        return { status: 'complete' }
      },
      hostedState: async ({ session, state, method }) => {
        const response = await page.goto(path(session))
        assert.equal(response.status(), state === 'refused' ? 401 : 200)
        await fit(page, `method-${method}-${state}`)
      },
      confirmMethodAction,
      confirmUncertainMethodAction: confirmMethodAction,
      methodState: async ({ session, operation, state }) => {
        const response = await page.goto(path(session))
        assert.equal(response.status(), state === 'refused' ? 401 : 200)
        await fit(page, `method-action-${operation}-${state}`)
      },
    })
  })
}

async function nativeInvoices() {
  await installation({ localTime: '2026-10-21T09:00:00Z' }, async (h, owner, page) => {
    const { customers, invoices, invoice } = await seedPortalRecords(h, owner)
    await h.api('portal.configure', owner, { hosts: [h.origin], parents: [] })
    const issue = customer => h.api('portal.session.issue', owner, { customer, origin: h.origin, audience: 'hosted' })
    const session = await issue(customers[0]), foreign = invoices.find(row => row.customer_id === customers[1])
    for (const language of ['en', 'es-US']) {
      const current = await h.api(`customers/${customers[0]}`, owner)
      await h.api('customer.update', owner, { customer: current.id, revision: current.revision, name: current.name, billing_email: current.billing_email, language })
      const own = await issue(customers[0])
      await page.goto(`${h.origin}/portal?session=${encodeURIComponent(own.token)}`)
      assert.equal(await page.locator('html').getAttribute('lang'), language)
      await fit(page, `invoice-${language}-overview`)
      await Promise.all([page.waitForNavigation(), tap(page.locator(`a[href*="/portal/invoices/${invoice.id}?"]`))])
      await fit(page, `invoice-${language}-detail`)
      const text = await page.locator('main').innerText()
      for (const fact of ['Northwind Robotics', 'USD 300.00', 'USD 25.00', 'USD 100.00', 'USD 175.00']) assert.ok(text.includes(fact), `Own invoice shows ${fact}`)
      assert.doesNotMatch(text, /Pinecrest|PRIVATE-|INTERNAL-/)
      const [download] = await Promise.all([page.waitForEvent('download'), tap(page.locator('a[href*="format=pdf"]'))])
      assert.equal(await download.failure(), null)
      const bytes = await readFile(await download.path())
      assert.match(bytes.toString('latin1'), /^%PDF-1.4/)
      const pdfText = [...bytes.toString('latin1').matchAll(/<([0-9a-f]+)> Tj/g)].map(m => Buffer.from(m[1], 'hex').toString('latin1')).join('\n')
      for (const fact of ['Northwind Robotics', 'USD 300.00', 'USD 25.00', 'USD 100.00', 'USD 175.00']) assert.ok(pdfText.includes(fact), `Downloaded PDF shows ${fact}`)
      assert.doesNotMatch(pdfText, /Pinecrest|PRIVATE-|INTERNAL-/)
      await fit(page, `invoice-${language}-downloaded`)
    }
    const before = await h.api(`invoices/${invoice.id}`, owner)
    assert.equal((await page.goto(`${h.origin}/portal/invoices/${foreign.id}?session=${encodeURIComponent(session.token)}`)).status(), 404)
    await fit(page, 'invoice-foreign-refused')
    assert.equal((await h.raw(`/portal/invoices/${foreign.id}?session=${encodeURIComponent(session.token)}&format=pdf`)).status, 404)
    await h.api('portal.session.revoke', owner, { session: session.id })
    assert.equal((await page.goto(`${h.origin}/portal?session=${encodeURIComponent(session.token)}`)).status(), 401)
    await fit(page, 'invoice-revoked-refused')
    const expired = await issue(customers[0])
    await h.advanceClock(new Date(expired.expiresAt).toISOString())
    assert.equal((await page.goto(`${h.origin}/portal?session=${encodeURIComponent(expired.token)}`)).status(), 401)
    await fit(page, 'invoice-expired-refused')
    for (const token of [session.token, expired.token, 'synthetic-nectar-altered']) {
      assert.equal((await h.raw(`/portal/invoices/${invoice.id}?session=${encodeURIComponent(token)}&format=pdf`)).status, 401)
    }
    assert.deepEqual(await h.api(`invoices/${invoice.id}`, owner), before, 'Refusals and downloads change no financial evidence')
  })
}

async function nativeReceipts() {
  await installation({ localTime: '2026-10-21T09:00:00Z' }, async (h, owner, page) => {
    const { customers, invoice } = await seedPortalRecords(h, owner)
    const unallocated = (await h.api('payment.record', owner, { customer: customers[0], amount: '25', received_on: '2026-09-04', method: 'check', reference: 'PRIVATE-MOBILE-REFERENCE', evidence: 'INTERNAL-MOBILE-EVIDENCE' })).payment
    const other = (await h.api('payment.record', owner, { customer: customers[1], amount: '9', received_on: '2026-09-04', method: 'check', reference: 'PRIVATE-FOREIGN-REFERENCE' })).payment
    await h.api('portal.configure', owner, { hosts: [h.origin], parents: [] })
    const issue = customer => h.api('portal.session.issue', owner, { customer, origin: h.origin, audience: 'hosted' })
    const session = await issue(customers[0]), foreign = await issue(customers[1])
    const path = (token, suffix = '') => `/portal/receipts${suffix}?session=${encodeURIComponent(token)}`
    const json = async suffix => {
      const response = await h.raw(path(session.token, suffix), { headers: { accept: 'application/json' } })
      assert.equal(response.status, 200)
      return response.json()
    }
    const list = await json('')
    assert.deepEqual(list.receipts.map(r => [r.amountCents, r.allocatedCents, r.returnedCents, r.unallocatedCents]), [[2500,0,0,2500],[10000,10000,0,0]], 'The two numbered receipts retain original cash and exact allocations')
    assert.equal(list.custody, 'recorded_cash')
    const ledger = (await h.api(`customers/${customers[0]}`, owner)).ledger
    assert.equal(list.receipts.reduce((n, r) => n + r.amountCents, 0), ledger.payments.reduce((n, r) => n + r.amount_cents, 0))
    const before = { ledger, invoice: await h.api(`invoices/${invoice.id}`, owner), audit: await h.api('audit', owner) }
    for (const language of ['en', 'es-US']) {
      const customer = await h.api(`customers/${customers[0]}`, owner)
      await h.api('customer.update', owner, { customer: customer.id, revision: customer.revision, name: customer.name, billing_email: customer.billing_email, language })
      await page.goto(`${h.origin}/portal?session=${encodeURIComponent(session.token)}`)
      await Promise.all([page.waitForNavigation(), tap(page.locator('a[href^="/portal/receipts?"]'))])
      assert.equal(await page.locator('html').getAttribute('lang'), language)
      await fit(page, `receipt-${language}-list`)
      for (const receipt of list.receipts) {
        await page.goto(h.origin + path(session.token))
        await Promise.all([page.waitForNavigation(), tap(page.locator(`a[href^="/portal/receipts/${receipt.id}?"]`))])
        await fit(page, `receipt-${language}-${receipt.amountCents}-detail`)
        const detail = await json(`/${receipt.id}`)
        assert.deepEqual(detail.receipts, [receipt], 'Receipt identity and financial figures are identical in each language')
        assert.deepEqual(detail.allocations.map(a => [a.invoice, a.amountCents]), receipt.id === unallocated ? [] : [[invoice.id,10000]])
        const text = await page.locator('main').innerText()
        const date = new Intl.DateTimeFormat(language, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${receipt.receivedOn}T00:00:00Z`))
        for (const fact of ['Northwind Robotics', receipt.number, date, `USD ${(receipt.amountCents / 100).toFixed(2)}`]) assert.ok(text.includes(fact), `Receipt retains ${fact}`)
        assert.doesNotMatch(text, /Pinecrest|PRIVATE-|INTERNAL-|\/app\//)
        const [download] = await Promise.all([page.waitForEvent('download'), tap(page.locator('a[href*="format=pdf"]'))])
        assert.equal(await download.failure(), null)
        const pdf = (await readFile(await download.path())).toString('latin1')
        assert.match(pdf, /^%PDF-1.4/)
        const pdfText = [...pdf.matchAll(/<([0-9a-f]+)> Tj/g)].map(m => Buffer.from(m[1], 'hex').toString('latin1')).join('\n')
        for (const fact of ['Northwind Robotics', receipt.number, `USD ${(receipt.amountCents / 100).toFixed(2)}`]) assert.ok(pdfText.includes(fact), `Downloaded receipt retains ${fact}`)
        for (const cents of [receipt.allocatedCents,receipt.returnedCents,receipt.unallocatedCents]) assert.ok(pdfText.includes(`USD ${(cents / 100).toFixed(2)}`))
        assert.doesNotMatch(pdfText, /Pinecrest|PRIVATE-|INTERNAL-|\/app\//)
        if (receipt.id !== unallocated) {
          await Promise.all([page.waitForNavigation(), tap(page.locator(`a[href^="/portal/invoices/${invoice.id}?"]`))])
          assert.ok((await page.locator('main').innerText()).includes('USD 175.00'))
          await fit(page, `receipt-${language}-invoice-source`)
        }
      }
    }
    for (const [token, payment] of [[session.token,other],[foreign.token,unallocated]]) {
      for (const format of ['', '&format=pdf']) assert.equal((await h.raw(path(token, `/${payment}`) + format)).status, 404)
    }
    assert.equal((await page.goto(h.origin + path(session.token, `/${other}`))).status(), 404)
    await fit(page, 'receipt-foreign-refused')
    assert.equal((await h.raw('/portal/receipts', { cookie: owner })).status, 401)
    assert.equal((await h.raw(path(session.token, '/synthetic-nectar-missing'))).status, 404)
    assert.equal((await h.raw(path(session.token), { body: {} })).status, 405)
    assert.deepEqual((await h.api(`customers/${customers[0]}`, owner)).ledger, before.ledger, 'Receipt views and refusals move no cash')
    assert.deepEqual(await h.api(`invoices/${invoice.id}`, owner), before.invoice, 'Receipt views and refusals change no issued evidence')
    const readAudit = await h.api('audit', owner)
    assert.ok(readAudit.filter(row => !before.audit.some(old => old.seq === row.seq)).every(row => row.action === 'customer.update'), 'Receipt reads never create audit or financial writes')
    await h.api('portal.session.revoke', owner, { session: session.id })
    const expired = await issue(customers[0])
    await h.advanceClock(new Date(expired.expiresAt).toISOString())
    for (const [label, token] of [['revoked',session.token],['expired',expired.token],['altered','synthetic-nectar-altered']]) {
      assert.equal((await page.goto(h.origin + path(token))).status(), 401)
      await fit(page, `receipt-${label}-refused`)
      assert.equal((await h.raw(path(token, `/${unallocated}`) + '&format=pdf')).status, 401)
    }
    const erasedSession = await issue(customers[0])
    const erasure = await h.api('erasure.request', owner, { customer: customers[0] })
    await h.api('erasure.verify', owner, { request: erasure.id, reason: 'Independently verified receipt owner', evidence: file('synthetic-nectar-receipt.txt','Synthetic ownership proof','text/plain') })
    await h.api('erasure.approve', owner, { request: erasure.id, confirm: true })
    assert.equal((await page.goto(h.origin + path(erasedSession.token, `/${unallocated}`))).status(), 401)
    await fit(page, 'receipt-erased-refused')
    assert.equal((await h.raw(path(erasedSession.token, `/${unallocated}`) + '&format=pdf')).status, 401)
    console.log('Mobile recorded-cash receipts, source invoices, PDF downloads and capability custody passed')
  })
}

async function nativePortal() {
  const activate = async control => {
    const page = control.page(), label = `portal-control-${taps + 1}`
    await fit(page, `${label}-before`)
    const navigates = await control.evaluate(node => node.tagName === 'A' || node.tagName === 'BUTTON')
    if (navigates) await Promise.all([page.waitForNavigation(), tap(control)])
    else await tap(control)
    await fit(page, `${label}-after`)
  }
  await installation({}, async (h, owner, page, context) => {
    await portalChangeRequestsFlow(h, owner, { customerContext: context, activate, onScreen: (screen, name) => fit(screen, `changes-${name}`) })
  })
  await installation({}, async (h, owner, page, context) => {
    await portalRenewalFlow(h, owner, { customerContext: context, activate, onScreen: (screen, name) => fit(screen, `renewal-${name}`) })
  })
  await installation({}, async (h, owner, page) => {
    await portalPrepaidFlow(h, owner, { onState: async ({ moneySession, unitSession, money, unitData }) => {
      for (const [language, session, data] of [['en',moneySession,money],['es-US',unitSession,unitData]]) {
        await page.goto(`${h.origin}/portal?session=${encodeURIComponent(session.token)}`)
        await fit(page, `prepaid-${language}-overview`)
        await Promise.all([page.waitForNavigation(), tap(page.locator('a[href^="/portal/prepaid?"]').first())])
        await fit(page, `prepaid-${language}-list`)
        assert.equal(await page.locator('html').getAttribute('lang'), language)
        for (const lot of data.lots) {
          await page.goto(`${h.origin}/portal/prepaid?session=${encodeURIComponent(session.token)}`)
          await Promise.all([page.waitForNavigation(), tap(page.locator(`a[href^="${lot.href}?"]`))])
          await fit(page, `prepaid-${language}-${lot.id}`)
          const text = await page.locator('main').innerText()
          assert.ok(text.includes(new Intl.NumberFormat(language, { style: 'currency', currency: 'USD', currencyDisplay: 'code' }).format(lot.liabilityCents / 100).replaceAll('\u00a0',' ')), 'The source retains its independently reconciled liability')
          assert.equal(await page.locator('section.card').count(), 1 + lot.entries.length, 'The customer can read every actual ledger event')
        }
        await page.goto(`${h.origin}/portal/prepaid?session=${encodeURIComponent(session.token)}`)
        const [download] = await Promise.all([page.waitForEvent('download'), tap(page.locator('a[href^="/portal/prepaid.csv?"]'))])
        assert.equal(await download.failure(), null)
        const csv = await readFile(await download.path(), 'utf8')
        for (const lot of data.lots) assert.ok(csv.includes(lot.id))
        await fit(page, `prepaid-${language}-downloaded`)
      }
    } })
  })
  await installation({ localTime: '2026-10-21T09:00:00Z' }, async (h, owner, page) => {
    await portalAnswersFlow(h, owner, async ({ session, invoice, question, topic, answer }) => {
      await page.goto(`${h.origin}/portal/answers?${new URLSearchParams({ session: session.token, invoice })}`)
      await fit(page, `answers-${topic}-question`)
      const input = page.locator('input[name=question]')
      await tap(input); await input.fill(question)
      await submit(page, page.locator('form').first(), `answers-${topic}`)
      const text = await page.locator('main').innerText()
      for (const figure of answer.figures.filter(f => f.unit === 'cents')) {
        const language = await page.locator('html').getAttribute('lang')
        const amount = new Intl.NumberFormat(language, { style: 'currency', currency: 'USD', currencyDisplay: 'code' }).format(Number(figure.value) / 100).replaceAll('\u00a0',' ')
        assert.ok(text.includes(amount), 'Mobile billing answers preserve the exact reconciled figures')
      }

    })
  })
  console.log('Mobile portal plan requests, estimates, renewal, saves, win-back, prepaid and billing answers passed')
}

async function nativeBilling() {
  await installation({ localTime: '2026-10-21T09:00:00Z' }, async (h, owner, page) => {
    const records = await seedPortalRecords(h, owner)
    await h.api('portal.configure', owner, { hosts: [h.origin], parents: [] })
    const session = await h.api('portal.session.issue', owner, { customer: records.customers[0], origin: h.origin, audience: 'hosted' })
    const reviewerEmail = `reviewer-${h.vars.OWNER_EMAIL}`
    await h.api('access.give', owner, { email: reviewerEmail, name: 'Independent correction reviewer', role: 'finance' })
    await h.signIn(reviewerEmail, { requested: true })
    await portalCorrections(h, owner, session, records.invoice.id, async state => {
      const query = new URLSearchParams({ session: state.session.token, subscription: state.subscription, period: state.period })
      await page.goto(`${h.origin}/portal/upcoming?${query}`)
      await fit(page, `upcoming-${state.kind}-${state.state}`)
      const form = page.locator('form')
      await tap(form.locator('select')); await form.locator('select').selectOption(state.subscription)
      await tap(form.locator('input[type=month]')); await form.locator('input[type=month]').fill(state.period)
      await submit(page, form, `upcoming-${state.kind}-${state.state}-refresh`)
      if (state.state !== 'prepared') {
        const cents = { fixed_credit: 10450, usage: 11550, metric: 11550 }[state.kind] ?? 9900
        assert.ok((await page.locator('main').innerText()).includes(`USD ${(cents / 100).toFixed(2)}`), 'Approved customer preview retains the independently checked correction')
      }
      const [download] = await Promise.all([page.waitForEvent('download'), tap(page.locator('a[href^="/portal/usage.csv?"]').first())])
      assert.equal(await download.failure(), null)
      assert.match(await readFile(await download.path(), 'utf8'), /^meter,period_start,period_end,quantity,earlier_quantity/)
      await fit(page, `upcoming-${state.kind}-${state.state}-downloaded`)
      if (state.state === 'issued') {
        await page.goto(`${h.origin}/portal?session=${encodeURIComponent(state.session.token)}`)
        await Promise.all([page.waitForNavigation(), tap(page.locator('a[href^="/portal/adjustments?"]'))])
        await fit(page, `adjustments-${state.kind}`)
        assert.ok(await page.locator('section.card').count() > 0, 'The actual approved explanation is visible')
      }
    })
    const fresh = await h.api('portal.session.issue', owner, { customer: records.customers[0], origin: h.origin, audience: 'hosted' })
    await page.goto(`${h.origin}/portal/answers?${new URLSearchParams({ session: fresh.token, invoice: records.invoice.id, question: 'What do we owe?' })}`)
    await fit(page, 'billing-credit-review')
    const form = page.locator('form[action^="/portal/answer-proposal?"]')
    await tap(form.locator('input[name=credit_amount]')); await form.locator('input[name=credit_amount]').fill('1')
    await tap(form.locator('input[name=reason]')); await form.locator('input[name=reason]').fill('Please review this amount')
    const before = await h.api(`invoices/${records.invoice.id}`, owner)
    await submit(page, form, 'billing-credit-request')
    assert.deepEqual(await h.api(`invoices/${records.invoice.id}`, owner), before, 'A customer credit request changes no financial record')
    await page.goto(`${h.origin}/portal?session=${encodeURIComponent(fresh.token)}`)
    await Promise.all([page.waitForNavigation(), tap(page.locator('a[href^="/portal/privacy?"]'))])
    await fit(page, 'privacy-request')
    await submit(page, page.locator('form'), 'privacy-request-recorded')
    const request = (await h.api('erasures', owner)).find(row => row.customer_id === records.customers[0])
    assert.equal(request.status, 'pending', 'A tap requests review and cannot erase customer data')
    assert.deepEqual(await h.api(`invoices/${records.invoice.id}`, owner), before)
  })
  console.log('Mobile upcoming invoices, corrected figures, usage downloads, approved explanations, pending credit and privacy requests passed')
}

async function nativeRecovery() {
  // Keep only native pages under qualification; processor challenges are an
  // explicitly substituted network edge and establish no Stripe mobile proof.
  await installation(retryOptions(), async (h, owner, page) => {
    await retryMethodsFlow(h, owner, {
      acceptRecovery: async ({ path, prepared }) => {
        await page.goto(h.origin + path)
        const form = page.locator('form:has(input[name=accept])')
        assert.equal(await form.locator('input[name=quote_hash]').inputValue(), prepared.quoteHash)
        await confirm(form, 'accept'); await submit(page, form, 'replacement-consent')
      },
      onState: async ({ path, state }) => {
        await page.goto(h.origin + path); await fit(page, `replacement-${state}`)
      },
    })
  })
  await installation(retryOptions(), async (h, owner, page) => {
    await page.route('https://hooks.stripe.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Processor fixture</title><p>Synthetic processor challenge</p>' }))
    await retryAuthenticationFlow(h, owner, {
      acceptRecovery: async ({ path, prepared }) => {
        await page.goto(h.origin + path)
        const form = page.locator('form:has(input[name=accept])')
        assert.equal(await form.locator('input[name=quote_hash]').inputValue(), prepared.quoteHash)
        await confirm(form, 'accept'); await submit(page, form, 'authentication-consent')
      },
      confirmAuthentication: async ({ path, body }) => {
        await page.goto(h.origin + path); await fit(page, 'authentication-ready')
        await Promise.all([page.waitForURL('https://hooks.stripe.com/**'), tap(page.locator('form:has(input[name=authenticate]) button'))])
        return h.raw(path, { body })
      },
      checkAuthentication: async ({ prepared, edge, intent }) => {
        edge.authenticate(intent)
        await page.goto(`${h.origin}/portal/retry-method-recoveries/${prepared.id}/return?payment_intent=${intent}&payment_intent_client_secret=synthetic-nectar-redirect-secret`)
        assert.equal(new URL(page.url()).search, '', 'Return credentials are cleared before the native page renders')
        await submit(page, page.locator('form:has(input[name=check])'), 'authentication-return')
        assert.equal(new URL(page.url()).search, '')
      },
      onState: async ({ path, state }) => {
        const response = await page.goto(h.origin + path)
        assert.equal(response.status(), state === 'authentication-erased' ? 401 : 200)
        await fit(page, `recovery-${state}`)
      },
    })
  })
  await installation(topupOptions(), async (h, owner, page) => {
    const target = (row, session = row.portal) => `${h.origin}/portal/prepaid-topups/${row.authorization.id}?session=${encodeURIComponent(session.token)}`
    await prepaidTopupFlow(h, owner, {
      acceptAuthorization: async ({ row, session }) => {
        await page.goto(target(row, session))
        const text = await page.locator('main').innerText()
        for (const amount of ['USD 1,000.00','USD 5,000.00']) assert.ok(text.includes(amount), 'Customer authorization retains its exact threshold, charge and monthly cap')
        const form = page.locator('form[action^="/portal/prepaid-topup.accept?"]')
        await confirm(form, 'accept'); await submit(page, form, `topup-${row.n}-consent`)
      },
      revokeAuthorization: async ({ row, session }) => {
        await page.goto(target(row, session))
        await submit(page, page.locator('form[action^="/portal/prepaid-topup.revoke?"]'), 'topup-revocation')
      },
      onState: async ({ row, session, label }) => {
        if (!row) return
        const current = session ?? row.portal
        const response = await page.goto(target(row, current))
        assert.equal(response.status(), ['uncertain','reconciled'].includes(label) ? 401 : 200, 'Expired customer authority is never refreshed by viewing a top-up')
        await fit(page, `topup-${row.n}-${label}`)
      },
    })
  })
  console.log('Mobile native method recovery, authentication return and prepaid authorization passed; processor fixtures are not provider qualification')
}

async function nativeCollectionConsent() {
  await installation(automaticOptions(), async (h, owner, page) => {
    await automaticCollectionFlow(h, owner, {
      acceptCollection: async ({ target, prepared }) => {
        await page.goto(h.origin + target)
        const form = page.locator('form:has(input[name=accept])')
        assert.equal(await form.locator('input[name=basis_hash]').inputValue(), prepared.basis)
        assert.ok((await page.locator('main').innerText()).includes('USD 100.00'), 'Mobile collection consent shows the exact amount')
        await confirm(form, 'accept'); await submit(page, form, 'collection-exact-consent')
      },
      onState: async ({ session, request, state }) => {
        await page.goto(`${h.origin}/portal/automatic-collections/${request.id}?session=${encodeURIComponent(session.token)}`)
        await fit(page, `collection-${state}-${request.id}`)
      },
    })
  })
  console.log('Mobile card and bank collection consent and native financial end states passed')
}

async function message(page, html, label, facts, expectsLink = true) {
  await page.goto('about:blank'); await page.setContent(html)
  for (const fact of facts) assert.ok((await page.locator('body').innerText()).includes(fact), `${label} retains ${fact}`)
  await fit(page, label)
  const buttons = page.getByRole('link')
  assert.equal(await buttons.count(), expectsLink ? 1 : 0, 'The message exposes its intended primary action')
  for (const button of await buttons.all()) assert.ok((await button.boundingBox()).height >= 44, 'Primary email links are tappable')
  // A single message column stays within the phone even with the real capability URL.
  assert.equal(await page.locator('body').evaluate(node => node.getBoundingClientRect().right <= innerWidth), true)
  const paragraphs = page.locator('body > p, body > main > p')
  assert.ok(await paragraphs.count() > 0, 'The actual message has visible paragraphs')
  assert.equal(await paragraphs.evaluateAll(nodes => nodes.every((node, index) => !index || node.getBoundingClientRect().top >= nodes[index - 1].getBoundingClientRect().bottom)), true, 'Message paragraphs occupy one column')
}
async function nativeMessages() {
  await installation(dunningOptions(), async (h, owner, page) => {
    const languages = new Set()
    await dunningSequenceFlow(h, owner, {
      onState: async state => {
        if (!state.emailHtml) return
        await message(page, state.emailHtml, `dunning-${state.record.customer}-${state.message.step}`, ['USD 100.00'], !!state.link)
        languages.add(await page.locator('html').getAttribute('lang'))
        const customer = await h.api(`customers/${state.record.customer}`, owner)
        const invoice = await h.api(`invoices/${state.record.invoice}`, owner)
        assert.equal(await page.locator('html').getAttribute('lang'), customer.language)
        assert.ok((await page.locator('body').innerText()).includes(invoice.number))
        assert.equal(invoice.balanceCents, 10000)
        if (state.link) {
          await Promise.all([page.waitForNavigation(), tap(page.getByRole('link'))])
          await fit(page, `dunning-update-${customer.language}`)
        }
      },
      updateMethod: async ({ path, setupId, complete }) => {
        await page.goto(h.origin + path)
        let form = page.locator(`form:has(input[name=setup][value="${setupId}"])`)
        await confirm(form); await confirm(form, 'make_default'); await fit(page, 'dunning-update-consent')
        await Promise.all([page.waitForNavigation().catch(error => {
          assert.match(error.message, /ERR_FAILED|ERR_ABORTED/)
        }), tap(form.getByRole('button'))])
        complete(); await page.goto(h.origin + path)
        form = page.locator(`form:has(input[name=setup][value="${setupId}"])`)
        await confirm(form); await submit(page, form, 'dunning-update-finish')
      },
      acceptRecovery: async ({ path, proposal }) => {
        await page.goto(h.origin + path)
        const form = page.locator('form:has(input[name=accept])')
        assert.equal(await form.locator('[name=quote_hash]').inputValue(), proposal.quoteHash)
        await confirm(form, 'accept'); await submit(page, form, 'dunning-recovery-consent')
      },
    })
    assert.deepEqual([...languages].sort(), ['en', 'es-US'], 'Both actual dunning message languages render')
  })
  await installation(expiryOptions(), async (h, owner, page) => {
    await cardExpiryNoticesFlow(h, owner, { onState: async state => {
      if (state.state === 'expired') {
        assert.equal((await page.goto(state.updateLink)).status(), 401); await fit(page, 'expiry-link-refused')
      }
    } })
    const delivered = h.mails.filter(mail => mail.html?.includes('4242'))
    const languages = new Set()
    for (const mail of delivered) {
      const language = mail.html.match(/lang="([^"]+)"/)[1]
      const date = new Intl.DateTimeFormat(language, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date('2026-11-05T00:00:00Z'))
      await message(page, mail.html, `expiry-${language}`, ['4242', date])
      languages.add(language)
    }
    assert.deepEqual([...languages].sort(), ['en', 'es-US'], 'Both actual expiry message languages render')
  })
}

try {
  await nativePaymentLinks()
  console.log('Mobile native payment links, returns and cancellation passed')
  await nativeMethods()
  console.log('Mobile native payment method consent, defaults and removal passed')
  await nativeInvoices()
  console.log('Mobile own-customer invoices, PDF downloads and capability refusals passed')
  await nativeReceipts()
  await nativePortal()
  await nativeBilling()
  await nativeRecovery()
  await nativeCollectionConsent()
  await nativeMessages()
  console.log(`mobileCustomerJourney passed: ${states} native states at 390 by 844, ${taps} taps; provider payment and mailbox delivery remain unqualified`)
} finally { await browser.close() }
