// Outside push Verify. Parent builds/commits, then runs through heavy-slot and
// briefs/_od08-env.py STRIPE_SECRET_KEY=STRIPE_US_TEST_SECRET_KEY -- node THIS_FILE.
// No Stripe response bodies, credentials, customer URLs or auth cookies are logged.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stripeSandbox, check, safeError, reference, monthTime, monthName } from './stripe-sandbox-client.mjs'

const evidence = join(process.cwd(), '.evidence')
const receipt = { version: 1, journey: 'MOVE-007 Stripe 18-month history', status: 'running', startedAt: new Date().toISOString(), head: null,
  clockId: null, sourceIds: {}, assertions: {}, captureHashes: {}, cleanup: { clockDeleted: false } }
let stripe, phase = 'test-key', ownedClock, h
const step = name => { phase = name; console.log(`Stripe history: ${name}`) }
const sum = rows => rows.reduce((total, row) => total + row, 0)
const dateMonth = seconds => new Date(seconds * 1000).toISOString().slice(0, 7)
const subscriptionOf = invoice => reference(invoice.subscription ?? invoice.parent?.subscription_details?.subscription)
const invoicePayments = invoice => invoice.payments?.data ?? []
const belongs = (payment, charge) => payment.payment?.type === 'payment_intent'
  ? reference(payment.payment.payment_intent) === reference(charge.payment_intent)
  : payment.payment?.type === 'charge' && reference(payment.payment.charge) === charge.id

async function capturedInvoice(id) {
  const invoice = await stripe.request('GET', `/v1/invoices/${id}`, { 'expand[]': 'payments' })
  // Pagination combines real provider list entries without inventing documents.
  if (invoice.lines.has_more) invoice.lines = await stripe.list(`/v1/invoices/${id}/lines`)
  if (invoice.payments?.has_more) invoice.payments = await stripe.list('/v1/invoice_payments', { invoice: id })
  check(invoice.lines?.has_more === false && Array.isArray(invoice.lines.data), 'stripe_invoice_lines_incomplete')
  check(invoice.payments?.has_more === false, 'stripe_invoice_payments_incomplete')
  return invoice
}

