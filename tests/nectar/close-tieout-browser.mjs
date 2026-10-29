// Browser proof of the same close-preparation journey, using existing components.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { harness } from './harness.mjs'
import { applyPolicy } from './policy-helper.mjs'
import { closeTieoutFlow, harnessOptions } from './close-tieout.mjs'

const directory = process.env.NECTAR_EVIDENCE_DIR ?? '.evidence/close-tieout'
await mkdir(directory, { recursive: true })
const h = await harness({ assets: true, ...harnessOptions() })
let browser
try {
  await h.raw('/auth/bootstrap', { body: { token: h.vars.SETUP_TOKEN, displayName: 'Nectar Owner' } })
  const owner = await h.signIn(h.vars.OWNER_EMAIL)
  await h.raw('/setup', { cookie: owner, form: new URLSearchParams({ confirm: 'yes' }) })
  await h.api('business.configure', owner, { legal_name: 'Native Close Software', timezone: 'America/Los_Angeles', invoice_prefix: 'CLOSE', payment_terms_days: 30 })
  await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: 'CA', tax_mode: 'no_tax', tax_note: 'Reviewed close preparation journey' })
  await h.api('tax.review', owner, { revision: (await h.api('business', owner)).revision })
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}), args: ['--no-sandbox', '--use-mock-keychain', '--password-store=basic'] })
  const context = await browser.newContext()
  await context.addCookies(owner.split('; ').map(value => { const i = value.indexOf('='); return { name: value.slice(0, i), value: value.slice(i + 1), url: h.origin } }))
  const page = await context.newPage()
  await closeTieoutFlow(h, owner, { onState: async state => {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 950 })
      await page.goto(`${h.origin}/app/close-tieout?period=2026-09`)
      await page.getByRole('heading', { name: 'Close preparation', exact: true }).waitFor()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `The ${state} packet fits at ${width}`)
      // Functional assertions use one width; the second width is the phone smoke and screen proof.
      if (width === 1440) {
        await page.getByRole('link', { name: 'Revenue schedules and period close' }).waitFor()
        const scan = page.locator('form[action="/app/do/close.scan"]')
        if (state === 'open') {
          await Promise.all([page.waitForNavigation(), scan.getByRole('button', { name: 'Scan for review items' }).click()])
          assert.equal(new URL(page.url()).searchParams.get('error'), null)
          assert.equal(await page.locator('article').filter({ hasText: 'Unapplied received cash' }).count(), 1)
          assert.equal(await page.locator('article').filter({ hasText: 'Bad-debt synchronization failure' }).count(), 1)
          assert.equal(await page.locator('article').filter({ hasText: 'Payout and fee reconciliation' }).count(), 1)
          assert.equal(await page.locator('article').filter({ hasText: 'Credit-note synchronization' }).count(), 1)
          const recheck = page.locator('form[action="/app/do/assurance.recheck"]').first()
          await Promise.all([page.waitForNavigation(), recheck.getByRole('button').click()])
          assert.equal(new URL(page.url()).searchParams.get('error'), null)
        }
        const undersized = await page.locator('main').evaluate(root => [...root.querySelectorAll('p,h1,h2,h3,label,button,td,th,a,summary')].filter(element => parseFloat(getComputedStyle(element).fontSize) < 13).map(element => element.tagName))
        assert.deepEqual(undersized, [], 'Every touched screen uses readable text')
      }
      await page.screenshot({ path: `${directory}/${width}-${state}.png`, fullPage: true })
      console.log(`BROWSER ${width} ${state}`)
    }
  } })
} finally { await browser?.close(); await h.close() }
