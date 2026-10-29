// Native customer journeys use real touch input, Worker routes and D1.
// Processor and mail substitutions remain at the existing network edges.
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { harness } from './harness.mjs'
import { applyPolicy } from './policy-helper.mjs'
import { paymentLinksFlow, harnessOptions as linkOptions } from './payment-links.mjs'
import { customerSearchFlow, harnessOptions as methodOptions } from './customer-search.mjs'
import { dunningSequenceFlow, harnessOptions as dunningOptions } from './dunning-sequences.mjs'
import { cardExpiryNoticesFlow, harnessOptions as expiryOptions } from './card-expiry-notices.mjs'
import { seedPortalRecords } from './portal-sessions.mjs'

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
  await nativeMessages()
  console.log(`mobileCustomerJourney passed: ${states} native states at 390 by 844, ${taps} taps; provider payment and mailbox delivery remain unqualified`)
} finally { await browser.close() }
