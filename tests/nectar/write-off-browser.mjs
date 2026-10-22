// Browser proof of AR-004's own screens at 1440 and 390 over the real Worker:
// the invoice's write-off section after execution and recovery, and the
// receivables and customer pages. Only the QuickBooks network edge is synthetic.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { harness } from './harness.mjs'
import { harnessOptions, writeOffFlow } from './write-offs.mjs'

const directory = process.env.NECTAR_EVIDENCE_DIR ?? '.evidence/write-offs'
await mkdir(directory, { recursive: true })
const h = await harness({ assets: true, ...harnessOptions() })
let browser
try {
  assert.equal((await h.raw('/auth/bootstrap', { body: { token: h.vars.SETUP_TOKEN, displayName: 'Nectar Owner' } })).status, 303)
  const owner = await h.signIn(h.vars.OWNER_EMAIL)
  await h.raw('/setup', { cookie: owner, form: new URLSearchParams({ confirm: 'yes' }) })
  await h.api('business.configure', owner, { legal_name: 'Cedar Software Inc', timezone: 'America/Los_Angeles', invoice_prefix: 'CD', payment_terms_days: 30 })
  await (await import('./policy-helper.mjs')).applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: 'CA', tax_mode: 'no_tax', tax_note: 'Reviewed browser proof' })
  await h.api('tax.review', owner, { revision: (await h.api('business', owner)).revision })
  const ids = await writeOffFlow(h, owner)
  browser = await chromium.launch({ headless: true, args: ['--use-mock-keychain', '--password-store=basic'] })
  const context = await browser.newContext()
  await context.addCookies(owner.split('; ').map(value => { const i = value.indexOf('='); return { name: value.slice(0, i), value: value.slice(i + 1), url: h.origin } }))
  const page = await context.newPage()
  for (const [label, path, text] of [['invoice-recovered', `/app/invoices/${ids.first}`, 'Bad debt write-offs'], ['invoice-two-person', `/app/invoices/${ids.second}`, 'Bad debt write-offs'], ['receivables', '/app/receivables', 'Written off'], ['customer', `/app/customers/${ids.customer}`, 'Written off']]) {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 950 })
      const response = await page.goto(h.origin + path)
      assert.equal(response.status(), 200)
      assert.ok((await page.content()).includes(text), `${label} shows ${text}`)
      assert.equal(await page.locator('main h1').count(), 1)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${label} fits ${width}`)
      await page.screenshot({ path: `${directory}/${width}-${label}.png`, fullPage: true })
      console.log(`BROWSER ${width} ${label}`)
    }
  }
} finally { await browser?.close(); await h.close() }
