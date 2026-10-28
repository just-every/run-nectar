import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { harness } from './harness.mjs'
import { applyPolicy } from './policy-helper.mjs'
import { portalReceiptsFlow } from './portal-receipts.mjs'

const directory = process.env.NECTAR_EVIDENCE_DIR ?? '.evidence/portal-receipts'
await mkdir(directory, { recursive: true })
const h = await harness({ assets: true })
let browser
try {
  await h.raw('/auth/bootstrap', { body: { token: h.vars.SETUP_TOKEN, displayName: 'Nectar Owner' } })
  const owner = await h.signIn(h.vars.OWNER_EMAIL)
  await h.raw('/setup', { cookie: owner, form: new URLSearchParams({ confirm: 'yes' }) })
  await h.api('business.configure', owner, { legal_name: 'Cedar Software Inc', timezone: 'America/Los_Angeles', invoice_prefix: 'RCPT', payment_terms_days: 30 })
  await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: 'CA', tax_mode: 'no_tax', tax_note: 'Reviewed synthetic receipt journey' })
  await h.api('tax.review', owner, { revision: (await h.api('business', owner)).revision })
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-mock-keychain', '--password-store=basic'] })
  const context = await browser.newContext(), page = await context.newPage()
  await portalReceiptsFlow(h, owner, { onState: async ({ label, path, number, pdfPath, status = 200 }) => {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      assert.equal((await page.goto(h.origin + path)).status(), status)
      if (number) assert.ok((await page.locator('main').innerText()).includes(number))
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${label} fits at ${width}`)
      const small = await page.locator('main *').evaluateAll(nodes => nodes.filter(n => n.textContent.trim() && parseFloat(getComputedStyle(n).fontSize) < 13).map(n => n.tagName))
      assert.deepEqual(small, [], 'Customer receipt text is at least 13px')
      const icons = await page.locator('a,button,[role=button]').evaluateAll(nodes => nodes.filter(n => !n.textContent.trim() && n.querySelector('svg,img') && !n.getAttribute('aria-describedby')).map(n => n.tagName))
      assert.deepEqual(icons, [], 'Icon controls have descriptive tooltips')
      await page.screenshot({ path: `${directory}/${width}-${label}.png`, fullPage: true })
      if (pdfPath && width === 1440) {
        const download = page.waitForEvent('download')
        await page.locator('a[href*="format=pdf"]').click()
        const downloaded = await download
        assert.match(downloaded.suggestedFilename(), /^RCT-\d+\.pdf$/)
        await downloaded.saveAs(`${directory}/${label}.pdf`)
      }
      console.log('BROWSER', width, label)
    }
  } })
} finally { await browser?.close(); await h.close() }
