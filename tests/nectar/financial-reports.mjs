import assert from 'node:assert/strict'
import { applyPolicy } from './policy-helper.mjs'

const metrics = ['billings', 'collections', 'refunds', 'ar', 'credits', 'tax', 'unbilled', 'credit-balances']
const sum = rows => rows.reduce((total, row) => total + row.amountCents, 0)
const money = cents => (cents / 100).toFixed(2)
const content = mail => `${mail.subject} ${mail.text ?? ''} ${mail.html ?? ''}`
const monthAfter = (period, count = 1) => {
  const date = new Date(`${period}-01T12:00:00Z`)
  date.setUTCMonth(date.getUTCMonth() + count)
  return date.toISOString().slice(0, 7)
}

// Parse the exported public format, including comma/quote/newline escaping.
export function csvRows(text) {
  const rows = [], row = []
  let cell = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++ }
      else quoted = !quoted
    } else if (!quoted && (c === ',' || c === '\n')) {
      row.push(cell.replace(/\r$/, '')); cell = ''
      if (c === '\n') { rows.push([...row]); row.length = 0 }
    } else cell += c
  }
  assert.equal(quoted, false, 'CSV quotes are balanced')
  if (cell || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row) }
  const fields = rows.shift()
  return rows.filter(row => row.some(Boolean)).map(row => {
    assert.equal(row.length, fields.length, 'CSV cells survive escaping')
    return Object.fromEntries(fields.map((field, i) => [field, row[i]]))
  })
}

function reconcilesCsv(text, reports) {
  const rows = csvRows(text)
  for (const report of reports) {
    const own = rows.filter(row => row.report === report.metric)
    const totals = own.filter(row => row.source === 'TOTAL')
    assert.equal(totals.length, 1, `${report.metric} has one explicit CSV total`)
    assert.equal(totals[0].amount, money(report.totalCents))
    const entries = own.filter(row => row.source !== 'TOTAL')
    assert.deepEqual(entries.map(row => [row.customer, row.amount, row.source_path]).sort(), report.entries.map(row => [row.customerName, money(row.amountCents), row.href]).sort(), `${report.metric} CSV preserves the same source/customer amounts`)
    for (const row of own) {
      assert.equal(row.period, report.period)
      assert.equal(row.definition, report.definition)
    }
  }
  assert.equal(rows.length, reports.reduce((n, report) => n + report.entries.length + 1, 0))
}

