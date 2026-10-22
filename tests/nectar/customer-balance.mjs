// INV-006 through public doors: an overpayment and a goodwill credit sit on the
// customer's balance ledger, apply to the next invoice, and the cash remainder
// is returned; GOV-002's limit governs grants and returns; RPT-002 balance
// reports, source drill-through, CSV and scheduled snapshots equal the ledger.
import assert from 'node:assert/strict'
import { applyPolicy } from './policy-helper.mjs'
import { csvRows } from './financial-reports.mjs'

export const harnessOptions = () => ({ localTime: '2026-11-03T20:00:00Z' })

export async function customerBalanceFlow(h, owner) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  const people = {}
  for (const role of ['finance', 'accountant', 'collections']) { await api('access.give', { email: `balance-${role}@example.test`, name: `Bea ${role}`, role }); people[role] = await h.signIn(`balance-${role}@example.test`, { requested: true }) }
  const agent = { bearer: (await api('credential.issue', { name: 'Balance agent', scopes: ['prepare'] })).key }
  const customer = (await api('customer.create', { external_id: 'INV006', name: 'Brightwater Systems', billing_email: 'ap@brightwater.example' })).id
  const product = (await api('product.create', { code: 'inv006-platform', name: 'Balance platform' })).id
  const price = (await api('price.create', { product, kind: 'flat', unit_amount: '1000.00', taxable: false })).id
  await api('subscription.create', { customer, start_date: '2026-09-01', anchor_day: '1', price: [price] })
  const run = await api('billrun.prepare', { period: '2026-09' })
  const draft = (await api(`runs/${run.id}`)).invoices.find(row => row.customer_id === customer)
  await api('invoice.approve', { invoice: draft.id, acknowledge: true }); await api('invoice.finalise', { invoice: draft.id, issue_date: '2026-10-01' })
  const first = draft.id
  const pay = async (amount, reference) => { await api('payment.record', { customer, amount, received_on: '2026-11-02', method: 'bank_transfer', reference }); return (await api('payments')).find(row => row.reference === reference).id }
  const manual = async (amount, description) => {
    const charge = (await api('charge.add', { customer, amount, description, taxable: false, effective_date: '2026-10-15' })).charge
    const id = (await api('invoice.manual', { customer, charges: [charge], service_date: '2026-10-15' })).id
    await api('invoice.approve', { invoice: id, acknowledge: true }); await api('invoice.finalise', { invoice: id, issue_date: '2026-11-03' })
    return id
  }
  const balance = () => api(`customers/${customer}/balance`)
  // The ledger balances and RPT-002 equals it: balance report, each source's components, and the CSV.
  const parity = async expected => {
    const view = await balance(), report = await api(`reports/credit-balances?customer=${customer}`)
    assert.deepEqual([view.cashCents, view.goodwillCents, view.totalCents], expected)
    assert.equal(report.totalCents, view.totalCents, 'the balance report equals the credit ledger')
    for (const entry of report.entries.filter(row => row.sourceKind === 'customer_balance')) {
      const source = await api(`reports/credit-balances/${entry.invoiceId}?customer=${customer}`)
      assert.equal(source.components.reduce((n, c) => n + c.amountCents, 0), entry.amountCents, 'source drill-through ties to its entry')
    }
    const credits = { receipt: 0, goodwill: 0, debits: 0 }
    for (const row of view.ledger) { if (['receipt', 'goodwill'].includes(row.kind)) credits[row.kind] += row.amountCents; else credits.debits += row.amountCents }
    assert.equal(credits.receipt + credits.goodwill - credits.debits, view.cashCents + view.goodwillCents, 'the balance ledger balances')
    const rows = csvRows(await (await h.raw(`/app/exports/reports/credit-balances.csv?customer=${customer}`, { cookie: owner })).text())
    const total = Number(rows.find(row => row.source === 'TOTAL').amount)
    assert.equal(Math.round(total * 100), view.totalCents, 'the CSV total equals the credit ledger')
    assert.equal(Math.round(rows.filter(row => row.source !== 'TOTAL').reduce((n, row) => n + Number(row.amount), 0) * 100), view.totalCents, 'the CSV rows sum to the total')
    return view
  }

  // A $200 wire overpayment and a $100 goodwill credit.
  const wire = await pay('1200.00', 'INV006-WIRE')
  await api('payment.allocate', { payment: wire, invoice: first, amount: '1000.00' })
  await parity([20000, 0, 20000])
  for (const who of [people.accountant, people.collections, agent]) for (const [action, body] of [['balance.goodwill', { customer, amount: '100', reason: 'x' }], ['balance.return', { customer, payment: wire, amount: '10', reason: 'x', reference: 'r' }], ['balance.prepare', { kind: 'goodwill', customer, amount: '1', reason: 'x' }], ['balance.approve', { request: 'none' }], ['balance.apply', { invoice: first }]]) await h.api(action, who, body, 403)
  await h.api('balance.goodwill', undefined, {}, 401)
  await api('balance.goodwill', { customer, amount: '0', reason: 'x' }, 400)
  await api('balance.goodwill', { customer, amount: '100.00', reason: 'Goodwill for the onboarding delay' })
  await parity([20000, 10000, 30000])

  // Both apply to the next invoice automatically; the cash remainder is refundable.
  await applyPolicy(h, owner, 'credit.policy', { two_person_above: '1000.00', balance_application: 'automatic' })
  assert.equal((await api('policies/current')).balanceApplication, 'automatic')
  const second = await manual('250.00', 'Workshop')
  const applied = await api(`invoices/${second}`)
  assert.deepEqual([applied.total_cents, applied.balanceCents, applied.creditedCents, applied.paidCents], [25000, 0, 10000, 15000], 'goodwill first, then cash, fully applied')
  assert.equal(applied.creditedCents + applied.paidCents + applied.balanceCents, applied.total_cents)
  await parity([5000, 0, 5000])
  await api('balance.return', { customer, payment: wire, amount: '60.00', reason: 'More than remains', reference: 'WIRE-OUT-0' }, 409)
  await api('balance.return', { customer, payment: wire, amount: '50.00', reason: 'Return the remaining overpayment', reference: 'WIRE-OUT-1' })
  await parity([0, 0, 0])
  assert.equal((await api('payments')).find(row => row.id === wire).unallocated_cents, 0)

  // GOV-002 on the balance doors: a $1,500 return needs a second person; $900 needs one.
  const big = await pay('1500.00', 'INV006-BIG')
  await h.api('balance.return', people.finance, { customer, payment: big, amount: '1500.00', reason: 'Direct', reference: 'W2' }, 409)
  await api('balance.return', { customer, payment: big, amount: '1500.00', reason: 'Owner direct', reference: 'W2' }, 409)
  const request = (await h.api('balance.prepare', people.finance, { kind: 'return', customer, payment: big, amount: '1500.00', reason: 'Return the duplicate wire', reference: 'WIRE-OUT-2' })).request
  assert.equal((await h.api('balance.approve', people.finance, { request }, 409)).error, 'second_approver_required')
  for (const who of [people.accountant, people.collections, agent]) await h.api('balance.approve', who, { request }, 403)
  await parity([150000, 0, 150000])
  await h.submit('balance.approve', owner, { request }, `/app/customers/${customer}`)
  await parity([0, 0, 0])
  assert.equal((await api('balance.approve', { request }, 409)).error, 'balance_request_already_executed')
  const record = (await balance()).requests.find(row => row.id === request)
  assert.deepEqual([record.approval, record.preparedBy, record.approvedBy], ['two-person', 'balance-finance@example.test', 'owner@example.test'])
  const audit = JSON.parse((await api('audit')).find(row => row.action === 'balance.return' && row.subject === request).detail)
  assert.deepEqual([audit.preparedBy, audit.approvedBy], ['balance-finance@example.test', 'owner@example.test'], 'audit records both people')
  const nine = await pay('900.00', 'INV006-NINE')
  await h.submit('balance.return', people.finance, { customer, payment: nine, amount: '900.00', reason: 'Small return', reference: 'WIRE-OUT-3' }, `/app/customers/${customer}`)
  await parity([0, 0, 0])
  // A changed policy leaves a saved request stale and moves nothing.
  const stale = await pay('1200.00', 'INV006-STALE')
  const pending = (await h.api('balance.prepare', people.finance, { kind: 'return', customer, payment: stale, amount: '1100.00', reason: 'Prepared before the policy changed', reference: 'WIRE-OUT-4' })).request
  await applyPolicy(h, owner, 'credit.policy', { two_person_above: '1200.00', balance_application: 'manual' })
  assert.equal((await api('balance.approve', { request: pending }, 409)).error, 'balance_request_stale')
  await parity([120000, 0, 120000])

  // Manual policy: the balance waits until an approver applies it.
  const third = await manual('80.00', 'Manual application')
  assert.equal((await api(`invoices/${third}`)).balanceCents, 8000)
  assert.deepEqual(await api('balance.apply', { invoice: third }), { id: third, appliedCents: 8000 })
  assert.equal((await api(`invoices/${third}`)).balanceCents, 0)
  await api('balance.apply', { invoice: third }, 409)
  await parity([112000, 0, 112000])

  // Scheduled snapshots freeze the same balance and its sources.
  await api('report.schedule', { enabled: true, day: 5 })
  const tick = await h.raw(`/cdn-cgi/local/scheduled?time=${Date.parse('2026-11-05T20:00:00Z')}&cron=${encodeURIComponent('0 14 * * *')}`)
  assert.equal(tick.status, 200)
  const delivery = await api(`report-deliveries/${(await api('report-schedule')).deliveries[0].id}`)
  const frozen = delivery.reports.find(row => row.metric === 'credit-balances')
  assert.equal(frozen.totalCents, (await api('reports/credit-balances')).totalCents, 'the scheduled snapshot equals the balance report')
  assert.ok(delivery.sourceEvidence.some(source => source.metric === 'credit-balances' && source.detail.sourceKind === 'customer_balance'), 'frozen source evidence names the customer balance')
  assert.match(await h.page(`/app/customers/${customer}`, owner), /Credit balance/)
  console.log('INV-006 customer credit balance, application, returns and RPT-002 parity passed')
  return { customer }
}
