import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { harness } from './harness.mjs'
import { applyPolicy } from './policy-helper.mjs'
import { invoiceVoidFlow } from './one-time.mjs'
import { harnessOptions,invoiceRefundExecutionFlow,invoiceTaxRefundFlow,invoiceCancellationRefundFlow,getInvoiceRefundEdge } from './invoice-refund-preview.mjs'
const directory = process.env.NECTAR_EVIDENCE_DIR ?? '.evidence/invoice-voids'
await mkdir(directory, { recursive: true })
console.log('INVOICE VOID BROWSER HEAD', execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim())
const refunds=process.argv[2]==='refunds'
const h = await harness({ ...(refunds?harnessOptions():{}),assets: true }); let browser
try {
  await h.raw('/auth/bootstrap', { body: { token: h.vars.SETUP_TOKEN, displayName: 'Nectar Owner' } })
  const owner = await h.signIn(h.vars.OWNER_EMAIL)
  await h.raw('/setup', { cookie: owner, form: new URLSearchParams({ confirm: 'yes' }) })
  await h.api('business.configure', owner, { legal_name: 'Synthetic service business', timezone: 'UTC', invoice_prefix: 'VOID', payment_terms_days: 30 })
  await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: 'CA', tax_mode: 'no_tax', tax_note: 'Synthetic no-tax void journey' })
  await h.api('tax.review', owner, { revision: (await h.api('business', owner)).revision })
  browser = await chromium.launch({ headless: true, executablePath: process.env.NECTAR_CHROMIUM_PATH, args: ['--no-sandbox', '--use-mock-keychain', '--password-store=basic'] })
  const context = await browser.newContext()
  await context.addCookies(owner.split('; ').map(part => { const at = part.indexOf('='); return { name: part.slice(0, at), value: part.slice(at + 1), url: h.origin } }))
  const page = await context.newPage()
  const onState = async ({ label, id, kind }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto(h.origin + (kind==='settings'?'/app/settings':`/app/${kind==='proposal'?'proposals':'invoices'}/${id}`))
    if(kind==='settings') {
      assert.equal(await page.getByLabel('Allow reviewed original-method cancellation refunds').count(),1)
    } else if(kind==='cancellation') {
      assert.equal(await page.getByRole('heading',{name:'Invoice refunds'}).count(),1)
      assert.equal(await page.getByRole('columnheader',{name:'Tax reversal',exact:true}).count(),1)
    } else if(kind==='proposal') {
      assert.equal(await page.getByRole('heading',{name:'Invoice refund simulation'}).count(),1)
    } else if(refunds) {
      assert.equal(await page.getByRole('heading',{name:'Invoice refunds'}).count(),1)
      assert.equal(await page.getByText('Customer balance',{exact:true}).count(),1)
    } else {
      const link = label.endsWith('original') ? page.getByRole('link', { name: 'Open replacement invoice' }) : page.getByRole('link', { name: 'the original invoice', exact: true })
      assert.equal(await link.count(), 1)
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    const icons = await page.locator('a,button,[role=button]').evaluateAll(nodes => nodes.filter(node => !node.textContent.trim() && node.querySelector('svg,img') && !node.getAttribute('aria-describedby')).map(node => node.outerHTML))
    assert.deepEqual(icons, [], 'Every icon control has a descriptive tooltip')
    await page.screenshot({ path: `${directory}/1440-${label}.png`, fullPage: true })
    await page.setViewportSize({ width: 390, height: 1000 })
    await page.screenshot({ path: `${directory}/390-${label}.png`, fullPage: true })
    console.log('BROWSER 1440 and 390', label)
  }
  if(refunds) {
    // The edge assertions run in the HTTP journey; this mode records its screen.
    await invoiceRefundExecutionFlow(h,owner,{account:'synthetic-nectar-native-account-1',customerRef:'synthetic-nectar-native-customer-3',edge:getInvoiceRefundEdge(),onState})
    await invoiceTaxRefundFlow(h,owner,{account:'synthetic-nectar-native-account-1',customerRef:'synthetic-nectar-native-customer-3',processor:getInvoiceRefundEdge(),onState})
    await invoiceCancellationRefundFlow(h,owner,{account:'synthetic-nectar-native-account-1',customerRef:'synthetic-nectar-native-customer-5',processor:getInvoiceRefundEdge(),onState})
  } else await invoiceVoidFlow(h,owner,{onState})
} finally { await browser?.close(); await h.close() }
