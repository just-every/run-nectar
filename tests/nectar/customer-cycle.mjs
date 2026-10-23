import assert from 'node:assert/strict'
import { stripeHistoryCapture } from '../fixtures/stripe-history.mjs'
import { file } from './harness.mjs'
import { applyPolicy } from './policy-helper.mjs'

const sum = (rows, field) => rows.reduce((total, row) => total + row[field], 0)

/** Continue the ordinary card/ACH customer through purchased value and history. */
export async function assertCustomerFullCycle(h, owner, { customer, finance, edge, onReady = async () => {} }) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  const date = '2026-10-22'
  const contact=await api('contact.add',{customer,name:'Morgan Palmer',email:'morgan@observatory.example'})
  const note=await api('note.add',{kind:'customer',record:customer,body:'Customer confirmed the workshop and unused-credit adjustment.'})
  await api('metadata.write',{kind:'customer',record:customer,revision:0,metadata:{segment:'Observatory research'}})
  edge.at(`${date}T10:00:00Z`)
  const before = await api(`customers/${customer}`)
  assert.equal(before.external_id, stripeHistoryCapture().customers.data[0].id)
  assert.ok(before.billingRecord.processorPayments.some(row => row.status === 'collected'))
  assert.ok(before.billingRecord.achPaymentEvidence.length)

  const product = (await api('product.create', { code: 'cus001-cycle-service', name: 'Customer cycle service' })).id
  const meter = (await api('meter.create', { code: 'cus001-cycle-units', name: 'Customer cycle units', unit_label: 'units' })).id
  const price = (await api('price.create', { product, meter, kind: 'unit', unit_amount: '1', taxable: false })).id
  const subscription = (await api('subscription.create', { customer, start_date: date, price: [price] })).id
  const intent = await api('prepaid.prepare', {
    subscription, mode: 'grant', kind: 'money', source: 'purchase', amount: '20',
    effective_date: date, expires_date: '2027-01-01', priority: 10, expiry_consent: true,
  })
  await h.api('prepaid.decide', finance, { request: intent.request, decision: 'approved' })
  const purchase = (await api('prepaid.purchase.prepare', { intent: intent.request, issue_date: date })).invoice
  await api('invoice.approve', { invoice: purchase, acknowledge: true })
  await api('invoice.finalise', { invoice: purchase, issue_date: date })
  const collection = await api('collection.prepare', { invoice: purchase })
  const captured = await api('collection.confirm', collection.instructions.confirm)
  assert.equal(captured.status, 'collected')
  const original = await api(`invoices/${purchase}`)
  const funded = await api(`prepaid/${subscription}`)
  const grant = funded.grants.find(row => row.source === 'purchase')
  assert.ok(grant)
  // The public refund action returns the whole unused lot; no arbitrary partial
  // amount or fabricated consumption is used to make a smaller refund.
  const reason = 'Unused customer cycle purchase returned to its original card'
  const prepared = await api('prepaid.refund.prepare', { grant: grant.id, reason })
  assert.deepEqual([prepared.quote.amountN, prepared.quote.amountCents], [2000, 2000])
  await api('prepaid.refund.decide', { refund: prepared.id, basis_hash: prepared.basis, decision: 'approved' }, 409)
  const executed = await h.api('prepaid.refund.decide', finance, {
    refund: prepared.id, basis_hash: prepared.basis, decision: 'approved',
  })
  assert.equal(executed.status, 'refunded')
  const refunded = (await api(`prepaid/refunds?subscription=${subscription}`)).find(row => row.id === prepared.id)
  assert.ok(refunded)
  assert.equal(refunded.status, 'refunded')
  assert.equal(refunded.cashAmountCents, -2000)
  assert.ok(refunded.credit && refunded.creditNumber && refunded.refundRef)
  const returned = await api(`invoices/${purchase}`)
  assert.deepEqual(returned.calculation, original.calculation)
  assert.equal(returned.balanceCents, 0)
  const credit = returned.credits.find(row => row.id === refunded.credit)
  assert.deepEqual([credit.amount_cents, credit.applied_cents, credit.tax_cents], [2000, 0, 0])
  const prepaid = await api(`prepaid/${subscription}`)
  const reversal = prepaid.entries.find(row => row.kind === 'refund')
  assert.deepEqual([reversal.amountN, reversal.liabilityCents, reversal.recognitionCents], [-2000, -2000, 0])
  assert.equal(sum(prepaid.balances, 'remainingN'), 0)
  const refundSource = await api(`reports/refunds/${refunded.id}?period=2026-10&customer=${customer}`)
  assert.equal(sum(refundSource.components, 'amountCents'), refunded.cashAmountCents)
  assert.equal(refundSource.refund.credit.id, credit.id)
  assert.equal(refundSource.refund.receipt.id, captured.payment_id)
  assert.equal(refundSource.refund.purchase.id, purchase)

  const capture = stripeHistoryCapture()
  capture.refunds.data[0].id='synthetic-nectar-history-refund-1'
  const files = Object.fromEntries(Object.entries(capture).map(([name, value]) =>
    [name, file(`${name}.json`, JSON.stringify(value), 'application/json')]))
  const preview = await api('import.preview', files)
  assert.deepEqual(preview.rejected, [])
  assert.equal(preview.create.customer, 0, 'Exact native external id reuses this customer')
  const nativeBeforeImport = (await api(`customers/${customer}`)).ledger
  await api('import.apply', { ...files, fingerprint: preview.fingerprint })
  const imported = await api(`customers/${customer}`)
  assert.deepEqual(imported.ledger, nativeBeforeImport, 'Moved history adds no native invoice, credit or cash')
  assert.equal(imported.incumbentHistory.documents.length, capture.invoices.data.length + capture.credit_notes.data.length)
  for (const kind of ['payment', 'refund', 'dispute', 'subscription-event']) {
    assert.ok(imported.incumbentHistory.records.some(row => row.kind === kind))
  }
  assert.ok(imported.incumbentHistory.documents.every(row => row.customer_id === customer))
  assert.ok(imported.incumbentHistory.records.every(row => row.customer_id === customer))
  assert.equal(imported.incumbentHistory.totals.invoicedCents, sum(capture.invoices.data, 'total'))
  assert.equal(imported.incumbentHistory.totals.paymentsCents, sum(capture.payments.data, 'amount'))
  assert.equal(imported.incumbentHistory.totals.refundsCents, sum(capture.refunds.data, 'amount'))

  const support = await h.signIn('lookup-support@example.test')
  const accountant = await h.signIn('lookup-accountant@example.test')
  await applyPolicy(h, owner, 'credit.policy', { support_limit: '1', balance_application: 'manual' })
  const adjustment = await api('charge.add', { customer, amount: '3', description: 'Customer cycle service adjustment', effective_date: date, taxable: false })
  const adjustmentInvoice = (await api('invoice.manual', { customer, charges: [adjustment.charge], service_date: date })).id
  await api('invoice.approve', { invoice: adjustmentInvoice, acknowledge: true })
  await api('invoice.finalise', { invoice: adjustmentInvoice, issue_date: date })
  await h.api('credit.issue', support, { invoice: adjustmentInvoice, amount: '2', reason: 'Above approved support authority' }, 403)
  const supportCredit = await h.api('credit.issue', support, { invoice: adjustmentInvoice, amount: '1', reason: 'Customer cycle service adjustment' })
  await h.api('credit.issue', accountant, { invoice: adjustmentInvoice, amount: '1', reason: 'Accountant cannot change billing' }, 403)
  await h.api('prepaid.refund.prepare', support, { grant: grant.id, reason: 'Support cannot prepare a cash refund' }, 403)

  const record = await api(`customers/${customer}`)
  const { ledger, billingRecord } = record
  assert.ok(record.contacts.some(row=>row.email==='morgan@observatory.example'))
  assert.ok(record.contacts.every(row=>row.customer_id===customer))
  assert.ok(record.notes.some(row=>row.body==='Customer confirmed the workshop and unused-credit adjustment.'))
  assert.ok(record.notes.every(row=>row.customer_id===customer))
  assert.equal(record.metadata.segment,'Observatory research')
  assert.ok(billingRecord.subscriptionHistory.some(row => row.id === subscription))
  const upcoming=await api(`subscriptions/${subscription}/upcoming?period=2026-10`)
  assert.deepEqual(billingRecord.prepaid.find(row => row.subscription === subscription),upcoming.prepaid)
  const composedRefund = billingRecord.refunds.find(row => row.id === refunded.id)
  assert.equal(composedRefund.creditNumber, credit.number)
  assert.equal(composedRefund.customer, customer)
  assert.ok(ledger.credits.some(row => row.id === supportCredit.credit))
  for (const payment of [...billingRecord.processorPayments.filter(row => row.status === 'collected'), ...billingRecord.achPaymentEvidence]) {
    assert.equal(payment.customer, customer)
    const source = await api(`invoices/${payment.invoice}`)
    assert.equal(source.customer_id, customer)
    assert.equal(source.total_cents, payment.amountCents)
    assert.ok(ledger.payments.some(row => row.id === payment.payment && row.amount_cents === payment.amountCents))
  }
  assert.equal(ledger.invoicedCents, sum(ledger.invoices, 'total_cents'))
  assert.equal(ledger.paidCents, sum(ledger.invoices, 'paid_cents'))
  assert.equal(ledger.creditedCents, sum(ledger.invoices, 'credited_cents'))
  assert.equal(ledger.balanceCents, sum(ledger.invoices, 'balance_cents'))
  assert.equal(ledger.invoicedCents, ledger.paidCents + ledger.creditedCents + ledger.writtenOffCents + ledger.balanceCents)
  for (const action of ['contact.add','note.add','metadata.write','collection.collected', 'payment.ach_evidence.record', 'prepaid.refund.complete', 'credit.issue']) {
    assert.ok(billingRecord.auditEvents.some(row => row.action === action), `Customer retains ${action}`)
  }
  const nativeCard = billingRecord.processorPayments.find(row => row.card)
  const queries = [record.name, record.billing_email, record.external_id,'morgan@observatory.example','Observatory research', original.number, credit.number, supportCredit.number,
    nativeCard.chargeRef, nativeCard.paymentIntentRef, nativeCard.card.last4, `${nativeCard.card.brand} ${nativeCard.card.last4}`,
    refunded.refundRef, ...billingRecord.achPaymentEvidence.flatMap(row => [row.chargeRef, row.paymentIntentRef]),
    capture.invoices.data[0].number, capture.invoices.data[0].id, capture.payments.data[0].id, capture.refunds.data[0].id]
  for (const query of new Set(queries)) {
    assert.deepEqual((await api(`customers?search=${encodeURIComponent(query)}`)).map(row => row.id), [customer])
  }
  const shared = await h.api(`customers/${customer}`, support)
  assert.equal(shared.billingRecord.refunds.find(row => row.id === refunded.id).reasonCategory, 'unused_paid_credit')
  assert.ok(!JSON.stringify(shared.billingRecord).includes(reason))
  await h.api(`customers/${customer}`, undefined, undefined, 401)
  await h.api(`customers?search=${encodeURIComponent(record.billing_email)}`, undefined, undefined, 401)
  await onReady({ h, owner, customer, query: refunded.refundRef, kind: 'full-cycle', invoice: original, credit: supportCredit,
    refund: refunded, subscription, ledger, record })
  return { customer, subscription, purchase, refund: refunded, record }
}
