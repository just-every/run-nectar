import assert from 'node:assert/strict'

// INV-004: genuine current-door progress; hosted/PDF/email/branding and usage
// presentation remain open. All writes use public JSON or ordinary HTML forms.
export async function invoiceContentFlow(h, owner, { onState } = {}) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  const business = await api('business')
  const configure = fields => api('business.configure', { ...business, revision: fields.revision ?? business.revision, ...fields })
  await configure({ invoice_fields: { 'Vendor ID': 'V-104' } })
  await h.api('access.give', owner, { email: 'inv004-finance@example.test', name: 'Invoice Finance', role: 'finance' })
  await h.api('access.give', owner, { email: 'inv004-accountant@example.test', name: 'Invoice Accountant', role: 'accountant' })
  const finance = await h.signIn('inv004-finance@example.test', { requested: true })
  const accountant = await h.signIn('inv004-accountant@example.test', { requested: true })
  const agent = { bearer: (await api('credential.issue', { name: 'INV-004 order preparer', scopes: ['prepare'] })).key }
  const settings = { paymentTermsDays: 45, poRequired: true, poNumber: '', memo: 'Please quote our purchase order.', customFields: { 'Cost center': 'Research West' } }
  const create = async (suffix, invoice_settings) => (await api('customer.create', { external_id: `INV004-${suffix}`, name: `Cedar ${suffix}`, billing_email: `${suffix.toLowerCase()}@invoice.example`, invoice_settings })).id
  const first = await create('FIRST', settings), second = await create('SECOND', {})
  const update = async (customer, invoice_settings, who = owner, status) => {
    const c = await api(`customers/${customer}`)
    return h.api('customer.update', who, { customer, revision: c.revision, name: c.name, billing_email: c.billing_email, invoice_settings }, status)
  }
  const product = (await api('product.create', { code: 'inv004-service', name: 'Invoice content service' })).id
  const price = (await api('price.create', { product, kind: 'flat', unit_amount: '100', taxable: false })).id
  for (const customer of [first, second]) await api('subscription.create', { customer, start_date: '2026-08-01', price: [price] })
  const prepare = async period => {
    const run = await api('billrun.prepare', { period })
    return { run, invoices: (await api(`runs/${run.id}`)).invoices }
  }
  let prepared = await prepare('2026-08')
  let blocked = prepared.invoices.find(i => i.customer_id === first)
  const exception = (await api(`invoices/${blocked.id}`)).exceptions.find(e => e.code === 'po_required')
  assert.ok(exception, 'INV-004 a required missing PO is a blocking exception')
  await api('invoice.approve', { invoice: blocked.id, acknowledge: true }, 409)
  await api('invoice.finalise', { invoice: blocked.id, issue_date: '2026-09-01' }, 409)
  await onState?.({ label: 'po-missing', path: `/app/invoices/${blocked.id}`, owner, first })
  for (const who of [agent, accountant]) await update(first, { ...settings, poNumber: 'ILLEGAL' }, who, 403)
  await h.api('customer.update', null, {}, 401)
  await update(first, { ...settings, paymentTermsDays: 40 }, owner, 400)
  await update(first, { ...settings, customFields: { 'Cost center': ['invalid'] } }, owner, 400)
  assert.equal(JSON.parse((await api(`customers/${first}`)).invoice_settings_json).poNumber, '')

  // Actually submit the form emitted by the customer screen, including the
  // parallel name/value controls; no implementation-only setup helper writes.
  const c = await api(`customers/${first}`)
  const saved = await h.submit('customer.update', finance, { customer: first, revision: c.revision, name: c.name,
    billing_email: c.billing_email, invoice_edit: 'yes', invoice_terms_days: '45', invoice_po_required: 'yes',
    invoice_po_number: 'BUYER-42', invoice_memo: settings.memo,
    invoice_field_name: ['Cost center', ''], invoice_field_value: ['Research West', ''] }, `/app/customers/${first}`)
  assert.equal(saved.searchParams.has('error'), false)
  await api('invoice.approve', { invoice: blocked.id, acknowledge: true }, 409)
  prepared = await prepare('2026-08')
  const invoice = prepared.invoices.find(i => i.customer_id === first)
  const other = prepared.invoices.find(i => i.customer_id === second)
  let detail = await api(`invoices/${invoice.id}`)
  const content = detail.calculation.inputs.invoiceContent
  assert.deepEqual([content.paymentTermsDays, content.poRequired, content.poNumber, content.memo, content.customFields], [45, true, 'BUYER-42', settings.memo, { 'Vendor ID': 'V-104', 'Cost center': 'Research West' }])
  const otherContent = (await api(`invoices/${other.id}`)).calculation.inputs.invoiceContent
  assert.equal(otherContent.paymentTermsDays, 30)
  assert.deepEqual(otherContent.customFields, { 'Vendor ID': 'V-104' }, 'INV-004 customer fields never leak to another customer')
  await api('invoice.approve', { invoice: invoice.id, acknowledge: true })
  await update(first, { ...settings, poNumber: 'BUYER-CHANGED' })
  await api('invoice.finalise', { invoice: invoice.id, issue_date: '2026-09-01' }, 409)
  await update(first, { ...settings, poNumber: 'BUYER-42' })
  prepared = await prepare('2026-08')
  const final = prepared.invoices.find(i => i.customer_id === first)
  await api('invoice.approve', { invoice: final.id, acknowledge: true })
  await api('invoice.finalise', { invoice: final.id, issue_date: '2026-09-01' })
  detail = await api(`invoices/${final.id}`)
  assert.equal(detail.due_date, '2026-10-16', 'INV-004 Net45 means 45 calendar days after actual issue')
  assert.equal(detail.total_cents, 10000, 'INV-004 invoice content never changes rating cents')
  const originalCalculation = detail.calculation, originalFingerprint = detail.source_fingerprint
  await update(first, { paymentTermsDays: 15, poRequired: false, memo: 'Future invoices only', customFields: { 'Cost center': 'Changed' } })
  const changed = await api('business')
  await configure({ revision: changed.revision, invoice_fields: { 'Vendor ID': 'FUTURE-VENDOR' } })
  const after = await api(`invoices/${final.id}`)
  assert.deepEqual(after.calculation, originalCalculation, 'INV-004 issued content is immutable despite customer/business edits')
  assert.equal(after.source_fingerprint, originalFingerprint)
  assert.equal(after.due_date, '2026-10-16')
  const exported = await h.raw(`/app/billing/${prepared.run.id}.json`, { cookie: accountant })
  assert.equal(exported.status, 200)
  const document = (await exported.json()).invoices.find(i => i.id === final.id)
  assert.deepEqual(document.calculation.inputs.invoiceContent, originalCalculation.inputs.invoiceContent)
  assert.equal(document.dueDate, after.due_date)
  assert.deepEqual(document.lines.map(l => l.amount_cents), after.lines.map(l => l.amount_cents), 'INV-004 NEC-13 retains all original line detail')
  await onState?.({ label: 'issued', path: `/app/invoices/${final.id}`, owner, first })
  await onState?.({ label: 'customer-settings', path: `/app/customers/${first}`, owner, first })
  await onState?.({ label: 'business-fields', path: '/app/settings', owner, first })

  // Standalone invoices share the same required-PO and terms boundary.
  const manualCustomer = await create('MANUAL', settings)
  const charge = (await api('charge.add', { customer: manualCustomer, amount: '7', description: 'Standalone work', effective_date: '2026-08-01', taxable: false })).charge
  let manual = await api('invoice.manual', { customer: manualCustomer, charges: [charge], service_date: '2026-08-01' })
  assert.ok((await api(`invoices/${manual.id}`)).exceptions.some(e => e.code === 'po_required'))
  await api('invoice.approve', { invoice: manual.id, acknowledge: true }, 409)
  await update(manualCustomer, { ...settings, poNumber: 'MANUAL-PO' })
  manual = await api('invoice.manual', { customer: manualCustomer, charges: [charge], service_date: '2026-08-01' })
  await api('invoice.approve', { invoice: manual.id, acknowledge: true })
  await api('invoice.finalise', { invoice: manual.id, issue_date: '2026-08-01' })
  assert.equal((await api(`invoices/${manual.id}`)).due_date, '2026-09-15')

  // INV-004 / AGENT-006: quote, independent review, atomic installation and
  // complete-term preview/content/due-date parity with ordinary issue.
  const customerQuote = 'Cedar Order LLC, billing email order@invoice.example, customer INV004-ORDER.'
  const subscriptionQuote = 'Monthly arrears service from 2026-01-01 until 2026-03-01, on day 1.'
  const priceQuote = 'Invoice content service is USD 100 per month, non-taxable.'
  const invoiceQuote = 'Net 45; purchase order PO number ORDER-42 is required on every invoice. Memo: Buyer-approved service. Cost center: Order West.'
  const payload = { setup: true, source: { name: 'executed-order.txt', text: [customerQuote,subscriptionQuote,priceQuote,invoiceQuote].join('\n'), execution_reference: 'Buyer-recorded signed order 42' },
    customer: { external_id: 'INV004-ORDER', name: 'Cedar Order LLC', billing_email: 'order@invoice.example', quote: customerQuote },
    catalog: [{ key: 'base', existing: price, quote: priceQuote }],
    subscription: { start_date: '2026-01-01', months: 2, quote: subscriptionQuote },
    items: [{ key: 'base', price: 'base', quantity: 1, from: '2026-01-01', to: '2026-03-01', quote: priceQuote }],
    invoice: { paymentTermsDays: 45, poRequired: true, poNumber: 'ORDER-42', memo: 'Buyer-approved service.', customFields: { 'Cost center': 'Order West' }, quote: invoiceQuote } }
  const propose = (value, who = owner) => h.api('proposal.create', who, { kind: 'amendment', title: 'INV-004 quoted invoice requirements', payload: value })
  for (const invoice of [undefined, { ...payload.invoice, poNumber: '' }]) {
    const missing = structuredClone(payload)
    if (invoice) missing.invoice = invoice; else delete missing.invoice
    const pending = await propose(missing, agent)
    assert.ok(pending.impact.unresolvedAmbiguities.length, 'INV-004 / AGENT-006 missing invoice requirements cannot disappear at approval')
    await h.api('proposal.decide', finance, { proposal: pending.id, decision: 'approved' }, 409)
    assert.ok(!(await api('customers')).some(c => c.external_id === 'INV004-ORDER'))
    await h.api('proposal.decide', finance, { proposal: pending.id, decision: 'rejected' })
  }
  const proposed = await propose(payload)
  assert.deepEqual(proposed.impact.unresolvedAmbiguities, [])
  assert.deepEqual(proposed.impact.periods.map(p => [p.assumedIssueDate,p.dueDate,p.calculation.totalCents]), [['2026-02-01','2026-03-18',10000],['2026-03-01','2026-04-15',10000]])
  for (const key of ['paymentTermsDays','poRequired','poNumber','memo','customFields']) assert.ok(proposed.impact.quotes.some(q => q.field === `invoice.${key}` && q.quote === invoiceQuote))
  await onState?.({ label: 'quoted-order', path: `/app/proposals/${proposed.id}`, owner, first })
  await api('proposal.decide', { proposal: proposed.id, decision: 'approved' }, 409)
  const applied = await h.api('proposal.decide', finance, { proposal: proposed.id, decision: 'approved' })
  for (const preview of proposed.impact.periods) {
    const run = await prepare(preview.period.start.slice(0,7))
    const draft = run.invoices.find(i => i.customer_id === applied.customer)
    await api('invoice.approve', { invoice: draft.id, acknowledge: true })
    await api('invoice.finalise', { invoice: draft.id, issue_date: preview.assumedIssueDate })
    const issued = await api(`invoices/${draft.id}`)
    assert.equal(issued.due_date, preview.dueDate)
    assert.deepEqual(issued.calculation.inputs.invoiceContent, preview.invoiceContent)
    assert.equal(issued.total_cents, preview.calculation.totalCents)
  }
  await h.api('proposal.decide', finance, { proposal: proposed.id, decision: 'approved' }, 409)
  console.log('INV-004 Net45, required PO, fields/isolation, manual billing, immutable content/export and AGENT-006 quoted setup parity passed')
  return { customer: first, invoice: final.id }
}