async function prepaidReportFixtures(h, owner, { subscription, customer, meter, period, issue, payment }) {
  const api = (path, body) => h.api(path, owner, body)
  const grants = []
  for (const [kind, source, amount, purchase_amount, cents] of [['money', 'purchase', '20', undefined, 2000], ['money', 'promotion', '5', undefined, 500], ['units', 'purchase', '3', '1', 100], ['units', 'promotion', '1.25', undefined, 0]]) {
    const pending = await api('prepaid.prepare', { subscription, mode: 'grant', kind, source, amount, ...(purchase_amount ? { purchase_amount } : {}),
      ...(kind === 'units' ? { meter } : {}), effective_date: `${period}-01`, expires_date: `${monthAfter(period, 12)}-01`, expiry_consent: true })
    await api('prepaid.decide', { request: pending.request, decision: 'approved', confirm_single: true })
    let invoice
    if (source === 'purchase') {
      const purchase = await api('prepaid.purchase.prepare', { intent: pending.request, issue_date: `${period}-01` })
      invoice = await issue(purchase.invoice, `${period}-01`)
      const receipt = await payment(money(invoice.total_cents), `RPT002-PREPAID-${pending.request}`)
      await api('payment.allocate', { invoice: invoice.id, payment: receipt.payment, amount: money(invoice.total_cents) })
      await api('prepaid.funding.confirm', { intent: pending.request, confirm: true })
    }
    const ledger = await api(`prepaid/${subscription}`)
    const grant = ledger.grants.find(row => source === 'purchase' ? row.purchaseInvoice === invoice.id : row.id === pending.request)
    assert.ok(grant)
    grants.push({ id: grant.id, kind, source, cents })
  }
  const future = await api('prepaid.prepare', { subscription, mode: 'grant', kind: 'money', source: 'promotion', amount: '99', effective_date: `${monthAfter(period)}-01`, expiry_consent: true })
  await api('prepaid.decide', { request: future.request, decision: 'approved', confirm_single: true })
  const before = await api(`prepaid/${subscription}`)
  const report = await api(`reports/credit-balances?period=${period}&customer=${customer}`)
  assert.equal(report.totalCents, 3300, '$25 available money, $1 unconsumed paid unit consideration and $7 of unallocated receipts (INV-006), never unit quantities as USD')
  assert.equal(report.entries.length, 5, 'The future-dated grant is not available at the current business date; the unallocated receipt is the fifth source')
  assert.equal((await api(`reports/credit-balances?period=${monthAfter(period)}&customer=${customer}`)).totalCents, 3300, 'The selected export month cannot turn a future lot into current available credit')
  for (const grant of grants) {
    const entry = report.entries.find(row => row.prepaid?.grantId === grant.id)
    assert.ok(entry)
    assert.equal(entry.sourceKind, 'prepaid_grant')
    assert.equal(entry.amountCents, grant.cents)
    const source = await api(entry.href.replace('/app/', ''))
    assert.equal(source.invoice, null)
    assert.equal(source.prepaid.kind, grant.kind)
    assert.equal(source.prepaid.source, grant.source)
    assert.equal(sum(source.components), grant.cents)
    assert.equal(source.prepaid.entries.length, 1)
    assert.ok(source.prepaid.entries.every(row => row.serviceDate <= source.prepaid.asOf), 'Only ledger entries effective at the current business date contribute')
    const ledgerSource = await api(source.prepaid.ledgerHref.replace('/app/', ''))
    assert.equal(ledgerSource.entry.id, source.prepaid.entries[0].id)
    assert.equal(ledgerSource.grant.id, grant.id)
    if (grant.kind === 'units') {
      assert.equal(source.prepaid.meterId, meter)
      assert.equal(Number(source.prepaid.availableQuantity), grant.source === 'purchase' ? 3 : 1.25)
      assert.equal(source.prepaid.liabilityCents, grant.cents)
    }
  }
  assert.deepEqual(await api(`prepaid/${subscription}`), before, 'Repeated reports and source reads never grant, consume, expire or charge')
  return { grants, future: future.request, subscription, customer }
}

