// Outside push Verify. Build the committed candidate first; inject the held
// STRIPE_US_TEST_SECRET_KEY as STRIPE_SECRET_KEY, then run this file with Node.
// No receipt files are written. stdout is one safe JSON result; no credentials,
// portal capabilities, provider client secrets or bank and card numbers are emitted.
//
// Stripe's documented limitation is material to PAY-003:
// https://docs.stripe.com/billing/testing/test-clocks/api-advanced-usage#caveats-with-payment-processing
// Test-clock advancement does not support bank-debit collection. This journey
// nevertheless observes the actual API at T+3 and T+4. Failure is failure, never
// a skipped clause or a locally fabricated settlement. Standard T+4 timing:
// https://docs.stripe.com/payments/ach-direct-debit#timing
// Official test tokens / verification:
// https://docs.stripe.com/payments/ach-direct-debit/accept-a-payment?payment-ui=direct-api#test-account-numbers
// https://docs.stripe.com/api/setup_intents/verify_microdeposits
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { stripeSandbox, check, reference, safeError, SandboxFailure } from './stripe-sandbox-client.mjs'
import { totp } from './mfa.mjs'

// Start no later than actual provider time. The run keeps both clocks explicit.
const start = Math.floor(Date.now()/1000)-60
const businessDay = count => {
 const day=new Date(start*1000)
 while(count){day.setUTCDate(day.getUTCDate()+1);if(![0,6].includes(day.getUTCDay()))count--}
 return Math.floor(day.getTime()/1000)
}
const thirdDay = businessDay(3)
const fourthDay = businessDay(4)
const settlementDate = new Date(fourthDay*1000).toISOString().slice(0,10)
const limitation = 'https://docs.stripe.com/billing/testing/test-clocks/api-advanced-usage#caveats-with-payment-processing'
const result = { version: 1, clause: 'PAY-003', status: 'running', head: null, accountRef: null, checks: {}, sources: [], cleanup: [] }
const sources = [], workerRequests = []
let stripe, h, owner, factor, verifiedAt = start * 1000, localInstant = start * 1000, phase = 'candidate'
const step = value => { phase = value }
const iso = seconds => new Date(seconds * 1000).toISOString()
const date = seconds => iso(seconds).slice(0, 10)
const posts = () => workerRequests.filter(row => row.method === 'POST')

// Use the public JSON door without harness assertion messages that can include
// a response body. The only diagnostic fields admitted here are safe codes.
async function api(path, body, status = 200) {
  const response = await h.raw(`/api/nectar/${path}`, { cookie: owner, body })
  let value
  try { value = await response.json() } catch { throw new SandboxFailure('nectar_invalid_json', response.status) }
  if (response.status !== status) {
    const error = safeError({ code: value?.error ?? value?.code })
    throw new SandboxFailure(error.code === 'sandbox_failure' ? 'nectar_unexpected_status' : error.code, response.status)
  }
  return value
}

async function alignClock(seconds) {
  localInstant = seconds * 1000
  await h.advanceClock(iso(seconds))
  if (factor && localInstant - verifiedAt > 10 * 60 * 1000) {
    await api('mfa.verify', { code: totp(factor, localInstant) })
    verifiedAt = localInstant
  }
}

async function forward(request) {
  const response = await stripe.forward(request, entry => {
    check(entry.method !== 'POST' || entry.path === '/v1/payment_intents', 'unexpected_worker_provider_mutation')
    if (entry.method === 'POST') {
      check(entry.fields.get('confirm') === 'true' && entry.fields.get('off_session') === 'true'
        && !entry.fields.has('receipt_email') && !entry.fields.has('payment_method_data[us_bank_account][account_number]')
        && !entry.fields.has('payment_method_data[card][number]'), 'unsafe_worker_payment_parameters')
    }
    workerRequests.push({ method: entry.method, path: entry.path, customerRef: entry.fields.get('customer'), key: entry.idempotencyKey })
  })
  if (!response.ok) {
    let value
    try { value = await response.clone().json() } catch { /* Only safe status survives. */ }
    result.providerFailure = { ...safeError({ code: value?.error?.code ?? value?.error?.type, status: response.status, param: value?.error?.param }) }
  }
  return response
}

