import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { populateErasureKinds } from './erasure-record-kinds.mjs'
import { file } from './harness.mjs'

const confirmation = mail => new URL(mail.text.match(/https?:\/\/[^\s]+\/erase\/[a-f0-9]+/)[0]).pathname
const fields = ['number', 'issue_date', 'subtotal_cents', 'tax_cents', 'total_cents', 'paidCents', 'balanceCents']

// PORT-005 inherits GOV-005 through the customer request door. Receipts remain
// operator records: approval withdraws customer sessions rather than extending
// their authority to let an erased customer read a receipt.
export async function portalPrivacyRetention(h, owner) {
  const previousClock = h.vars.NECTAR_LOCAL_TIME
  await h.advanceClock('2026-02-01T16:00:00Z')
  const api = (path, body, status) => h.api(path, owner, body, status)
  const make = async suffix => (await api('customer.create', {
    external_id: `PORT005-PRIVACY-${suffix}`, name: `Juniper ${suffix} Legal LLC`,
    billing_email: `${suffix.toLowerCase()}@portal-privacy.example`, address: `Private Juniper address ${suffix}`,
  })).id
  const issue = customer => api('portal.session.issue', { customer, origin: h.origin, audience: 'hosted' })
  const portal = (session, path = '/portal/data', options) => h.raw(`${path}?session=${encodeURIComponent(session.token)}`, options)
  const request = async session => {
    const before = await api('erasures'), mailCount = h.mails.length
    assert.equal((await portal(session, '/portal/privacy', { form: new URLSearchParams({ confirm: 'yes' }) })).status, 303)
    const saved = (await api('erasures')).find(row => !before.some(old => old.id === row.id))
    assert.ok(saved, 'PORT-005 customer form records one new privacy request')
    const mail = h.mails.slice(mailCount).find(message => String(message.text).includes('/erase/'))
    assert.ok(mail, 'PORT-005 customer request uses ordinary GOV-005 confirmation mail')
    return { saved, mail, path: confirmation(mail) }
  }
  const customer = await make('FORMER'), unrelated = await make('OTHER')
  const privateValues = ['private Juniper contact', 'contact@portal-privacy.example', 'private Juniper note', 'private Juniper metadata', 'private Juniper bank reference', 'private Juniper invoice line']
  await api('contact.add', { customer, name: privateValues[0], email: privateValues[1], role: 'billing' })
  await api('note.add', { kind: 'customer', record: customer, body: privateValues[2] })
  await api('metadata.write', { kind: 'customer', record: customer, revision: 0, metadata: { personal: privateValues[3] } })
  const charge = (await api('charge.add', { customer, amount: '120', description: privateValues[5], taxable: false, effective_date: '2026-01-05' })).charge
  const invoice = (await api('invoice.manual', { customer, charges: [charge], service_date: '2026-01-05' })).id
  await api('invoice.approve', { invoice, acknowledge: true })
  await api('invoice.finalise', { invoice, issue_date: '2026-01-05' })
  const payment = (await api('payment.record', { customer, amount: '120', received_on: '2026-01-20', method: 'bank_transfer', reference: privateValues[4], evidence: privateValues[1] })).payment
  await api('payment.allocate', { payment, invoice, amount: '120' })
  const rich = await populateErasureKinds(h, owner, customer)
  const before = await api(`customers/${customer}`), original = await api(`invoices/${invoice}`)
  privateValues.push(before.billing_email, before.address, before.external_id, ...rich.privateValues)
  const peer = await api(`customers/${unrelated}`), report = await api(`report-deliveries/${rich.report}`)
  const session = await issue(customer), peerSession = await issue(unrelated)
  const portalBefore = await (await portal(session)).json()
  assert.deepEqual(portalBefore.invoices.map(row => [row.total_cents, row.credited_cents, row.paid_cents, row.balance_cents]), [[12000, 0, 12000, 0]], 'PORT-005 populated customer sees exact pre-erasure financial facts')
  const { saved, mail, path } = await request(session)
  assert.equal(saved.customer_id, customer)
  assert.deepEqual(mail.to, [before.billing_email], 'PORT-005 verification recipient comes only from the on-file billing address')
  await api('erasure.approve', { request: saved.id, confirm: true }, 409)
  for (const method of ['GET', 'HEAD']) assert.equal((await h.raw(path, { method })).status, 200)
  assert.deepEqual(await api(`customers/${customer}`), before, 'PORT-005 requesting and reading confirmation erase nothing')
  assert.equal((await h.raw(path, { form: new URLSearchParams({ confirm: 'yes' }), headers: { origin: 'https://foreign.example' } })).status, 403)
  assert.equal((await h.raw(path, { form: new URLSearchParams({ confirm: 'yes' }) })).status, 200)
  assert.equal((await h.raw(path, { form: new URLSearchParams({ confirm: 'yes' }) })).status, 404)
  assert.deepEqual(await (await portal(session)).json(), portalBefore, 'PORT-005 verification leaves the complete customer projection unchanged')
  for (const [email, role] of [['privacy-finance@example.test', 'finance'], ['privacy-accountant@example.test', 'accountant']]) {
    await api('access.give', { email, name: `Privacy ${role}`, role })
    const who = await h.signIn(email, { requested: true })
    for (const action of ['approve', 'verify', 'purge']) await h.api(`erasure.${action}`, who, { request: saved.id, confirm: true }, 403)
  }
  const agent = { bearer: (await api('credential.issue', { name: 'Privacy request preparation', scopes: ['prepare'] })).key }
  await h.api('erasure.approve', agent, { request: saved.id, confirm: true }, 403)
  await api('erasure.approve', { request: saved.id }, 400)
  const approved = await api('erasure.approve', { request: saved.id, confirm: true })
  await api('erasure.approve', { request: saved.id, confirm: true }, 409)
  const receipt = approved.receipt
  for (const kind of ['nc_customers', 'nc_contacts', 'nc_notes', 'nc_metadata_revisions', 'nc_payments', 'nc_invoice_lines', 'nc_portal_sessions', ...rich.receiptKinds]) {
    assert.ok(receipt.changed.some(row => row.kind === kind && row.records > 0 && row.fields.length > 0), `PORT-005 receipt enumerates changed ${kind} fields and counts`)
  }
  assert.ok(receipt.importCustody.receiptId && receipt.importCustody.stores, 'PORT-005 receipt binds separate import custody')
  assert.equal(receipt.verification.method, 'billing-email')
  assert.equal(receipt.retained.until, '2033-01-20', 'PORT-005 latest payment controls seven-calendar-year retention')
  assert.equal(receipt.retained.legalLabels.issueSnapshots, 1)
  assert.equal(receipt.retained.legalLabels.legacyDisplayedLabels, 0)
  assert.match(receipt.archive, /Older archives are refused/)
  const retained = await api(`invoices/${invoice}`), erased = await api(`customers/${customer}`)
  for (const key of fields) assert.equal(retained[key], original[key], `PORT-005 retains exact financial ${key}`)
  assert.equal(retained.retainedFinancial.legal_name, before.name)
  assert.equal(retained.retainedFinancial.retain_until, receipt.retained.until)
  const frozen = await api(`report-deliveries/${rich.report}`)
  assert.deepEqual(frozen.reports.map(row => [row.metric, row.totalCents]), report.reports.map(row => [row.metric, row.totalCents]), 'PORT-005 erasure preserves frozen report totals')
  const projections = [erased, retained, frozen, await api('customers'), await api('payments'), await api(`notes/customer/${customer}`), await api(`metadata/customer/${customer}`), await api('audit')]
  for (const projection of projections) for (const value of privateValues) assert.ok(!JSON.stringify(projection).includes(value), 'PORT-005 ordinary API projections withdraw personal values')
  for (const path of [`/app/customers/${customer}`, '/app/customers', '/app/audit', '/app/erasures', '/app/exports/customers.csv', '/app/exports/invoices.csv']) {
    const response = await h.raw(path, { cookie: owner })
    assert.equal(response.status, 200)
    const text = (await response.text()).replaceAll('<wbr>', '')
    for (const value of [...privateValues, before.name]) assert.ok(!text.includes(value), `PORT-005 ${path} withdraws personal identity`)
  }
  await api(`proposals/${rich.sourceProposal}`, undefined, 410)
  assert.equal((await h.raw(rich.renewalPath)).status, 404)
  assert.equal((await portal(session)).status, 401)
  assert.equal((await portal(session, '/portal/privacy')).status, 401)
  await api('portal.session.issue', { customer, origin: h.origin, audience: 'hosted' }, 404)
  assert.equal((await portal(peerSession)).status, 200, 'PORT-005 another customer remains signed in')
  assert.deepEqual(await api(`customers/${unrelated}`), peer)
  await api('contact.add', { customer, name: 'Revived contact', email: before.billing_email }, 409)
  assert.deepEqual((await api('erasure.purge', {})).removed, [], 'PORT-005 retained evidence cannot be removed early')

  // A separate customer-originated request exercises the ordinary owner-only
  // evidence path and subsequent explicit manual removal.
  const alternate = await make('ALTERNATE'), alternateSession = await issue(alternate)
  const altCharge = (await api('charge.add', { customer: alternate, amount: '25', description: 'Retained alternate service', taxable: false, effective_date: '2026-02-09' })).charge
  const altInvoice = (await api('invoice.manual', { customer: alternate, charges: [altCharge], service_date: '2026-02-09' })).id
  await api('invoice.approve', { invoice: altInvoice, acknowledge: true })
  await api('invoice.finalise', { invoice: altInvoice, issue_date: '2026-02-09' })
  const credit = await api('credit.issue', { invoice: altInvoice, amount: '5', reason: 'Private alternate credit explanation' })
  const originalAlternate = await api(`invoices/${altInvoice}`)
  const alt = await request(alternateSession), evidence = 'Independent PORT-005 account ownership verification'
  await api('erasure.verify', { request: alt.saved.id, evidence: file('verification.txt', evidence) }, 400)
  await api('erasure.verify', { request: alt.saved.id, reason: 'Mailbox disputed' }, 400)
  await api('erasure.verify', { request: alt.saved.id, reason: 'Mailbox disputed; independently checked account ownership', evidence: file('verification.txt', evidence) })
  const evidencePath = `/app/erasures/${alt.saved.id}/evidence`
  assert.equal(await (await h.raw(evidencePath, { cookie: owner })).text(), evidence)
  const alternative = await api('erasure.approve', { request: alt.saved.id, confirm: true })
  assert.equal(alternative.receipt.retained.creditRecords, 1)
  assert.ok(alternative.receipt.changed.some(row => row.kind === 'nc_credit_notes' && row.records > 0))
  const retainedAlternate = await api(`invoices/${altInvoice}`)
  for (const key of fields) assert.equal(retainedAlternate[key], originalAlternate[key], `PORT-005 retains exact credited financial ${key}`)
  assert.equal(alternative.receipt.verification.evidence.sha256, createHash('sha256').update(evidence).digest('hex'))
  assert.equal(alternative.receipt.verification.evidence.bytes, Buffer.byteLength(evidence))
  assert.equal(alternative.receipt.verification.evidence.status, 'verification file withdrawn after erasure')
  assert.equal((await h.raw(evidencePath, { cookie: owner })).status, 404)
  assert.equal((await h.raw(alt.path)).status, 404)

  // The same portal-originated confirmation expires at the deadline and binds
  // the customer revision/email, even if the request came from a valid session.
  const staleCustomer = await make('STALE'), staleSession = await issue(staleCustomer)
  const stale = await request(staleSession), staleRecord = await api(`customers/${staleCustomer}`)
  await api('customer.update', { customer: staleCustomer, revision: staleRecord.revision, name: staleRecord.name, billing_email: 'replacement@portal-privacy.example', address: staleRecord.address })
  assert.equal((await h.raw(stale.path, { form: new URLSearchParams({ confirm: 'yes' }) })).status, 404)
  await api('erasure.approve', { request: stale.saved.id, confirm: true }, 409)
  const expiringCustomer = await make('EXPIRED'), expiring = await request(await issue(expiringCustomer))
  await h.advanceClock(new Date(expiring.saved.expires_at).toISOString())
  assert.equal((await h.raw(expiring.path)).status, 404, 'PORT-005 verification expires at the exact seven-day deadline')
  assert.equal((await h.raw(expiring.path, { form: new URLSearchParams({ confirm: 'yes' }) })).status, 404)
  assert.equal((await api(`customers/${expiringCustomer}`)).erased_at, null, 'PORT-005 expired verification erases nothing')

  await h.advanceClock('2033-01-19T16:00:00Z')
  assert.deepEqual((await api('erasure.purge', {})).removed, [])
  assert.equal((await h.raw(`/cdn-cgi/local/scheduled?time=${Date.parse('2033-01-20T16:00:00Z')}&cron=${encodeURIComponent('0 14 * * *')}`)).status, 200)
  await api(`invoices/${invoice}`, undefined, 404)
  assert.ok(!(await api('payments')).some(row => row.id === payment))
  const completed = JSON.parse((await api('erasures')).find(row => row.id === saved.id).receipt_json)
  assert.ok(completed.removal.retainedLegalIdentityRemoved)
  assert.ok(completed.removal.records.some(row => row.kind === 'nc_invoices' && row.records > 0))
  assert.deepEqual((await api('erasure.purge', {})).removed, [], 'PORT-005 daily financial removal occurs once')
  await h.advanceClock(`${alternative.receipt.retained.until}T16:00:00Z`)
  assert.ok((await api('erasure.purge', {})).removed.includes(alt.saved.id), 'PORT-005 owner manual sweep removes a second due financial group')
  await api(`invoices/${altInvoice}`, undefined, 404)
  assert.ok(!(await api(`customers/${alternate}`)).ledger.credits.some(row => row.id === credit.credit), 'PORT-005 due removal withdraws retained credit notes')
  const audit = await api('audit')
  for (const action of ['erasure.request', 'erasure.verify', 'erasure.complete', 'erasure.financial.remove']) assert.ok(audit.some(row => row.action === action && row.subject === saved.id), `PORT-005 audits ${action}`)
  await h.advanceClock(previousClock ?? new Date().toISOString())
  console.log('PORT-005 populated customer privacy, owner receipts, full redaction, financial retention and daily/manual removal passed')
}
