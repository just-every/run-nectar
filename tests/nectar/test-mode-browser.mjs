import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { harness } from './harness.mjs'
import { applyPolicy } from './policy-helper.mjs'
import { harnessOptions, sandboxTimezone, testModeFlow } from './test-mode.mjs'

const directory = process.env.NECTAR_EVIDENCE_DIR ?? '.evidence/test-mode'
await mkdir(directory, { recursive: true })
const h = await harness({ assets: true, ...harnessOptions() })
let browser
try {
  await h.raw('/auth/bootstrap', { body: { token: h.vars.SETUP_TOKEN, displayName: 'Nectar Owner' } })
  const owner = await h.signIn(h.vars.OWNER_EMAIL)
  await h.raw('/setup', { cookie: owner, form: new URLSearchParams({ confirm: 'yes' }) })
  await h.api('business.configure', owner, { legal_name: 'Synthetic Sandbox Software', timezone: sandboxTimezone, invoice_prefix: 'SB', payment_terms_days: 30 })
  await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: 'CA', tax_mode: 'no_tax', tax_note: 'Synthetic sandbox browser basis' })
  await h.api('tax.review', owner, { revision: (await h.api('business', owner)).revision })
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}), args: ['--no-sandbox', '--use-mock-keychain', '--password-store=basic'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), page = await context.newPage()
  const as = async cookie => {
    await context.clearCookies()
    await context.addCookies(cookie.split('; ').map(part => { const i = part.indexOf('='); return { name: part.slice(0, i), value: part.slice(i + 1), url: h.origin } }))
  }
  const submit = async form => {
    await Promise.all([page.waitForNavigation(), form.getByRole('button').click()])
    const url = new URL(page.url())
    assert.equal(url.searchParams.get('error'), null, 'Native sandbox form succeeds')
    return url
  }
  const form = action => page.locator(`form[action="/app/do/${action}"]`)
  await testModeFlow(h, owner, {
    bindProcessor: async (payload, developer) => {
      await as(developer)
      await page.goto(h.origin + `/app/settings/test-mode/${payload.customer}`)
      await page.getByText('Enable test billing', { exact: true }).click()
      const fields = form('sandbox.processor.bind')
      await fields.locator('[name="stripe_customer_ref"]').fill(payload.stripe_customer_ref)
      await fields.locator('[name="confirm"]').check()
      await submit(fields)
    },
    copyCatalog: async source => {
      await as(owner)
      await page.goto(h.origin + '/app/settings/test-mode')
      const fields = form('sandbox.catalog.copy')
      assert.equal(await fields.locator('[name="source_fingerprint"]').inputValue(), source.sourceFingerprint)
      await fields.locator('[name="confirm"]').check()
      await submit(fields)
      const saved = (await h.api('sandbox', owner)).catalogs.find(c => c.sourceFingerprint === source.sourceFingerprint)
      assert.ok(saved)
      return saved
    },
    createSecond: async payload => {
      await as(owner)
      await page.goto(h.origin + '/app/settings/test-mode')
      const fields = form('sandbox.customer.create').filter({ has: page.locator(`input[name="catalog"][value="${payload.catalog}"]`) })
      await fields.locator('xpath=..').locator('summary').click()
      for (const name of ['label', 'clock', 'trial_end']) await fields.locator(`[name="${name}"]`).fill(payload[name])
      await fields.locator('[name="price"]').selectOption(payload.price[0])
      await fields.locator('[name="quantity"]').fill(payload.quantity[0])
      return submit(fields)
    },
    advanceSecond: async (payload, developer) => {
      await as(developer)
      await page.goto(h.origin + `/app/settings/test-mode/${payload.customer}`)
      const fields = form('sandbox.clock.advance')
      await fields.locator('[name="clock"]').fill(payload.clock)
      await fields.locator('[name="confirm"]').check()
      return submit(fields)
    },
    onState: async ({ label, path }) => {
      await as(owner)
      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.goto(h.origin + path)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Sandbox content fits the desktop viewport')
      const textSizes = await page.locator('main p,main a,main button,main label,main input,main select,main li').evaluateAll(nodes => nodes.filter(n => n.getClientRects().length && parseFloat(getComputedStyle(n).fontSize) < 13).map(n => n.tagName))
      assert.deepEqual(textSizes, [], 'Sandbox text is at least 13px')
      const iconControls = await page.locator('button,a,[role="button"]').evaluateAll(nodes => nodes.filter(n => n.getClientRects().length && !n.textContent.trim() && n.querySelector('svg,img')).map(n => n.outerHTML))
      assert.deepEqual(iconControls, [], 'All sandbox controls have visible labels')
      if (label === 'thirteen-month-clock') {
        const state = await h.api(`sandbox/customers/${path.split('/').at(-1)}`, owner)
        assert.equal(await page.getByRole('heading', { name: 'Due 2028-01-31', exact: true }).count(), 2)
        for (const preview of state.previews) assert.ok((await page.locator('main').innerText()).includes((preview.rating.totalCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })), 'Visible totals match saved previews')
      }
      if (label === 'sandbox-annual-failures') {
        assert.equal(await page.getByRole('heading', { name: 'Sandbox invoices', exact: true }).count(), 1)
        assert.equal(await page.getByRole('heading', { name: 'Sandbox inbox and history', exact: true }).count(), 1)
        const text = await page.locator('main').innerText()
        assert.ok(text.includes('$10.98') && text.includes('$12.00'), 'Annual test invoices show independently reconciled cents')
        assert.equal((text.match(/failure notice preview/g) ?? []).length, 6)
      }
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 })
        await page.screenshot({ path: `${directory}/${label}-${width}.png`, fullPage: true })
        console.log('BROWSER', label, width)
      }
      await page.setViewportSize({ width: 1440, height: 1000 })
    },
  })
} finally {
  await browser?.close()
  await h.close()
}
