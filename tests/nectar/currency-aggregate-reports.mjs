import assert from 'node:assert/strict'
import { csvRows } from './financial-reports.mjs'

const sum = rows => rows.reduce((total, row) => total + row.amountCents, 0)
const amount = cents => (cents / 100).toFixed(2)
const idOf = value => typeof value === 'string' ? value : value?.id

// Fold into currencyFlow after its CAD receipt and credit exist. All writes use
// ordinary public doors; the caller retains its existing processor network edge.
export async function assertCurrencyAggregateReports(h, owner, { customer, invoice, payment, credit, usdCustomer, recordRate,finance } = {}) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  const setTax=async payload=>{const pending=await api('tax.declare',payload);await h.api('policy.decide',finance,{request:pending.request,decision:'approved'})}
  const original = await api(`invoices/${idOf(invoice)}`)
  customer = idOf(customer) ?? original.customer_id
  const ledger = (await api(`customers/${customer}`)).ledger
  payment = idOf(payment) ?? ledger.payments.find(row => row.amount_cents === 899)?.id
  credit = idOf(credit) ?? ledger.credits.find(row => row.amount_cents === 101)?.id
  assert.ok(payment); assert.ok(credit)
  const reports = new Map()
  const check = async (metric, sourceId, nativeCents, usdCents, rateDate, scope = customer) => {
    const query = `period=2026-10&customer=${scope}`
    const report = await api(`reports/${metric}?${query}`)
    assert.equal(report.totalCents, sum(report.entries), `${metric} report equals USD contributions`)
    const entry = report.entries.find(row => row.invoiceId === sourceId)
    assert.ok(entry, `${metric} contains the source`)
    assert.equal(entry.amountCents, usdCents)
    assert.equal(entry.nativeCurrency, 'CAD')
    assert.equal(entry.nativeAmountCents, nativeCents)
    assert.equal(entry.reporting.currency, 'USD')
    assert.equal(entry.reporting.rateDate, rateDate)
    assert.ok(entry.reporting.rateId)
    assert.ok(entry.reporting.source)
    const source = await api(entry.href.replace('/app/', ''))
    assert.equal(source.totalCents, entry.amountCents)
    assert.equal(sum(source.components), entry.amountCents)
    assert.equal(source.components.reduce((n, row) => n + row.nativeAmountCents, 0), nativeCents)
    assert.deepEqual(source.reporting, entry.reporting)
    const response = await h.raw(`/app/exports/reports/${metric}.csv?${query}`, { cookie: owner })
    assert.equal(response.status, 200)
    const rows = csvRows(await response.text())
    const exported = rows.find(row => row.source_reference === sourceId)
    assert.ok(exported)
    assert.equal(exported.amount, amount(usdCents))
    assert.equal(exported.native_amount, amount(nativeCents))
    assert.equal(exported.native_currency, 'CAD')
    assert.equal(exported.reporting_currency, 'USD')
    assert.equal(exported.usd_per_unit, entry.reporting.rate)
    assert.equal(exported.rate_record_id, entry.reporting.rateId)
    assert.equal(exported.rate_date, rateDate)
    assert.equal(exported.rate_source, entry.reporting.source)
    reports.set(metric, report)
    return source
  }
  await check('billings', original.id, 1000, 735, '2026-10-01')
  const receipt = await check('collections', payment, 899, 661, '2026-10-23')
  assert.equal(receipt.payment.amountCents, 899)
  assert.equal(receipt.payment.currency, 'CAD')
  const adjustment = await check('credits', credit, 101, 74, '2026-10-23')
  assert.equal(adjustment.credit.amountCents, 101)
  await check('tax', original.id, 0, 0, '2026-10-01')

  usdCustomer = idOf(usdCustomer) ?? (await api('customer.create', { external_id: 'synthetic-nectar-301', name: 'Synthetic aggregate USD customer', billing_email: 'synthetic-nectar-301@example.test' })).id
  const issue = async (target, cents, date, count = 1, taxable = false) => {
    const charges = []
    for (let index = 0; index < count; index++) charges.push((await api('charge.add', { customer: target, amount: amount(cents), description: 'Synthetic aggregate component synthetic-nectar-302', taxable, effective_date: date })).charge)
    const draft = await api('invoice.manual', { customer: target, charges, service_date: date })
    await api('invoice.approve', { invoice: draft.id, acknowledge: true })
    await api('invoice.finalise', { invoice: draft.id, issue_date: date })
    return api(`invoices/${draft.id}`)
  }
  const usdInvoice = await issue(usdCustomer, 123, '2026-10-01')
  const usdPayment = await api('payment.record', { customer: usdCustomer, amount: '0.07', received_on: '2026-10-23', method: 'bank_transfer', reference: 'synthetic-nectar-303' })
  const tiny = await issue(customer, 1, '2026-10-01', 3)
  const tinySource = await check('billings', tiny.id, 3, 2, '2026-10-01')
  assert.deepEqual(tinySource.components.map(row => row.amountCents), [1, 1, 0, 0], 'one conversion of the transaction prevents split-line inflation')
  const tinyPayment = await api('payment.record', { customer, amount: '0.03', received_on: '2026-10-23', method: 'bank_transfer', reference: 'synthetic-nectar-304' })
  for (let index = 0; index < 3; index++) await api('payment.allocate', { invoice: tiny.id, payment: tinyPayment.payment, amount: '0.01' })
  const tinyReceipt = await check('collections', tinyPayment.payment, 3, 2, '2026-10-23')
  assert.deepEqual(tinyReceipt.components.map(row => row.amountCents), [1, 1, 0], 'payment allocations distribute the once-rounded receipt')

  // No adjacent day, invoice date or latest rate may replace the required date.
  const missing = await issue(customer, 1, '2026-10-22')
  for (const metric of ['billings', 'tax']) {
    await api(`reports/${metric}?period=2026-10&customer=${customer}`, undefined, 409)
    await api(`reports/${metric}/${missing.id}?period=2026-10&customer=${customer}`, undefined, 409)
    assert.equal((await h.raw(`/app/exports/reports/${metric}.csv?period=2026-10&customer=${customer}`, { cookie: owner })).status, 409)
  }
  const usdOnly = await api(`reports/billings?period=2026-10&customer=${usdCustomer}`)
  assert.equal(usdOnly.totalCents, 123, 'USD scope does not depend on another customer rate')
  assert.equal(usdOnly.entries[0].reporting, undefined)
  const payload = { currency: 'CAD', rate_date: '2026-10-22', usd_per_unit: '0.50', source: 'Synthetic daily aggregate worksheet synthetic-nectar-305' }
  if (recordRate) await recordRate(payload)
  else await api('currency.rate.record', payload)
  await check('billings', missing.id, 1, 1, '2026-10-22')
  const datedPayment = await api('payment.record', { customer, amount: '0.03', received_on: '2026-10-22', method: 'bank_transfer', reference: 'synthetic-nectar-306' })
  await check('collections', datedPayment.payment, 3, 2, '2026-10-22')

  // Tax shares the invoice conversion; rounding the tiny tax separately would
  // incorrectly add one USD cent to this invoice's whole USD cent.
  const before = await api('business')
  try {
    await setTax( { tax_jurisdiction: 'CA', tax_mode: 'flat_rate', tax_rate: '50', tax_note: 'Synthetic aggregate tax fixture synthetic-nectar-307' })
    await api('tax.review', { revision: (await api('business')).revision })
    const taxed = await issue(customer, 1, '2026-10-01', 1, true)
    assert.equal(taxed.tax_cents, 1); assert.equal(taxed.total_cents, 2)
    const taxBillings = await check('billings', taxed.id, 2, 1, '2026-10-01')
    assert.deepEqual(taxBillings.components.map(row => row.amountCents), [1, 0])
    const taxSource = await check('tax', taxed.id, 1, 0, '2026-10-01')
    assert.equal(taxSource.components[0].amountCents, taxBillings.components.find(row => row.kind === 'tax').amountCents)
  } finally {
    await setTax( { tax_jurisdiction: before.tax_jurisdiction, tax_mode: before.tax_mode, tax_rate: before.tax_rate, tax_note: before.tax_note })
    if (before.taxReady) await api('tax.review', { revision: (await api('business')).revision })
  }
  for (const metric of ['billings', 'collections', 'credits', 'tax']) {
    const all = await api(`reports/${metric}?period=2026-10`)
    assert.equal(all.totalCents, sum(all.entries))
    assert.equal(all.reportingCurrency, 'USD')
    assert.ok(all.entries.some(entry => entry.nativeCurrency === 'CAD'))
    if (metric === 'billings') assert.equal(all.entries.find(entry => entry.invoiceId === usdInvoice.id).amountCents, 123)
    if (metric === 'collections') assert.equal(all.entries.find(entry => entry.invoiceId === usdPayment.payment).amountCents, 7)
  }
  for (const metric of ['ar', 'mrr', 'unbilled', 'credit-balances']) await api(`reports/${metric}?period=2026-10`, undefined, 409)
  await api('revenue?period=2026-10', undefined, 409)
  const refunds = await api('reports/refunds?period=2026-10')
  assert.equal(refunds.totalCents, sum(refunds.entries), 'existing USD refund contributions remain readable')
  const final = await api(`invoices/${original.id}`)
  assert.deepEqual(final.lines, original.lines)
  assert.deepEqual(final.calculation, original.calculation)
  assert.equal(final.source_fingerprint, original.source_fingerprint)
  assert.equal(final.total_cents, original.total_cents)
  return { reports: Object.fromEntries(reports), tiny: tiny.id, missing: missing.id, usdCustomer }
}
