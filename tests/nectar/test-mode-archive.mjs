// Real public export, reset and import preserve sandbox evidence, while
// restoring no executable processor consent. Run only in a fresh checkout.
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { readArchive } from '@runeditrun/rer/modules/portability'
import { harness } from './harness.mjs'
import { command } from './cli.mjs'
import { applyPolicy } from './policy-helper.mjs'
import { sandboxProcessor, testModeBillingFlow } from './test-mode-billing.mjs'
import { totp } from './mfa.mjs'

assert.equal(process.env.NECTAR_TEST_CHECKOUT, '1', 'Use only a fresh disposable checkout')
const root = process.cwd()
for (const path of ['.dev.vars', '.wrangler/state']) await access(join(root, path)).then(() => { throw new Error('A fresh unconfigured checkout is required') }, error => { if (error.code !== 'ENOENT') throw error })
await mkdir('exports', { recursive: true })
const scratch = await mkdtemp(join(root, 'exports', 'sandbox-archive-'))
const empty = join(scratch, 'empty.rer'), populated = join(scratch, 'populated.rer')
let h
try {
  await command(root, ['export', '--output', empty])
  const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'))
  const databaseId = config.d1_databases.find(binding => binding.binding === 'DB').database_id
  const options = { persistence: join(root, '.wrangler/state/v3'), databaseId, applyMigrations: false, localTime: '2026-10-01T12:00:00Z', stripeFetch: sandboxProcessor.fetch, stripeSecret: 'synthetic-nectar-sandbox-secret' }
  h = await harness(options)
  await h.raw('/auth/bootstrap', { body: { token: h.vars.SETUP_TOKEN, displayName: 'Nectar Owner' } })
  const owner = await h.signIn(h.vars.OWNER_EMAIL)
  await h.raw('/setup', { cookie: owner, form: new URLSearchParams({ confirm: 'yes' }) })
  await h.api('business.configure', owner, { legal_name: 'Synthetic Sandbox Software', timezone: ['America', 'Los_Angeles'].join('/'), invoice_prefix: 'SB', payment_terms_days: 30 })
  await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: 'CA', tax_mode: 'no_tax', tax_note: 'Synthetic sandbox archive basis' })
  await h.api('tax.review', owner, { revision: (await h.api('business', owner)).revision })
  let factor
  const api = h.api
  h.api = async (...args) => {
    const result = await api(...args)
    if (args[0] === 'mfa.totp.start') factor = result.secret
    return result
  }
  const proof = await testModeBillingFlow(h, owner)
  const before = await h.api(`sandbox/customers/${proof.customer}`, owner)
  const settings = { ...h.vars }
  await h.close(); h = null
  await command(root, ['export', '--output', populated])
  const bytes = await readFile(populated), items = []
  for await (const record of readArchive(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } }))) {
    if (record.kind === 'part') items.push(...record.items)
  }
  const rows = items.filter(item => item.kind === 'row')
  assert.ok(rows.some(item => item.table === 'nc_sandbox_invoices' && item.row.customer_id === proof.customer), 'The actual archive contains populated sandbox invoices')
  assert.ok(rows.some(item => item.table === 'nc_sandbox_attempts' && item.row.customer_id === proof.customer), 'The actual archive contains provider outcomes')
  assert.ok(!rows.some(item => item.table === 'nc_sandbox_processor_authority'), 'The actual archive contains no executable sandbox debit consent')
  await command(root, ['reset', '--yes'])
  await command(root, ['import', '--input', populated, '--yes'])
  h = await harness({ ...options, settings })
  assert.equal((await h.raw('/auth/bootstrap', { body: { token: h.vars.SETUP_TOKEN, displayName: 'Restored owner' } })).status, 303)
  const restoredOwner = await h.signIn(h.vars.OWNER_EMAIL)
  await h.api('mfa.verify', restoredOwner, { code: totp(factor, Date.parse(options.localTime)) })
  const after = await h.api(`sandbox/customers/${proof.customer}`, restoredOwner)
  assert.deepEqual(after, { ...before, billing: { ...before.billing, enabled: false, processor: null } }, 'Public restore retains all clock, calendar, invoice, retry, cent and inbox evidence exactly')
  const writes = sandboxProcessor.writes.length
  const liveBefore = await h.api(`customers/${proof.liveCustomer}`, restoredOwner)
  await h.api('collection.customer.bind', restoredOwner, { customer: proof.liveCustomer, account_ref: 'synthetic-nectar-sandbox-account', stripe_customer_ref: proof.remote, confirm: true }, 409)
  assert.deepEqual(await h.api(`customers/${proof.liveCustomer}`, restoredOwner), liveBefore, 'Restored test-object custody still refuses live identifier crossover')
  await h.api('sandbox.billing.reconcile', restoredOwner, { customer: proof.customer, confirm: true }, 409)
  await h.api('sandbox.processor.bind', restoredOwner, { customer: proof.customer, stripe_customer_ref: proof.remote, confirm: true }, 409)
  const advanced = await h.api('sandbox.clock.advance', restoredOwner, { customer: proof.customer, revision: after.revision, clock: '2028-02-02T08:00:00Z', confirm: true })
  assert.equal(advanced.execution, null)
  assert.equal(sandboxProcessor.writes.length, writes, 'Neither replay, rebind nor an explicit restored clock advance revives a test debit')
  assert.deepEqual((await h.api(`sandbox/customers/${proof.customer}`, restoredOwner)).billing, after.billing)
  console.log('DEV-004 real archive: exact restored sandbox clocks, invoices, provider outcomes and inbox evidence; no restored debit authority passed')
} finally {
  await h?.close()
  await rm(scratch, { recursive: true, force: true })
}