async function providerSources() {
  step('owned-provider-sources')
  stripe = stripeSandbox(process.env.STRIPE_SECRET_KEY)
  const account = await stripe.request('GET', '/v1/account')
  check(account.object === 'account' && account.country === 'US', 'us_stripe_test_account_required')
  result.accountRef = account.id
  for (const [index, kind] of ['card', 'us_bank_account'].entries()) {
    const source = { index, kind, amount: index ? 2300 : 1200 }
    // Register each resource immediately so a later assertion cannot orphan it.
    sources.push(source)
    const clock = await stripe.request('POST', '/v1/test_helpers/test_clocks', { frozen_time: start, name: `synthetic-nectar-${index + 1}` })
    source.clockRef = clock.id
    check(clock.status === 'ready' && clock.frozen_time === start, 'owned_provider_clock_not_ready')
    const customer = await stripe.request('POST', '/v1/customers', { name: `synthetic-nectar-${index + 3}`, test_clock: clock.id, 'metadata[nectar_run]': stripe.run })
    source.customerRef = customer.id
    check(customer.test_clock === clock.id && customer.livemode === false && !customer.email, 'owned_provider_customer_mismatch')
    if (kind === 'card') {
      const method = await stripe.request('POST', '/v1/payment_methods', { type: 'card', 'card[token]': 'tok_visa' })
      source.methodRef = method.id
      await stripe.request('POST', `/v1/payment_methods/${method.id}/attach`, { customer: customer.id })
    } else {
      // Mandate acceptance and verification occur only on Stripe's test edge.
      // Nectar receives object references, never financial account numbers.
      let setup = await stripe.request('POST', '/v1/setup_intents', { customer: customer.id, payment_method: 'pm_usBankAccount_success',
        'payment_method_types[0]': 'us_bank_account', usage: 'off_session', confirm: 'true',
        'mandate_data[customer_acceptance][type]': 'online', 'mandate_data[customer_acceptance][accepted_at]': start,
        'mandate_data[customer_acceptance][online][ip_address]': '127.0.0.1',
        'mandate_data[customer_acceptance][online][user_agent]': 'synthetic-nectar-5' })
      source.setupRef = setup.id
      if (setup.status === 'requires_action') {
        const verification = setup.next_action?.verify_with_microdeposits
        check(setup.next_action?.type === 'verify_with_microdeposits' && verification, 'ach_setup_unexpected_customer_action')
        check(['descriptor_code', 'amounts'].includes(verification.microdeposit_type), 'ach_setup_unknown_verification')
        setup = await stripe.request('POST', `/v1/setup_intents/${setup.id}/verify_microdeposits`,
          verification.microdeposit_type === 'descriptor_code' ? { descriptor_code: 'SMT86W' } : { 'amounts[0]': 32, 'amounts[1]': 45 })
      }
      check(setup.status === 'succeeded' && setup.livemode === false && reference(setup.customer) === customer.id, 'ach_verified_setup_required')
      source.methodRef = reference(setup.payment_method); source.mandateRef = reference(setup.mandate)
      check(source.methodRef && source.mandateRef, 'ach_verified_method_and_mandate_required')
      const mandate = await stripe.request('GET', `/v1/mandates/${source.mandateRef}`)
      check(mandate.status === 'active' && mandate.type === 'multi_use' && mandate.livemode === false
        && reference(mandate.payment_method) === source.methodRef && mandate.customer_acceptance?.type === 'online', 'ach_active_online_mandate_required')
    }
    const saved = await stripe.request('POST', `/v1/customers/${customer.id}`, { 'invoice_settings[default_payment_method]': source.methodRef })
    const method = await stripe.request('GET', `/v1/payment_methods/${source.methodRef}`)
    check(reference(saved.invoice_settings?.default_payment_method) === source.methodRef && method.type === kind
      && method.livemode === false && reference(method.customer) === customer.id, 'owned_saved_method_mismatch')
    result.sources.push({ kind, clockRef: source.clockRef, customerRef: source.customerRef, methodRef: source.methodRef,
      ...(source.mandateRef ? { setupRef: source.setupRef, mandateRef: source.mandateRef, mandateStatus: 'active' } : {}) })
  }
}

