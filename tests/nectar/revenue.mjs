import assert from 'node:assert/strict'
import { applyPolicy } from './policy-helper.mjs'

const entries = schedule => schedule.entries.map(row => [row.period, row.amountCents])

const sum = rows => rows.reduce((total, row) => total + row.amountCents, 0)

const money = cents => (cents / 100).toFixed(2)

const frozen = invoice => ({ lines: invoice.lines, calculation: invoice.calculation, subtotal: invoice.subtotal_cents, tax: invoice.tax_cents, total: invoice.total_cents, fingerprint: invoice.source_fingerprint })

// Read the actual CSV, including customer names containing commas and quotes.
function csvRows(text) {
  const rows = []; let row = [], cell = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++ } else quoted = !quoted
    } else if (char === ',' && !quoted) { row.push(cell); cell = '' }
    else if (char === '\n' && !quoted) { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = '' }
    else cell += char
  }
  assert.equal(quoted, false)
  const fields = rows.shift()
  return rows.filter(row => row.some(Boolean)).map(row => {
    assert.equal(row.length, fields.length)
    return Object.fromEntries(fields.map((field, i) => [field, row[i]]))
  })
}

// REV-001's approved current-line boundary: genuine monthly arrears, never a
// fabricated annual advance or prepaid purchase. Corrections have their own
// AGENT-002 public-door journeys, extended by their integration owner.
export async function revenueFlow(h, owner, { onState } = {}) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: 'CA', tax_mode: 'flat_rate', tax_rate: '10', tax_note: 'Revenue excludes original invoice tax' })
  await api('tax.review', { revision: (await api('business')).revision })
  const customer = (await api('customer.create', { external_id: 'REV001-CROSS', name: 'Cedar, "Revenue"', billing_email: 'billing@revenue.example' })).id
  const empty = (await api('customer.create', { external_id: 'REV001-EMPTY', name: 'No issued revenue', billing_email: 'empty@revenue.example' })).id
  const meter = (await api('meter.create', { code: 'rev001-events', name: 'Revenue events', unit_label: 'events' })).id
  const prices = []
  for (const [kind, unit_amount] of [['flat', '31'], ['seat', '15.50'], ['unit', '1']]) {
    const product = (await api('product.create', { code: `rev001-${kind}`, name: `Revenue ${kind}` })).id
    prices.push((await api('price.create', { product, kind, unit_amount, taxable: true, ...(kind === 'unit' ? { meter } : {}) })).id)
  }
  const subscription = (await api('subscription.create', { customer, start_date: '2026-03-15', anchor_day: 15, price: prices, quantity: ['', '2', ''] })).id
  for (const [kind, value] of [['discount_percent', '10'], ['fixed_credit', '3.10']]) {
    const amendment = await api('amendment.propose', { subscription, kind, value, effective_from: '2026-03-15', note: 'Signed revenue allocation terms', clause: 'Ten percent recurring discount and one $3.10 service credit.' })
    await api('amendment.decide', { amendment: amendment.amendment, decision: 'approved' })
  }
  const event = (event_id, quantity, occurred_at) => ({ event_id, customer: 'REV001-CROSS', meter: 'rev001-events', quantity, occurred_at })
  await api('usage.submit', { events: [event('rev001-march', '1', '2026-03-31T23:59:59-07:00'), event('rev001-april', '2', '2026-04-01T00:00:00-07:00')] })
  await api('charge.add', { customer, subscription, amount: '5', description: 'March service activation', effective_date: '2026-03-20', taxable: true })
  const run = await api('billrun.prepare', { period: '2026-03' })
  const draft = (await api(`runs/${run.id}`)).invoices.find(row => row.customer_id === customer)
  assert.ok(draft)
  const read = (query = '') => api(`revenue?${query}`)
  const scoped = `from=2026-03&to=2026-05&customer=${customer}`
  assert.deepEqual((await read(scoped)).contributions, [], 'draft consideration never becomes revenue')
  await api(`revenue/${draft.id}`, undefined, 404)
  await api('invoice.approve', { invoice: draft.id, acknowledge: true })
  assert.deepEqual((await read(scoped)).contributions, [], 'approval alone creates no revenue')
  await api('invoice.finalise', { invoice: draft.id, issue_date: '2026-05-01' })
  const issued = await api(`invoices/${draft.id}`)
  assert.deepEqual([issued.subtotal_cents, issued.tax_cents, issued.total_cents], [6070, 607, 6677])
  const source = await api(`revenue/${issued.id}`)
  assert.equal(source.custody, 'issue-snapshot', 'normal issue durably captures schedules rather than deriving them on reads')
  assert.equal(source.schedules.length, issued.lines.length)
  assert.equal(sum(source.schedules), 6070)
  const schedule = kind => {
    const matches = source.schedules.filter(row => row.kind === kind)
    assert.equal(matches.length, 1, `${kind} has its actual issued line schedule`)
    const result = matches[0]
    assert.equal(result.lineId, issued.lines.find(row => row.kind === kind).id)
    assert.equal(sum(result.entries), result.amountCents)
    return result
  }
  // March 15–April 15 has 17 March and 14 April service days. Signed
  // consideration is allocated once; consumption follows business-local dates.
  assert.deepEqual(entries(schedule('flat')), [['2026-03', 1700], ['2026-04', 1400]])
  assert.deepEqual(entries(schedule('seat')), [['2026-03', 1700], ['2026-04', 1400]])
  assert.deepEqual(entries(schedule('discount')), [['2026-03', -340], ['2026-04', -280]])
  assert.deepEqual(entries(schedule('credit')), [['2026-03', -170], ['2026-04', -140]])
  assert.deepEqual(entries(schedule('usage')), [['2026-03', 100], ['2026-04', 200]])
  assert.deepEqual(entries(schedule('one_time')), [['2026-03', 500]])
  assert.deepEqual(schedule('usage').entries.flatMap(row => row.basis.weight.eventIds), ['rev001-march', 'rev001-april'])
  let report = await read(scoped)
  assert.deepEqual(report.months.map(row => [row.period, row.openingCents, row.netBillingsCents, row.recognizedCents, row.closingCents, row.accruedContractAssetCents, row.deferredLiabilityCents]), [
    ['2026-03', 0, 0, 3490, -3490, 3490, 0],
    ['2026-04', -3490, 0, 2580, -6070, 6070, 0],
    ['2026-05', -6070, 6070, 0, 0, 0, 0],
  ], 'recognition precedes late-issued billings; accrued assets are not mislabeled deferred liabilities')
  assert.deepEqual([report.openingCents, report.netBillingsCents, report.recognizedCents, report.closingCents], [0, 6070, 6070, 0])
  assert.deepEqual((await read(`period=2026-04&customer=${customer}`)).months, [report.months[1]], 'opening includes prior recognition outside the selected window')
  assert.equal((await read(`from=2026-03&to=2026-05&customer=${empty}`)).recognizedCents, 0)
  for (const row of report.contributions) {
    assert.equal(row.invoiceId, issued.id)
    assert.ok(source.schedules.some(schedule => schedule.lineId === row.lineId))
    assert.ok((await h.page(row.href, owner)).includes(`id="line-${row.lineId}"`), 'every journal contribution opens its actual schedule')
  }
  // REV-002: independent debit/credit expectations across recognition before
  // billing; selecting April alone must keep March's accrued opening balance.
  const journal = query => api(`revenue-journal?${query}`)
  const compact = rows => rows.map(row => [row.period, row.account, row.debitCents, row.creditCents])
  const originalJournal = await journal(scoped)
  assert.deepEqual(compact(originalJournal.entries), [
    ['2026-03', 'accrued-contract-assets', 3490, 0], ['2026-03', 'recognized-revenue', 0, 3490],
    ['2026-04', 'accrued-contract-assets', 2580, 0], ['2026-04', 'recognized-revenue', 0, 2580],
    ['2026-05', 'pretax-billings-clearing', 6070, 0], ['2026-05', 'accrued-contract-assets', 0, 6070],
  ])
  assert.deepEqual(originalJournal.sources, report.contributions)
  assert.deepEqual(originalJournal.periods.map(row => [row.debitCents, row.creditCents]), [[3490, 3490], [2580, 2580], [6070, 6070]])
  const aprilJournal = await journal(`period=2026-04&customer=${customer}`)
  assert.equal(aprilJournal.periods[0].openingAccruedContractAssetCents, 3490)
  assert.deepEqual(aprilJournal.entries, originalJournal.entries.filter(row => row.period === '2026-04'))
  assert.deepEqual((await journal(`period=2026-04&customer=${empty}`)).entries, [])
  assert.deepEqual((await journal(`period=2026-04&customer=${empty}`)).sources, [])
  const journalCsv = await h.raw(`/app/exports/revenue-journal.csv?${scoped}`, { cookie: owner })
  assert.equal(journalCsv.status, 200)
  assert.match(journalCsv.headers.get('content-disposition'), /nectar-revenue-journal\.csv/)
  assert.equal(journalCsv.headers.get('cache-control'), 'private, no-store')
  const exportedJournal = csvRows(await journalCsv.text())
  assert.deepEqual(exportedJournal.map(row => [row.period, row.account, row.debit, row.credit, row.currency]), [
    ['2026-03', 'accrued-contract-assets', '34.90', '0.00', 'USD'], ['2026-03', 'recognized-revenue', '0.00', '34.90', 'USD'],
    ['2026-04', 'accrued-contract-assets', '25.80', '0.00', 'USD'], ['2026-04', 'recognized-revenue', '0.00', '25.80', 'USD'],
    ['2026-05', 'pretax-billings-clearing', '60.70', '0.00', 'USD'], ['2026-05', 'accrued-contract-assets', '0.00', '60.70', 'USD'],
  ], 'journal excludes the independently checked $6.07 tax; clearing is pretax')
  assert.ok(exportedJournal.every(row => /Tax, cash, collections/.test(row.basis) && /Later records post to the open period/.test(row.basis)))
  for (const row of exportedJournal) {
    const link = new URL(row.source_path, h.origin)
    assert.equal(link.searchParams.get('customer'), customer)
    assert.equal(link.searchParams.get('period'), row.period)
    assert.equal(link.hash, '#contributions')
    assert.equal((await h.raw(link.pathname + link.search, { cookie: owner })).status, 200)
  }
  const page = await h.page(`/app/revenue?${scoped}`, owner)
  assert.ok(page.includes('/app/exports/revenue.csv'))
  assert.ok(page.includes(`/app/revenue/${issued.id}`))
  await onState?.({ name: 'schedules', report: `/app/revenue?${scoped}`, source: `/app/revenue/${issued.id}`, invoice: issued.id, customer })
  const csv = await h.raw(`/app/exports/revenue.csv?${scoped}`, { cookie: owner })
  assert.equal(csv.status, 200)
  assert.match(csv.headers.get('content-type'), /text\/csv/)
  const exported = csvRows(await csv.text())
  assert.deepEqual(exported.filter(row => row.row_kind === 'rollforward').map(row => [row.period, row.opening, row.net_billings, row.recognized, row.closing]), report.months.map(row => [row.period, ...[row.openingCents, row.netBillingsCents, row.recognizedCents, row.closingCents].map(value => (value < 0 ? "'" : '') + money(value))]))
  assert.deepEqual(exported.filter(row => row.row_kind !== 'rollforward').map(row => [row.row_kind, row.period, row.line_id, row.signed_contribution, row.source_path]), report.contributions.map(row => [row.kind, row.period, row.lineId, (row.amountCents < 0 ? "'" : '') + money(row.amountCents), row.href]))
  assert.ok(exported.some(row => row.customer === 'Cedar, "Revenue"'))
  await api('usage.submit', { events: [event('rev001-late', '4', '2026-03-25T12:00:00-07:00')] })
  assert.deepEqual(await api(`revenue/${issued.id}`), source, 'late ingestion cannot rewrite issued schedules or their saved consumption basis')
  assert.deepEqual(frozen(await api(`invoices/${issued.id}`)), frozen(issued))

  const correction=await api('usage.correction.prepare',{subscription,from_period:'2026-03',through_period:'2026-03',void_event_ids:[],add_event_ids:['rev001-late'],reason:'Late March consumption',explanation:'Reviewed March consumption arrived after invoice issue; its exact difference is billed next.'})
  await api('usage.correction.decide',{correction:correction.id,decision:'approved'})
  const lateRun = await api('billrun.prepare', { period: '2026-04' })
  const lateDraft = (await api(`runs/${lateRun.id}`)).invoices.find(row => row.customer_id === customer)
  await api('invoice.approve', { invoice: lateDraft.id, acknowledge: true })
  await api('invoice.finalise', { invoice: lateDraft.id, issue_date: '2026-06-01' })
  const lateSource = await api(`revenue/${lateDraft.id}`)
  const lateSchedule = lateSource.schedules.find(row => row.kind === 'usage_correction')
  assert.ok(lateSchedule)
  assert.deepEqual(entries(lateSchedule), [['2026-03', 400]], 'late-billed usage recognizes its actual consumption month')
  assert.deepEqual(await api(`revenue/${issued.id}`), source, 'late issue preserves the original snapshot')

  const charge = (await api('charge.add', { customer: empty, amount: '7', description: 'Manual June service', taxable: true, effective_date: '2026-06-03' })).charge
  const manual = await api('invoice.manual', { customer: empty, charges: [charge], service_date: '2026-06-03' })
  await api('invoice.approve', { invoice: manual.id, acknowledge: true })
  await api('invoice.finalise', { invoice: manual.id, issue_date: '2026-06-04' })
  const manualSource = await api(`revenue/${manual.id}`)
  assert.equal(manualSource.custody, 'issue-snapshot')
  assert.deepEqual(entries(manualSource.schedules[0]), [['2026-06', 700]])
  assert.equal((await read(`period=2026-06&customer=${empty}`)).recognizedCents, 700)

  await api('credit.issue', { invoice: issued.id, amount: '5', reason: 'Reviewed revenue adjustment' })
  const credited = await api(`invoices/${issued.id}`)
  const afterCredit = await api(`revenue/${issued.id}`)
  assert.deepEqual(afterCredit.schedules, source.schedules, 'actual credits never edit original line recognition')
  assert.deepEqual(frozen(credited), frozen(issued))
  const credit = afterCredit.credits[0]
  assert.equal(credit.id, credited.credits[0].id)
  assert.equal(credit.amountCents, -500)
  const creditMonth = (await read(`period=${credit.period}&customer=${customer}`)).months[0]
  assert.equal(creditMonth.creditsCents, -500)
  assert.equal(creditMonth.recognizedCents, -500)
  assert.equal(creditMonth.closingCents, 0)
  assert.equal(credit.basis.originalTaxUnchanged, true)
  assert.ok((await h.page(`/app/revenue/${issued.id}`, owner)).includes(`id="credit-${credit.id}"`))

  const creditJournal = await journal(`period=${credit.period}&customer=${customer}`)
  assert.deepEqual(compact(creditJournal.entries), [
    [credit.period, 'pretax-billings-clearing', 0, 500], [credit.period, 'recognized-revenue', 500, 0],
  ], 'a negative credit reverses billings/revenue, never introduces a negative debit or credits original tax')
  assert.equal(creditJournal.periods[0].debitCents, 500)
  assert.equal(creditJournal.periods[0].creditCents, 500)
  assert.deepEqual(creditJournal.sources.map(row => row.creditId), [credit.id, credit.id])
  // Current manual doors refuse advance issue. Do not fabricate an annual
  // advance to exercise a future CAT-001 capability.
  const augustCharge = (await api('charge.add', { customer: empty, amount: '10', description: 'August service activation', taxable: true, effective_date: '2026-08-03' })).charge
  const augustInvoice = await api('invoice.manual', { customer: empty, charges: [augustCharge], service_date: '2026-08-03' })
  await api('invoice.approve', { invoice: augustInvoice.id, acknowledge: true })
  assert.equal((await api('invoice.finalise', { invoice: augustInvoice.id, issue_date: '2026-05-31' }, 400)).error, 'invalid_issue_date')
  assert.deepEqual((await journal(`period=2026-08&customer=${empty}`)).entries, [], 'refused advance issue contributes no journal')
  await api('invoice.finalise', { invoice: augustInvoice.id, issue_date: '2026-08-03' })
  const manualJournal = await journal(`from=2026-05&to=2026-08&customer=${empty}`)
  assert.deepEqual(compact(manualJournal.entries), [
    ['2026-06', 'pretax-billings-clearing', 700, 0], ['2026-06', 'recognized-revenue', 0, 700],
    ['2026-08', 'pretax-billings-clearing', 1000, 0], ['2026-08', 'recognized-revenue', 0, 1000],
  ])
  assert.deepEqual(manualJournal.periods.map(row => [row.period, row.debitCents, row.creditCents, row.deferredLiabilityCents]), [
    ['2026-05', 0, 0, 0], ['2026-06', 700, 700, 0], ['2026-07', 0, 0, 0], ['2026-08', 1000, 1000, 0],
  ])
  const companyJournal = await journal('period=2026-08')
  assert.equal(companyJournal.periods[0].debitCents, companyJournal.periods[0].creditCents)
  assert.equal(companyJournal.sources.filter(row => row.invoiceId === augustInvoice.id).length, 2)
  assert.deepEqual((await journal(`period=2026-08&customer=${customer}`)).sources.filter(row => row.invoiceId === augustInvoice.id), [])
  assert.deepEqual(frozen(await api(`invoices/${issued.id}`)), frozen(issued), 'read-only journal never edits the issued invoice')
  await onState?.({ name: 'journal', report: '/app/revenue?from=2026-03&to=2026-08', source: `/app/revenue/${augustInvoice.id}`, invoice: issued.id, customer, journalPath: `/app/exports/revenue-journal.csv?from=2026-03&to=2026-08` })
  await onState?.({ name: 'credit', report: `/app/revenue?period=${credit.period}&customer=${customer}`, source: `/app/revenue/${issued.id}`, invoice: issued.id, customer })
  const reader = { bearer: (await api('credential.issue', { name: 'Revenue reader', scopes: ['prepare'] })).key }
  const usageOnly = { bearer: (await api('credential.issue', { name: 'Revenue usage only', scopes: ['usage'] })).key }
  for (const path of ['revenue', 'revenue-journal', `revenue/${issued.id}`]) {
    await h.api(path, null, undefined, 401)
    await h.api(path, usageOnly, undefined, 403)
    await h.api(path, reader)
  }
  await api(`revenue/${issued.id}?customer=${empty}`, undefined, 404)
  await api('access.give', { email: 'rev001-accountant@example.test', name: 'Revenue Accountant', role: 'accountant' })
  const accountant = await h.signIn('rev001-accountant@example.test', { requested: true })
  assert.deepEqual(await h.api(`revenue/${issued.id}`, accountant), afterCredit)
  assert.equal((await h.raw(`/app/exports/revenue.csv?${scoped}`, { cookie: accountant })).status, 200)
  const accountantJournal = await h.raw('/app/exports/revenue-journal.csv?period=2026-05', { cookie: accountant })
  assert.equal(accountantJournal.status, 200)
  await accountantJournal.text()
  await api('access.give', { email: 'rev002-developer@example.test', name: 'Read-only developer', role: 'developer' })
  const developer = await h.signIn('rev002-developer@example.test', { requested: true })
  await h.api('revenue-journal?period=2026-05', developer)
  assert.equal((await h.raw('/app/exports/revenue-journal.csv', { cookie: developer })).status, 403)
  const readerCsv = await h.raw('/app/exports/revenue-journal.csv', reader)
  assert.equal(readerCsv.status, 403)
  assert.equal((await h.raw('/app/exports/revenue-journal.csv')).status, 303)
  for (const query of ['period=invalid', 'from=2026-05&to=2026-03', 'period=2026-03&from=2026-03', 'customer=a&customer=b', 'from=2020-01&to=2030-01']) await api(`revenue-journal?${query}`, undefined, 400)
  await api('invoice.finalise', { invoice: issued.id, issue_date: '2026-05-01' }, 409)
  assert.deepEqual(await api(`revenue/${issued.id}`), afterCredit, 'duplicate issue cannot append duplicate recognition')
  assert.equal((await h.raw('/app/revenue')).status, 303)
  assert.equal((await h.raw('/app/exports/revenue.csv')).status, 303)
  for (const query of ['period=invalid', 'from=2026-05&to=2026-03', 'period=2026-03&from=2026-03', 'customer=a&customer=b']) await api(`revenue?${query}`, undefined, 400)
  return { customer, subscription, invoice: issued.id, manual: manual.id }
}