async function generate() {
  step('create-owned-clock')
  const clock = await stripe.request('POST', '/v1/test_helpers/test_clocks', { frozen_time: monthTime(0), name: `Nectar history ${stripe.run}` })
  ownedClock = clock.id; receipt.clockId = ownedClock; receipt.clockDeletesAfter = clock.deletes_after
  check(clock.status === 'ready' && clock.frozen_time === monthTime(0), 'stripe_initial_clock_not_ready')
  step('create-owned-catalog-and-customer')
  const product = await stripe.request('POST', '/v1/products', { name: `Nectar history ${stripe.run}`, 'metadata[nectar_run]': stripe.run })
  receipt.sourceIds.product = product.id; receipt.sourceIds.prices = []
  const prices = []
  for (const [interval, amount] of [['month', 10000], ['year', 1200000]]) {
    const price = await stripe.request('POST', '/v1/prices', { product: product.id, currency: 'usd', unit_amount: amount,
      'recurring[interval]': interval, tax_behavior: 'exclusive', 'metadata[nectar_run]': stripe.run })
    prices.push(price); receipt.sourceIds.prices.push(price.id)
  }
  const method = await stripe.request('POST', '/v1/payment_methods', { type: 'card', 'card[token]': 'tok_visa' })
  receipt.sourceIds.paymentMethod = method.id
  const customer = await stripe.request('POST', '/v1/customers', { name: `Nectar sandbox ${stripe.run}`, test_clock: ownedClock,
    payment_method: method.id, 'invoice_settings[default_payment_method]': method.id, 'metadata[nectar_run]': stripe.run })
  receipt.sourceIds.customer = customer.id
  const events = new Map()
  async function captureEvents() {
    const listed = await stripe.list('/v1/events', { type: 'customer.subscription.*' })
    for (const event of listed.data) if (reference(event.data?.object?.customer) === customer.id) events.set(event.id, event)
  }
  const createSubscription = price => stripe.request('POST', '/v1/subscriptions', { customer: customer.id, 'items[0][price]': price,
    collection_method: 'charge_automatically', payment_behavior: 'error_if_incomplete', 'metadata[nectar_run]': stripe.run })
  step('create-monthly-subscription')
  const monthly = await createSubscription(prices[0].id)
  receipt.sourceIds.subscriptions = [monthly.id]
  await captureEvents()
  const first = await capturedInvoice(reference(monthly.latest_invoice))
  check(first.status === 'paid' && first.amount_paid === 10000, 'stripe_initial_invoice_not_paid')
  const firstCharges = await stripe.list('/v1/charges', { customer: customer.id })
  const firstCharge = firstCharges.data.find(charge => invoicePayments(first).some(payment => belongs(payment, charge)))
  check(firstCharge?.status === 'succeeded' && firstCharge.amount === 10000, 'stripe_first_payment_mapping_missing')
  step('create-twenty-dollar-refund-and-linked-credit')
  const refund = await stripe.request('POST', '/v1/refunds', { charge: firstCharge.id, amount: 2000, 'metadata[nectar_run]': stripe.run })
  receipt.sourceIds.refund = refund.id
  check(refund.status === 'succeeded' && refund.amount === 2000, 'stripe_refund_not_succeeded')
  const credit = await stripe.request('POST', '/v1/credit_notes', { invoice: first.id, amount: 2000, 'refunds[0][refund]': refund.id,
    'refunds[0][amount_refunded]': 2000, memo: `Nectar history ${stripe.run}` })
  check(credit.status === 'issued' && credit.total === 2000, 'stripe_credit_not_issued')
  check(credit.refunds?.some(row => reference(row.refund) === refund.id && row.amount_refunded === 2000), 'stripe_credit_refund_link_missing')
  receipt.sourceIds.creditNote = credit.id
  let annual
  for (let index = 1; index < 18; index++) {
    step(`generate-${monthName(index)}`)
    await stripe.advance(ownedClock, monthTime(index), `${monthName(index)} boundary`)
    if (index === 14) {
      step('create-march-annual-subscription')
      annual = await createSubscription(prices[1].id)
      receipt.sourceIds.subscriptions.push(annual.id)
      await captureEvents()
    }
    phase = `settle-${monthName(index)}`
    await stripe.advance(ownedClock, monthTime(index) + 7200, `${monthName(index)} finalize`)
    await captureEvents()
  }
  phase = 'finish-before-cutover'
  await stripe.advance(ownedClock, monthTime(18) - 1, 'before July cutover')
  await captureEvents()
  step('capture-complete-provider-history')
  const customers = await stripe.list('/v1/customers', { test_clock: ownedClock })
  const subscriptions = await stripe.list('/v1/subscriptions', { customer: customer.id, status: 'all' })
  const listedInvoices = await stripe.list('/v1/invoices', { customer: customer.id })
  const invoices = { ...listedInvoices, data: [] }
  for (const row of listedInvoices.data) invoices.data.push(await capturedInvoice(row.id))
  const payments = await stripe.list('/v1/charges', { customer: customer.id })
  const refunds = { object: 'list', url: '/v1/refunds', has_more: false, data: [] }
  const disputes = { object: 'list', url: '/v1/disputes', has_more: false, data: [] }
  for (const charge of payments.data) {
    refunds.data.push(...(await stripe.list('/v1/refunds', { charge: charge.id })).data)
    if (charge.disputed) disputes.data.push(...(await stripe.list('/v1/disputes', { charge: charge.id })).data)
  }
  const creditNotes = await stripe.list('/v1/credit_notes', { customer: customer.id })
  const capture = { customers, products: { object: 'list', has_more: false, data: [product] }, prices: { object: 'list', has_more: false, data: prices },
    subscriptions, invoices, payments, refunds, disputes, credit_notes: creditNotes,
    subscription_events: { object: 'list', url: '/v1/events', has_more: false, data: [...events.values()] } }
  capture.manifest = { source: 'stripe', captured_at: new Date().toISOString(), api_version: stripe.apiVersion,
    captured_by: 'Nectar sandbox journey using held Stripe test credentials', clock: ownedClock,
    coverage: 'Only this journey clock/customer and owned catalog; subscription events captured during generation; all resource pages combined.',
    files: Object.fromEntries(Object.entries(capture).map(([name, value]) => [name, { endpoint: value.url ?? `/v1/${name}`, count: value.data.length, has_more: false }])) }
  check(customers.data.length === 1 && customers.data[0].id === customer.id, 'stripe_clock_customer_scope_changed')
  check(invoices.data.every(row => row.status === 'paid' && row.status_transitions.finalized_at && row.number), 'stripe_history_contains_unissued_invoice')
  check(invoices.data.filter(row => subscriptionOf(row) === monthly.id).length === 18, 'stripe_monthly_invoice_count')
  check(invoices.data.filter(row => subscriptionOf(row) === annual?.id).length === 1, 'stripe_annual_invoice_count')
  check(capture.subscription_events.data.length > 0, 'stripe_subscription_events_unavailable')
  check(refunds.data.some(row => row.id === refund.id && row.amount === 2000), 'stripe_refund_capture_missing')
  check(payments.data.every(charge => invoices.data.some(invoice => invoicePayments(invoice).some(payment => belongs(payment, charge)))), 'stripe_payment_invoice_mapping_incomplete')
  receipt.sourceIds.invoices = invoices.data.map(row => row.id)
  receipt.sourceIds.lines = invoices.data.flatMap(row => row.lines.data.map(line => line.id))
  receipt.sourceIds.payments = payments.data.map(row => row.id)
  receipt.sourceIds.events = capture.subscription_events.data.map(row => row.id)
  receipt.sourceIds.disputes = disputes.data.map(row => row.id)
  receipt.providerCounts = Object.fromEntries(Object.entries(capture).filter(([name]) => name !== 'manifest').map(([name, value]) => [name, value.data.length]))
  for (const [name, value] of Object.entries(capture)) receipt.captureHashes[name] = createHash('sha256').update(JSON.stringify(value)).digest('hex')
  if (process.env.STRIPE_SANDBOX_CAPTURE === '1') {
    const filename = `stripe-history-sandbox-capture-${stripe.run}.json`
    await writeFile(join(evidence, filename), JSON.stringify(capture), { mode: 0o600, flag: 'wx' }); receipt.privateCapture = filename
  }
  return { capture, customer, monthly, annual, first, refund, credit }
}

