// Outside push Verify. Build the candidate, then use the held-key injector to
// provide STRIPE_SECRET_KEY and run: node tests/nectar/payment-retries-sandbox.mjs
// Real Stripe responses pass through unchanged. Only safe facts reach stdout.
// Documented attachable decline tokens:
// https://docs.stripe.com/testing#declined-payments
// No Stripe Billing invoice or subscription is created by this journey.
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { stripeSandbox, check, reference, safeError, SandboxFailure } from './stripe-sandbox-client.mjs'
import { totp } from './mfa.mjs'

const start = Math.floor(Date.now() / 1000) - 60
const day = 86400000
const iso = milliseconds => new Date(milliseconds).toISOString()
const date = milliseconds => iso(milliseconds).slice(0, 10)
const result = { version: 1, clause: 'DUN-001', status: 'running', clauseComplete: false, head: null,
  accountRef: null, checks: { liveRetryBeforeDueAtDueAndRepeat: false }, sources: [], limitations: [], cleanup: [],
  documentation: ['https://docs.stripe.com/testing#declined-payments',
    'https://docs.stripe.com/billing/testing/test-clocks/api-advanced-usage'] }
const sources = [], writes = []
let stripe, h, owner, factor, phase = 'candidate', instant = start * 1000
// Bound local HTTP as well as provider requests, including harness sign-in.
const nativeFetch = globalThis.fetch
globalThis.fetch = (input, options = {}) => nativeFetch(input, { ...options,
  signal: AbortSignal.any([AbortSignal.timeout(25000), ...[options.signal].filter(Boolean),
    ...(input instanceof Request ? [input.signal] : [])]) })

async function api(path, body, expected = 200) {
  const response = await h.raw(`/api/nectar/${path}`, { cookie: owner, body })
  let value
  try { value = await response.json() } catch { throw new SandboxFailure('nectar_invalid_json', response.status) }
  if (response.status !== expected) {
    const error = safeError({ code: value?.error ?? value?.code })
    throw new SandboxFailure(error.code === 'sandbox_failure' ? 'nectar_unexpected_status' : error.code, response.status)
  }
  return value
}

async function forward(request) {
  return stripe.forward(request, entry => {
    const create = entry.path === '/v1/payment_intents'
    const confirm = /^\/v1\/payment_intents\/[A-Za-z0-9_]+\/confirm$/.test(entry.path)
    check(entry.method !== 'POST' || create || confirm, 'unexpected_worker_provider_write')
    if (entry.method !== 'POST') return
    check(entry.fields.get('off_session') === 'true' && (!create || entry.fields.get('confirm') === 'true')
      && !entry.fields.has('receipt_email') && !entry.fields.has('payment_method_data[card][number]')
      && !entry.fields.has('payment_method_data[us_bank_account][account_number]'), 'unsafe_payment_parameters')
    check(entry.idempotencyKey, 'payment_idempotency_key_missing')
    writes.push({ path: entry.path, key: entry.idempotencyKey, at: instant })
  })
}

async function providerSources() {
  phase = 'owned-provider-sources'
  stripe = stripeSandbox(process.env.STRIPE_SECRET_KEY)
  const account = await stripe.request('GET', '/v1/account')
  check(account.object === 'account' && account.country === 'US', 'us_stripe_test_account_required')
  result.accountRef = account.id
  for (const [index, scenario] of ['generic', 'lost', 'stolen'].entries()) {
    const source = { index, scenario, amount: 1200, methods: [] }
    sources.push(source)
    const clock = await stripe.request('POST', '/v1/test_helpers/test_clocks', {
      frozen_time: start, name: `synthetic-nectar-retry-${index + 1}` })
    source.clockRef = clock.id
    check(clock.status === 'ready' && clock.frozen_time === start, 'provider_clock_not_ready')
    const customer = await stripe.request('POST', '/v1/customers', {
      name: `synthetic-nectar-retry-${index + 4}`, test_clock: clock.id, 'metadata[nectar_run]': stripe.run })
    source.customerRef = customer.id
    check(customer.test_clock === clock.id && customer.livemode === false && !customer.email, 'provider_customer_mismatch')
    const token = { generic: 'tok_chargeCustomerFail', lost: 'tok_visa_chargeCustomerFailLostCard',
      stolen: 'tok_visa_chargeCustomerFailStolenCard' }[scenario]
    const method = await stripe.request('POST', '/v1/payment_methods', { type: 'card', 'card[token]': token })
    source.methodRef = method.id; source.methods.push(method.id)
    await stripe.request('POST', `/v1/payment_methods/${method.id}/attach`, { customer: customer.id })
    const saved = await stripe.request('POST', `/v1/customers/${customer.id}`, {
      'invoice_settings[default_payment_method]': method.id })
    const attached = await stripe.request('GET', `/v1/payment_methods/${method.id}`)
    check(reference(saved.invoice_settings?.default_payment_method) === method.id && attached.type === 'card'
      && attached.livemode === false && reference(attached.customer) === customer.id, 'saved_method_mismatch')
    source.receipt = { scenario, clockRef: clock.id, customerRef: customer.id, methodRef: method.id, observations: [] }
    result.sources.push(source.receipt)
  }
}

