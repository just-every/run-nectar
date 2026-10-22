// AR-004 through public doors (JSON door, form door, pages, CSV): a 120-day
// balance is written off, leaves ageing and the AR report, posts bad debt to
// QuickBooks at the network edge and stops reminders; a partial recovery
// reverses part of it; GOV-002's two-person limit governs every write-off door.
import assert from 'node:assert/strict'
import { quickbooksEdge } from './quickbooks-edge.mjs'
import { applyPolicy } from './policy-helper.mjs'

let edge
export const harnessOptions = () => { edge = quickbooksEdge(); return { quickbooksFetch: edge.fetch, localTime: '2026-08-29T20:00:00Z' } }

export async function writeOffFlow(h, owner) {
  const people = {}
  for (const [key, role] of [['finance', 'finance'], ['accountant', 'accountant'], ['collections', 'collections']]) {
    await h.api('access.give', owner, { email: `writeoff-${key}@example.test`, name: `Wren ${key}`, role })
    people[key] = await h.signIn(`writeoff-${key}@example.test`, { requested: true })
  }
  const agent = { bearer: (await h.api('credential.issue', owner, { name: 'Write-off agent', scopes: ['prepare'] })).key }
  const customer = (await h.api('customer.create', owner, { external_id: 'AR004', name: 'Harbor Freight Software', billing_email: 'ap@harbor-freight.example' })).id
  edge.addCustomer('Harbor Freight Software')
  const product = (await h.api('product.create', owner, { code: 'ar004-platform', name: 'Write-off platform' })).id
  const price = (await h.api('price.create', owner, { product, kind: 'flat', unit_amount: '2000.00', taxable: false })).id
  await h.api('subscription.create', owner, { customer, start_date: '2026-03-01', anchor_day: '1', price: [price] })
  const issue = async (period, issue_date) => {
    const run = await h.api('billrun.prepare', owner, { period })
    const draft = (await h.api(`runs/${run.id}`, owner)).invoices.find(row => row.customer_id === customer)
    await h.api('invoice.approve', owner, { invoice: draft.id, acknowledge: true })
    await h.api('invoice.finalise', owner, { invoice: draft.id, issue_date })
    return draft.id
  }
  const read = id => h.api(`invoices/${id}`, owner)
  const aged = id => h.api('ageing', owner).then(view => view.invoices.find(row => row.id === id))
  const arReport = () => h.api('reports/ar', owner)
  const journals = () => edge.summary()

  // The 120-day balance: due 1 May, today 29 August.
  const first = await issue('2026-03', '2026-04-01')
  assert.equal((await aged(first)).daysOverdue, 120)
  assert.equal((await aged(first)).bucket, '90+')
  // The collections cadence is live and sends for this overdue balance until it is written off.
  const rule = { segment: 'transfer-net30', minimum_cents: 1000, subject: '{business}: {invoice}, {balance}, stage {stage}', body: 'Please arrange the recorded transfer for {invoice}: {balance} (stage {stage}).' }
  const policy = await h.api('cadence.policy.prepare', owner, { enabled: true, require_human: false, rules: [rule] })
  await h.api('cadence.policy.decide', people.finance, { request: policy.request, decision: 'approved' })
  await h.api('cadence.enroll', owner, { invoice: first, segment: rule.segment, transfer_terms: 'Customer pays by bank transfer, Net30; operator recorded from the signed order.' })
  const tick = async time => {
    await h.advanceClock(time)
    assert.equal((await h.raw(`/cdn-cgi/local/scheduled?time=${Date.parse(time)}&cron=${encodeURIComponent('0 14 * * *')}`)).status, 200)
  }
  await tick('2026-08-29T21:00:00Z')
  const firstNumber = (await read(first)).number
  const sentBefore = h.mails.filter(mail => `${mail.text ?? ''}`.includes(`Invoice ${firstNumber};`)).length
  assert.ok(sentBefore >= 1, 'the cadence reminds for the overdue balance before the write-off')
  const draftReminder = await h.api('reminder.prepare', owner, { customer })
  await h.api('reminder.discard', owner, { notice: draftReminder.notice })
  assert.equal((await arReport()).totalCents, 200000)
  for (const who of [people.accountant, people.collections, agent]) await h.api('writeoff.issue', who, { invoice: first, amount: '2000.00', reason: 'Unauthorized' }, 403)
  await h.api('writeoff.issue', owner, { invoice: first, amount: '2500.00', reason: 'More than owed' }, 409)
  await h.api('writeoff.issue', owner, { invoice: first, amount: '0', reason: 'Nothing' }, 400)
  assert.deepEqual(journals(), [], 'refused write-offs post nothing')
  const written = await h.api('writeoff.issue', owner, { invoice: first, amount: '2000.00', reason: 'Customer dissolved; 120 days unpaid' })
  assert.equal(written.posting.status, 'posted')
  let invoice = await read(first)
  assert.equal(invoice.balanceCents, 0); assert.equal(invoice.writtenOffCents, 200000); assert.equal(invoice.total_cents, 200000, 'issued evidence is unchanged')
  assert.equal(invoice.creditedCents + invoice.paidCents + invoice.writtenOffCents + invoice.balanceCents, invoice.total_cents)
  assert.equal(await aged(first), undefined, 'the written-off balance leaves ageing')
  assert.equal((await arReport()).totalCents, 0)
  assert.equal((await h.api('ageing', owner)).totals.total, 0)
  assert.deepEqual(journals(), ['D:80:2000.00 C:84:2000.00'], 'one bad-debt journal: debit Bad Debts, credit Accounts Receivable')
  assert.equal(edge.entries[0].Line[1].JournalEntryLineDetail.Entity.EntityRef.value, 'synthetic-customer-1')
  await h.api('reminder.prepare', owner, { customer }, 409)
  await tick('2026-08-30T21:00:00Z'); await tick('2026-09-05T21:00:00Z')
  assert.equal(h.mails.filter(mail => `${mail.text ?? ''}`.includes(`Invoice ${firstNumber};`)).length, sentBefore, 'the cadence sends nothing once written off')
  assert.equal((await h.api('cadences', owner)).invoices.find(row => row.id === first).hold, 'written_off', 'collection stops')
  await h.api('payment.record', owner, { customer, amount: '10.00', received_on: '2026-08-29', method: 'check', reference: 'AR004-STRAY' })
  const stray = (await h.api('payments', owner)).find(row => row.reference === 'AR004-STRAY').id
  await h.api('payment.allocate', owner, { payment: stray, invoice: first, amount: '10.00' }, 409)
  const settled = await h.api('write-offs', owner)
  assert.equal(settled.writeOffs.length, 1)
  assert.deepEqual([settled.writeOffs[0].approval, settled.writeOffs[0].preparedBy, settled.writeOffs[0].approvedBy], ['single-person', 'owner@example.test', 'owner@example.test'])

  // A partial recovery is recorded against it and the ledger reverses that part.
  await h.api('payment.record', owner, { customer, amount: '500.00', received_on: '2026-08-29', method: 'bank_transfer', reference: 'AR004-RECOVERY' })
  const payment = (await h.api('payments', owner)).find(row => row.reference === 'AR004-RECOVERY').id
  for (const who of [people.accountant, people.collections, agent]) await h.api('writeoff.recover', who, { write_off: written.writeOff, payment, amount: '500.00' }, 403)
  await h.api('writeoff.recover', owner, { write_off: written.writeOff, payment, amount: '1990.00' }, 409)
  await h.api('writeoff.recover', owner, { write_off: written.writeOff, payment, amount: '500.01' }, 409)
  const recovered = await h.api('writeoff.recover', owner, { write_off: written.writeOff, payment, amount: '500.00' })
  assert.equal(recovered.posting.status, 'posted')
  await h.api('writeoff.recover', owner, { write_off: written.writeOff, payment, amount: '1.00' }, 409)
  invoice = await read(first)
  assert.deepEqual([invoice.balanceCents, invoice.writtenOffCents, invoice.paidCents], [0, 150000, 50000])
  assert.equal(invoice.creditedCents + invoice.paidCents + invoice.writtenOffCents + invoice.balanceCents, invoice.total_cents)
  assert.deepEqual(journals(), ['D:80:2000.00 C:84:2000.00', 'D:84:500.00 C:80:500.00'], 'the recovery reverses part of the bad debt in the ledger')
  assert.equal(edge.entries[1].Line[0].JournalEntryLineDetail.Entity.EntityRef.value, 'synthetic-customer-1')
  assert.equal((await arReport()).totalCents, 0)
  assert.ok((await h.api('reports/collections?period=2026-08', owner)).entries.some(entry => entry.number === 'AR004-RECOVERY' && entry.amountCents === 50000), 'the recovered cash is a collection')
  assert.match(await h.page(`/app/invoices/${first}`, owner), /Bad debt write-offs[\s\S]*Customer dissolved/)
  const customerLedger = (await h.api(`customers/${customer}`, owner)).ledger
  assert.equal(customerLedger.writtenOffCents, 150000); assert.equal(customerLedger.balanceCents, 0)
  const csv = await (await h.raw('/app/exports/invoices.csv', { cookie: owner })).text()
  assert.match(csv, /,0\.00,[^\n]*,1500\.00\r\n/, 'the invoice export shows the net write-off')
  const audit = (await h.api('audit', owner)).filter(row => row.action.startsWith('writeoff.'))
  assert.deepEqual(audit.map(row => row.action).sort(), ['writeoff.execute', 'writeoff.recover'])

  // GOV-002: the $1,000 limit applies to every write-off door.
  await applyPolicy(h, owner, 'credit.policy', { two_person_above: '1000.00' })
  const second = await issue('2026-04', '2026-05-01')
  const third = await issue('2026-05', '2026-06-01')
  const before = journals().length, ageBefore = (await h.api('ageing', owner)).totals
  await h.api('writeoff.issue', people.finance, { invoice: second, amount: '1500.00', reason: 'Cannot bypass second approval' }, 409)
  await h.api('writeoff.issue', owner, { invoice: second, amount: '1500.00', reason: 'Owner also needs a second person' }, 409)
  const request = (await h.api('writeoff.prepare', people.finance, { invoice: second, amount: '1500.00', reason: 'Two-person write-off for a failed customer' })).request
  assert.equal((await read(second)).balanceCents, 200000, 'preparation moves nothing')
  assert.equal((await h.api('writeoff.approve', people.finance, { request }, 409)).error, 'second_approver_required')
  for (const who of [people.accountant, people.collections, agent]) await h.api('writeoff.approve', who, { request }, 403)
  assert.equal((await read(second)).balanceCents, 200000); assert.equal(journals().length, before)
  assert.deepEqual((await h.api('ageing', owner)).totals, ageBefore, 'refused requests leave ageing and collection unchanged')
  const executed = await h.submit('writeoff.approve', owner, { request }, `/app/invoices/${second}`)
  assert.equal(executed.pathname, `/app/invoices/${second}`)
  assert.equal((await read(second)).balanceCents, 50000)
  assert.equal((await h.api('writeoff.approve', owner, { request }, 409)).error, 'write_off_already_executed')
  assert.equal(journals().length, before + 1, 'the approved write-off posts once')
  const record = (await h.api('write-offs', owner)).writeOffs.find(row => row.id === request)
  assert.deepEqual([record.approval, record.preparedBy, record.approvedBy, record.postings.length], ['two-person', 'writeoff-finance@example.test', 'owner@example.test', 1])
  const executeAudit = (await h.api('audit', owner)).find(row => row.action === 'writeoff.execute' && row.subject === request)
  const detail = JSON.parse(executeAudit.detail)
  assert.deepEqual([detail.preparedBy, detail.approvedBy], ['writeoff-finance@example.test', 'owner@example.test'], 'audit records both people')
  // $900 needs one person.
  const form = await h.submit('writeoff.issue', people.finance, { invoice: third, amount: '900.00', reason: 'Small balance, one person' }, `/app/invoices/${third}`)
  assert.equal(form.searchParams.has('error'), false, 'the form door executes the single-person write-off')
  assert.equal(journals().length, before + 2)
  assert.deepEqual((await h.api('write-offs', owner)).writeOffs.filter(row => row.invoice === third).map(row => [row.amountCents, row.approval]), [[90000, 'single-person']])
  assert.equal((await read(third)).balanceCents, 110000)
  // Stale and changed-policy requests change nothing.
  const stale = (await h.api('writeoff.prepare', people.finance, { invoice: third, amount: '1000.00', reason: 'Prepared before the balance changed' })).request
  await h.api('credit.issue', owner, { invoice: third, amount: '50.00', reason: 'Intervening credit' })
  assert.equal((await h.api('writeoff.approve', owner, { request: stale }, 409)).error, 'write_off_stale')
  const staleBalance = (await read(third)).balanceCents, stalePolicy = (await h.api('writeoff.prepare', people.finance, { invoice: third, amount: '1000.00', reason: 'Prepared before the policy changed' })).request
  await applyPolicy(h, owner, 'credit.policy', { two_person_above: '1200.00' })
  assert.equal((await h.api('writeoff.approve', owner, { request: stalePolicy }, 409)).error, 'write_off_stale')
  assert.equal((await read(third)).balanceCents, staleBalance); assert.equal(journals().length, before + 2)

  // The ledger queue: an outage never loses the write-off, retry posts exactly once, a lost response is adopted.
  await applyPolicy(h, owner, 'credit.policy', { two_person_above: '' })
  edge.setOutage('down')
  const down = await h.api('writeoff.issue', owner, { invoice: third, amount: '100.00', reason: 'Ledger unavailable' })
  assert.deepEqual([down.posting.status, down.posting.error], ['pending', 'ledger_unavailable'])
  assert.equal((await read(third)).balanceCents, staleBalance - 10000, 'the receivable fact stands while the posting waits')
  assert.equal(journals().length, before + 2)
  edge.setOutage('lost')
  assert.equal((await h.api('ledger.post', owner, {})).postings[0].status, 'pending')
  edge.setOutage(null)
  const retried = (await h.api('ledger.post', owner, {})).postings
  assert.deepEqual(retried.map(row => row.status), ['posted'])
  assert.equal(journals().length, before + 3, 'a lost response is adopted, never posted twice')
  assert.deepEqual((await h.api('ledger.post', owner, {})).postings, [])
  for (const who of [people.accountant, people.collections, agent]) await h.api('ledger.post', who, {}, 403)
  assert.equal((await h.api('ledger-postings', people.accountant)).postings.length, 5)
  const receivables = await h.page('/app/receivables', owner)
  assert.match(receivables, /Written off/)
  console.log('AR-004 write-offs, recoveries, ledger posting and GOV-002 approvals passed')
  return { customer, first, second, third }
}
