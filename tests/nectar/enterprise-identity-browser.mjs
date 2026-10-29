import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { harness } from './harness.mjs'
import { enterpriseLinkingFlow } from './enterprise-linking.mjs'
import { enterpriseIdentityFlow } from './enterprise-identity.mjs'

if (process.argv[2] === 'oidc') await oidcBrowser()
else if (process.argv[2] === 'linking') await linkingBrowser()
else {
const directory = process.env.NECTAR_EVIDENCE_DIR ?? '.evidence/enterprise-identity'
await mkdir(directory, { recursive: true })
const h = await harness({ assets: true })
let browser
try {
  await h.raw('/auth/bootstrap', { body: { token: h.vars.SETUP_TOKEN, displayName: 'Alder owner' } })
  const owner = await h.signIn(h.vars.OWNER_EMAIL)
  await h.raw('/setup', { cookie: owner, form: new URLSearchParams({ confirm: 'yes' }) })
  await h.api('business.configure', owner, { legal_name: 'Alder Research Software', timezone: 'UTC', invoice_prefix: 'ALDER', payment_terms_days: 30 })
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args: ['--use-mock-keychain', '--password-store=basic', '--no-sandbox'] })
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
        if (width === 390) await memberPage.locator('label[for=menu]').click()
        assert.match(await memberPage.locator('body').innerText(), /Accountant/)
        if (width === 390) await memberPage.locator('label[for=menu]').click()
        assert.equal(await memberPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
        await memberPage.screenshot({ path: `${directory}/${width}-mapped-member.png`, fullPage: true })
      }
      await memberContext.close()
    }
  } })
} finally { await browser?.close(); await h.close() }

}

async function linkingBrowser() {
  const directory = process.env.NECTAR_EVIDENCE_DIR ?? '.evidence/enterprise-linking'
  await mkdir(directory, { recursive: true })
  const h = await harness({ assets: true })
  let browser
  try {
    await h.raw('/auth/bootstrap', { body: { token: h.vars.SETUP_TOKEN, displayName: 'Nectar owner' } })
    const owner = await h.signIn(h.vars.OWNER_EMAIL)
    await h.raw('/setup', { cookie: owner, form: new URLSearchParams({ confirm: 'yes' }) })
    await h.api('business.configure', owner, { legal_name: 'Nectar linking journey', timezone: 'UTC', invoice_prefix: 'LINK', payment_terms_days: 30 })
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args: ['--no-sandbox', '--use-mock-keychain', '--password-store=basic'] })
    const contexts = new Map()
    async function pageFor(cookie) {
      if (contexts.has(cookie)) return contexts.get(cookie)
      const context = await browser.newContext({ viewport: { width: 1440, height: 950 } })
      await context.addCookies(cookie.split('; ').map(value => { const i = value.indexOf('='); return { name: value.slice(0, i), value: value.slice(i + 1), url: h.origin } }))
      const page = await context.newPage()
      contexts.set(cookie, page)
      return page
    }
    async function capture(page, label, path) {
      await page.setViewportSize({ width: 1440, height: 950 })
      await page.goto(h.origin + path)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, label + ' fits')
      assert.equal(await page.locator('a,button,[role=button]').evaluateAll(nodes => nodes.filter(node => !node.textContent.trim() && node.querySelector('svg,img') && !node.getAttribute('aria-describedby')).length), 0)
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 950 })
        await page.screenshot({ path: `${directory}/${width}-${label}.png`, fullPage: true, mask: [page.locator('code.credential')] })
        console.log('BROWSER', width, label)
      }
      await page.setViewportSize({ width: 1440, height: 950 })
    }
    const ownerPage = await pageFor(owner)
    await enterpriseLinkingFlow(h, owner, {
      onState: async ({ label, member, request }) => {
        await capture(ownerPage, label, '/app/sso')
        if (label === 'link-pending') {
          assert.equal(await ownerPage.locator(`form input[name=link][value="${request.id}"]`).count(), 1)
          const memberPage = await pageFor(member.cookie)
          await capture(memberPage, 'member-link-start', '/app/security')
          assert.equal(await memberPage.getByRole('link', { name: 'Prove provider identity' }).count(), 1)
        }
        if (label === 'link-approved') {
          assert.match(await ownerPage.locator('body').innerText(), /Active/)
          const linkedPage = await pageFor(member.cookie)
          await linkedPage.goto(h.origin + '/app/security')
          assert.equal(await linkedPage.getByRole('link', { name: 'Prove provider identity' }).count(), 0, 'A managed member is already bound')
        }
        if (label === 'link-deprovisioned') assert.match(await ownerPage.locator('body').innerText(), /Ended/)
      },
      approve: async ({ request }) => {
        await ownerPage.goto(h.origin + '/app/sso')
        const form = ownerPage.locator('form').filter({ has: ownerPage.locator(`input[name=link][value="${request.id}"]`) })
        await Promise.all([ownerPage.waitForNavigation(), form.getByRole('button', { name: 'Approve member link' }).click()])
        assert.equal(await ownerPage.locator(`input[name=link][value="${request.id}"]`).count(), 0, 'Native form consumes the exact reviewed request')
      },
    })
  } finally { await browser?.close(); await h.close() }
}