async function nativeSources() {
  step('ordinary-owner-mfa-and-native-invoices')
  const { harness } = await import('./harness.mjs')
  const { applyPolicy } = await import('./policy-helper.mjs')
  h = await harness({ localTime: iso(start), stripeSecret: process.env.STRIPE_SECRET_KEY, stripeFetch: forward })
  check((await h.raw('/auth/bootstrap', { body: { token: h.vars.SETUP_TOKEN, displayName: 'synthetic-nectar-6' } })).status === 303, 'owner_bootstrap_failed')
  owner = await h.signIn(h.vars.OWNER_EMAIL)
  check((await h.raw('/setup', { cookie: owner, form: new URLSearchParams({ confirm: 'yes' }) })).status === 303, 'owner_setup_failed')
  await api('business.configure', { legal_name: 'synthetic-nectar-7', address: 'synthetic-nectar-8', timezone: 'UTC', invoice_prefix: 'SYNTH', payment_terms_days: 30 })
  await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: 'CA', tax_mode: 'no_tax', tax_note: 'synthetic-nectar-9' })
  await api('tax.review', { revision: (await api('business')).revision })
  const enrollment = await api('mfa.totp.start', {})
  factor = enrollment.secret
  await api('mfa.totp.confirm', { factor: enrollment.factor, code: totp(factor, localInstant) })
  await api('mfa.policy', { scope: 'all' })
  await api('portal.configure', { hosts: [h.origin], parents: [] })
  for (const source of sources) {
    source.nativeCustomer = (await api('customer.create', { external_id: `synthetic-nectar-${source.index + 10}`,
      name: `synthetic-nectar-${source.index + 12}`, billing_email: `synthetic-nectar-${source.index + 14}@example.test` })).id
    const charge = await api('charge.add', { customer: source.nativeCustomer, amount: (source.amount / 100).toFixed(2),
      description: `synthetic-nectar-${source.index + 16}`, effective_date: date(start), taxable: false })
    source.invoiceRef = (await api('invoice.manual', { customer: source.nativeCustomer, charges: [charge.charge], service_date: date(start) })).id
    await api('invoice.approve', { invoice: source.invoiceRef, acknowledge: true })
    await api('collection.customer.bind', { customer: source.nativeCustomer, account_ref: result.accountRef, stripe_customer_ref: source.customerRef, confirm: true })
    const automatic = await api('automatic.collection.prepare', { invoice: source.invoiceRef, issue_date: date(start),
      ...(source.mandateRef ? { mandate_ref: source.mandateRef } : {}) })
    source.requestRef = automatic.id
    check(automatic.status === 'awaiting_customer' && automatic.method === source.kind && automatic.quote?.accountRef === result.accountRef
      && automatic.quote.method.customerRef === source.customerRef && automatic.quote.method.paymentMethodRef === source.methodRef
      && automatic.amountCents === source.amount && automatic.quote.issueDate === date(start), 'automatic_exact_terms_mismatch')
    const session = await api('portal.session.issue', { customer: source.nativeCustomer, origin: h.origin, audience: 'hosted' })
    const path = `/portal/automatic-collections/${automatic.id}?${new URLSearchParams({ session: session.token })}`
    check((await h.raw(path)).status === 200, 'customer_consent_page_unavailable')
    const accepted = await h.raw(path, { body: { request: automatic.id, basis_hash: automatic.basis, accept: true } })
    check(accepted.status === 200 && (await accepted.json()).status === 'pending_approval', 'authenticated_customer_consent_missing')
    const approved = await api('automatic.collection.decide', { request: automatic.id, basis_hash: automatic.basis,
      decision: 'approved', confirm: true, confirm_single: true })
    check(approved.status === 'active' && approved.acceptedAt && approved.approvedAt && approved.approvalMode === 'single-approver', 'human_exact_approval_missing')
    source.original = await api(`invoices/${source.invoiceRef}`)
    check(source.original.status === 'approved' && posts().length === 0, 'automatic_collection_charged_before_issue')
    Object.assign(result.sources[source.index], { nativeCustomerRef: source.nativeCustomer, invoiceRef: source.invoiceRef, requestRef: source.requestRef })
  }
  result.checks.authenticatedCustomerAndHumanExactApprovalBeforeIssue = true
}

