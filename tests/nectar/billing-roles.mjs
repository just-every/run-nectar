// GOV-001: billing roles through the public doors. Each preset role and an
// owner-defined custom role is crawled across every action, JSON door and page
// as NEC-15 does, against expectations written here from ct's approved matrix
// (20 Oct 16:55Z); support credits stop at the owner-set limit; a custom role
// change applies on the member's next request; support notes, INT-003 alerts,
// DEV-005 metadata and AGENT-007 answers follow the member's current authority.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { API_DOORS, PAGE_DOORS } from '../../src/nectar/doors.ts'
import { totp } from './mfa.mjs'
import { applyPolicy } from './policy-helper.mjs'

const ACTIONS = [...(await readFile(new URL('../../src/nectar/actions.ts', import.meta.url), 'utf8')).matchAll(/^  '([\w.]+)':/gm)].map(match => match[1])
// Every member manages their own factor and email choices (GOV-007, INT-003).
const OWN = name => (name.startsWith('mfa.') && !['mfa.policy', 'mfa.reset'].includes(name)) || name === 'notification.preferences'
// Probes name a record kind or metric where a door's pattern needs one, so the family check decides.
const API_PROBE = { notes: 'notes/payment/none', metadata: 'metadata/price/none', metadataObjects: 'objects/customer', report: 'reports/billings', reportInvoice: 'reports/billings/none', reportLine: 'invoices/none/lines/none' }
const PAGE_PROBE = { metadata: '/app/metadata/price/none', report: '/app/reports/billings', reportInvoice: '/app/reports/billings/none', reportCsv: '/app/exports/reports/billings.csv', metadataCsv: '/app/exports/objects/customer.csv', reportLine: '/app/invoices/none/lines/none' }
const fill = pattern => pattern.replace(/^\^|\$$/g, '').replace(/\(\[[^)]*\]\+\)/g, 'none').replace(/\\\./g, '.')

const READ_ALL_API = API_DOORS.map(([, name]) => name).filter(name => !['members', 'roles', 'imports', 'audit', 'reportSchedule', 'reportDelivery', 'noteMembers','billingEntities'].includes(name))
const READ_ALL_PAGES = PAGE_DOORS.map(([, name]) => name).filter(name => !['revenueJournalCsv', 'numberRegisterCsv', 'erasureEvidence', 'revenueCsv', 'reportSchedule', 'reportDelivery', 'reportDeliveryCsv', 'reportCsv', 'metadataCsv', 'runFile', 'import', 'exports', 'customersFile', 'invoicesFile', 'usageFile', 'subscriptionsFile', 'audit', 'noticeFile','importOriginals'].includes(name))
const COMMON = { api: ['openapi', 'me', 'notifications', 'mfa'], pages: ['home', 'more', 'security', 'passkeyScript'] }
const EXPECTED = {
  collections: {
    actions: ['payment.record', 'payment.allocate', 'reminder.prepare', 'reminder.approve', 'reminder.discard', 'task.create', 'task.complete', 'cadence.enroll', 'cadence.promise', 'cadence.dispute', 'cadence.resolve', 'cadence.approve', 'cadence.run', 'note.add', 'answer.read'],
    api: ['numberRegister', 'customers', 'customer', 'invoices', 'invoice', 'ageing', 'payments', 'notices', 'tasks', 'notes', 'noteMembers', 'entitlement', 'reportLine', 'cadences', 'metadataObjects'],
    pages: ['numberRegister', 'customers', 'customer', 'certificateFile', 'invoice', 'receivables', 'noticeFile', 'cadences', 'billingAnswers', 'reportLine', 'metadataList'],
  },
  sales: {
    actions: ['change.prepare', 'amendment.propose', 'contract.prepare'],
    api: ['customers', 'customer', 'catalog', 'subscription', 'upcoming', 'entitlement', 'metadata', 'metadataObjects'],
    pages: ['customers', 'customer', 'certificateFile', 'catalog', 'subscription', 'metadata', 'metadataList'],
  },
  support: {
    actions: ['note.add', 'credit.issue', 'answer.read'],
    api: ['numberRegister', 'customers', 'customer', 'invoices', 'invoice', 'ageing', 'payments', 'notes', 'noteMembers', 'entitlement', 'subscription', 'upcoming', 'reportLine', 'metadataObjects'],
    pages: ['numberRegister', 'customers', 'customer', 'certificateFile', 'subscription', 'invoice', 'receivables', 'billingAnswers', 'reportLine', 'metadataList'],
  },
  developer: {
    actions: ['credential.issue', 'credential.revoke', 'credential.version', 'answer.read', 'meter.preview', 'usage.correction.preview'],
    api: READ_ALL_API, pages: READ_ALL_PAGES,
  },
  analyst: {
    actions: ['report.schedule'],
    api: ['customers', 'customer', 'entitlement', 'metadataObjects', 'report', 'reportInvoice', 'reportLine', 'revenue', 'revenueJournal', 'revenueSource', 'reportSchedule', 'reportDelivery'],
    pages: ['customers', 'customer', 'certificateFile', 'metadataList', 'metadataCsv', 'revenue', 'revenueSource', 'revenueCsv', 'revenueJournalCsv', 'reportSchedule', 'reportDelivery', 'reportDeliveryCsv', 'reportCsv', 'report', 'reportInvoice', 'reportLine', 'exports', 'customersFile'],
  },
}

