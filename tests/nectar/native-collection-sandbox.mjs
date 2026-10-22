// Outside push Verify. Parent builds the committed candidate and supplies held
// STRIPE_SECRET_KEY=STRIPE_US_TEST_SECRET_KEY and
// STRIPE_SECONDARY_SECRET_KEY=STRIPE_RER_TEST_SECRET_KEY through _od08-env.py.
// Both provider legs are real test-mode Stripe requests. The sole injected
// transport fault drops one real successful response to prove GET-only recovery.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { join } from 'node:path'
import { stripeSandbox, check, reference, safeError } from './stripe-sandbox-client.mjs'
import { csvRows } from './financial-reports.mjs'
import { totp } from './mfa.mjs'

const receipt = { version: 1, journey: 'Native invoice collection on two real Stripe test accounts', status: 'running', head: null,
  accounts: [], nativeIds: [], checks: {}, counts: {}, hashes: {}, cleanup: [] }
const evidence = join(process.cwd(), '.evidence'), contexts = [], workerRequests = []
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const sum = values => values.reduce((total, value) => total + value, 0)
const cents = value => Math.round(Number(value) * 100)
let phase = 'held-test-keys', h, lostResponse = false, lostIntentRef = null, owner, factor, verifiedAt = 0
const step = name => { phase = name; console.log(`Native Stripe sandbox: ${name}`) }

async function currentClock() {
  const instant = Date.now()
  await h.advanceClock(new Date(instant).toISOString())
  if (factor && instant - verifiedAt > 10 * 60 * 1000) {
    await h.api('mfa.verify', owner, { code: totp(factor, instant) })
    verifiedAt = instant
  }
  return new Date(instant).toISOString().slice(0, 10)
}

async function forward(request) {
  const authorization = request.headers.get('authorization')
  const context = contexts.find(entry => authorization === `Bearer ${entry.secret}`)
  check(context, 'unexpected_worker_processor_binding')
  check(request.headers.get('Stripe-Version') === '2025-03-31.basil', 'worker_stripe_protocol_changed')
  const response = await context.stripe.forward(request, entry => {
    if (entry.method === 'POST') {
      check(entry.path === '/v1/payment_intents', 'unexpected_worker_provider_mutation')
      check(!entry.fields.has('receipt_email') && entry.fields.get('confirm') === 'true' && entry.fields.get('off_session') === 'true', 'unapproved_worker_payment_parameters')
    }
    workerRequests.push({ account: context.account.id, method: entry.method, path: entry.path,
      customer: entry.fields.get('customer'), amount: Number(entry.fields.get('amount')), key: entry.idempotencyKey })
  })
  if (context.index === 1 && !lostResponse && request.method === 'POST' && new URL(request.url).pathname === '/v1/payment_intents' && response.ok) {
    // Stripe has actually executed this charge. Only delivery of its response
    // fails; the application's subsequent recovery must query the real object.
    const intent = await response.json()
    check(intent.object === 'payment_intent' && intent.status === 'succeeded' && intent.amount_received > 0 && intent.livemode === false, 'real_charge_before_response_loss_unproven')
    lostIntentRef = intent.id; lostResponse = true
    return new Response(null, { status: 503 })
  }
  return response
}