async function collection(source) {
  const rows = await api('automatic-collections')
  const row = rows.find(item => item.id === source.requestRef)
  check(row, 'automatic_collection_missing')
  return row
}

async function providerPayment(source) {
  const row = await collection(source)
  check(row.paymentIntentRef, 'automatic_payment_intent_missing')
  const intent = await stripe.request('GET', `/v1/payment_intents/${row.paymentIntentRef}`)
  check(intent.object === 'payment_intent' && intent.livemode === false && intent.amount === source.amount && intent.currency === 'usd'
    && reference(intent.customer) === source.customerRef && reference(intent.payment_method) === source.methodRef
    && intent.metadata?.nectar_native_invoice === source.invoiceRef && intent.metadata?.nectar_native_collection_request === source.requestRef, 'provider_intent_identity_mismatch')
  const charges = await stripe.list('/v1/charges', { customer: source.customerRef })
  check(charges.data.length === 1, 'owned_customer_charge_count_mismatch')
  const charge = charges.data[0]
  check(reference(charge.payment_intent) === intent.id && reference(intent.latest_charge) === charge.id && charge.amount === source.amount
    && charge.currency === 'usd' && charge.livemode === false && reference(charge.payment_method) === source.methodRef
    && charge.amount_refunded === 0 && !charge.disputed && !charge.receipt_email && !intent.receipt_email, 'provider_charge_identity_mismatch')
  const transactionRef = reference(charge.balance_transaction)
  const transaction = transactionRef ? await stripe.request('GET', `/v1/balance_transactions/${transactionRef}`) : null
  if (transaction) check(transaction.object === 'balance_transaction' && transaction.id === transactionRef && transaction.type === (source.kind === 'us_bank_account' ? 'payment' : 'charge')
    && reference(transaction.source) === charge.id && transaction.amount === source.amount && transaction.currency === 'usd', 'provider_funds_identity_mismatch')
  return { row, intent, charge, transaction }
}

function observe(proof) {
  return { paymentIntentRef: proof.intent.id, paymentIntentStatus: proof.intent.status, created: proof.intent.created,
    chargeRef: proof.charge.id, chargeStatus: proof.charge.status, balanceTransactionRef: proof.transaction?.id ?? null,
    fundsStatus: proof.transaction?.status ?? null, availableOn: proof.transaction?.available_on ?? null, nectarStatus: proof.row.status }
}

async function assertPaid(source, proof) {
  check(proof.row.status === 'collected' && proof.row.payment && proof.intent.status === 'succeeded' && proof.intent.amount_received === source.amount
    && proof.charge.status === 'succeeded' && proof.charge.paid === true && proof.charge.captured === true
    && proof.charge.amount_captured === source.amount, 'provider_captured_payment_required')
  const invoice = await api(`invoices/${source.invoiceRef}`)
  check(invoice.status === 'issued' && invoice.paidCents === source.amount && invoice.balanceCents === 0 && invoice.creditedCents === 0
    && invoice.allocations.length === 1 && invoice.allocations[0].payment_id === proof.row.payment
    && invoice.allocations[0].amount_cents === source.amount, 'invoice_payment_allocation_not_once')
  check(invoice.source_fingerprint === source.original.source_fingerprint && isDeepStrictEqual(invoice.calculation, source.original.calculation)
    && isDeepStrictEqual(invoice.lines, source.original.lines), 'approved_invoice_source_changed')
  const payments = (await api('payments')).filter(payment => payment.customer_id === source.nativeCustomer)
  check(payments.length === 1 && payments[0].id === proof.row.payment && payments[0].amount_cents === source.amount
    && payments[0].reference === `stripe:${result.accountRef}:${proof.intent.id}`, 'financial_payment_not_once')
  Object.assign(result.sources[source.index], { paymentRef: proof.row.payment, paymentIntentRef: proof.intent.id, chargeRef: proof.charge.id })
}

