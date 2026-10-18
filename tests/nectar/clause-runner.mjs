// Focused execution of a contract journey against the real built HTTP Worker.
import assert from 'node:assert/strict'
import { harness } from './harness.mjs'
const h = await harness()
try {
  assert.equal((await h.raw('/auth/bootstrap', { body: { token: h.vars.SETUP_TOKEN, displayName: 'Nectar Owner' } })).status, 303)
  const owner = await h.signIn(h.vars.OWNER_EMAIL)
  await h.raw('/setup', { cookie: owner, form: new URLSearchParams({ confirm: 'yes' }) })
  await h.api('business.configure', owner, { legal_name: 'Cedar Software Inc', timezone: 'America/Los_Angeles', invoice_prefix: 'CD', payment_terms_days: 30 })
  await h.api('tax.declare', owner, { tax_jurisdiction: 'CA', tax_mode: 'no_tax', tax_note: 'No taxable sales under our reviewed policy' })
  await h.api('tax.review', owner, { revision: (await h.api('business', owner)).revision })
  const { [process.argv[3]]: run } = await import(`./${process.argv[2]}.mjs`)
  await run(h, owner)
} finally { await h.close() }