async function createProviderSources() {
  step('verify-two-distinct-test-accounts')
  for (const [index, secret] of [process.env.STRIPE_SECRET_KEY, process.env.STRIPE_SECONDARY_SECRET_KEY].entries()) contexts.push({ index, secret, stripe: stripeSandbox(secret) })
  for (const context of contexts) {
    context.account = await context.stripe.request('GET', '/v1/account')
    check(context.account.object === 'account' && typeof context.account.id === 'string', 'stripe_account_identity_missing')
  }
  check(contexts[0].account.country === 'US', 'primary_us_test_account_required')
  check(contexts[0].account.id !== contexts[1].account.id, 'two_distinct_test_accounts_required')
  receipt.accounts = contexts.map(context => ({ accountId: context.account.id }))
  receipt.checks.primaryAccountUS = true
  for (const context of contexts) {
    step(`create-owned-sources-${context.index + 1}`)
    const stripe = context.stripe
    const clock = await stripe.request('POST', '/v1/test_helpers/test_clocks', { frozen_time: Math.floor(Date.now() / 1000) - 60, name: `Nectar native collection ${stripe.run}` })
    context.clock = clock.id
    check(clock.status === 'ready', 'owned_clock_not_ready')
    const method = await stripe.request('POST', '/v1/payment_methods', { type: 'card', 'card[token]': 'tok_visa' })
    context.method = method.id
    // No email address exists on these owned customers, so account receipt
    // settings cannot deliver a success email independently of Nectar.
    context.customer = await stripe.request('POST', '/v1/customers', { name: `Nectar native collection ${stripe.run}`, test_clock: clock.id,
      payment_method: method.id, 'invoice_settings[default_payment_method]': method.id, 'metadata[nectar_run]': stripe.run })
    check(context.customer.test_clock === clock.id && !context.customer.email && reference(context.customer.invoice_settings.default_payment_method) === method.id, 'saved_default_card_not_established')
    receipt.accounts[context.index] = { accountId: context.account.id, clockId: clock.id, customerId: context.customer.id, paymentMethodId: method.id }
  }
}

async function createNativeInvoices() {
  step('ordinary-owner-and-native-invoices')
  const { harness } = await import('./harness.mjs')
  const { applyPolicy } = await import('./policy-helper.mjs')
  h = await harness({ localTime: new Date().toISOString(), stripeSecret: contexts[0].secret, stripeSecondarySecret: contexts[1].secret, stripeFetch: forward })
  check((await h.raw('/auth/bootstrap', { body: { token: h.vars.SETUP_TOKEN, displayName: 'Native Sandbox Owner' } })).status === 303, 'owner_bootstrap_failed')
  owner = await h.signIn(h.vars.OWNER_EMAIL)
  check((await h.raw('/setup', { cookie: owner, form: new URLSearchParams({ confirm: 'yes' }) })).status === 303, 'owner_setup_failed')
  const api = (path, body, status) => h.api(path, owner, body, status)
  await api('business.configure', { legal_name: 'Synthetic native collection sandbox', address: '1 Synthetic Way, CA, US', timezone: 'UTC', invoice_prefix: 'NATIVE', payment_terms_days: 30 })
  await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: 'CA', tax_mode: 'no_tax', tax_note: 'Owned test-mode invoice collection; no tax service requested' })
  await api('tax.review', { revision: (await api('business')).revision })
  const instant = Date.now(), started = await api('mfa.totp.start', {})
  await h.advanceClock(new Date(instant).toISOString())
  factor = started.secret
  await api('mfa.totp.confirm', { factor: started.factor, code: totp(factor, instant) })
  verifiedAt = instant
  await api('mfa.policy', { scope: 'all' })
  for (const context of contexts) {
    const date = await currentClock(), n = context.index + 1
    context.nativeCustomer = (await api('customer.create', { external_id: `synthetic-native-sandbox-${context.stripe.run}`, name: `Synthetic native entity ${n} customer`, billing_email: `native-${context.stripe.run}@example.test` })).id
    context.entity = (await api('entity.create', { revision: (await api('business')).revision, legal_name: `Synthetic native entity ${n}`, address: `${n} Synthetic Way, CA, US`, ein: `${10 + n}-3456789`,
      invoice_prefix: `NATIVE${n}`, invoice_number_width: 4, payment_terms_days: 30, processor_account_ref: context.account.id,
      ledger_company_ref: `synthetic-unconnected-ledger-${n}`, tax_registration: 'Synthetic sandbox registration' })).id
    await api('customer.entity', { revision: (await api('business')).revision, customer: context.nativeCustomer, entity: context.entity, confirm: true })
    context.gross = context.index ? 2300 : 1200; context.credit = context.index ? 300 : 200; context.owed = context.gross - context.credit
    const charge = await api('charge.add', { customer: context.nativeCustomer, amount: (context.gross / 100).toFixed(2), description: 'Owned native sandbox service', effective_date: date, taxable: false })
    const draft = await api('invoice.manual', { customer: context.nativeCustomer, charges: [charge.charge], service_date: date })
    await api('invoice.approve', { invoice: draft.id, acknowledge: true })
    await api('invoice.finalise', { invoice: draft.id, issue_date: date })
    context.invoice = await api(`invoices/${draft.id}`)
    await api('credit.issue', { invoice: draft.id, amount: (context.credit / 100).toFixed(2), reason: 'Owned pre-collection sandbox adjustment' })
    context.original = await api(`invoices/${draft.id}`)
    const route = JSON.parse(context.original.billing_route_json)
    check(route.entityId === context.entity && route.processorAccountRef === context.account.id && route.ledgerCompanyRef === `synthetic-unconnected-ledger-${n}`, 'issued_native_route_mismatch')
    await api('collection.customer.bind', { customer: context.nativeCustomer, account_ref: context.account.id, stripe_customer_ref: context.customer.id, confirm: true })
    receipt.nativeIds.push({ customerId: context.nativeCustomer, entityId: context.entity, invoiceId: context.invoice.id })
  }
}

