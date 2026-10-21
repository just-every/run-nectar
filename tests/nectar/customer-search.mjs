import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { file } from './harness.mjs'

// CUS-001 current-record slice; no processor verification or full-clause claim.
export async function customerSearchFlow(h, owner, onReady = async () => {}) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  const create = async (external_id, name, billing_email) => (await api('customer.create', { external_id, name, billing_email })).id
  const customer = await create('MARIGOLD-OPS', 'Marigold Research', 'billing@marigold.example')
  const other = await create('CEDAR-OPS', 'Cedar Fieldwork', 'billing@cedar.example')
  await api('contact.add', { customer, name: 'Priya Billing', email: 'priya@marigold.example' })
  const charge = await api('charge.add', { customer, amount: '125', description: 'Research workshop', effective_date: '2026-01-05', taxable: false })
  const draft = await api('invoice.manual', { customer, charges: [charge.charge], service_date: '2026-01-05' })
  await api('invoice.approve', { invoice: draft.id, acknowledge: true })
  await api('invoice.finalise', { invoice: draft.id, issue_date: '2026-01-05' })
  const invoice = await api(`invoices/${draft.id}`)
  const credit = await api('credit.issue', { invoice: draft.id, amount: '25', reason: 'Workshop service adjustment' })
  const payment = await api('payment.record', { customer, amount: '75', method: 'bank_transfer', reference: 'BANK_MARIGOLD%7781', received_on: '2026-01-07' })
  await api('payment.allocate', { payment: payment.payment, invoice: draft.id, amount: '75' })
  await api('payment.record', { customer: other, amount: '20', method: 'card_external', reference: 'OTHER-CARD-7781', received_on: '2026-01-08' })
  await api('note.add', { kind: 'customer', record: customer, body: 'Finance confirmed the workshop adjustment.' })
  await api('metadata.write', { kind: 'customer', record: customer, revision: 0, metadata: { segment: 'Enterprise research' } })

  const queries = ['billing@marigold.example', '  MARIGOLD  ', 'MARIGOLD-OPS', 'PRIYA@MARIGOLD.EXAMPLE', invoice.number, credit.number, 'bank_marigold%7781', 'Enterprise research']
  for (const query of queries) assert.deepEqual((await api(`customers?search=${encodeURIComponent(query)}`)).map(row => row.id), [customer], `CUS-001 resolves ${query} to its customer only`)
  for (const query of ["' OR 1=1 --", '%', '_']) {
    const matches = await api(`customers?search=${encodeURIComponent(query)}`)
    assert.deepEqual(matches.map(row => row.id), query === "' OR 1=1 --" ? [] : [customer], 'CUS-001 search text is literal, including wildcard characters')
  }
  assert.deepEqual(await api('customers?search=no-such-billing-record'), [])
  assert.deepEqual((await api('customers?search=OTHER-CARD-7781')).map(row => row.id), [other])
  assert.deepEqual((await api(`customers?search=marigold&metadata_key=segment&metadata_value=${encodeURIComponent('Enterprise research')}`)).map(row => row.id), [customer])
  assert.deepEqual(await api('customers?search=marigold&metadata_key=segment&metadata_value=unrelated'), [])

  const record = await api(`customers/${customer}`), ledger = record.ledger
  assert.deepEqual([ledger.invoicedCents, ledger.creditedCents, ledger.paidCents, ledger.balanceCents], [12500, 2500, 7500, 2500])
  assert.equal(ledger.invoicedCents, ledger.creditedCents + ledger.paidCents + ledger.balanceCents)
  assert.deepEqual(ledger.payments.map(row => row.id), [payment.payment])
  assert.deepEqual(ledger.credits.map(row => row.number), [credit.number])
  for (const role of ['support', 'accountant', 'collections']) {
    const email = `lookup-${role}@example.test`
    await api('access.give', { email, name: `Lookup ${role}`, role })
    const cookie = await h.signIn(email, { requested: true })
    assert.deepEqual((await h.api(`customers?search=${encodeURIComponent(credit.number)}`, cookie)).map(row => row.id), [customer])
    assert.deepEqual((await h.api(`customers/${customer}`, cookie)).ledger, ledger)
    const html = await h.page(`/app/customers/${customer}`, cookie)
    assert.ok(html.includes(credit.number) && html.includes('Workshop service adjustment'), 'CUS-001 credit evidence appears on the customer screen')
    await h.api('customer.update', cookie, { customer, revision: record.revision, name: 'Forbidden', billing_email: record.billing_email }, 403)
  }
  await h.api('customers?search=marigold', undefined, undefined, 401)
  await h.api(`customers/${customer}`, undefined, undefined, 401)
  const history = []
  for (let index = 0; index < 210; index++) history.push((await api('payment.record', { customer: other, amount: '1', method: 'check', reference: `CEDAR-ARCHIVE-${index}`, received_on: '2025-01-07' })).payment)
  const complete = (await api(`customers/${other}`)).ledger
  for (const id of history) assert.ok(complete.payments.some(row => row.id === id), 'CUS-001 customer ledger retains older payments as its history grows')
  assert.equal(complete.unallocatedCents, 23000, 'CUS-001 all retained payment amounts contribute to the unallocated total')
  const audit = await api('audit')
  for (const path of ['/app/customers', `/app/customers/${customer}`, '/app/receivables', '/app/billing']) {
    const html = await h.page(path, owner)
    assert.match(html, /role="search"[^>]*aria-label="Customer lookup"/, 'CUS-001 the shared operator frame offers the lookup door')
  }
  assert.deepEqual(await api('audit'), audit, 'CUS-001 lookup and record reads do not mutate billing')
  await onReady({ h, owner, customer, other, invoice, credit, ledger })

  // Captured previous-biller documents also resolve to their own customer.
  const files = Object.fromEntries(await Promise.all(['manifest', 'customers', 'products', 'prices', 'subscriptions', 'invoices', 'meters'].map(async name => [name, file(`${name}.json`, await readFile(new URL(`../fixtures/stripe/${name}.json`, import.meta.url)), 'application/json')])))
  const preview = await api('import.preview', files)
  await api('import.apply', { ...files, fingerprint: preview.fingerprint })
  const captured = JSON.parse(await readFile(new URL('../fixtures/stripe/invoices.json', import.meta.url))).data[0]
  const moved = (await api('customers')).find(row => row.external_id === captured.customer)
  for (const value of [captured.number, captured.id]) assert.deepEqual((await api(`customers?search=${encodeURIComponent(value)}`)).map(row => row.id), [moved.id], 'CUS-001 retained previous-biller number and reference resolve to the moved customer')
  console.log('CUS-001 customer lookup, literal searches, scoped billing evidence, totals and role custody passed')
  return { customer, other, invoice, credit }
}