async function nativeSources() {
  phase = 'owner-mfa-and-exact-customer-consent'
  const { harness } = await import('./harness.mjs')
  h = await harness({ localTime: iso(instant), stripeSecret: process.env.STRIPE_SECRET_KEY, stripeFetch: forward })
  check((await h.raw('/auth/bootstrap', { body: { token: h.vars.SETUP_TOKEN,
    displayName: 'synthetic-nectar-retry-7' } })).status === 303, 'owner_bootstrap_failed')
  owner = await h.signIn(h.vars.OWNER_EMAIL)
  check((await h.raw('/setup', { cookie: owner, form: new URLSearchParams({ confirm: 'yes' }) })).status === 303, 'owner_setup_failed')
  await api('business.configure', { legal_name: 'synthetic-nectar-retry-8', address: 'synthetic-nectar-retry-9',
    timezone: 'UTC', invoice_prefix: 'SYNTH', payment_terms_days: 30 })
  const prepared = await api('tax.declare', { tax_jurisdiction: 'CA', tax_mode: 'no_tax', tax_note: 'synthetic-nectar-retry-10' })
  check(prepared.status === 'pending', 'tax_policy_not_prepared')
  const policy = (await api('policies')).find(row => row.id === prepared.request)
  check(policy?.singleAllowed, 'sole_owner_policy_required')
  await api('policy.decide', { request: prepared.request, decision: 'approved', confirm_single: true })
  await api('tax.review', { revision: (await api('business')).revision })
  const enrollment = await api('mfa.totp.start', {})
  factor = enrollment.secret
  await api('mfa.totp.confirm', { factor: enrollment.factor, code: totp(factor, instant) })
  await api('mfa.policy', { scope: 'all' })
  await api('portal.configure', { hosts: [h.origin], parents: [] })
  for (const source of sources) {
    source.nativeCustomer = (await api('customer.create', { external_id: `synthetic-nectar-retry-${source.index + 11}`,
      name: `synthetic-nectar-retry-${source.index + 14}`, billing_email: `synthetic-nectar-retry-${source.index + 17}@example.test` })).id
    const charge = await api('charge.add', { customer: source.nativeCustomer, amount: '12.00',
      description: 'Synthetic recurring service', effective_date: date(instant), taxable: false })
    source.invoiceRef = (await api('invoice.manual', { customer: source.nativeCustomer,
      charges: [charge.charge], service_date: date(instant) })).id
    await api('collection.customer.bind', { customer: source.nativeCustomer, account_ref: result.accountRef,
      stripe_customer_ref: source.customerRef, confirm: true })
    const automatic = await api('automatic.collection.prepare', { invoice: source.invoiceRef,
      issue_date: date(instant), enable_retries: true })
    source.requestRef = automatic.id
    check(automatic.status === 'awaiting_customer' && automatic.quote?.retryPolicy
      && automatic.quote.method.paymentMethodRef === source.methodRef && automatic.amountCents === source.amount,
    'exact_retry_terms_missing')
    source.policy = automatic.quote.retryPolicy
    const session = await api('portal.session.issue', { customer: source.nativeCustomer, origin: h.origin, audience: 'hosted' })
    const path = `/portal/automatic-collections/${automatic.id}?${new URLSearchParams({ session: session.token })}`
    check((await h.raw(path)).status === 200, 'customer_consent_page_unavailable')
    const acceptance = await h.raw(path, { body: { request: automatic.id, basis_hash: automatic.basis, accept: true } })
    check(acceptance.status === 200 && (await acceptance.json()).status === 'pending_approval', 'customer_retry_acceptance_missing')
    const approved = await api('automatic.collection.decide', { request: automatic.id, basis_hash: automatic.basis,
      decision: 'approved', confirm: true, confirm_single: true })
    check(approved.status === 'active' && approved.acceptedAt && approved.approvedAt
      && approved.approvalMode === 'single-approver', 'human_exact_retry_approval_missing')
    await api('invoice.approve', { invoice: source.invoiceRef, acknowledge: true })
    Object.assign(source.receipt, { nativeCustomerRef: source.nativeCustomer, invoiceRef: source.invoiceRef,
      requestRef: source.requestRef, policy: source.policy })
  }
  check(writes.length === 0, 'collection_before_invoice_issue')
  result.checks.customerAcceptedRetriesAndOwnerApprovedBeforeIssue = true
}