/** What a signed-in member actually reaches: anything but 403 counts as reached. */
async function reach(h, who) {
  const found = { actions: [], api: [], pages: [] }
  for (const name of ACTIONS.filter(name => !OWN(name))) {
    const response = await h.raw(`/api/nectar/${name}`, { cookie: who, body: {} })
    const text = await response.text()
    assert.ok(response.status < 500 && response.status !== 401, `${name}: ${response.status} ${text.slice(0, 200)}`)
    if (response.status !== 403) found.actions.push(name)
    else assert.match(JSON.parse(text).error, /^(forbidden|owner_required|person_required)$/, `${name} refused for its role, not its input`)
  }
  for (const [pattern, name] of API_DOORS) {
    const response = await h.raw(`/api/nectar/${API_PROBE[name] ?? fill(pattern)}`, { cookie: who })
    await response.text()
    assert.ok(response.status < 500 && response.status !== 401, `${name}: ${response.status}`)
    if (response.status !== 403) found.api.push(name)
  }
  for (const [pattern, name] of PAGE_DOORS) {
    const response = await h.raw(PAGE_PROBE[name] ?? fill(pattern), { cookie: who })
    await response.text()
    assert.ok(response.status < 500 && response.status !== 401, `${name}: ${response.status}`)
    if (response.status !== 403) found.pages.push(name)
  }
  return found
}

// Real records, so a page that composes several reads cannot hide behind a placeholder's 404.
const FAMILIES = { collections: ['customers', 'invoices', 'payments'], sales: ['customers', 'catalog', 'subscriptions'], support: ['customers', 'subscriptions', 'invoices', 'payments'],
  developer: ['customers', 'catalog', 'subscriptions', 'invoices', 'payments', 'reports'], analyst: ['customers', 'reports'] }
const recordDoors = ids => [
  [`/api/nectar/customers/${ids.customer}`, ['customers']], [`/app/customers/${ids.customer}`, ['customers']],
  [`/api/nectar/subscriptions/${ids.subscription}`, ['subscriptions']], [`/app/subscriptions/${ids.subscription}`, ['subscriptions']], [`/api/nectar/subscriptions/${ids.subscription}/upcoming`, ['subscriptions']],
  [`/api/nectar/invoices/${ids.invoice}`, ['invoices']], [`/app/invoices/${ids.invoice}`, ['invoices']], ['/api/nectar/payments', ['payments']], [`/api/nectar/notes/payment/${ids.payment}`, ['payments']],
  [`/api/nectar/metadata/invoice/${ids.invoice}`, ['invoices']], ['/api/nectar/catalog', ['catalog']], ['/app/catalog', ['catalog']],
  ['/api/nectar/number-register', ['invoices']], ['/app/numbering', ['invoices']],
  ['/app/reports/billings', ['reports']], ['/app/revenue', ['reports']], ['/app/receivables', ['customers', 'invoices', 'payments']],
  [`/api/nectar/reports/billings/${ids.invoice}?period=2026-09`, ['reports']], [`/app/reports/billings/${ids.invoice}?period=2026-09`, ['reports']],
]
async function assertRecords(h, who, role, ids) {
  for (const [path, needs] of recordDoors(ids)) {
    const response = await h.raw(path, { cookie: who })
    await response.text()
    assert.ok(response.status < 500 && response.status !== 401, `${path}: ${response.status}`)
    assert.equal(response.status !== 403, needs.every(family => FAMILIES[role].includes(family)), `GOV-001 ${role} on a real record ${path}: ${response.status}`)
  }
}