async function assertPending(source, proof) {
  check(proof.row.status === 'pending_settlement' && !proof.row.payment && !proof.row.settledAt, 'ach_marked_paid_without_settlement')
  const invoice = await api(`invoices/${source.invoiceRef}`)
  check(invoice.paidCents === 0 && invoice.balanceCents === source.amount && invoice.allocations.length === 0, 'ach_pending_receivable_not_outstanding')
  check(!(await api('payments')).some(payment => payment.customer_id === source.nativeCustomer), 'ach_pending_created_financial_payment')
}

async function replay(source, eventType) {
  step(`${source.kind}-repeat-issue-and-real-event`)
  const count = posts().length
  await api('invoice.finalise', { invoice: source.invoiceRef, issue_date: date(start) }, 409)
  const before = await api('automatic.collection.reconcile', { request: source.requestRef })
  let event
  for (let attempt = 0; attempt < 8 && !event; attempt++) {
    const events = await stripe.request('GET', '/v1/events', { type: eventType, limit: 100 })
    check(events.object === 'list' && Array.isArray(events.data), 'provider_event_list_invalid')
    event = events.data.find(item => item.data?.object?.id === before.paymentIntentRef)
    if (!event && attempt < 7) await delay(1000)
  }
  check(event && event.livemode === false, 'real_processor_event_unavailable')
  const first = await api('automatic.collection.event', { request: source.requestRef, event_ref: event.id })
  const repeated = await api('automatic.collection.event', { request: source.requestRef, event_ref: event.id })
  check(first.replayed === false && repeated.replayed === true && repeated.paymentIntentRef === before.paymentIntentRef
    && repeated.payment === before.payment && posts().length === count, 'issue_or_processor_event_replay_recharged')
  check((await stripe.list('/v1/charges', { customer: source.customerRef })).data.length === 1, 'processor_event_replay_created_second_charge')
  Object.assign(result.sources[source.index], { eventRef: event.id, eventType, repeatIssueAndEventNoSecondCharge: true })
}

async function advance(source, target) {
  step(`provider-clock-${date(target)}`)
  await stripe.request('POST', `/v1/test_helpers/test_clocks/${source.clockRef}/advance`, { frozen_time: target }, 15_000)
  for (let attempt = 0; attempt < 40; attempt++) {
    const clock = await stripe.request('GET', `/v1/test_helpers/test_clocks/${source.clockRef}`, {}, 5000)
    if (clock.status === 'ready') { check(clock.frozen_time === target, 'provider_clock_wrong_time'); return }
    check(clock.status === 'advancing', 'provider_clock_failed')
    await delay(1000)
  }
  throw new SandboxFailure('provider_clock_timeout')
}