async function prove({ capture, customer, monthly, annual, first, refund, credit }) {
  step('ordinary-owner-setup')
  const { harness, file } = await import('./harness.mjs')
  const { applyPolicy } = await import('./policy-helper.mjs')
  h = await harness({ localTime: '2026-07-01T00:00:00Z' })
  check((await h.raw('/auth/bootstrap', { body: { token: h.vars.SETUP_TOKEN, displayName: 'Sandbox Owner' } })).status === 303, 'owner_bootstrap_failed')
  const owner = await h.signIn(h.vars.OWNER_EMAIL)
  check((await h.raw('/setup', { cookie: owner, form: new URLSearchParams({ confirm: 'yes' }) })).status === 303, 'owner_setup_failed')
  const api = (path, body, status) => h.api(path, owner, body, status)
  await api('business.configure', { legal_name: 'Nectar sandbox history', timezone: 'UTC', invoice_prefix: 'SANDBOX', payment_terms_days: 30 })
  await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: 'CA', tax_mode: 'no_tax', tax_note: 'Zero-tax provider sandbox history; no tax service requested' })
  await api('tax.review', { revision: (await api('business')).revision })
  const files = Object.fromEntries(Object.entries(capture).map(([name, value]) => [name, file(`${name}.json`, JSON.stringify(value), 'application/json')]))
  step('public-import-preview-and-apply')
  const preview = await api('import.preview', files)
  check(preview.rejected.some(row => row.location.includes(annual.id)), 'annual_active_subscription_not_explicitly_rejected')
  check(preview.rejected.some(row => row.location.includes(capture.prices.data[1].id)), 'annual_active_price_not_explicitly_rejected')
  check(preview.rejected.length === 2, 'unexpected_history_mapping_rejection')
  check(preview.create.invoice === 19 && preview.create.credit_note === 1, 'import_document_count_mismatch')
  check((await api('customers')).length === 0, 'import_preview_mutated_customers')
  const job = await api('import.apply', { ...files, fingerprint: preview.fingerprint })
  check((await api('import.apply', { ...files, fingerprint: preview.fingerprint })).job === job.job, 'import_replay_changed_job')
  const imported = (await api('customers')).find(row => row.external_id === customer.id)
  check(imported, 'imported_customer_missing')
  const detail = await api(`customers/${imported.id}`), history = detail.incumbentHistory
  check(history.documents.length === 20, 'customer_history_document_count')
  const importedPayments = history.records.filter(row => row.kind === 'payment')
  check(importedPayments.length === capture.payments.data.length, 'customer_history_payment_count')
  for (const charge of capture.payments.data) {
    const retained = importedPayments.find(row => row.provider_ref === charge.id)
    const linked = capture.invoices.data.find(invoice => invoicePayments(invoice).some(payment => belongs(payment, charge)))
    check(retained?.amount_cents === charge.amount && retained.invoice_ref === linked?.id, 'imported_basil_payment_link_mismatch')
    check(JSON.stringify(retained.original) === JSON.stringify(charge), 'imported_payment_original_changed')
  }
  check(history.records.some(row => row.kind === 'refund' && row.provider_ref === refund.id && row.amount_cents === 2000), 'customer_history_refund_missing')
  check(history.documents.some(row => row.provider_ref === credit.id && row.document_kind === 'credit-note' && row.total_cents === 2000), 'customer_history_credit_missing')
  check(history.records.filter(row => row.kind === 'subscription-event').length === capture.subscription_events.data.length, 'customer_history_subscription_events_missing')
  for (const event of capture.subscription_events.data) check(JSON.stringify(history.records.find(row => row.provider_ref === event.id)?.original) === JSON.stringify(event), 'imported_subscription_snapshot_changed')
  for (const invoice of capture.invoices.data) check(JSON.stringify(history.documents.find(row => row.provider_ref === invoice.id)?.original) === JSON.stringify(invoice), 'imported_invoice_original_changed')
  check(!detail.subscriptions.some(row => row.provider_ref === annual.id), 'unsupported_annual_subscription_installed')
  const annualInvoice = capture.invoices.data.find(row => subscriptionOf(row) === annual.id)
  const annualDocument = history.documents.find(row => row.provider_ref === annualInvoice.id)
  check(annualDocument && annualDocument.original.id === annualInvoice.id, 'annual_original_history_missing')
  receipt.assertions.history = { importedDocuments: history.documents.length, importedPayments: importedPayments.length,
    importedRefundCents: 2000, importedCreditCents: 2000, importedSubscriptionEvents: capture.subscription_events.data.length, annualActiveMappingRejected: true }
  step('public-eighteen-month-source-reports')
  const monthlyReports = []
  for (let index = 0; index < 18; index++) {
    const period = monthName(index); phase = `reports-${period}`
    const sourceInvoices = capture.invoices.data.filter(row => dateMonth(row.status_transitions.finalized_at) === period)
    const sourceCharges = capture.payments.data.filter(row => row.status === 'succeeded' && dateMonth(row.created) === period)
    const amounts = { billings: sum(sourceInvoices.map(row => row.total)), collections: sum(sourceCharges.map(row => row.amount)), tax: 0,
      credits: sum(capture.credit_notes.data.filter(row => row.status === 'issued' && dateMonth(row.created) === period).map(row => row.total)), mrr: 10000 + (index >= 14 ? 100000 : 0) }
    check(sourceInvoices.some(row => subscriptionOf(row) === monthly.id), 'monthly_source_invoice_missing')
    for (const [metric, expected] of Object.entries(amounts)) {
      const report = await api(`reports/${metric}?period=${period}&customer=${imported.id}`)
      check(report.totalCents === expected, `historical_${metric}_total_mismatch`)
      check(report.entries.every(row => row.sourceProvider === 'stripe'), 'report_source_provider_mismatch')
      for (const entry of report.entries) {
        const source = await api(`reports/${metric}/${entry.invoiceId}?period=${period}&customer=${imported.id}`)
        check(source.totalCents === entry.amountCents && sum(source.components.map(row => row.amountCents)) === entry.amountCents, 'historical_source_reconciliation_mismatch')
        check(source.historical.reference === entry.sourceReference, 'historical_source_reference_mismatch')
      }
    }
    monthlyReports.push({ period, ...amounts })
  }
  receipt.assertions.monthlyReports = monthlyReports
  step('public-annual-deferred-revenue')
  const revenue = await api(`revenue?from=2026-07&to=2027-02&customer=${imported.id}`)
  check(revenue.openingCents === 800000 && revenue.recognizedCents === 800000 && revenue.closingCents === 0, 'annual_deferred_rollforward_mismatch')
  check(revenue.months.length === 8 && revenue.months.every(row => row.recognizedCents === 100000), 'annual_monthly_recognition_mismatch')
  const source = await api(`revenue/${annualDocument.id}?from=2026-07&to=2027-02&customer=${imported.id}`)
  check(source.source.providerRef === annualInvoice.id, 'annual_revenue_source_mismatch')
  check(source.schedules.length === 1 && source.schedules[0].entries.length === 12 && source.schedules[0].entries.every(row => row.amountCents === 100000), 'annual_source_schedule_mismatch')
  receipt.assertions.revenue = { annualInvoice: annualInvoice.id, julyOpeningDeferredCents: 800000, remainingMonths: 8, monthlyRecognitionCents: 100000, closingCents: 0 }
  const csv = await h.raw(`/app/exports/revenue.csv?from=2026-07&to=2027-02&customer=${imported.id}`, { cookie: owner })
  check(csv.status === 200 && (await csv.text()).includes('1000.00'), 'annual_revenue_csv_missing')
  receipt.assertions.importJob = job.job
  receipt.assertions.firstStripeInvoice = first.id
}

