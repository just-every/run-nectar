import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { harness } from './harness.mjs'
import { applyPolicy } from './policy-helper.mjs'

const evidence = process.env.NECTAR_EVIDENCE_DIR ?? join(process.cwd(), '.evidence')

await mkdir(evidence, { recursive: true })

const h = await harness({ hostname: 'localhost', assets: true })

let browser

try {
  assert.equal((await h.raw('/auth/bootstrap', { body: { token: h.vars.SETUP_TOKEN, displayName: 'Nectar Owner' } })).status, 303)
  const owner = await h.signIn(h.vars.OWNER_EMAIL)
  await h.raw('/setup', { cookie: owner, form: new URLSearchParams({ confirm: 'yes' }) })
  await h.api('business.configure', owner, { legal_name: 'Cedar Software Inc', timezone: 'America/Los_Angeles', invoice_prefix: 'CD', payment_terms_days: 30 })
  await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: 'CA', tax_mode: 'no_tax', tax_note: 'Reviewed GOV-007 passkey journey' })
  await h.api('access.give', owner, { email: 'gov007-passkey@example.test', name: 'Pia Passkey', role: 'finance' })
  await h.api('mfa.policy', owner, { scope: 'roles', roles: ['finance'] })
  const signedIn = await h.signIn('gov007-passkey@example.test', { requested: true })

  browser = await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, headless: true, args: ['--no-sandbox', '--use-mock-keychain', '--password-store=basic'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const useCookie = async cookie => { await context.clearCookies(); await context.addCookies(cookie.split('; ').map(pair => { const at = pair.indexOf('='); return { name: pair.slice(0, at), value: pair.slice(at + 1), url: h.origin } })) }
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
  const shot = async name => { await page.screenshot({ path: join(evidence, `${page.viewportSize().width}-${name}.jpg`), fullPage: true, type: 'jpeg', quality: 82 }) }

  await useCookie(signedIn)
  await page.goto(`${h.origin}/app/customers`)
  assert.equal(new URL(page.url()).pathname, '/app/security', 'GOV-007 held at enrollment')
  await page.getByText('Enroll an authenticator app or a passkey').waitFor()
  await shot('gov007-held-enrollment')
  await page.getByRole('button', { name: 'Add a passkey' }).click()
  await page.getByText('Your passkey is on.').waitFor()
  assert.equal(await page.locator('#passkey-status .recovery-codes li').count(), 10, 'GOV-007 recovery codes after the passkey')
  assert.equal((await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials.length, 1, 'GOV-007 the virtual authenticator holds the passkey')
  await shot('gov007-passkey-enrolled')
  await page.getByRole('link', { name: 'Continue' }).click()
  await page.waitForURL(`${h.origin}/app/customers`)
  assert.equal(await page.locator('main h1').textContent(), 'Customers')

  // A new session is held at the check until the passkey is presented.
  await useCookie(await h.signIn('gov007-passkey@example.test'))
  await page.goto(`${h.origin}/app/receivables`)
  assert.equal(new URL(page.url()).pathname, '/app/security', 'GOV-007 held at the check')
  await page.getByText('Confirm it’s you with your second factor').waitFor()
  await shot('gov007-held-check')
  await page.getByRole('button', { name: 'Use a passkey' }).click()
  await page.waitForURL(`${h.origin}/app/receivables`)
  await shot('gov007-passkey-presented')
  const trail = (await h.api('audit', owner)).filter(row => row.action.startsWith('mfa.'))
  assert.ok(trail.some(row => row.action === 'mfa.enroll' && JSON.parse(row.detail).kind === 'passkey'))
  assert.ok(trail.some(row => row.action === 'mfa.verify' && JSON.parse(row.detail).method === 'passkey'))
  console.log('GOV-007 passkey enrollment and presentation in a WebAuthn virtual authenticator passed')
} finally { await browser?.close(); await h.close() }
