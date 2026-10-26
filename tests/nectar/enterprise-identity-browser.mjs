import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { harness } from './harness.mjs'
import { enterpriseIdentityFlow } from './enterprise-identity.mjs'

const directory = process.env.NECTAR_EVIDENCE_DIR ?? '.evidence/enterprise-identity'
await mkdir(directory, { recursive: true })
const h = await harness({ assets: true })
let browser
try {
  await h.raw('/auth/bootstrap', { body: { token: h.vars.SETUP_TOKEN, displayName: 'Alder owner' } })
  const owner = await h.signIn(h.vars.OWNER_EMAIL)
  await h.raw('/setup', { cookie: owner, form: new URLSearchParams({ confirm: 'yes' }) })
  await h.api('business.configure', owner, { legal_name: 'Alder Research Software', timezone: 'UTC', invoice_prefix: 'ALDER', payment_terms_days: 30 })
  browser = await chromium.launch({ headless: true, args: ['--use-mock-keychain', '--password-store=basic'] })
  const context = await browser.newContext()
  await context.addCookies(owner.split('; ').map(value => { const i = value.indexOf('='); return { name: value.slice(0, i), value: value.slice(i + 1), url: h.origin } }))
  const page = await context.newPage()
  async function capture(label, path) {
    if (path) await page.goto(h.origin + path)
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 950 })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, label + ' fits the viewport')
      const iconOnly = await page.locator('a,button,[role=button]').evaluateAll(nodes => nodes.filter(node => !node.textContent.trim() && node.querySelector('svg,img') && !node.getAttribute('aria-describedby')).length)
      assert.equal(iconOnly, 0, 'every control has visible text or a tooltip')
      await page.screenshot({ path: `${directory}/${width}-${label}.png`, fullPage: true, mask: [page.locator('code.credential')] })
      console.log('BROWSER', width, label)
    }
  }
  await capture('access', '/app/access')
  await page.getByRole('link', { name: 'Enterprise sign-in and provisioning' }).click()
  await capture('empty-settings')
  await enterpriseIdentityFlow(h, owner, { configure: async settings => {
    await page.locator('[name=issuer]').fill(settings.issuer)
    await page.locator('[name=entry_point]').fill(settings.entry_point)
    await page.locator('[name=certificate]').fill(settings.certificate)
    await page.locator('[name=role_map]').fill(JSON.stringify(settings.role_map))
    await capture('connection-review')
    await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Authorize connection' }).click()])
    assert.equal(await page.locator('code.credential').count(), 1, 'the native form returns a once-shown credential')
    const scim_token = await page.locator('code.credential').innerText()
    await capture('connection-authorized')
    return { revision: 1, scim_token }
  }, onState: async state => {
    await capture(state.label + '-settings', '/app/sso')
    if (state.label === 'mfa-signed-in') {
      const memberContext = await browser.newContext()
      await memberContext.addCookies(state.member.split('; ').map(value => { const i = value.indexOf('='); return { name: value.slice(0, i), value: value.slice(i + 1), url: h.origin } }))
      const memberPage = await memberContext.newPage()
      for (const width of [1440, 390]) {
        await memberPage.setViewportSize({ width, height: 950 })
        await memberPage.goto(h.origin + '/app/customers')
        assert.match(await memberPage.locator('body').innerText(), /Accountant/)
        assert.equal(await memberPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
        await memberPage.screenshot({ path: `${directory}/${width}-mapped-member.png`, fullPage: true })
      }
      await memberContext.close()
    }
  } })
} finally { await browser?.close(); await h.close() }