// RPT-002: an isolated company, independent cents and real signed-in HTTP doors.
export async function financialReportsFlow(h, owner) {
  const before = await h.api('business', owner)
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: before.timezone, year: 'numeric', month: '2-digit' }).formatToParts(new Date()).filter(p => p.type !== 'literal').map(p => [p.type, p.value]))
  const period = `${parts.year}-${parts.month}`, prior = monthAfter(period, -1)
  const initialSchedule = (await h.api('report-schedule', owner)).schedule
  await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: 'CA', tax_mode: 'flat_rate', tax_rate: '10', tax_note: 'Reviewed financial reporting fixture' })
  await h.api('tax.review', owner, { revision: (await h.api('business', owner)).revision })
  const customer = async (external_id, name) => (await h.api('customer.create', owner, { external_id, name, billing_email: 'ap@reports.example' })).id
  const billed = await customer('RPT002-BILLED', 'Cedar, "Reports"')
  const pending = await customer('RPT002-PENDING', 'Unbilled research')
  const empty = await customer('RPT002-EMPTY', 'Empty research')
  const meter = (await h.api('meter.create', owner, { code: 'rpt002-events', name: 'Report events', unit_label: 'events' })).id
  const prices = []
  for (const [kind, amount] of [['flat', '100'], ['unit', '0.012345']]) {
    const product = (await h.api('product.create', owner, { code: `rpt002-${kind}`, name: `Reporting ${kind}` })).id
    prices.push((await h.api('price.create', owner, { product, kind, unit_amount: amount, taxable: true, ...(kind === 'unit' ? { meter } : {}) })).id)
  }
  const subscriptions = []
  for (const target of [billed, pending]) subscriptions.push((await h.api('subscription.create', owner, { customer: target, start_date: `${target === billed ? prior : period}-01`, price: prices })).id)
  const event = (event_id, target, quantity) => ({ event_id, customer: target, meter: 'rpt002-events', quantity, occurred_at: `${period}-01T12:00:00Z` })
  await h.api('usage.submit', owner, { events: [{ ...event('RPT002-BILLED-USAGE', 'RPT002-BILLED', '1000.5'), occurred_at: `${prior}-01T12:00:00Z` }, event('RPT002-PENDING-A', 'RPT002-PENDING', '1000'), event('RPT002-PENDING-B', 'RPT002-PENDING', '0.5')] })
  await h.api('charge.add', owner, { customer: pending, subscription: subscriptions[1], amount: '25', description: 'Unbilled non-usage fee', taxable: true, effective_date: `${period}-01` })
  const issue = async (invoice, issue_date) => {
    await h.api('invoice.approve', owner, { invoice, acknowledge: true })
    await h.api('invoice.finalise', owner, { invoice, issue_date })
    return h.api(`invoices/${invoice}`, owner)
  }
  const charge = (await h.api('charge.add', owner, { customer: billed, amount: '40', description: 'Old open invoice', taxable: true, effective_date: '2024-01-01' })).charge
  const oldInvoice = await issue((await h.api('invoice.manual', owner, { customer: billed, charges: [charge], service_date: '2024-01-01' })).id, '2024-01-01')
  assert.deepEqual([oldInvoice.subtotal_cents, oldInvoice.tax_cents, oldInvoice.total_cents], [4000, 400, 4400])
  const run = await h.api('billrun.prepare', owner, { period: prior })
  const drafts = (await h.api(`runs/${run.id}`, owner)).invoices
  const draft = drafts.find(row => row.customer_id === billed)
  assert.ok(draft)
  assert.equal((await h.api(`reports/billings?period=${period}`, owner)).totalCents, 0, 'drafts are not issued billings')
  const invoice = await issue(draft.id, `${period}-01`)
  const pendingRun = await h.api('billrun.prepare', owner, { period })
  assert.equal((await h.api(`subscriptions/${subscriptions[1]}/upcoming?period=${period}`,owner)).state,'preview','RPT-002 reads real unissued current-period usage before the period can be issued')
  assert.equal((await h.api(`runs/${pendingRun.id}`,owner)).invoices.some(row=>row.customer_id===pending),false,'an incomplete service period is not issued early')
  // 100 + round(1000.5 * .012345) = 112.35; 10% tax rounds to 11.24.
  assert.deepEqual([invoice.subtotal_cents, invoice.tax_cents, invoice.total_cents], [11235, 1124, 12359])
  await h.api('credit.issue', owner, { invoice: invoice.id, amount: '12.50', reason: 'Documented service adjustment' })
  const payment = async (amount, reference) => h.api('payment.record', owner, { customer: billed, amount, reference, received_on: `${period}-01`, method: 'bank_transfer', evidence: 'Reporting fixture bank statement' })
  const allocated = await payment('20', 'RPT002-ALLOCATED')
  await h.api('payment.allocate', owner, { invoice: invoice.id, payment: allocated.payment, amount: '20' })
  await payment('7', 'RPT002-UNALLOCATED')
  assert.equal((await h.api(`invoices/${invoice.id}`, owner)).credits.reduce((n, credit) => n + credit.amount_cents, 0), 1250)
  const prepaid = await prepaidReportFixtures(h, owner, { subscription: subscriptions[0], customer: billed, meter, period, issue, payment })

  const expected = { refunds: 0, billings: 14459, collections: 4800, ar: 13509, credits: 1250, tax: 1124, unbilled: 1235, 'credit-balances': 3300 }
  const read = (metric, target) => h.api(`reports/${metric}?period=${period}${target ? `&customer=${target}` : ''}`, owner)
  const exportCsv = async (path, who = owner) => {
    const result = await h.raw(path, { cookie: who })
    assert.equal(result.status, 200, await result.clone().text())
    assert.match(result.headers.get('content-type'), /text\/csv/)
    return result.text()
  }
  const reports = []
  for (const metric of metrics) {
    const report = await read(metric)
    reports.push(report)
    assert.equal(report.metric, metric)
    assert.equal(report.totalCents, expected[metric], `${metric} independently calculated cents`)
    assert.equal(sum(report.entries), report.totalCents)
    assert.ok(report.definition.length > 0)
    const scoped = await read(metric, metric === 'unbilled' ? pending : billed)
    assert.equal(scoped.totalCents, expected[metric])
    const sources = rows => rows.map(({ href, ...entry }) => entry)
    assert.deepEqual(sources(scoped.entries), sources(report.entries), 'the other customer contributes no unrelated amount')
    const absent = await read(metric, empty)
    assert.equal(absent.totalCents, 0); assert.deepEqual(absent.entries, [])
    reconcilesCsv(await exportCsv(`/app/exports/reports/${metric}.csv?period=${period}&customer=${empty}`), [absent])
    reconcilesCsv(await exportCsv(`/app/exports/reports/${metric}.csv?period=${period}&customer=${metric === 'unbilled' ? pending : billed}`), [scoped])
    const html = await h.page(`/app/reports/${metric}?period=${period}`, owner)
    for (const entry of report.entries) {
      assert.ok(html.includes(entry.href.replaceAll('&', '&amp;')))
      await h.page(entry.href, owner)
    }
    for (const query of ['period=2026-13', 'period=2026-1', 'period=invalid']) {
      await h.api(`reports/${metric}?${query}`, owner, undefined, 400)
      assert.equal((await h.raw(`/app/exports/reports/${metric}.csv?${query}`, { cookie: owner })).status, 400)
    }
  }
  assert.equal((await h.api(`reports/credits?period=${prior}&customer=${billed}`, owner)).totalCents, 0, 'credits use their actual creation month, not invoice service month')
  assert.equal((await h.api(`reports/unbilled?period=${prior}&customer=${billed}`, owner)).totalCents, 0, 'issued subscription periods cannot contribute unbilled usage again')
  assert.equal((await h.api('reports/tax?period=2024-01', owner)).totalCents, 400, 'old invoice tax stays in its issue month')
  assert.equal((await read('tax', billed)).totalCents, 1124, 'unattributed credit notes cannot invent a tax reversal')
  const creditSource = await h.api(reports.find(report => report.metric === 'credits').entries[0].href.replace('/app/', ''), owner)
  assert.equal(creditSource.credit.invoiceId, invoice.id)
  assert.equal(creditSource.credit.amountCents, 1250)
  assert.equal(sum(creditSource.components), 1250)
  const taxSource = await h.api(reports.find(report => report.metric === 'tax').entries[0].href.replace('/app/', ''), owner)
  assert.equal(sum(taxSource.components), 1124)
  assert.deepEqual(taxSource.calculation.inputs, invoice.calculation.inputs)
  const prepaidCsv = csvRows(await exportCsv(`/app/exports/reports/credit-balances.csv?period=${period}&customer=${billed}`)).filter(row => row.source !== 'TOTAL')
  assert.equal(prepaidCsv.length, 5, 'four prepaid grants and the unallocated receipt')
  assert.deepEqual(prepaidCsv.filter(row => row.prepaid_kind === 'units').map(row => [row.prepaid_source, Number(row.prepaid_available_quantity), row.prepaid_paid_liability, row.amount]).sort(), [['promotion', 1.25, '0.00', '0.00'], ['purchase', 3, '1.00', '1.00']])
  const unbilledEntry = reports.find(report => report.metric === 'unbilled').entries[0]
  const unbilledSource = await h.api(unbilledEntry.href.replace('/app/', ''), owner)
  assert.equal(unbilledSource.invoice, null)
  assert.equal(unbilledSource.unbilled.subscriptionId, subscriptions[1])
  assert.deepEqual(unbilledSource.unbilled.eventIds.slice().sort(), ['RPT002-PENDING-A', 'RPT002-PENDING-B'])
  assert.equal(sum(unbilledSource.components), 1235)
  assert.equal(unbilledSource.unbilled.lines.length, 1, 'flat prices and one-time fees are excluded from rated usage')
  const usageLine = unbilledSource.unbilled.lines[0]
  assert.equal(usageLine.quantity, '1000.50')
  assert.equal(usageLine.amountCents, 1235)
  assert.deepEqual(usageLine.eventIds.slice().sort(), ['RPT002-PENDING-A', 'RPT002-PENDING-B'])
  assert.deepEqual(usageLine.events.map(event => event.eventId).sort(), ['RPT002-PENDING-A', 'RPT002-PENDING-B'])
  assert.ok(unbilledSource.unbilled.calculation.inputs)
  const ageing = await h.api('ageing', owner)
  assert.equal(ageing.totals.total, 13509)
  assert.equal(ageing.invoices.find(row => row.id === oldInvoice.id).bucket, '90+')
  for (const [bucket, cents] of [['current', 9109], ['1-30', 0], ['31-60', 0], ['61-90', 0], ['90+', 4400], ['overdue', 4400]]) {
    const report = await h.api(`reports/ar?customer=${billed}&bucket=${encodeURIComponent(bucket)}`, owner)
    assert.equal(report.totalCents, cents, `current AR ageing ${bucket}`)
    reconcilesCsv(await exportCsv(`/app/exports/reports/ar.csv?customer=${billed}&bucket=${encodeURIComponent(bucket)}`), [report])
  }
  await h.api('reports/ar?bucket=invalid', owner, undefined, 400)
  assert.equal((await h.raw('/app/exports/reports/ar.csv?bucket=invalid', { cookie: owner })).status, 400)

  const invite = async (name, role = 'finance') => {
    const email = `rpt002-${name}@example.test`
    const member = await h.api('access.give', owner, { email, name: `Reports ${name}`, role })
    return { ...member, email, who: await h.signIn(email, { requested: true }) }
  }
  const finance = await invite('finance'), quiet = await invite('quiet'), ended = await invite('ended'), accountant = await invite('accountant', 'accountant')
  const credential = await h.api('credential.issue', owner, { name: 'Report preparation', scopes: ['prepare'] })
  const ingestion = await h.api('credential.issue', owner, { name: 'Report ingestion', scopes: ['usage'] })
  const agent = { bearer: credential.key }, usageAgent = { bearer: ingestion.key }
  for (const metric of metrics) {
    const apiPath = `reports/${metric}?period=${period}`
    await h.api(apiPath, undefined, undefined, 401)
    await h.api(apiPath, usageAgent, undefined, 403)
    assert.deepEqual(await h.api(apiPath, accountant.who), reports.find(report => report.metric === metric))
    const path = `/app/exports/reports/${metric}.csv?period=${period}`
    assert.equal((await h.raw(path)).status, 303)
    assert.equal((await h.raw(path, usageAgent)).status, 403)
    reconcilesCsv(await exportCsv(path, accountant.who), [reports.find(report => report.metric === metric)])
  }
  const save = (who, enabled, day = 5) => h.api('report.schedule', who, { enabled, day })
  assert.equal(initialSchedule.enabled, false, 'scheduled reports start opted out')
  for (const person of [finance, quiet, ended, accountant]) {
    assert.deepEqual((await h.api('report-schedule', person.who)).deliveries, [])
    assert.deepEqual(await save(person.who, true), { enabled: true, day: 5 })
  }
  await save(owner, true)
  await save(finance.who, true, 6)
  await save(quiet.who, false); await save(accountant.who, false)
  await h.api('access.end', owner, { member: ended.id })
  for (const payload of [{ enabled: true, day: 0 }, { enabled: true, day: 29 }, { enabled: true, day: 1.5 }, ...[{ member: quiet.id }, { member_id: quiet.id }, { email: quiet.email }, { recipient: quiet.email }].map(spoof => ({ enabled: true, day: 5, ...spoof }))])
    await h.api('report.schedule', owner, payload, 400)
  assert.deepEqual((await h.api('report-schedule', quiet.who)).schedule, { enabled: false, day: 5 }, 'spoofed destinations cannot opt another member in')
  for (const [who, status] of [[undefined, 401], [agent, 403], [ended.who, 401]]) {
    await h.api('report.schedule', who, { enabled: true, day: 5 }, status)
    await h.api('report-schedule', who, undefined, status)
  }
  assert.equal((await h.raw('/api/nectar/report.schedule', { cookie: owner, body: { enabled: false, day: 5 }, headers: { origin: 'https://other.example' } })).status, 403)
  assert.equal((await h.api('report-schedule', owner)).schedule.enabled, true)
  const tick = async timestamp => {
    const result = await h.raw(`/cdn-cgi/local/scheduled?time=${Date.parse(timestamp)}&cron=${encodeURIComponent('0 14 * * *')}`)
    assert.equal(result.status, 200, await result.text())
  }
  const next = monthAfter(period), start = h.mails.length
  // 00Z on the 5th is still the 4th in Los Angeles; 20Z is the chosen local day.
  await tick(`${next}-05T00:00:00Z`)
  assert.equal(h.mails.length, start, 'UTC day alone cannot trigger the local schedule')
  await tick(`${next}-05T20:00:00Z`); await tick(`${next}-05T20:00:00Z`)
  assert.equal(h.mails.length, start + 1, 'each member uses their own selected day')
  await tick(`${next}-08T20:00:00Z`)
  assert.deepEqual(h.mails.slice(start).flatMap(mail => [mail.to].flat()).sort(), [(await h.api('me', owner)).email, finance.email].sort(), 'only active opted-in members receive one report')
  assert.deepEqual((await h.api('report-schedule', quiet.who)).deliveries, [])
  assert.deepEqual((await h.api('report-schedule', accountant.who)).deliveries, [])
  let frozen
  for (const [who, email] of [[owner, (await h.api('me', owner)).email], [finance.who, finance.email]]) {
    const rows = (await h.api('report-schedule', who)).deliveries
    assert.equal(rows.length, 1)
    const delivery = await h.api(`report-deliveries/${rows[0].id}`, who)
    assert.equal(delivery.period, period); assert.equal(delivery.status, 'accepted')
    const audit=await h.api('audit',owner)
    for(const action of ['report.reserve','report.mail.claim','report.delivery'])assert.equal(audit.filter(e=>e.subject===delivery.id&&e.action===action).length,1,'RPT-002/GOV-004 each reservation, sending claim and outcome has one durable audit event')
    const reservation=JSON.parse(audit.find(e=>e.subject===delivery.id&&e.action==='report.reserve').detail)
    assert.ok(reservation.scheduleRevision);assert.equal(reservation.period,period)
    const financialData = rows => rows.map(report => ({ ...report, entries: report.entries.map(({ href, sourcePath, ...entry }) => entry) }))
    assert.deepEqual(financialData(delivery.reports), financialData(reports))
    reconcilesCsv(delivery.csv, delivery.reports)
    for (const report of delivery.reports) for (const entry of report.entries) {
      assert.ok(entry.href.startsWith(`/app/report-deliveries/${delivery.id}#`), 'frozen sources link to the delivered evidence')
      assert.ok(reports.find(row => row.metric === report.metric).entries.some(row => row.href === entry.sourcePath))
    }
    const evidence = delivery.sourceEvidence.find(source => source.metric === 'unbilled')
    assert.ok(evidence)
    assert.equal(evidence.detail.totalCents, 1235)
    assert.deepEqual(evidence.detail.unbilled.eventIds.slice().sort(), ['RPT002-PENDING-A', 'RPT002-PENDING-B'])
    const prepaidEvidence = delivery.sourceEvidence.filter(source => source.metric === 'credit-balances' && source.detail.sourceKind === 'prepaid_grant')
    assert.equal(prepaidEvidence.length, 4)
    for (const source of prepaidEvidence) {
      const expected = prepaid.grants.find(grant => grant.id === source.detail.prepaid.grantId)
      assert.ok(expected)
      assert.equal(source.detail.totalCents, expected.cents)
      assert.equal(sum(source.detail.components), expected.cents)
      assert.equal(source.detail.prepaid.entries.length, 1, 'Scheduled snapshots retain exact original lot ledger components')
    }
    const mail = h.mails.slice(start).find(mail => [mail.to].flat().includes(email))
    assert.equal(delivery.provider_ref, `test-${h.mails.indexOf(mail) + 1}`)
    assert.ok(content(mail).includes(period))
    const href = `/app/report-deliveries/${delivery.id}`
    assert.ok(content(mail).includes(href), 'email points to its frozen signed-in report')
    // Where figures are included, every figure must be the corresponding snapshot total.
    if (/\d[,.]\d{2}\b/.test(`${mail.text ?? ''} ${mail.html ?? ''}`))
      for (const report of reports) assert.ok(content(mail).replaceAll(',', '').includes(money(report.totalCents)), `${report.metric} email equals snapshot cents`)
    const snapshotPage = await h.page(href, who)
    for (const report of delivery.reports) for (const entry of report.entries)
      assert.ok(snapshotPage.includes(`id="${new URL(entry.href, h.origin).hash.slice(1)}"`), 'every frozen contribution link has its saved evidence anchor')
    assert.equal(await exportCsv(`${href}.csv`, who), delivery.csv)
    assert.equal((await h.raw(href)).status, 303)
    assert.equal((await h.raw(`${href}.csv`)).status, 303)
    await h.api(`report-deliveries/${delivery.id}`, undefined, undefined, 401)
    await h.api(`report-deliveries/${delivery.id}`, agent, undefined, 403)
    await h.api(`report-deliveries/${delivery.id}`, accountant.who, undefined, 404)
    assert.equal((await h.raw(href, { cookie: accountant.who })).status, 404)
    assert.equal((await h.raw(`${href}.csv`, { cookie: accountant.who })).status, 404)
    assert.equal((await h.raw(href, agent)).status, 403)
    assert.equal((await h.raw(`${href}.csv`, agent)).status, 403)
    if (who === owner) frozen = structuredClone(delivery)
  }
  await h.api('usage.submit', owner, { events: [event('RPT002-AFTER-SNAPSHOT', 'RPT002-PENDING', '1000')] })
  await payment('3.21', 'RPT002-AFTER-SNAPSHOT')
  const laterGrant = await h.api('prepaid.prepare', owner, { subscription: prepaid.subscription, mode: 'grant', kind: 'money', source: 'promotion', amount: '2', effective_date: `${period}-01`, expiry_consent: true })
  await h.api('prepaid.decide', finance.who, { request: laterGrant.request, decision: 'approved' })
  assert.equal((await read('unbilled')).totalCents, 2470)
  assert.equal((await read('collections')).totalCents, 5121)
  assert.equal((await read('credit-balances')).totalCents, 3821, 'INV-006: unallocated receipts across the installation now count')
  assert.deepEqual(await h.api(`report-deliveries/${frozen.id}`, owner), frozen, 'later rated usage and payments cannot rewrite a delivered report')
  assert.equal(await exportCsv(`/app/report-deliveries/${frozen.id}.csv`), frozen.csv)
  await save(finance.who, false)
  for (const [offset, status, outcome] of [[2, 400, 'rejected'], [3, 500, 'uncertain']]) {
    const begin = h.mails.length, month = monthAfter(period, offset)
    h.mailResponses.push({ status, body: { name: 'provider_error' } })
    await tick(`${month}-05T20:00:00Z`); await tick(`${month}-05T20:00:00Z`)
    assert.equal(h.mails.length, begin + 1, `${outcome} sends are claimed once and never retried`)
    const receipt = (await h.api('report-schedule', owner)).deliveries.find(row => row.period === monthAfter(month, -1))
    assert.ok(receipt); assert.equal(receipt.status, outcome); assert.equal(receipt.provider_ref, null)
    assert.equal((await h.api(`report-deliveries/${receipt.id}`, owner)).status, outcome)
  }
  await save(owner, initialSchedule.enabled, initialSchedule.day)
  for (const person of [finance, quiet, accountant]) await h.api('access.end', owner, { member: person.id })
  for (const key of [credential, ingestion]) await h.api('credential.revoke', owner, { key: key.id })
  await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: before.tax_jurisdiction, tax_mode: before.tax_mode, tax_rate: before.tax_rate, tax_note: before.tax_note })
  if (before.taxReady) await h.api('tax.review', owner, { revision: (await h.api('business', owner)).revision })
  console.log('RPT-002 financial source totals, scoped CSVs, ageing, self-only schedules and immutable delivery custody passed')
  return { customer: billed, pending, invoice: invoice.id, run: run.id, delivery: frozen.id }
}