async function collect() {
  const api = (path, body, status) => h.api(path, owner, body, status), mailCount = h.mails.length
  for (const context of contexts) {
    step(`explicit-owner-collection-${context.index + 1}`)
    await currentClock()
    const prepared = await api('collection.prepare', { invoice: context.invoice.id })
    check(prepared.review.accountRef === context.account.id && prepared.review.customerRef === context.customer.id && prepared.review.paymentMethodRef === context.method
      && prepared.review.amountCents === context.owed && prepared.review.currency === 'usd' && prepared.review.livemode === false, 'prepared_actual_account_customer_card_balance_mismatch')
    check(prepared.review.sourceFingerprint === context.original.source_fingerprint, 'prepared_original_source_hash_mismatch')
    const result = await api('collection.confirm', prepared.instructions.confirm)
    if (context.index === 1) {
      check(lostResponse && result.status === 'uncertain', 'lost_successful_response_not_held_uncertain')
      const posts = workerRequests.filter(entry => entry.method === 'POST').length, deadline = Date.now() + 90_000
      let recovered = result
      while (recovered.status !== 'collected' && Date.now() < deadline) {
        await currentClock()
        recovered = await api('collection.reconcile', { request: result.id })
        check(workerRequests.filter(entry => entry.method === 'POST').length === posts, 'reconciliation_mutated_provider')
        if (recovered.status !== 'collected') { console.log('Native Stripe sandbox: waiting for read-only Stripe search visibility'); await delay(5000) }
      }
      check(recovered.status === 'collected' && recovered.payment_intent_ref === lostIntentRef, 'real_uncertain_payment_not_reconciled')
      context.collection = recovered
    } else { check(result.status === 'collected', 'native_payment_not_recorded'); context.collection = result }
    const collected = context.collection
    const intent = await context.stripe.request('GET', `/v1/payment_intents/${collected.payment_intent_ref}`)
    const charges = await context.stripe.list('/v1/charges', { customer: context.customer.id })
    check(charges.data.length === 1, 'owned_customer_charged_more_than_once')
    const charge = charges.data[0]
    check(intent.status === 'succeeded' && intent.amount === context.owed && intent.amount_received === context.owed && intent.currency === 'usd' && intent.livemode === false
      && reference(intent.customer) === context.customer.id && reference(intent.payment_method) === context.method && reference(intent.latest_charge) === charge.id, 'actual_payment_intent_proof_mismatch')
    check(charge.id === collected.charge_ref && reference(charge.payment_intent) === intent.id && reference(charge.customer) === context.customer.id && reference(charge.payment_method) === context.method
      && charge.paid === true && charge.captured === true && charge.status === 'succeeded' && charge.amount === context.owed && charge.amount_captured === context.owed
      && charge.amount_refunded === 0 && charge.livemode === false && !charge.receipt_email && !intent.receipt_email, 'actual_captured_charge_proof_mismatch')
    context.proof = { paymentIntentId: intent.id, chargeId: charge.id, receivedOn: new Date(charge.created * 1000).toISOString().slice(0, 10) }
    const current = await api(`invoices/${context.invoice.id}`)
    check(current.paidCents === context.owed && current.creditedCents === context.credit && current.balanceCents === 0, 'native_receivable_not_exactly_settled')
    check(current.allocations.length === 1 && current.allocations[0].payment_id === collected.payment_id && current.allocations[0].amount_cents === context.owed, 'native_payment_allocation_not_once')
    check(current.billing_route_json === context.original.billing_route_json && current.source_fingerprint === context.original.source_fingerprint
      && isDeepStrictEqual(current.calculation, context.original.calculation) && isDeepStrictEqual(current.lines, context.original.lines), 'issued_entity_route_or_source_was_modified')
    const posts = workerRequests.filter(entry => entry.method === 'POST').length
    await api('collection.confirm', prepared.instructions.confirm, 409)
    check((await api('collection.reconcile', { request: collected.id })).payment_id === collected.payment_id, 'settled_reconciliation_changed_payment')
    check(workerRequests.filter(entry => entry.method === 'POST').length === posts, 'repeat_or_settled_reconciliation_recharged')
    check((await context.stripe.list('/v1/charges', { customer: context.customer.id })).data.length === 1, 'repeat_created_another_provider_charge')
    const payments = await api('payments'), recorded = payments.filter(payment => payment.id === collected.payment_id)
    check(recorded.length === 1 && recorded[0].amount_cents === context.owed && recorded[0].received_on === context.proof.receivedOn
      && recorded[0].method === 'card_external' && recorded[0].reference === `stripe:${context.account.id}:${intent.id}`, 'captured_native_payment_not_recorded_once')
    receipt.accounts[context.index] = { ...receipt.accounts[context.index], paymentIntentId: intent.id, chargeId: charge.id }
    receipt.nativeIds[context.index] = { ...receipt.nativeIds[context.index], collectionId: collected.id, paymentId: collected.payment_id, allocationId: collected.allocation_id }
    receipt.hashes[`issuedSource${context.index + 1}`] = digest({ route: current.billing_route_json, calculation: current.calculation, lines: current.lines })
  }
  check(h.mails.length === mailCount, 'native_collection_sent_customer_email')
  const posts = workerRequests.filter(entry => entry.method === 'POST')
  check(posts.length === 2 && new Set(posts.map(entry => entry.key)).size === 2, 'one_processor_attempt_per_invoice_not_proven')
  for (const context of contexts) check(posts.filter(entry => entry.account === context.account.id && entry.customer === context.customer.id && entry.amount === context.owed).length === 1, 'processor_attempt_used_foreign_entity_route')
  receipt.checks.actualTwoAccountCollection = true; receipt.checks.originalSourcesUnchanged = true
  receipt.checks.uncertainRecoveryOnlyGets = true; receipt.checks.repeatRefused = true; receipt.checks.zeroCustomerEmail = true
}

