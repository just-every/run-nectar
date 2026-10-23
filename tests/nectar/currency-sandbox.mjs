// Outside push Verify. Run only through the held-key helper with an explicitly
// finance-entered NECTAR_CAD_USD_RATE and NECTAR_CAD_USD_SOURCE for today's UTC date.
// The Worker uses the real Stripe test account; no provider response is faked.
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { stripeSandbox, check, reference, safeError } from './stripe-sandbox-client.mjs'
import { applyPolicy } from './policy-helper.mjs'
import { totp } from './mfa.mjs'

const receipt = { version: 1, journey: 'Canadian price, invoice, native Stripe capture, credit and sourced daily USD report', status: 'running', checks: {}, cleanup: [] }
let phase = 'finance-rate-input', stripe, clock, providerCustomer, h, owner
const posts = [], date = new Date().toISOString().slice(0, 10)
const rate = process.env.NECTAR_CAD_USD_RATE, source = process.env.NECTAR_CAD_USD_SOURCE
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const step = value => { phase = value; console.log(`Currency Stripe sandbox: ${value}`) }
const api = (path, body, status) => h.api(path, owner, body, status)
function converted(cents) {
  const [whole, fraction = ''] = rate.split('.'), scaled = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'))
  return Number((BigInt(cents) * scaled + 500000n) / 1000000n)
}

