import assert from 'node:assert/strict'
import { applyPolicy } from './policy-helper.mjs'
import { publishPrice } from './price-helper.mjs'

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
  return rows
}

// CAT-003: signed terms, usage and issued bills through public HTTP only.
export async function commitments(h, owner) {
  await h.api('access.give', owner, { email: 'cat003-finance@example.test', name: 'Commitment Finance', role: 'finance' })
  const finance = await h.signIn('cat003-finance@example.test', { requested: true })
  await h.api('access.give', owner, { email: 'cat003-accountant@example.test', name: 'Commitment Accountant', role: 'accountant' })
  const accountant = await h.signIn('cat003-accountant@example.test', { requested: true })
  const credential = await h.api('credential.issue', owner, { name: 'CAT-003 contract preparation', scopes: ['prepare'] })
  const agent = { bearer: credential.key }
  const previous = await h.api('business', owner)
  await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: 'CA', tax_mode: 'flat_rate', tax_rate: '10', tax_note: 'CAT-003 commitment true-up tax example' })
  await h.api('tax.review', owner, { revision: (await h.api('business', owner)).revision })
  const api = (path, body, status) => h.api(path, owner, body, status)
  const read = subscription => api(`subscriptions/${subscription}`)
  const preview = (subscription, month) => api(`subscriptions/${subscription}/upcoming?period=${month}`)
  const customerFor = async suffix => (await api('customer.create', { external_id: `CAT003-${suffix}`, name: `CAT003 ${suffix}`, billing_email: 'ap@cat003.example' })).id
  const productFor = async suffix => (await api('product.create', { code: `cat003-${suffix}`, name: `CAT003 ${suffix}` })).id
  const flat = (await api('price.create', { product: await productFor('platform'), kind: 'flat', unit_amount: '1000', taxable: true })).id
  const seatsProduct = await productFor('seats')
  const seatTerms = { product: seatsProduct, kind: 'seat', taxable: true }
  const seats = []
  for (const amount of ['1000', '2000', '3000']) seats.push((await publishPrice(h, owner, { ...seatTerms, unit_amount: amount })).id)
  const meter = (await api('meter.create', { code: 'cat003-calls', name: 'CAT003 analysis calls', unit_label: 'calls' })).id
  const usage = (await api('price.create', { product: await productFor('calls'), kind: 'unit', meter, unit_amount: '2', taxable: true })).id
  const customer = await customerFor('THREE-YEAR')
  const subscription = (await api('subscription.create', { customer, start_date: '2020-01-01', anchor_day: 1, price: [flat, seats[0], usage], quantity: ['', '1', ''] })).id
  const original = await read(subscription)
  const item = original.items.find(row => row.price_id === seats[0]).id
  const terms = {
    commitments: [2020, 2021, 2022].map(year => ({ from: `${year}-01-01`, to: `${year + 1}-01-01`, minimum: '50000.00', taxable: true })),
    included: [{ price: usage, quantity: '100', from: '2020-01-01', to: '2023-01-01' }],
    ramps: [1, 2].map(index => ({ item, effective_date: `${2020 + index}-01-01`, price: seats[index], quantity: index + 1 })),
  }
  const prepared = await api('contract.prepare', { subscription, revision: original.revision, clause: 'Signed three-year order: $50,000 annual minimum before tax; 100 included calls monthly; seats ramp to two at $2,000 and three at $3,000 on each anniversary.', ...terms })
  assert.equal(prepared.id, subscription, 'CAT-003 preparation identifies the contracted subscription')
  const decide = (who, decision = 'approved', status = 200) => h.api('contract.decide', who, { contract: prepared.contract, decision }, status)
  await decide(owner, 'approved', 409)
  for (const who of [accountant, agent]) await decide(who, 'approved', 403)
  await decide(undefined, 'approved', 401)
  const pending = await read(subscription)
  assert.deepEqual(pending.items, original.items, 'CAT-003 preparation and refused approvals leave every plan item unchanged')
  assert.equal(pending.revision, original.revision, 'CAT-003 unapproved terms do not change the subscription revision')
  assert.equal(pending.contracts.find(row => row.id === prepared.contract).status, 'proposed', 'CAT-003 refused approvals leave signed terms proposed')
  assert.equal((await preview(subscription, '2021-01')).calculation.subtotalCents, 200000, 'CAT-003 unapproved ramps do not change a future bill')
  await decide(finance)
  await decide(finance, 'approved', 409)
  const approved = await read(subscription)
  const contract = approved.contracts.find(row => row.id === prepared.contract)
  assert.equal(contract.status, 'approved', 'CAT-003 a separate finance member approves all commercial terms')
  assert.equal(contract.prepared_by, (await api('me')).email, 'CAT-003 contract custody names the preparer')
  assert.equal(contract.decided_by, 'cat003-finance@example.test', 'CAT-003 contract custody names the separate approver')
  assert.equal(contract.terms.commitments.length, 3, 'CAT-003 all three annual minimum windows are retained')
  const audit = await api('audit')
  for (const [action, actor] of [['contract.prepare', contract.prepared_by], ['contract.approved', contract.decided_by]])
    assert.ok(audit.some(row => row.subject === prepared.contract && row.action === action && row.actor === actor), `CAT-003 ${action} audit preserves the responsible member`)
  assert.deepEqual(approved.items.filter(row => row.kind === 'seat').map(row => [row.price_id, Number(row.quantity), row.effective_from, row.effective_to]), [
    [seats[0], 1, '2020-01-01', '2021-01-01'], [seats[1], 2, '2021-01-01', '2022-01-01'], [seats[2], 3, '2022-01-01', null],
  ], 'CAT-003 approval atomically schedules exact immutable prices and quantities on both anniversary dates')
  for (const [kind, value] of [['discount_percent', '10'], ['fixed_credit', '100']]) {
    const amendment = await api('amendment.propose', { subscription, kind, value, effective_from: '2020-01-01', effective_to: '2023-01-01', clause: 'CAT-003 recurring discount and separate launch credit' })
    await api('amendment.decide', { amendment: amendment.amendment, decision: 'approved' })
  }
  await api('charge.add', { customer, subscription, amount: '500', description: 'CAT003 implementation fee', effective_date: '2020-01-01', taxable: true })
  const events = []
  for (let year = 2020; year <= 2022; year++) for (let month = 1; month <= 12; month++) {
    const period = `${year}-${String(month).padStart(2, '0')}`
    for (const [index, quantity] of ['90', year === 2020 ? '60' : year === 2021 ? '510' : '10'].entries()) events.push({
      event_id: `cat003-${period}-${index}`, customer: 'CAT003-THREE-YEAR', meter: 'cat003-calls', quantity, occurred_at: `${period}-15T12:${index ? '30' : '00'}:00Z`,
    })
  }
  assert.equal((await api('usage.submit', { events })).accepted, 72, 'CAT-003 all three years of independently identifiable usage enter through ingestion')
  const draftFor = async month => {
    const run = await api('billrun.prepare', { period: month })
    const invoice = (await api(`runs/${run.id}`)).invoices.find(row => row.customer_id === customer)
    assert.ok(invoice, `CAT-003 ${month} prepares the target subscription invoice`)
    return api(`invoices/${invoice.id}`)
  }
  // The final month alone is insufficient: omitted invoices cannot be assumed zero.
  const incomplete = await draftFor('2020-12')
  assert.ok(incomplete.exceptions.some(row => row.code === 'commitment_prior_periods'), 'CAT-003 final true-up reports missing earlier issued periods')
  await api('invoice.approve', { invoice: incomplete.id, acknowledge: true }, 409)
  const issue = async invoice => {
    await api('invoice.approve', { invoice: invoice.id, acknowledge: true })
    await api('invoice.finalise', { invoice: invoice.id, issue_date: invoice.period_end })
    return api(`invoices/${invoice.id}`)
  }
  const earnedKinds = new Set(['flat', 'seat', 'usage', 'late_usage', 'overage', 'discount', 'cancellation_credit'])
  const earned = invoice => invoice.lines.filter(row => earnedKinds.has(row.kind)).reduce((sum, row) => sum + row.amount_cents, 0)
  const trueUp = invoice => invoice.lines.filter(row => row.kind === 'commitment_trueup').reduce((sum, row) => sum + row.amount_cents, 0)
  const invoices = []
  for (let year = 2020; year <= 2022; year++) for (let month = 1; month <= 12; month++) {
    const period = `${year}-${String(month).padStart(2, '0')}`
    const invoice = await issue(await draftFor(period))
    invoices.push(invoice)
    const expectedEarned = year === 2020 ? 190000 + (month === 2 ? 2000 : 0) : year === 2021 ? 550000 : 900000
    const expectedTrueUp = year === 2020 && month === 12 ? 2718000 : 0
    assert.equal(invoice.status, 'issued', `CAT-003 ${period} reaches the issued ledger`)
    assert.equal(earned(invoice), expectedEarned, `CAT-003 ${period} earns the exact discounted ramp and overage amount`)
    assert.equal(trueUp(invoice), expectedTrueUp, `CAT-003 ${period} true-up belongs only to its own annual final period`)
    assert.equal(invoice.subtotal_cents, expectedEarned + expectedTrueUp + (year === 2020 && month === 1 ? 40000 : 0), `CAT-003 ${period} fee and fixed credit stay outside minimum consumption`)
    assert.equal(invoice.tax_cents, invoice.subtotal_cents / 10, `CAT-003 ${period} tax is calculated after minimum true-up`)
    assert.equal(invoice.total_cents, invoice.subtotal_cents + invoice.tax_cents, `CAT-003 ${period} issued total includes true-up tax`)
    const overage = invoice.lines.filter(row => row.price_id === usage && !row.evidence.late)
    assert.ok(overage.every(row => row.kind === 'overage'), `CAT-003 ${period} included usage retains explicit overage classification`)
    assert.equal(overage.reduce((sum, row) => sum + Number(row.evidence.rawQuantity), 0), year === 2020 ? 150 : year === 2021 ? 600 : 100, `CAT-003 ${period} overage evidence retains raw usage`)
    assert.equal(overage.reduce((sum, row) => sum + Number(row.evidence.includedQuantity), 0), 100, `CAT-003 ${period} allowance applies once across events and resets monthly`)
    assert.equal(overage.reduce((sum, row) => sum + Number(row.evidence.billableQuantity), 0), year === 2020 ? 50 : year === 2021 ? 500 : 0, `CAT-003 ${period} only usage above the allowance is billable`)
    const seatLine = invoice.lines.find(row => row.kind === 'seat')
    assert.equal(seatLine.price_id, seats[year - 2020], `CAT-003 ${period} uses its scheduled immutable seat price`)
    assert.equal(Number(seatLine.quantity), year - 2019, `CAT-003 ${period} uses its scheduled seat quantity`)
    const late = invoice.lines.filter(row => row.price_id === usage && row.evidence.late)
    assert.equal(late.length, year === 2020 && month === 2 ? 1 : 0, `CAT-003 ${period} bills late usage exactly once`)
    if (late.length) assert.deepEqual([Number(late[0].evidence.rawQuantity), Number(late[0].evidence.includedQuantity), Number(late[0].evidence.billableQuantity), late[0].amount_cents], [10, 0, 10, 2000], 'CAT-003 late January usage cannot reuse its already exhausted monthly allowance')
    if (year === 2020 && month === 1) {
      await api('usage.submit', { events: [{ event_id: 'cat003-late-january', customer: 'CAT003-THREE-YEAR', meter: 'cat003-calls', quantity: '10', occurred_at: '2020-01-16T12:00:00Z' }] })
      assert.deepEqual((await api(`invoices/${invoice.id}`)).calculation, invoice.calculation, 'CAT-003 late usage preserves the original issued calculation')
    }
  }
  const frozen = invoices[11].calculation
  const state = await read(subscription)
  const burnDown = state.burnDown.filter(row => row.contract === prepared.contract)
  assert.equal(burnDown.length, 3, 'CAT-003 operator burn-down retains each annual window separately')
  for (let year = 2020; year <= 2022; year++) {
    const window = burnDown.find(row => row.from === `${year}-01-01`)
    const issued = invoices.filter(invoice => invoice.period_start.startsWith(String(year)))
    const earnedCents = issued.reduce((sum, invoice) => sum + earned(invoice), 0)
    const trueUpCents = issued.reduce((sum, invoice) => sum + trueUp(invoice), 0)
    assert.deepEqual([window.to, window.minimumCents, window.earnedCents, window.trueUpCents, window.billedCents, window.remainingCents], [`${year + 1}-01-01`, 5000000, earnedCents, trueUpCents, earnedCents + trueUpCents, 0], `CAT-003 ${year} burn-down ties to issued eligible earnings and shortfall, before tax`)
    assert.equal(window.invoices.length, 12, `CAT-003 ${year} burn-down links every monthly issued invoice once`)
    for (const invoice of issued) assert.deepEqual(window.invoices.find(row => row.id === invoice.id), { id: invoice.id, number: invoice.number, earnedCents: earned(invoice), trueUpCents: trueUp(invoice) }, `CAT-003 ${invoice.number} burn-down drilldown reconciles to the issued lines`)
  }
  assert.deepEqual((await api(`invoices/${invoices[11].id}`)).calculation, frozen, 'CAT-003 later ramps and true-ups preserve year-one issued calculation evidence')
  const operatorHtml = await h.page(`/app/subscriptions/${subscription}`, accountant)
  assert.ok(operatorHtml.includes(invoices[11].number), 'CAT-003 accountant subscription view exposes issued-invoice burn-down drilldown')
  const quantityOnly = await api('contract.prepare', { subscription, revision: state.revision, clause: 'CAT-003 proposed fourth seat from January 2023.', commitments: [], included: [], ramps: [{ item: state.items.find(row => row.price_id === seats[2]).id, effective_date: '2023-01-01', price: seats[2], quantity: 4 }] })
  await api('contract.decide', { contract: quantityOnly.contract, decision: 'approved' }, 409)
  await h.api('contract.decide', finance, { contract: quantityOnly.contract, decision: 'rejected' })
  const rejected = await read(subscription)
  assert.equal(rejected.contracts.find(row => row.id === quantityOnly.contract).status, 'rejected', 'CAT-003 a quantity-only contract also requires another member and records rejection')
  assert.deepEqual(rejected.items, state.items, 'CAT-003 rejecting a quantity-only ramp preserves the approved plan schedule')
  assert.equal(rejected.revision, state.revision, 'CAT-003 rejected terms preserve the live subscription revision')
  const exported = await h.raw('/app/exports/subscriptions.csv', { cookie: accountant })
  assert.equal(exported.status, 200, 'CAT-003 accountant exports signed terms and minimum consumption')
  const [columns, ...rows] = csvRows(await exported.text())
  const exportedRows = rows.filter(row => row[columns.indexOf('subscription_id')] === subscription)
  assert.equal(exportedRows.length, state.items.length, 'CAT-003 subscription export retains every scheduled plan segment')
  for (const row of exportedRows) {
    assert.deepEqual(JSON.parse(row[columns.indexOf('contracts_json')]), rejected.contracts, 'CAT-003 CSV preserves exact approved and rejected signed terms with custody')
    assert.deepEqual(JSON.parse(row[columns.indexOf('commitment_burn_down_json')]), rejected.burnDown, 'CAT-003 CSV burn-down preserves exact issued invoice references and amounts')
  }

  // A monthly minimum uses active service days, independently of annual terms.
  const daily = (await api('price.create', { product: await productFor('active-days'), kind: 'flat', unit_amount: '31', taxable: true })).id
  const activeCases = []
  for (const [kind, activeDays] of [['trial', 15], ['pause', 21], ['cancel', 15]]) {
    const caseCustomer = await customerFor(kind.toUpperCase())
    const id = (await api('subscription.create', { customer: caseCustomer, start_date: '2023-10-01', price: [daily], ...(kind === 'trial' ? { trial_end: '2023-10-17' } : {}) })).id
    const request = await api('contract.prepare', { subscription: id, revision: (await read(id)).revision, clause: 'CAT-003 minimum $310 for October, reduced by inactive service days.', commitments: [{ from: '2023-10-01', to: '2023-11-01', minimum: '310', taxable: true }], included: [], ramps: [] })
    await h.api('contract.decide', finance, { contract: request.contract, decision: 'approved' })
    if (kind !== 'trial') await api(`subscription.${kind === 'cancel' ? 'cancel' : 'pause'}`, { subscription: id, revision: (await read(id)).revision, effective_date: kind === 'cancel' ? '2023-10-16' : '2023-10-11', reason: 'CAT-003 active-day minimum proof', ...(kind === 'cancel' ? { mode: 'immediate' } : { resume_date: '2023-10-21', access: 'retain' }) })
    activeCases.push({ id, customer: caseCustomer, contract: request.contract, kind, activeDays })
  }
  const run = await api('billrun.prepare', { period: '2023-10' })
  const drafts = (await api(`runs/${run.id}`)).invoices
  for (const entry of activeCases) {
    const draft = drafts.find(row => row.customer_id === entry.customer)
    assert.ok(draft, `CAT-003 ${entry.kind} prepares a monthly commitment invoice`)
    const invoice = await issue(await api(`invoices/${draft.id}`))
    assert.equal(earned(invoice), entry.activeDays * 100, `CAT-003 ${entry.kind} earns only active service days`)
    assert.equal(trueUp(invoice), entry.activeDays * 900, `CAT-003 ${entry.kind} true-up excludes inactive-day minimum`)
    assert.equal(invoice.subtotal_cents, entry.activeDays * 1000, `CAT-003 ${entry.kind} monthly minimum is prorated before tax`)
    const window = (await read(entry.id)).burnDown.find(row => row.contract === entry.contract)
    assert.equal(window.minimumCents, entry.activeDays * 1000, `CAT-003 ${entry.kind} burn-down shows the same reduced minimum as the invoice`)
  }
  await api('credential.revoke', { key: credential.id })
  await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: previous.tax_jurisdiction, tax_mode: previous.tax_mode, tax_rate: previous.tax_rate, tax_note: previous.tax_note })
  if (previous.taxReady) await h.api('tax.review', owner, { revision: (await api('business')).revision })
  console.log('CAT-003 three-year annual minimum, overages/late allowance, price/quantity ramps, separate approval/rejection, audit/export, prior-period guard, active-day minimum and issued burn-down passed')
  return { customer, subscription, contract: prepared.contract, invoices: invoices.map(invoice => invoice.id) }
}
