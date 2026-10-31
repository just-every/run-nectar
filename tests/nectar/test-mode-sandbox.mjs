// Explicit held-key qualification, outside push Verify. The production clock
// stays pinned; only the product's persisted per-customer sandbox advances.
import { execFileSync } from 'node:child_process'
import { harness } from './harness.mjs'
import { applyPolicy } from './policy-helper.mjs'
import { testModeBillingFlow } from './test-mode-billing.mjs'
import { stripeSandbox, safeError, check } from './stripe-sandbox-client.mjs'

const receipt = { run: process.env.NECTAR_JOURNEY_RUN ?? 'DEV-004-held-key', head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), status: 'started', cleanup: [] }
let h, stripe
const remoteCustomers = []
const attachable = process.argv.includes('--attachable-card')
receipt.scenario = attachable ? 'attachable-nonretryable-card' : 'insufficient-funds-retry-qualification'
try {
  stripe = stripeSandbox(process.env.STRIPE_SECRET_KEY)
  const balance = await stripe.request('GET', '/v1/balance')
  check(balance.object === 'balance' && balance.livemode === false, 'test_balance_required')
  h = await harness({ localTime: '2026-10-01T12:00:00Z', stripeSecret: process.env.STRIPE_SECRET_KEY, stripeFetch: async request => {
    const response = await stripe.forward(request)
    if (!response.ok) {
      let value
      try { value = await response.clone().json() } catch { /* Safe status only. */ }
      receipt.providerFailures ??= []
      receipt.providerFailures.push({ path: new URL(request.url).pathname, ...safeError({ code: value?.error?.code ?? value?.error?.type, status: response.status, param: value?.error?.param }) })
    }
    return response
  } })
  await h.raw('/auth/bootstrap', { body: { token: h.vars.SETUP_TOKEN, displayName: 'Nectar Owner' } })
  const owner = await h.signIn(h.vars.OWNER_EMAIL)
  await h.raw('/setup', { cookie: owner, form: new URLSearchParams({ confirm: 'yes' }) })
  await h.api('business.configure', owner, { legal_name: 'Synthetic Sandbox Software', timezone: ['America', 'Los_Angeles'].join('/'), invoice_prefix: 'SB', payment_terms_days: 30 })
  await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: 'CA', tax_mode: 'no_tax', tax_note: 'Synthetic sandbox provider qualification' })
  await h.api('tax.review', owner, { revision: (await h.api('business', owner)).revision })
  receipt.proof = await testModeBillingFlow(h, owner, { edge: null, ...(attachable ? { attemptsPerInvoice: 1, declineCode: 'generic_decline' } : {}), provision: async (customer, catalog) => {
    const remote = await stripe.request('POST', '/v1/customers', { 'metadata[nectar_sandbox_customer]': customer, 'metadata[nectar_sandbox_catalog]': catalog, 'metadata[nectar_run]': stripe.run })
    remoteCustomers.push(remote.id)
    check(remote.object === 'customer' && remote.livemode === false && !remote.email, 'isolated_test_customer_required')
    const method = await stripe.request('POST', '/v1/payment_methods', { type: 'card', 'card[token]': attachable ? 'tok_chargeCustomerFail' : 'tok_chargeDeclinedInsufficientFunds',
      'metadata[nectar_sandbox_customer]': customer, 'metadata[nectar_sandbox_catalog]': catalog })
    if (attachable) {
      await stripe.request('POST', `/v1/payment_methods/${method.id}/attach`, { customer: remote.id })
      await stripe.request('POST', `/v1/customers/${remote.id}`, { 'invoice_settings[default_payment_method]': method.id })
      return remote.id
    }
    return { customer: remote.id, method: method.id }
  } })
  receipt.status = 'passed'
  receipt.boundary = 'Real Stripe test-account declines. Invoice dates, retry due times and states are the native sandbox clock; inbox previews are not external delivery.'
} catch (error) {
  receipt.status = 'failed'
  receipt.failure = safeError(error)
  // Native assertion text contains only synthetic business facts or safe API
  // error codes. Never emit request headers, private bindings or key values.
  if (error?.code === 'ERR_ASSERTION') receipt.failure.assertion = String(error.message).slice(0, 500)
  process.exitCode = 1
} finally {
  await h?.close()
  for (const id of remoteCustomers) {
    try { await stripe.request('DELETE', `/v1/customers/${id}`); receipt.cleanup.push({ customer: id, status: 'deleted' }) }
    catch (error) { receipt.cleanup.push({ customer: id, ...safeError(error) }); process.exitCode = 1 }
  }
  receipt.requests = stripe?.requests
  console.log(JSON.stringify(receipt, null, 2))
}