async function oidcBrowser() {
  const { harnessOptions, enterpriseOidcFlow } = await import('./enterprise-oidc.mjs')
  const directory = process.env.NECTAR_EVIDENCE_DIR ?? '.evidence/enterprise-oidc'
  await mkdir(directory, { recursive: true })
  const h = await harness({ ...harnessOptions(), assets: true })
  let browser
  try {
    await h.raw('/auth/bootstrap', { body: { token: h.vars.SETUP_TOKEN, displayName: 'Nectar owner' } })
    const owner = await h.signIn(h.vars.OWNER_EMAIL)
    await h.raw('/setup', { cookie: owner, form: new URLSearchParams({ confirm: 'yes' }) })
    await h.api('business.configure', owner, { legal_name: 'Nectar enterprise journey', timezone: 'UTC', invoice_prefix: 'OIDC', payment_terms_days: 30 })
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args: ['--no-sandbox', '--use-mock-keychain', '--password-store=basic'] })
    const context = await browser.newContext({ viewport: { width: 1440, height: 950 } })
    await context.addCookies(owner.split('; ').map(value => { const i = value.indexOf('='); return { name: value.slice(0, i), value: value.slice(i + 1), url: h.origin } }))
    const ownerPage = await context.newPage()
    async function capture(page, label, path) {
      await page.setViewportSize({ width: 1440, height: 950 })
      await page.goto(h.origin + path)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, label + ' fits')
      assert.equal(await page.locator('a,button,[role=button]').evaluateAll(nodes => nodes.filter(node => !node.textContent.trim() && node.querySelector('svg,img') && !node.getAttribute('aria-describedby')).length), 0)
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 950 })
        await page.screenshot({ path: `${directory}/${width}-${label}.png`, fullPage: true })
        console.log('BROWSER', width, label)
      }
    }
    await enterpriseOidcFlow(h, owner, { onState: async ({ label, session }) => {
      await capture(ownerPage, label + '-settings', '/app/sso')
      assert.equal(await ownerPage.getByRole('heading', { name: 'OpenID Connect connection' }).count(), 1)
      assert.equal(await ownerPage.locator('[name=certificate]').count(), 0, 'OIDC settings never present an unrelated SAML reconfiguration form')
      const memberContext = await browser.newContext()
      await memberContext.addCookies(session.split('; ').map(value => { const i = value.indexOf('='); return { name: value.slice(0, i), value: value.slice(i + 1), url: h.origin } }))
      const page = await memberContext.newPage()
      await capture(page, label + '-member', '/app/security')
      assert.equal(await page.getByRole('link', { name: 'Prove provider identity' }).count(), 0)
      await memberContext.close()
    } })
  } finally { await browser?.close(); await h.close() }
}