async function tick(at) {
  check(at >= instant, 'nectar_clock_cannot_reverse')
  instant = at
  await h.advanceClock(iso(at))
  const response = await h.raw(`/cdn-cgi/local/scheduled?time=${at}&cron=${encodeURIComponent('* * * * *')}`)
  check(response.status === 200, 'scheduled_worker_failed')
}

async function advance(source, at) {
  await stripe.request('POST', `/v1/test_helpers/test_clocks/${source.clockRef}/advance`, { frozen_time: Math.floor(at / 1000) }, 15000)
  for (let attempt = 0; attempt < 40; attempt++) {
    const clock = await stripe.request('GET', `/v1/test_helpers/test_clocks/${source.clockRef}`, {}, 5000)
    if (clock.status === 'ready') {
      check(clock.frozen_time === Math.floor(at / 1000), 'provider_clock_wrong_time')
      source.receipt.clockAdvancedTo = clock.frozen_time
      return
    }
    check(clock.status === 'advancing', 'provider_clock_failed')
    await delay(500)
  }
  throw new SandboxFailure('provider_clock_timeout')
}

async function proof(source) {
  const row = (await api('automatic-collections')).find(item => item.id === source.requestRef)
  check(row?.paymentIntentRef, 'provider_intent_missing')
  const intent = await stripe.request('GET', `/v1/payment_intents/${row.paymentIntentRef}`)
  check(intent.object === 'payment_intent' && intent.livemode === false && intent.amount === source.amount
    && intent.currency === 'usd' && reference(intent.customer) === source.customerRef
    && intent.metadata?.nectar_native_invoice === source.invoiceRef
    && intent.metadata?.nectar_native_collection_request === source.requestRef, 'provider_intent_identity_mismatch')
  const charges = (await stripe.list('/v1/charges', { customer: source.customerRef })).data
  check(charges.length > 0 && charges.every(charge => reference(charge.payment_intent) === intent.id
    && reference(charge.customer) === source.customerRef && charge.livemode === false && charge.amount === source.amount
    && charge.status === 'failed' && charge.paid === false
    && !charge.receipt_email && !charge.disputed), 'failed_charge_proof_missing')
  check(intent.status === 'requires_payment_method' && intent.amount_received === 0 && intent.last_payment_error,
    'definitive_live_refusal_missing')
  const invoice = await api(`invoices/${source.invoiceRef}`)
  check(invoice.status === 'issued' && invoice.balanceCents === source.amount && invoice.paidCents === 0
    && invoice.allocations.length === 0, 'failed_invoice_received_cash')
  const code = intent.last_payment_error.decline_code ?? intent.last_payment_error.code
  check(typeof code === 'string' && /^[a-z_]{1,100}$/.test(code), 'safe_provider_decline_code_missing')
  source.receipt.observations.push({ at: instant, paymentIntentRef: intent.id, providerCreated: intent.created,
    providerStatus: intent.status, declineCode: code, nectarStatus: row.status,
    attemptCount: invoice.attempt_count, nextPaymentAttempt: invoice.next_payment_attempt,
    charges: charges.map(charge => ({ ref: charge.id, created: charge.created, status: charge.status,
      advice: /^[a-z_]{1,100}$/.test(charge.outcome?.advice_code ?? '') ? charge.outcome.advice_code : null })) })
  return { invoice, intent, charges, code }
}