async function reports() {
  step('scoped-and-consolidated-revenue-and-cash')
  await currentClock()
  const api = path => h.api(path, owner), months = [...new Set(contexts.flatMap(context => [context.invoice.issue_date.slice(0, 7), context.proof.receivedOn.slice(0, 7)]))].sort()
  for (const month of months) for (const metric of ['billings', 'collections', 'credits', 'ar']) {
    const expected = context => metric === 'billings' ? context.invoice.issue_date.startsWith(month) ? context.gross : 0
      : metric === 'collections' ? context.proof.receivedOn.startsWith(month) ? context.owed : 0
        : metric === 'credits' ? context.invoice.issue_date.startsWith(month) ? context.credit : 0 : 0
    const all = await api(`reports/${metric}?period=${month}`)
    check(all.totalCents === sum(contexts.map(expected)), 'consolidated_financial_report_mismatch')
    for (const context of contexts) {
      const scoped = await api(`reports/${metric}?period=${month}&customer=${context.nativeCustomer}`)
      check(scoped.totalCents === expected(context) && scoped.entries.every(entry => entry.customerId === context.nativeCustomer), 'customer_financial_report_mismatch')
      if (metric === 'collections' && expected(context)) {
        const source = await api(`reports/collections/${context.collection.payment_id}?period=${month}&customer=${context.nativeCustomer}`)
        check(source.totalCents === context.owed && sum(source.components.map(entry => entry.amountCents)) === context.owed && source.payment.receivedOn === context.proof.receivedOn, 'captured_receipt_report_source_mismatch')
      }
    }
  }
  const from = months[0], to = months.at(-1), consolidated = await api(`revenue?from=${from}&to=${to}`)
  const scoped = []
  for (const context of contexts) {
    const report = await api(`revenue?from=${from}&to=${to}&entity=${context.entity}`)
    check(report.netBillingsCents === context.owed && report.recognizedCents === context.owed && report.closingCents === 0
      && report.contributions.length > 0 && report.contributions.every(entry => entry.invoiceId === context.invoice.id), 'entity_revenue_route_filter_or_amount_mismatch')
    const journal = await api(`revenue-journal?from=${from}&to=${to}&entity=${context.entity}`)
    check(journal.periods.length > 0 && journal.sources.length > 0 && journal.periods.every(period => period.debitCents === period.creditCents) && journal.sources.every(source => source.invoiceId === context.invoice.id), 'entity_staging_journal_mismatch')
    const csv = await h.raw(`/app/exports/revenue.csv?from=${from}&to=${to}&entity=${context.entity}`, { cookie: owner })
    check(csv.status === 200, 'entity_revenue_csv_unavailable')
    const rows = csvRows(await csv.text()), rolls = rows.filter(row => row.row_kind === 'rollforward')
    check(sum(rolls.map(row => cents(row.net_billings))) === context.owed && sum(rolls.map(row => cents(row.recognized))) === context.owed, 'entity_revenue_csv_mismatch')
    scoped.push(report)
  }
  check(consolidated.netBillingsCents === sum(scoped.map(report => report.netBillingsCents)) && consolidated.recognizedCents === sum(scoped.map(report => report.recognizedCents))
    && consolidated.netBillingsCents === 3000 && consolidated.recognizedCents === 3000, 'scoped_and_consolidated_revenue_do_not_reconcile')
  receipt.hashes.financialAndRevenue = digest({ consolidated, scoped })
  receipt.checks.receiptsInOrdinaryFinancialReports = true; receipt.checks.entityRevenueCsvAndConsolidatedParity = true; receipt.checks.balancedReadOnlyStagingJournals = true
}