/** Every link a member is shown opens for them: pages reached from Home never point at a refused door. */
async function assertLinksOpen(h, who, role) {
  const seen = new Set(), queue = ['/app']
  while (queue.length && seen.size < 40) {
    const path = queue.shift()
    if (seen.has(path)) continue
    seen.add(path)
    const response = await h.raw(path, { cookie: who })
    const text = await response.text()
    if (response.status !== 200 || !(response.headers.get('content-type') ?? '').includes('text/html')) continue
    for (const [, href] of text.matchAll(/href="(\/app[^"#]*)/g)) {
      const link = href.replaceAll('&amp;', '&')
      if (link.startsWith('/app/do/') || seen.has(link)) continue
      const opened = await h.raw(link, { cookie: who })
      await opened.text()
      assert.notEqual(opened.status, 403, `GOV-001 ${role} is shown ${link} on ${path} but may not open it`)
      if (opened.status === 200 && !queue.includes(link)) queue.push(link)
    }
  }
}

async function assertReach(h, who, role, expected) {
  const found = await reach(h, who)
  const want = { actions: expected.actions, api: [...new Set([...COMMON.api, ...expected.api])], pages: [...new Set([...COMMON.pages, ...expected.pages])] }
  for (const kind of ['actions', 'api', 'pages']) assert.deepEqual(found[kind].toSorted(), want[kind].toSorted(), `GOV-001 ${role} reaches exactly its ${kind}`)
}

export async function billingRolesFlow(h, owner) {
  // Two customers with issued invoices and a recorded payment, all by the owner.
  const customer = async (id, name, email) => (await h.api('customer.create', owner, { external_id: id, name, billing_email: email })).id
  const alder = await customer('GOV001-ALDER', 'Alder Robotics', 'ap@alder.example'), birch = await customer('GOV001-BIRCH', 'Birch Labs', 'ap@birch.example')
  const product = (await h.api('product.create', owner, { code: 'gov001-plan', name: 'Roles plan' })).id
  const price = (await h.api('price.create', owner, { product, kind: 'flat', unit_amount: '2000', taxable: false })).id
  const subscriptions = {}
  for (const id of [alder, birch]) subscriptions[id] = (await h.api('subscription.create', owner, { customer: id, start_date: '2026-08-01', price: [price] })).id
  const run = (await h.api('billrun.prepare', owner, { period: '2026-08' })).id
  const drafts = (await h.api(`runs/${run}`, owner)).invoices
  for (const invoice of drafts) {
    await h.api('invoice.approve', owner, { invoice: invoice.id, acknowledge: true })
    await h.api('invoice.finalise', owner, { invoice: invoice.id, issue_date: invoice.period_end })
  }
  const invoiceOf = id => drafts.find(invoice => invoice.customer_id === id).id
  const payment = (await h.api('payment.record', owner, { customer: alder, amount: '700.00', received_on: '2026-09-02', method: 'bank_transfer', reference: 'GOV001-WIRE-1' })).payment

  // Preset roles, given by the owner through ordinary invitations.
  const people = { finance: 'gov001-finance@example.test', collections: 'gov001-collections@example.test', sales: 'gov001-sales@example.test', support: 'gov001-support@example.test', developer: 'gov001-developer@example.test' }
  for (const [role, email] of Object.entries(people)) await h.api('access.give', owner, { email, name: `${role[0].toUpperCase()}${role.slice(1)} Member`, role })
  const who = {}
  for (const [role, email] of Object.entries(people)) who[role] = await h.signIn(email, { requested: true })
  const member = async email => (await h.api('members', owner)).find(m => m.email === email)
  const records = { customer: alder, subscription: subscriptions[alder], invoice: invoiceOf(alder), payment }
  for (const role of ['collections', 'sales', 'support', 'developer']) {
    assert.equal((await h.api('me', who[role])).role, role)
    await assertReach(h, who[role], role, EXPECTED[role])
    await assertRecords(h, who[role], role, records)
    if (role !== 'developer') await assertLinksOpen(h, who[role], role)
  }

  // Support credits: zero until the owner sets a limit, then $500 passes and $600 is refused.
  const credit = amount => ({ invoice: invoiceOf(birch), amount, reason: 'Goodwill for a support outage' })
  assert.equal((await h.api('credit.issue', who.support, credit('1.00'), 403)).error, 'exceeds_support_limit', 'GOV-001 the default support limit is zero')
  assert.equal((await h.api('policies/current', owner)).supportLimitCents, 0)
  await applyPolicy(h, owner, 'credit.policy', { support_limit: '500.00' })
  assert.equal((await h.api('policies/current', owner)).supportLimitCents, 50000)
  const issued = await h.api('credit.issue', who.support, credit('500.00'))
  assert.match(issued.number, /-CN-/)
  assert.equal((await h.api('credit.issue', who.support, credit('600.00'), 403)).error, 'exceeds_support_limit')
  assert.equal((await h.api('credit.issue', who.support, credit('500.01'), 403)).error, 'exceeds_support_limit')
  const birchInvoice = await h.api(`invoices/${invoiceOf(birch)}`, owner)
  assert.equal(birchInvoice.creditedCents, 50000, 'only the $500 support credit reached the invoice')
  assert.equal(birchInvoice.balanceCents, birchInvoice.total_cents - 50000)
  await h.api('credit.prepare', who.support, credit('100.00'), 403)
  await h.api('credit.issue', who.collections, credit('10.00'), 403)
  const supportAudit = (await h.api('audit', owner)).find(row => row.action === 'credit.issue' && row.subject === issued.credit)
  assert.equal(supportAudit.actor, people.support)

  // Support notes on a payment: one permitted email, visible on the customer and its export, never edited.
  const financeMember = await member(people.finance)
  let start = h.mails.length
  const note = await h.api('note.add', who.support, { kind: 'payment', record: payment, body: 'Customer says this wire covers August; confirm with the bank.', mention: [financeMember.id] })
  const mentionMails = h.mails.slice(start)
  assert.deepEqual(mentionMails.map(mail => [mail.to].flat().join()), [people.finance])
  assert.match(mentionMails[0].subject, /payment GOV001-WIRE-1/)
  const alderRecord = await h.api(`customers/${alder}`, who.support)
  assert.ok(alderRecord.notes.some(n => n.id === note.note && n.author === people.support && n.kind === 'payment'))
  assert.match(await (await h.raw('/app/exports/customers.csv', { cookie: owner })).text(), /confirm with the bank/)
  await h.api('note.edit', who.support, { note: note.note, body: 'Changed' }, 404)
  const followUp = await h.api('note.add', who.support, { kind: 'payment', record: payment, body: 'Follow-up: bank confirmed the wire.', mention: [] })
  const notes = await h.api(`notes/payment/${payment}`, owner)
  assert.deepEqual(notes.map(n => n.body), ['Customer says this wire covers August; confirm with the bank.', 'Follow-up: bank confirmed the wire.'])
  assert.ok((await h.api('audit', owner)).some(row => row.action === 'note.add' && row.subject === followUp.note && row.actor === people.support))
  await h.api('note.add', who.sales, { kind: 'payment', record: payment, body: 'Sales cannot read payments', mention: [] }, 403)
  // A mention is permitted only for a colleague who can read the noted record; nothing is saved or sent otherwise.
  start = h.mails.length
  const salesMember = await member(people.sales)
  assert.equal((await h.api('note.add', who.support, { kind: 'payment', record: payment, body: 'Not for sales', mention: [financeMember.id, salesMember.id] }, 400)).error, 'mention_member_not_permitted')
  assert.equal(h.mails.length, start)
  assert.equal((await h.api(`notes/payment/${payment}`, owner)).length, 2)

  // A custom "Billing analyst": read customers, read reports and export, exactly.
  const analystRole = await h.api('role.define', owner, { name: 'Billing analyst', capabilities: ['read.customers', 'read.reports', 'export'] })
  await h.api('role.define', owner, { name: 'Overreach', capabilities: ['read.customers', 'approve'] }, 400)
  await h.api('role.define', who.developer, { name: 'Self-made', capabilities: ['read.customers'] }, 403)
  await h.api('access.give', owner, { email: 'gov001-analyst@example.test', name: 'Avery Analyst', role: 'custom', custom_role: analystRole.id })
  who.analyst = await h.signIn('gov001-analyst@example.test', { requested: true })
  const me = await h.api('me', who.analyst)
  assert.equal(me.role_name, 'Billing analyst'); assert.deepEqual(me.capabilities.toSorted(), ['export', 'read.customers', 'read.reports'])
  await assertReach(h, who.analyst, 'Billing analyst', EXPECTED.analyst)
  await assertRecords(h, who.analyst, 'analyst', records)
  await assertLinksOpen(h, who.analyst, 'Billing analyst')
  assert.match(await h.page(`/app/reports/billings/${invoiceOf(alder)}?period=2026-09`, who.analyst), /\$2,000\.00/, 'GOV-001 a report reader drills a figure to its source invoice')
  assert.match(await (await h.raw('/app/exports/customers.csv', { cookie: who.analyst })).text(), /Alder Robotics/)
  // Removing export applies on the next request, without signing out.
  await h.api('role.update', owner, { role: analystRole.id, revision: 1, capabilities: ['read.customers', 'read.reports'] })
  assert.equal((await h.raw('/app/exports/customers.csv', { cookie: who.analyst })).status, 403)
  assert.equal((await h.raw('/app/reports/billings', { cookie: who.analyst })).status, 200)
  await h.api('role.update', owner, { role: analystRole.id, revision: 1, capabilities: ['read.customers'] }, 409)

  // INT-003: opting in grants nothing; alerts follow current read and action authority.
  const cashRole = await h.api('role.define', owner, { name: 'Cash desk', capabilities: ['read.customers', 'read.payments', 'receivables'] })
  await h.api('access.give', owner, { email: 'gov001-cash@example.test', name: 'Casey Cash', role: 'custom', custom_role: cashRole.id })
  who.cash = await h.signIn('gov001-cash@example.test', { requested: true })
  const allOn = { mentions: true, payment_mismatch: true, billrun_exceptions: true, proposals: true }
  for (const person of ['analyst', 'cash', 'support']) await h.api('notification.preferences', who[person], allOn)
  const mismatch = async reference => (await h.api('payment.record', owner, { customer: alder, amount: '13.13', received_on: '2026-09-03', method: 'check', reference })).payment
  const alerted = async (person, subject) => (await h.api('notifications', who[person])).deliveries.filter(row => row.event === 'payment_mismatch' && row.subject === subject)
  start = h.mails.length
  const first = await mismatch('GOV001-CHK-1')
  assert.equal((await alerted('cash', first)).length, 1, 'GOV-001 a custom role with payment read and receivables gets the alert')
  assert.equal((await alerted('analyst', first)).length, 0, 'GOV-001 no receivables authority, no alert despite opting in')
  assert.equal((await alerted('support', first)).length, 0, 'GOV-001 support cannot act on receivables, so no alert')
  assert.deepEqual(h.mails.slice(start).map(mail => [mail.to].flat().join()), ['gov001-cash@example.test'])
  await h.api('role.update', owner, { role: cashRole.id, revision: 1, capabilities: ['read.customers', 'read.payments'] })
  start = h.mails.length
  const second = await mismatch('GOV001-CHK-2')
  assert.equal((await alerted('cash', second)).length, 0, 'GOV-001 removed authority takes effect before the next send')
  assert.equal(h.mails.slice(start).length, 0)

  // DEV-005 metadata follows the underlying record families, rechecked on each request.
  assert.equal((await h.api(`metadata/customer/${alder}`, who.analyst)).id, alder)
  await h.api(`metadata/invoice/${invoiceOf(alder)}`, who.analyst, undefined, 403)
  await h.api(`metadata/payment/${payment}`, who.cash)
  await h.api('metadata.write', who.cash, { kind: 'payment', record: payment, revision: 0, metadata: { batch: 'B-1' } }, 403)
  await h.api(`metadata/price/${price}`, who.sales)
  await h.api(`metadata/invoice/${invoiceOf(alder)}`, who.sales, undefined, 403)
  await h.api('role.update', owner, { role: analystRole.id, revision: 2, capabilities: ['read.reports'] })
  await h.api(`metadata/customer/${alder}`, who.analyst, undefined, 403)
  await h.api(`customers/${alder}`, who.analyst, undefined, 403)

  // AGENT-007 answers cite only sources the reader may open; suggestions need propose and never approve.
  const question = { customer: alder, invoice: invoiceOf(alder), question: 'What is the invoice total?' }
  const answered = await h.api('answer.read', who.support, question)
  assert.equal(answered.invoiceId, invoiceOf(alder))
  assert.ok(answered.figures.some(figure => figure.value === 200000 || figure.value === '2000.00'), JSON.stringify(answered.figures))
  await h.api('answer.read', who.sales, question, 403)
  await h.api('answer.read', who.analyst, question, 403)
  const suggestion = { customer: alder, invoice: invoiceOf(alder), question: 'What is still owed?', topic: 'balance', credit_amount: '12.34', reason: 'Review a disputed service charge' }
  await h.api('answer.propose', who.support, suggestion, 403)
  const proposerRole = await h.api('role.define', owner, { name: 'Answer desk', capabilities: ['read.customers', 'read.invoices', 'propose'] })
  await h.api('access.give', owner, { email: 'gov001-answers@example.test', name: 'Ari Answers', role: 'custom', custom_role: proposerRole.id })
  who.answers = await h.signIn('gov001-answers@example.test', { requested: true })
  const proposal = await h.api('answer.propose', who.answers, suggestion)
  assert.equal((await h.api(`proposals/${proposal.id}`, owner)).status, 'pending')
  await h.api('proposal.decide', who.answers, { proposal: proposal.id, decision: 'approved' }, 403)
  await h.api('proposal.create', who.answers, { kind: 'collection', title: 'Not through the general door', payload: { customer: alder } }, 403)
  await h.api('role.update', owner, { role: proposerRole.id, revision: 1, capabilities: ['read.customers', 'propose'] })
  await h.api('answer.read', who.answers, question, 403)
  await h.api('answer.propose', who.answers, suggestion, 403)
  assert.equal((await h.api(`proposals/${proposal.id}`, owner)).status, 'pending', 'GOV-001 a suggestion never approves itself')

  // GOV-007 inheritance: changing the support limit asks for a fresh factor; credits within it do not.
  let clock = Date.now()
  const at = async ms => { clock = ms; await h.advanceClock(new Date(ms).toISOString()) }
  await at(clock)
  await h.api('mfa.policy', owner, { scope: 'roles', roles: ['owner', 'support'] })
  const enroll = async person => { const started = await h.api('mfa.totp.start', person, {}); await h.api('mfa.totp.confirm', person, { factor: started.factor, code: totp(started.secret, clock) }); return started.secret }
  const ownerSecret = await enroll(owner)
  await enroll(who.support)
  await at(clock + 20 * 60 * 1000)
  assert.ok((await h.api('credit.issue', who.support, credit('5.00'))).credit, 'GOV-007 a credit within the support limit does not ask again')
  assert.equal((await h.api('credit.policy', owner, { support_limit: '750.00' }, 403)).error, 'mfa_step_up_required', 'GOV-001 the support limit inherits the GOV-007 step-up')
  assert.equal((await h.api('policies/current', owner)).supportLimitCents, 50000)
  await h.api('mfa.verify', owner, { code: totp(ownerSecret, clock) })
  const raised = await h.api('credit.policy', owner, { support_limit: '750.00' })
  await h.api('policy.decide', who.finance, { request: raised.request, decision: 'approved' })
  assert.equal((await h.api('policies/current', owner)).supportLimitCents, 75000)
  // "Chosen roles" now defaults to every role that can credit or manage credentials.
  assert.deepEqual((await h.api('mfa.policy', owner, { scope: 'roles' })).roles, ['developer', 'finance', 'owner', 'support'])
  console.log('GOV-001 preset and custom roles reach exactly their capabilities, support credit limit, next-request revocation, notes, alerts, metadata and answers passed')
}