async function collectAndSettle() {
  const [card, bank] = sources
  const mailCount = h.mails.length
  step('card-immediate-autocharge-on-issue')
  await api('invoice.finalise', { invoice: card.invoiceRef, issue_date: date(start) })
  const cardProof = await providerPayment(card)
  await assertPaid(card, cardProof)
  result.sources[0].onIssue = observe(cardProof)
  result.checks.cardPaidImmediatelyOnIssue = true
  await replay(card, 'payment_intent.succeeded')
  step('ach-autocharge-processing-on-issue')
  await api('invoice.finalise', { invoice: bank.invoiceRef, issue_date: date(start) })
  const initial = await providerPayment(bank)
  result.sources[1].onIssue = observe(initial)
  check(initial.intent.status === 'processing', 'ach_initial_processing_not_observed')
  await assertPending(bank, initial)
  await replay(bank, 'payment_intent.processing')
  result.checks.achProcessingAndReceivablePendingOnIssue = true

  await advance(bank, thirdDay)
  const third = await providerPayment(bank)
  result.sources[1].thirdBusinessDay = observe(third)
  const earlyFunds = third.intent.status === 'succeeded' && third.transaction?.status === 'available'
  await alignClock(thirdDay)
  await api('automatic.collection.reconcile', { request: bank.requestRef })
  const pending = await providerPayment(bank)
  // Record all real observations, including unsupported provider behavior,
  // before deciding whether the complete T+4 requirement has been established.
  await advance(bank, fourthDay)
  const fourth = await providerPayment(bank)
  result.sources[1].fourthBusinessDay = observe(fourth)
  result.sources[1].clockRef = bank.clockRef
  result.checks.providerClockAdvancedThreeAndFourBusinessDays = true
  const actualT4 = !earlyFunds && date(fourth.intent.created) === date(start) && fourth.intent.status === 'succeeded'
    && fourth.transaction?.status === 'available' && Number.isSafeInteger(fourth.transaction.available_on)
    && date(fourth.transaction.available_on) === settlementDate && fourth.transaction.available_on <= fourthDay
  if (!actualT4) {
    result.limitation = { code: 'stripe_clock_ach_t4_settlement_not_proven', documentation: limitation,
      providerClockControlsIntent: fourth.intent.created === start, fundsAvailableBeforeFourthDay: earlyFunds }
    throw new SandboxFailure('stripe_clock_ach_t4_settlement_not_proven')
  }
  await assertPending(bank, pending)
  // Align Nectar only AFTER Stripe independently proves actual available funds.
  await alignClock(fourthDay)
  await api('automatic.collection.reconcile', { request: bank.requestRef })
  const settled = await providerPayment(bank)
  await assertPaid(bank, settled)
  check(settled.row.settledAt === settled.transaction.available_on * 1000, 'ach_settlement_time_not_provider_derived')
  await replay(bank, 'payment_intent.succeeded')
  const attempts = posts()
  check(attempts.length === 2 && new Set(attempts.map(item => item.key)).size === 2
    && sources.every(source => attempts.filter(item => item.customerRef === source.customerRef).length === 1), 'one_provider_attempt_per_invoice_not_proven')
  check(h.mails.length === mailCount, 'automatic_collection_sent_unexpected_customer_email')
  result.checks.achSettledOnlyAtProviderFourBusinessDays = true
  result.checks.oneChargeAndOneFinancialPaymentPerInvoiceAfterReplay = true
}

async function cleanup() {
  if (h) try { await h.close(); result.cleanup.push({ resource: 'worker', status: 'closed' }) }
  catch (error) { result.cleanup.push({ resource: 'worker', status: 'failed', ...safeError(error) }); process.exitCode = 1 }
  for (const source of sources.toReversed()) {
    // At most one clock DELETE, one customer GET and one customer DELETE per
    // source. Deleting a clock normally deletes its associated customer too.
    if (source.clockRef) {
      try {
        const deleted = await stripe.request('DELETE', `/v1/test_helpers/test_clocks/${source.clockRef}`, {}, 10_000)
        check(deleted.deleted === true, 'provider_clock_delete_unconfirmed')
        result.cleanup.push({ resource: 'clock', ref: source.clockRef, status: 'deleted' })
      } catch (error) { result.cleanup.push({ resource: 'clock', ref: source.clockRef, status: 'failed', ...safeError(error) }); process.exitCode = 1 }
    }
    if (!source.customerRef) continue
    try {
      const customer = await stripe.request('GET', `/v1/customers/${source.customerRef}`, {}, 10_000)
      if (!customer.deleted) {
        const deleted = await stripe.request('DELETE', `/v1/customers/${source.customerRef}`, {}, 10_000)
        check(deleted.deleted === true, 'provider_customer_delete_unconfirmed')
      }
      result.cleanup.push({ resource: 'customer', ref: source.customerRef, status: 'deleted' })
    } catch (error) {
      // Clock deletion may make the associated customer unavailable entirely.
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
  await collectAndSettle()
  result.status = 'passed'
} catch (error) {
  result.status = 'failed'; result.failure = { phase, ...safeError(error) }; process.exitCode = 1
} finally {
  await cleanup()
  if (process.exitCode && result.status === 'passed') result.status = 'cleanup_failed'
  result.counts = { provider: stripe?.counts ?? {}, workerPaymentAttempts: posts().length }
  console.log(JSON.stringify(result))
}