try {
  stripe = stripeSandbox(process.env.STRIPE_SECRET_KEY)
  receipt.head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  check(/^[a-f0-9]{40}$/.test(receipt.head), 'candidate_head_required')
  receipt.apiVersion = stripe.apiVersion
  await mkdir(evidence, { recursive: true, mode: 0o700 })
  step('verify-us-test-account')
  const account = await stripe.request('GET', '/v1/account')
  check(account.country === 'US', 'stripe_us_test_account_required')
  receipt.accountId = account.id
  await prove(await generate())
  receipt.status = 'passed'
} catch (error) {
  receipt.status = 'failed'; receipt.failure = { phase, ...safeError(error) }; process.exitCode = 1
  console.error(`Stripe history: failed phase=${phase} code=${receipt.failure.code} status=${receipt.failure.status ?? 'none'}`)
} finally {
  if (h) { try { await h.close() } catch (error) { receipt.status = 'failed'; receipt.runtimeCleanup = safeError(error); process.exitCode = 1 } }
  if (stripe && ownedClock) {
    try { const deleted = await stripe.request('DELETE', `/v1/test_helpers/test_clocks/${ownedClock}`); check(deleted.deleted === true && deleted.id === ownedClock, 'stripe_clock_cleanup_unconfirmed'); receipt.cleanup.clockDeleted = true }
    catch (error) { receipt.status = 'failed'; receipt.cleanup.error = safeError(error); process.exitCode = 1 }
  }
  receipt.completedAt = new Date().toISOString()
  if (stripe) receipt.requestCounts = stripe.counts
  try { await mkdir(evidence, { recursive: true, mode: 0o700 }); await writeFile(join(evidence, 'stripe-history-sandbox.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 }) }
  catch { console.error('Stripe history: safe receipt could not be written'); process.exitCode = 1 }
  console.log(`Stripe history: ${receipt.status}; owned clock deleted=${receipt.cleanup.clockDeleted}; receipt=.evidence/stripe-history-sandbox.json`)
}