async function liveJourney() {
  phase = 'real-failed-invoice-collection'
  for (const source of sources) {
    await api('invoice.finalise', { invoice: source.invoiceRef, issue_date: date(instant) })
    source.initial = await proof(source)
    check(source.initial.invoice.attempt_count === 1, 'initial_attempt_count_incorrect')
    if (source.scenario !== 'generic') {
      check(source.initial.code === `${source.scenario}_card`, 'expected_live_hard_decline_missing')
      check(source.initial.invoice.next_payment_attempt === null, 'hard_decline_scheduled_retry')
    }
  }
  check(writes.length === sources.length, 'initial_collection_not_once')
  result.checks.realAttachedMethodRefusals = true
  const generic = sources[0], next = generic.initial.invoice.next_payment_attempt
  if (next !== null) {
    phase = 'live-scheduled-retry-boundaries'
    check(Number.isSafeInteger(next) && next > instant && next <= instant + generic.policy.windowDays * day,
      'retry_time_outside_accepted_policy')
    const before = writes.length
    await advance(generic, next - 1000)
    await tick(next - 1)
    check(writes.length === before, 'retry_before_due')
    await advance(generic, next)
    await tick(next)
    check(writes.length === before + 1 && writes.at(-1).path.endsWith(`/${generic.initial.intent.id}/confirm`),
      'due_retry_not_one_original_intent_confirmation')
    const retried = await proof(generic)
    check(retried.invoice.attempt_count === 2 && retried.charges.length === generic.initial.charges.length + 1,
      'due_retry_failed_charge_not_proven')
    await tick(next)
    check(writes.length === before + 1, 'repeated_due_tick_confirmed_again')
    const replayed = await proof(generic)
    check(replayed.charges.length === retried.charges.length, 'repeated_due_tick_created_charge')
    result.checks.liveRetryBeforeDueAtDueAndRepeat = true
  } else {
    result.limitations.push({ code: 'attachable_generic_decline_not_scheduled', observedDecline: generic.initial.code,
      effect: 'This run proves the observed stop; it does not establish soft-decline retry timing.' })
    const later = instant + day, before = writes.length
    for (const source of sources) await advance(source, later)
    await tick(later); await tick(later)
    check(writes.length === before, 'blocked_decline_confirmed_again')
    result.checks.liveBlockedDeclinesNoRepeatedCharge = true
  }
  for (const source of sources.slice(1)) {
    const current = await proof(source)
    check(current.charges.length === source.initial.charges.length && current.invoice.attempt_count === 1
      && current.invoice.next_payment_attempt === null, 'hard_decline_retried_same_method')
  }
  result.checks.liveLostAndStolenMethodsNeverRetried = true
  phase = 'replacement-method-recovery-gap'
  const replacement = await stripe.request('POST', '/v1/payment_methods', { type: 'card', 'card[token]': 'tok_visa' })
  generic.methods.push(replacement.id)
  await stripe.request('POST', `/v1/payment_methods/${replacement.id}/attach`, { customer: generic.customerRef })
  await stripe.request('POST', `/v1/customers/${generic.customerRef}`, { 'invoice_settings[default_payment_method]': replacement.id })
  const outstanding = await api(`invoices/${generic.invoiceRef}`), before = writes.length
  const afterReplacement = outstanding.next_payment_attempt ?? instant + day
  await advance(generic, afterReplacement)
  await tick(afterReplacement); await tick(afterReplacement)
  check(writes.length === before, 'unapproved_replacement_method_charged')
  const final = await proof(generic)
  check(final.invoice.balanceCents === generic.amount && final.invoice.next_payment_attempt === null,
    'replacement_method_gap_not_observed')
  result.limitations.push({ code: 'saved_default_alone_never_authorizes_recovery', replacementMethodRef: replacement.id,
    effect: 'Changing the saved default alone leaves the original exact consent in force.' })
  result.checks.changedDefaultNeverUsesOldConsent = true
  phase = 'separately-consented-hard-decline-recovery'
  const hard = sources.at(-1)
  const freshMethod = await stripe.request('POST', '/v1/payment_methods', { type: 'card', 'card[token]': 'tok_visa' })
  hard.methods.push(freshMethod.id)
  await stripe.request('POST', `/v1/payment_methods/${freshMethod.id}/attach`, { customer: hard.customerRef })
  await stripe.request('POST', `/v1/customers/${hard.customerRef}`, { 'invoice_settings[default_payment_method]': freshMethod.id })
  await api('mfa.verify', { code: totp(factor, instant) })
  const recovery = await api('retry.method.prepare', { request: hard.requestRef, confirm: true })
  check(recovery.status === 'awaiting_customer' && recovery.quote.method.paymentMethodRef === freshMethod.id,
    'replacement_quote_missing')
  const session = await api('portal.session.issue', { customer: hard.nativeCustomer, origin: h.origin, audience: 'hosted' })
  const target = `/portal/retry-method-recoveries/${recovery.id}?session=${encodeURIComponent(session.token)}`
  const accepted = await h.raw(target, { body: { recovery: recovery.id, quote_hash: recovery.quoteHash, accept: true } })
  check(accepted.status === 200 && (await accepted.json()).status === 'pending_approval', 'replacement_acceptance_missing')
  const beforeRecovery = writes.length
  await api('retry.method.decide', { recovery: recovery.id, quote_hash: recovery.quoteHash, decision: 'approved', confirm: true, confirm_single: true })
  check(writes.length === beforeRecovery, 'replacement_approval_debited_before_tick')
  await tick(instant); await tick(instant)
  const paid = await api(`invoices/${hard.invoiceRef}`),provider = await stripe.request('GET', `/v1/payment_intents/${hard.initial.intent.id}`)
  check(paid.balanceCents === 0 && paid.paidCents === hard.amount && paid.allocations.length === 1
    && provider.status === 'succeeded' && provider.amount_received === hard.amount && reference(provider.payment_method) === freshMethod.id
    && writes.length === beforeRecovery + 1, 'replacement_recovery_not_once')
  Object.assign(hard.receipt, { recoveryRef: recovery.id, replacementMethodRef: freshMethod.id,
    recoveredPaymentIntentRef: provider.id, recoveredAmount: provider.amount_received, nativePaymentRef: paid.allocations[0].payment_id })
  result.checks.hardDeclineNewCardSeparateConsentSameIntentPaidOnce = true
  check(new Set(writes.map(write => write.key)).size === writes.length, 'reused_provider_mutation_key')
  result.checks.eachActualAttemptHasDistinctDurableKey = true
}