async function providerSources() {
  check(typeof rate === 'string' && /^\d{1,12}(\.\d{1,6})?$/.test(rate) && Number(rate) > 0, 'finance_entered_daily_rate_required')
  check(typeof source === 'string' && source.trim().length > 0 && source.length <= 300, 'finance_entered_daily_rate_source_required')
  stripe = stripeSandbox(process.env.STRIPE_SECRET_KEY)
  step('owned-us-test-account-and-canadian-customer')
  const account = await stripe.request('GET', '/v1/account')
  check(account.country === 'US', 'us_seller_test_account_required')
  const created = await stripe.request('POST', '/v1/test_helpers/test_clocks', { frozen_time: Math.floor(Date.now() / 1000) - 60, name: `Nectar CAD ${stripe.run}` })
  clock = created.id
  const method = await stripe.request('POST', '/v1/payment_methods', { type: 'card', 'card[token]': 'tok_visa' })
  providerCustomer = await stripe.request('POST', '/v1/customers', { name: `Synthetic Canadian customer ${stripe.run}`, 'address[country]': 'CA', test_clock: clock,
    payment_method: method.id, 'invoice_settings[default_payment_method]': method.id, 'metadata[nectar_run]': stripe.run })
  check(!providerCustomer.email && providerCustomer.test_clock === clock && reference(providerCustomer.invoice_settings.default_payment_method) === method.id, 'owned_saved_card_required')
  receipt.provider = { account: account.id, customer: providerCustomer.id, method: method.id, clock }
}
async function prepareInvoice() {
  step('ordinary-owner-cad-price-and-invoice')
  const { harness } = await import('./harness.mjs')
  h = await harness({ localTime: new Date().toISOString(), stripeSecret: process.env.STRIPE_SECRET_KEY, stripeFetch: request => stripe.forward(request, entry => {
    if (entry.method === 'POST') { check(entry.path === '/v1/payment_intents' && entry.fields.get('currency') === 'cad' && entry.fields.get('amount') === '899', 'unexpected_provider_mutation'); posts.push({ path: entry.path, currency: entry.fields.get('currency'), amount: entry.fields.get('amount'), key: entry.idempotencyKey }) }
  }) })
  check((await h.raw('/auth/bootstrap', { body: { token: h.vars.SETUP_TOKEN, displayName: 'Synthetic currency sandbox owner' } })).status === 303, 'owner_bootstrap_failed')
  owner = await h.signIn(h.vars.OWNER_EMAIL)
  check((await h.raw('/setup', { cookie: owner, form: new URLSearchParams({ confirm: 'yes' }) })).status === 303, 'owner_setup_failed')
  await api('business.configure', { legal_name: 'Synthetic US currency sandbox', address: '1 Synthetic Way, CA, US', timezone: 'UTC', invoice_prefix: 'FX', payment_terms_days: 30 })
  await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: 'CA', tax_mode: 'no_tax', tax_note: 'Owned test-mode currency validation; no tax service requested' })
  await api('tax.review', { revision: (await api('business')).revision })
  const product = (await api('product.create', { code: 'synthetic-nectar-201', name: 'Synthetic Canadian service' })).id
  const price = (await api('price.create', { product, kind: 'flat', unit_amount: '10', currency: 'CAD', taxable: false })).id
  const customer = (await api('customer.create', { external_id: 'synthetic-nectar-202', name: 'Synthetic Canadian customer', billing_email: 'synthetic-nectar-202@example.test', address: '1 Synthetic Way, Toronto, Canada', currency: 'CAD' })).id
  const charge = await api('charge.add', { customer, price, effective_date: date })
  const draft = await api('invoice.manual', { customer, charges: [charge.charge], service_date: date })
  await api('invoice.approve', { invoice: draft.id, acknowledge: true })
  await api('invoice.finalise', { invoice: draft.id, issue_date: date })
  const original = await api(`invoices/${draft.id}`)
  check(original.currency === 'CAD' && original.total_cents === 1000, 'cad_invoice_required')
  await api('currency.rate.record', { currency: 'CAD', rate_date: date, usd_per_unit: rate, source })
  await api('credit.issue', { invoice: draft.id, amount: '1.01', reason: 'Synthetic CAD sandbox pre-collection adjustment' })
  const instant = Date.now(), factor = await api('mfa.totp.start', {})
  await h.advanceClock(new Date(instant).toISOString())
  await api('mfa.totp.confirm', { factor: factor.factor, code: totp(factor.secret, instant) })
  await api('mfa.policy', { scope: 'all' })
  await api('collection.customer.bind', { customer, account_ref: receipt.provider.account, stripe_customer_ref: providerCustomer.id, confirm: true })
  receipt.native = { customer, price, invoice: draft.id }
  receipt.originalHash = digest({ calculation: original.calculation, lines: original.lines, fingerprint: original.source_fingerprint })
  return { original, customer, invoice: draft.id }
}
async function collectAndReport(context) {
  step('native-cad-capture-and-daily-usd-report')
  const prepared = await api('collection.prepare', { invoice: context.invoice })
  check(prepared.review.currency === 'cad' && prepared.review.amountCents === 899, 'cad_native_review_required')
  const collection = await api('collection.confirm', prepared.instructions.confirm)
  check(collection.status === 'collected' && collection.proof.currency === 'cad', 'native_cad_collection_failed')
  const intent = await stripe.request('GET', `/v1/payment_intents/${collection.payment_intent_ref}`)
  const charge = await stripe.request('GET', `/v1/charges/${collection.charge_ref}`)
  check(intent.currency === 'cad' && intent.amount_received === 899 && intent.status === 'succeeded' && intent.livemode === false && reference(intent.customer) === providerCustomer.id, 'real_cad_payment_intent_required')
  check(charge.currency === 'cad' && charge.amount_captured === 899 && charge.paid === true && charge.captured === true && charge.livemode === false && reference(charge.payment_intent) === intent.id, 'real_cad_captured_charge_required')
  const current = await api(`invoices/${context.invoice}`), ledger = (await api(`customers/${context.customer}`)).ledger
  check(current.currency === 'CAD' && current.balanceCents === 0 && current.paidCents === 899 && current.creditedCents === 101, 'native_cad_ledger_not_settled')
  check(digest({ calculation: current.calculation, lines: current.lines, fingerprint: current.source_fingerprint }) === receipt.originalHash, 'issued_history_changed')
  check(ledger.payments[0].currency === 'CAD' && ledger.payments[0].amount_cents === 899 && ledger.credits[0].currency === 'CAD' && ledger.credits[0].amount_cents === 101, 'transaction_currency_not_retained')
  const report = await api(`reports/currency?from=${date}&to=${date}`)
  check(report.totals.invoice === converted(1000) && report.totals.payment === converted(899) && report.totals.credit === converted(101), 'daily_usd_values_not_exact')
  check(report.transactions.every(row => row.currency === 'CAD' && row.reporting.currency === 'USD' && row.reporting.source === source && row.reporting.rateDate === date), 'rate_source_date_missing')
  await api('collection.confirm', prepared.instructions.confirm, 409)
  check(posts.length === 1, 'duplicate_provider_capture')
  receipt.provider.intent = intent.id; receipt.provider.charge = charge.id
  receipt.native.collection = collection.id; receipt.native.payment = collection.payment_id
  receipt.reporting = report; receipt.checks = { cadPriceInvoiceCreditAndPayment: true, realStripeCadCapture: true, exactUsdReportingWithSourceAndDate: true, issuedHistoryPreserved: true, oneCapture: true }
}
try {
  receipt.head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  await providerSources()
  await collectAndReport(await prepareInvoice())
  receipt.status = 'passed'
} catch (error) {
  receipt.status = 'failed'; receipt.failure = { phase, ...safeError(error) }; process.exitCode = 1
  console.error(`Currency Stripe sandbox: failed phase=${phase} code=${receipt.failure.code}`)
} finally {
  if (h) try { await h.close() } catch { receipt.status = 'failed'; receipt.runtimeCleanup = false; process.exitCode = 1 }
  if (clock) try { const deleted = await stripe.request('DELETE', `/v1/test_helpers/test_clocks/${clock}`); check(deleted.deleted, 'clock_cleanup_unconfirmed'); receipt.cleanup.push({ clock, deleted: true }) }
  catch (error) { receipt.status = 'failed'; receipt.cleanup.push({ clock, deleted: false, ...safeError(error) }); process.exitCode = 1 }
  await mkdir('.evidence', { recursive: true, mode: 0o700 })
  await writeFile('.evidence/currency-sandbox.json', `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
  console.log(`Currency Stripe sandbox: ${receipt.status}; receipt=.evidence/currency-sandbox.json`)
}