try {
  receipt.head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  check(/^[a-f0-9]{40}$/.test(receipt.head), 'candidate_head_required')
  await createProviderSources()
  await createNativeInvoices()
  await collect()
  await reports()
  receipt.status = 'passed'
} catch (error) {
  receipt.status = 'failed'; receipt.failure = { phase, ...safeError(error) }; process.exitCode = 1
  console.error(`Native Stripe sandbox: failed phase=${phase} code=${receipt.failure.code} status=${receipt.failure.status ?? 'none'}`)
} finally {
  if (h) try { await h.close() } catch (error) { receipt.status = 'failed'; receipt.runtimeCleanup = safeError(error); process.exitCode = 1 }
  for (const context of contexts) if (context.clock) {
    try {
      const deleted = await context.stripe.request('DELETE', `/v1/test_helpers/test_clocks/${context.clock}`)
      check(deleted.deleted === true && deleted.id === context.clock, 'owned_clock_cleanup_unconfirmed')
      receipt.cleanup.push({ clockId: context.clock, deleted: true })
    } catch (error) { receipt.status = 'failed'; receipt.cleanup.push({ clockId: context.clock, deleted: false, ...safeError(error) }); process.exitCode = 1 }
  }
  receipt.counts = { workerPaymentAttempts: workerRequests.filter(entry => entry.method === 'POST').length,
    droppedRealSuccessResponses: lostResponse ? 1 : 0, accounts: contexts.map(context => ({ accountId: context.account?.id ?? null, ...context.stripe.counts })) }
  try { await mkdir(evidence, { recursive: true, mode: 0o700 }); await writeFile(join(evidence, 'native-collection-sandbox.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 }) }
  catch { console.error('Native Stripe sandbox: safe receipt could not be written'); process.exitCode = 1 }
  console.log(`Native Stripe sandbox: ${receipt.status}; receipt=.evidence/native-collection-sandbox.json`)
}