async function cleanup() {
  if (h) try { await h.close(); result.cleanup.push({ resource: 'worker', status: 'closed' }) }
  catch (error) { result.cleanup.push({ resource: 'worker', status: 'failed', ...safeError(error) }); process.exitCode = 1 }
  for (const source of sources.toReversed()) {
    for (const method of source.methods.toReversed()) {
      try {
        const current = await stripe.request('GET', `/v1/payment_methods/${method}`, {}, 10000)
        if (reference(current.customer)) {
          check(reference(current.customer) === source.customerRef, 'cleanup_method_owner_mismatch')
          const detached = await stripe.request('POST', `/v1/payment_methods/${method}/detach`, {}, 10000)
          check(detached.id === method && !reference(detached.customer), 'method_detach_unconfirmed')
        }
        result.cleanup.push({ resource: 'method', ref: method, status: 'unattached' })
      } catch (error) {
        result.cleanup.push({ resource: 'method', ref: method, status: 'failed', ...safeError(error) }); process.exitCode = 1
      }
    }
    if (source.clockRef) try {
      const deleted = await stripe.request('DELETE', `/v1/test_helpers/test_clocks/${source.clockRef}`, {}, 10000)
      check(deleted.deleted === true, 'clock_delete_unconfirmed')
      result.cleanup.push({ resource: 'clock', ref: source.clockRef, status: 'deleted' })
    } catch (error) { result.cleanup.push({ resource: 'clock', ref: source.clockRef, status: 'failed', ...safeError(error) }); process.exitCode = 1 }
    if (source.customerRef) try {
      const customer = await stripe.request('GET', `/v1/customers/${source.customerRef}`, {}, 10000)
      if (!customer.deleted) {
        const deleted = await stripe.request('DELETE', `/v1/customers/${source.customerRef}`, {}, 10000)
        check(deleted.deleted === true, 'customer_delete_unconfirmed')
      }
      result.cleanup.push({ resource: 'customer', ref: source.customerRef, status: 'deleted' })
    } catch (error) {
      if (error?.status === 404 && error?.code === 'resource_missing') result.cleanup.push({ resource: 'customer', ref: source.customerRef, status: 'absent' })
      else { result.cleanup.push({ resource: 'customer', ref: source.customerRef, status: 'failed', ...safeError(error) }); process.exitCode = 1 }
    }
  }
}

try {
  result.head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  check(/^[a-f0-9]{40}$/.test(result.head), 'candidate_head_required')
  await providerSources()
  await nativeSources()
  await liveJourney()
  result.status = 'passed'
} catch (error) {
  result.status = 'failed'; result.failure = { phase, ...safeError(error) }; process.exitCode = 1
} finally {
  await cleanup()
  if (process.exitCode && result.status === 'passed') result.status = 'cleanup_failed'
  result.counts = { provider: stripe?.counts ?? {}, workerPaymentAttempts: writes.length,
    workerConfirmations: writes.filter(write => write.path.endsWith('/confirm')).length }
  globalThis.fetch = nativeFetch
  console.log(JSON.stringify(result))
}
