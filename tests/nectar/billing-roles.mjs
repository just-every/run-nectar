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
const API_PROBE = { periodCloses: 'period-closes', customerBalance: 'customers/none/balance', notes: 'notes/payment/none', metadata: 'metadata/price/none', metadataObjects: 'objects/customer', report: 'reports/billings', reportInvoice: 'reports/billings/none', reportLine: 'invoices/none/lines/none', prepaid:'prepaid/none', prepaidSource:'prepaid/none/entries/none' }
const PAGE_PROBE = { prepaid:'/app/prepaid/none', prepaidSource:'/app/prepaid/none/entries/none', prepaidCsv:'/app/exports/prepaid/none.csv', importOriginals:'/app/import/none/originals/'+ '0'.repeat(64), metadata: '/app/metadata/price/none', report: '/app/reports/billings', reportInvoice: '/app/reports/billings/none', reportCsv: '/app/exports/reports/billings.csv', metadataCsv: '/app/exports/objects/customer.csv', reportLine: '/app/invoices/none/lines/none' }
const fill = pattern => pattern.replace(/^\^|\$$/g, '').replace(/\(\[[^)]*\]\+\)/g, 'none').replace(/\\\./g, '.')

const READ_ALL_API = API_DOORS.map(([, name]) => name).filter(name => !['ssoLinks','transferInstructions','jobRuns','sandbox','sandboxCustomer','billingNotices','dunning','sso','paymentLinks','trialCollections','prepaidRefundNotices','hierarchies','webhooks','webhookDelivery','members', 'roles', 'imports', 'audit', 'reportSchedule', 'reportDelivery', 'noteMembers','billingEntities','nativeCollections','prepaidTopupAuthorizations','prepaidTopupClaims'].includes(name))
const READ_ALL_PAGES = PAGE_DOORS.map(([, name]) => name).filter(name => !['sandbox','sandboxCustomer','dunning','sso','paymentLinks','hierarchies','webhooks','webhookDelivery','prepaidRefundProof','prepaidRefundCsv','prepaidTopupSource','prepaidCsv', 'revenueJournalCsv', 'numberRegisterCsv', 'erasureEvidence', 'revenueCsv', 'reportSchedule', 'reportDelivery', 'reportDeliveryCsv', 'reportCsv', 'metadataCsv', 'runFile', 'import', 'exports', 'customersFile', 'invoicesFile', 'usageFile', 'subscriptionsFile', 'audit', 'noticeFile','importOriginals'].includes(name))
const COMMON = { api: ['openapi', 'me', 'notifications', 'mfa'], pages: ['home', 'more', 'security', 'passkeyScript'] }
const EXPECTED = {
  collections: {
    actions: ['bank.deposit.upload','remittance.upload','remittance.preview','remittance.confirm','remittance.allocate.preview','remittance.allocate','invoice.refund.preview', 'payment.record', 'payment.allocate', 'processor.cash.allocate', 'reminder.prepare', 'reminder.approve', 'reminder.discard', 'task.create', 'task.complete', 'cadence.enroll', 'cadence.promise', 'cadence.dispute', 'cadence.resolve', 'cadence.approve', 'cadence.run', 'note.add', 'answer.read'],
    api: ['remittances','processorEvents','automaticCollections','paymentReceipt','prepaidRefunds', 'numberRegister', 'customers', 'customer', 'invoices', 'invoice', 'ageing', 'writeOffs', 'ledgerPostings', 'customerBalance', 'payments', 'notices', 'tasks', 'notes', 'noteMembers', 'entitlement', 'reportLine', 'cadences', 'metadataObjects'],
    pages: ['processorEvents','paymentReceipt','prepaidRefundList', 'prepaidRefundSource', 'numberRegister', 'customers', 'customer', 'certificateFile', 'invoice', 'receivables', 'noticeFile', 'cadences', 'billingAnswers', 'reportLine', 'metadataList'],
  },
  sales: {
    actions: ['change.prepare', 'plan.change.prepare', 'amendment.propose', 'contract.prepare'],
    api: ['portalChanges', 'customers', 'customer', 'catalog', 'promotions', 'subscription', 'upcoming', 'entitlement', 'metadata', 'metadataObjects'],
    pages: ['portalChanges', 'customers', 'customer', 'certificateFile', 'catalog', 'subscription', 'metadata', 'metadataList'],
  },
  support: {
    actions: ['invoice.refund.preview', 'prepaid.refund.request', 'note.add', 'credit.issue', 'answer.read'],
    api: ['portalChanges','remittances','processorEvents','automaticCollections','paymentReceipt','prepaidRefunds', 'numberRegister', 'customers', 'customer', 'invoices', 'invoice', 'ageing', 'writeOffs', 'ledgerPostings', 'customerBalance', 'payments', 'notes', 'noteMembers', 'entitlement', 'subscription', 'upcoming', 'reportLine', 'metadataObjects', 'prepaid', 'prepaidSource'],
    pages: ['portalChanges','processorEvents','paymentReceipt','prepaidRefundList', 'prepaidRefundSource', 'numberRegister', 'customers', 'customer', 'certificateFile', 'subscription', 'prepaid', 'prepaidSource', 'invoice', 'receivables', 'billingAnswers', 'reportLine', 'metadataList'],
  },
  developer: {
    actions: ['sandbox.catalog.copy','sandbox.customer.create','sandbox.clock.advance','sandbox.processor.bind','sandbox.billing.reconcile','invoice.refund.preview', 'credential.issue', 'credential.revoke', 'credential.version', 'webhook.stripe.consume', 'webhook.register', 'webhook.rotate', 'webhook.disable', 'webhook.replay', 'webhook.dispatch', 'answer.read', 'meter.preview', 'usage.correction.preview'],
    api: [...READ_ALL_API,'sandbox','sandboxCustomer','webhooks','webhookDelivery'], pages: [...READ_ALL_PAGES,'sandbox','sandboxCustomer','webhooks','webhookDelivery'],
  },
  analyst: {
    actions: ['report.schedule'],
    api: ['retryComparison','currencyRates','currencyReport','customers', 'customer', 'entitlement', 'metadataObjects', 'report', 'reportInvoice', 'reportLine', 'periodCloses', 'revenue', 'revenueJournal', 'revenueSource', 'reportSchedule', 'reportDelivery'],
    pages: ['currencyReport','customers', 'customer', 'certificateFile', 'metadataList', 'metadataCsv', 'revenue', 'revenueSource', 'revenueCsv', 'revenueJournalCsv', 'reportSchedule', 'reportDelivery', 'reportDeliveryCsv', 'reportCsv', 'report', 'reportInvoice', 'reportLine', 'exports', 'customersFile'],
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

  await financialVisibilityFlow(h, owner, { sales: who.sales, finance: who.finance })

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


// A customer read must not inherit financial authority from its legacy ledger.
// Keep this regression in the existing Worker/D1 role journey, including both
// an entitlement-bearing customer and a customer with no entitlement subtree.
export async function financialVisibilityFlow(h, owner, { sales, finance, onReady = async () => {} } = {}) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  const mailbox = name => [name, 'example.test'].join('@')
  const member = async role => {
    const email = mailbox(`financial-visibility-${role}`)
    await api('access.give', { email, name: `Financial visibility ${role}`, role })
    return h.signIn(email, { requested: true })
  }
  sales ??= await member('sales')
  finance ??= await member('finance')
  const readers = []
  for (const [name, capabilities] of [
    ['customer-only', ['read.customers', 'export']],
    ['invoice-only', ['read.customers', 'read.invoices', 'export']],
    ['payment-only', ['read.customers', 'read.payments', 'export']],
    ['combined', ['read.customers', 'read.invoices', 'read.payments', 'export']],
  ]) {
    const role = await api('role.define', { name: `Visibility ${name}`, capabilities })
    const email = mailbox(`financial-visibility-${name}`)
    await api('access.give', { email, name: `Visibility ${name}`, role: 'custom', custom_role: role.id })
    readers.push({ name, who: await h.signIn(email, { requested: true }), role: role.id,
      invoices: capabilities.includes('read.invoices'), payments: capabilities.includes('read.invoices') && capabilities.includes('read.payments'), subscriptions: false })
  }
  const matrix = [{ name: 'sales', who: sales, invoices: false, payments: false, subscriptions: true }, ...readers,
    { name: 'finance', who: finance, invoices: true, payments: true, subscriptions: true },
    { name: 'owner', who: owner, invoices: true, payments: true, subscriptions: true }]
  const fixtures = []
  for (const entitled of [false, true]) {
    const code = `financial-visibility-${entitled ? 'inside' : 'outside'}`
    const customer = (await api('customer.create', { external_id: code, name: `Financial visibility ${entitled ? 'inside' : 'outside'}`, billing_email: mailbox(code), address: `Private address ${code}` })).id
    await api('contact.add', { customer, name: `Private contact ${code}`, email: mailbox(`${code}-contact`) })
    const product = (await api('product.create', { code, name: code })).id
    const price = (await api('price.create', { product, kind: 'flat', unit_amount: '100', taxable: false })).id
    if (entitled) await api('feature.grant', { product, feature: 'financial-visibility-feature' })
    const subscription = (await api('subscription.create', { customer, start_date: '2026-08-01', price: [price] })).id
    const charge = await api('charge.add', { customer, amount: '100', description: `Private service ${code}`, effective_date: '2026-08-01', taxable: false })
    const invoice = (await api('invoice.manual', { customer, charges: [charge.charge], service_date: '2026-08-01' })).id
    await api('invoice.approve', { invoice, acknowledge: true })
    await api('invoice.finalise', { invoice, issue_date: '2026-09-01' })
    await api('credit.issue', { invoice, amount: '1', reason: `Private adjustment ${code}` })
    const reference = `FINANCIAL-VISIBILITY-${entitled ? 'INSIDE' : 'OUTSIDE'}-WIRE`
    const payment = (await api('payment.record', { customer, amount: '12', received_on: '2026-09-02', method: 'bank_transfer', reference })).payment
    await api('payment.allocate', { payment, invoice, amount: '10' })
    await api('note.add', { kind: 'invoice', record: invoice, body: `Invoice note ${code}` })
    await api('note.add', { kind: 'payment', record: payment, body: `Payment note ${code}` })
    await api('metadata.write', { kind: 'invoice', record: invoice, revision: 0, metadata: { visibility: `invoice-metadata-${code}` } })
    await api('metadata.write', { kind: 'payment', record: payment, revision: 0, metadata: { visibility: `payment-metadata-${code}` } })
    const before = await api(`customers/${customer}`)
    assert.deepEqual([before.ledger.invoicedCents, before.ledger.creditedCents, before.ledger.paidCents, before.ledger.balanceCents, before.ledger.unallocatedCents], [10000, 100, 1000, 8900, 200])
    assert.equal(before.entitlements.length > 0, entitled)
    fixtures.push({ customer, invoice, payment, subscription, price, reference, before, code })
  }
  await api('hierarchy.configure', { customer: fixtures[1].customer, parent: fixtures[0].customer, billing_mode: 'separate', revision: 0, consent: true })
  const invoiceTotals = ['invoicedCents', 'creditedCents', 'paidCents', 'writtenOffCents', 'balanceCents']
  const assertLedger = (ledger, reader, expected) => {
    for (const key of ['invoices', 'credits', 'carriedUsageCredits']) assert.deepEqual(ledger[key], reader.invoices ? expected[key] : [], `${reader.name} ${key}`)
    for (const key of invoiceTotals) assert.equal(ledger[key], reader.invoices ? expected[key] : null, `${reader.name} ${key}`)
    assert.deepEqual(ledger.payments, reader.payments ? expected.payments : [], `${reader.name} payment custody`)
    assert.equal(ledger.unallocatedCents, reader.payments ? expected.unallocatedCents : null)
  }
  const mainHtml = html => html.slice(html.indexOf('<main'), html.indexOf('</main>'))
  const assertProjection = async (fixture, reader, erased = false) => {
    const expected = (await api(`customers/${fixture.customer}`)).ledger
    const record = await h.api(`customers/${fixture.customer}`, reader.who)
    assert.equal(record.id, fixture.customer)
    assertLedger(record.ledger, reader, expected)
    if (!erased) {
      assert.equal(record.contacts[0].email, fixture.before.contacts[0].email, 'Permitted customer contacts stay readable')
      assert.deepEqual(record.subscriptions, fixture.before.subscriptions.map(sub => reader.subscriptions ? sub : { ...sub, state: null }))
      assert.equal(record.entitlements.length, fixture.before.entitlements.length)
      for (const entitlement of record.entitlements) {
        // ENT-001 deliberately keeps its stronger combined-capability evidence rule.
        if (!reader.payments) assert.ok(!JSON.stringify(entitlement).includes('balanceCents'))
      }
    }
    for (const child of record.childAccounts ?? []) assertLedger(child.record.ledger, reader, (await api(`customers/${child.record.id}`)).ledger)
    const html = mainHtml(await h.page(`/app/customers/${fixture.customer}`, reader.who))
    const invoice = expected.invoices[0]
    assert.equal(JSON.stringify(record).includes(invoice.number), reader.invoices, `${reader.name} composed JSON follows invoice authority`)
    assert.equal(html.includes(invoice.number), reader.invoices, `${reader.name} permitted invoice number`)
    assert.equal(html.includes('$89.00'), reader.invoices, `${reader.name} independently reconciled outstanding balance`)
    assert.equal(html.includes(fixture.reference), reader.payments && !erased, `${reader.name} payment reference`)
    assert.equal(JSON.stringify(record).includes(fixture.reference), reader.payments && !erased, 'Customer JSON exposes only permitted payment fields')
    if (!reader.invoices) {
      for (const hint of ['Invoices and payments', 'No issued invoices', 'Credit notes', 'No credit notes', 'Invoiced', 'Owed now', 'One-time charges', 'No one-time charges', 'Stripe invoiced']) assert.ok(!html.includes(hint), `${reader.name} has no financial section or existence hint: ${hint}`)
      assert.ok(!html.includes('$100.00'), 'Unauthorized invoice totals are absent')
      assert.deepEqual(record.charges, [])
    }
    if (!reader.payments) {
      for (const hint of ['Unallocated payments', 'No payments.', 'Payment receipts', 'Processor payments', 'Credit balance']) assert.ok(!html.includes(hint), `${reader.name} has no payment existence hint: ${hint}`)
      assert.ok(!JSON.stringify(record).includes(`Payment note ${fixture.code}`))
      assert.ok(!JSON.stringify(record).includes(`payment-metadata-${fixture.code}`))
    }
    if (!reader.invoices) assert.ok(!JSON.stringify(record).includes(`Invoice note ${fixture.code}`))
    for (const [query, permitted] of [[invoice.number, reader.invoices], [fixture.reference, reader.payments && !erased],
      [`invoice-metadata-${fixture.code}`, reader.invoices && !erased], [`payment-metadata-${fixture.code}`, reader.payments && !erased]]) {
      const found = await h.api(`customers?search=${encodeURIComponent(query)}`, reader.who)
      assert.equal(found.some(row => row.id === fixture.customer), permitted, `${reader.name} search matches only authorized evidence`)
      const list = mainHtml(await h.page(`/app/customers?search=${encodeURIComponent(query)}`, reader.who))
      assert.equal(list.includes(`/app/customers/${fixture.customer}`), permitted, `${reader.name} built search has no forbidden match`)
    }
    if (erased) {
      for (const value of [fixture.before.name, fixture.before.external_id, fixture.before.billing_email, fixture.before.address, fixture.before.contacts[0].name, fixture.before.contacts[0].email, fixture.reference]) {
        assert.ok(!JSON.stringify(record).includes(value), 'Erased customer JSON contains no personal identifier')
        assert.ok(!html.includes(value), 'Erased built page contains no personal identifier')
        assert.equal((await h.api(`customers?search=${encodeURIComponent(value)}`, reader.who)).some(row => row.id === fixture.customer), false, 'Erased identifiers cannot find the customer')
      }
    }
    if (reader.name === 'sales') await h.page('/app/exports/customers.csv', reader.who, 403)
    else {
      const csv = await h.page('/app/exports/customers.csv', reader.who)
      if (!reader.payments) assert.ok(!csv.includes(fixture.reference), 'Customer CSV omits unauthorized payment facts')
      if (!reader.invoices) assert.ok(!csv.includes(`Invoice note ${fixture.code}`), 'Customer CSV omits unauthorized invoice notes')
      if (erased) for (const value of [fixture.before.billing_email, fixture.reference, fixture.before.name]) assert.ok(!csv.includes(value))
    }
    if (reader.invoices) {
      const invoiceRecord = await h.api(`invoices/${fixture.invoice}`, reader.who)
      assert.equal(invoiceRecord.balanceCents, 8900)
      assert.equal(JSON.stringify(invoiceRecord).includes(fixture.reference), reader.payments && !erased, 'Invoice drill-through preserves payment authority')
      const invoiceHtml = mainHtml(await h.page(`/app/invoices/${fixture.invoice}`, reader.who))
      assert.equal(invoiceHtml.includes(fixture.reference), reader.payments && !erased)
      if (!reader.payments) assert.ok(!invoiceHtml.includes('No payments allocated.'))
      if (erased) for (const value of [fixture.before.name, fixture.before.billing_email, fixture.reference]) assert.ok(!invoiceHtml.includes(value), 'Invoice drill-through renders no erased identifiers')
    } else await h.api(`invoices/${fixture.invoice}`, reader.who, undefined, 403)

  }
  const beforeReads = await Promise.all(fixtures.map(f => api(`customers/${f.customer}`)))
  const financialSnapshot = async () => ({ invoices: await Promise.all(fixtures.map(f => api(`invoices/${f.invoice}`))), payments: await api('payments') })
  const moneyBefore = await financialSnapshot()
  const audit = await api('audit')
  for (const fixture of fixtures) for (const reader of matrix) await assertProjection(fixture, reader)
  assert.deepEqual(await Promise.all(fixtures.map(f => api(`customers/${f.customer}`))), beforeReads, 'Allowed and refused reads change no customer or financial records')
  assert.deepEqual(await api('audit'), audit, 'Customer reads never change audit records')
  assert.deepEqual(await financialSnapshot(), moneyBefore, 'Allowed and refused reads preserve full invoice and payment records')
  await onReady({ fixtures, matrix, phase: 'ordinary' })

  // Every changed capability takes effect on the next request in the same session.
  const combined = readers.find(r => r.name === 'combined')
  await api('role.update', { role: combined.role, revision: 1, capabilities: ['read.customers', 'read.invoices', 'export'] })
  const revoked = { ...combined, payments: false }
  for (const fixture of fixtures) await assertProjection(fixture, revoked)
  await api('role.update', { role: combined.role, revision: 2, capabilities: ['read.customers', 'export'] })
  for (const fixture of fixtures) await assertProjection(fixture, { ...revoked, invoices: false })
  await api('role.update', { role: combined.role, revision: 3, capabilities: ['read.customers', 'read.invoices', 'read.payments', 'export'] })
  const credential = await api('credential.issue', { name: 'Financial visibility revoked credential', scopes: ['prepare'] })
  const agent = { bearer: credential.key }
  assert.deepEqual((await h.api(`customers/${fixtures[0].customer}`, agent)).ledger, fixtures[0].before.ledger)
  await api('credential.revoke', { key: credential.id })
  for (const fixture of fixtures) {
    await h.api(`customers/${fixture.customer}`, agent, undefined, 401)
    await h.api(`customers/${fixture.customer}`, undefined, undefined, 401)
    const response = await h.raw(`/app/customers/${fixture.customer}`, agent)
    assert.equal(response.status, 403)
    await response.text()
  }
  // Imported invoice evidence follows invoice authority; payment records require both.
  const { stripeHistoryCapture } = await import('../fixtures/stripe-history.mjs')
  const { file } = await import('./harness.mjs')
  const capture = stripeHistoryCapture()
  const files = Object.fromEntries(Object.entries(capture).map(([name, value]) => [name, file(`${name}.json`, JSON.stringify(value), 'application/json')]))
  const preview = await api('import.preview', files)
  assert.deepEqual(preview.rejected, [])
  await api('import.apply', { ...files, fingerprint: preview.fingerprint })
  const importedCustomer = (await api('customers')).find(row => row.external_id === 'synthetic-nectar-1').id
  const imported = await api(`customers/${importedCustomer}`)
  assert.ok(imported.incumbentHistory.documents.length > 0 && imported.incumbentHistory.records.some(row => row.kind === 'payment'))
  for (const reader of matrix) {
    const record = await h.api(`customers/${importedCustomer}`, reader.who)
    for (const key of ['invoicedCents','creditedCents','remainingCents','paymentsCents','refundsCents']) {
      const permitted = ['paymentsCents','refundsCents'].includes(key) ? reader.payments : reader.invoices
      assert.equal(record.incumbentHistory.totals[key], permitted ? imported.incumbentHistory.totals[key] : null, `${reader.name} imported totals retain their exact authorized values`)
    }
    assert.deepEqual(record.incumbentHistory.documents, reader.invoices ? imported.incumbentHistory.documents : [])
    assert.deepEqual(record.incumbentInvoices, reader.invoices ? imported.incumbentInvoices : [])
    assert.deepEqual(record.importedCollections, reader.payments ? imported.importedCollections : [])
    assert.deepEqual(record.incumbentHistory.records, imported.incumbentHistory.records.filter(row => row.kind === 'subscription-event' ? reader.subscriptions : reader.payments))
    const html = mainHtml(await h.page(`/app/customers/${importedCustomer}`, reader.who))
    assert.equal(html.includes(imported.incumbentHistory.documents[0].number), reader.invoices)
    assert.equal(html.includes('synthetic-nectar-payment-annual'), reader.payments)
    if (!reader.invoices) for (const hint of ['Stripe invoiced', 'Moved history', 'No moved documents']) assert.ok(!html.includes(hint))
    if (reader.name !== 'sales') {
      const csv = await h.page('/app/exports/customers.csv', reader.who)
      assert.equal(csv.includes('synthetic-nectar-payment-annual'), reader.payments)
      assert.equal(csv.includes(imported.incumbentHistory.documents[0].number), reader.invoices)
    }
  }
  const importedErasure = await api('erasure.request', { customer: importedCustomer })
  const importedMessage = h.mails.findLast(mail => [mail.to].flat().includes(imported.billing_email))
  const importedVerification = new URL(`${importedMessage.text ?? ''} ${importedMessage.html ?? ''}`.match(/https?:\/\/[^\s"<]+\/erase\/[a-f0-9]{64}/)[0]).pathname
  assert.equal((await h.raw(importedVerification, { form: new URLSearchParams({ confirm: 'yes' }) })).status, 200)
  await api('erasure.approve', { request: importedErasure.id, confirm: true })
  const retainedFields = ['id','number','issue_date','due_date','total_cents','remaining_cents','currency']
  const retainedDocuments = imported.incumbentHistory.documents.map(document => Object.fromEntries(retainedFields.map(field => [field, document[field] ?? null])))
  const retained = await api(`customers/${importedCustomer}`)
  for (const reader of matrix) {
    const record = await h.api(`customers/${importedCustomer}`, reader.who)
    assert.deepEqual(record.retainedImportedInvoices, reader.invoices ? retainedDocuments : [], 'Erased imported invoices retain only permitted closed facts')
    const html = mainHtml(await h.page(`/app/customers/${importedCustomer}`, reader.who))
    assert.equal(html.includes(imported.incumbentHistory.documents[0].number), reader.invoices)
    for (const value of [imported.name, imported.billing_email, imported.external_id, 'synthetic-nectar-payment-annual']) {
      assert.ok(!JSON.stringify(record).includes(value))
      assert.ok(!html.includes(value))
    }
    assert.equal((await h.api(`customers?search=${encodeURIComponent(imported.incumbentHistory.documents[0].number)}`, reader.who)).some(row => row.id === importedCustomer), reader.invoices)
    assert.equal((await h.api('customers?search=synthetic-nectar-payment-annual', reader.who)).some(row => row.id === importedCustomer), false)
  }
  assert.equal((await api('import.preview', files, 409)).error, 'erased_import_source')
  assert.equal((await api('import.apply', { ...files, fingerprint: preview.fingerprint }, 409)).error, 'erased_import_source')
  assert.deepEqual(await api(`customers/${importedCustomer}`), retained, 'Replayed captures cannot resurrect an erased identity or alter retained financial facts')
  await onReady({ fixtures, matrix, phase: 'erased-import', imported: { customer: importedCustomer, before: imported } })
  // Erase the child first: the ordinary parent must not revive private child fields.
  for (const fixture of [...fixtures].reverse()) {
    const erasure = await api('erasure.request', { customer: fixture.customer })
    const message = h.mails.findLast(mail => [mail.to].flat().includes(fixture.before.billing_email))
    const verification = new URL(`${message.text ?? ''} ${message.html ?? ''}`.match(/https?:\/\/[^\s"<]+\/erase\/[a-f0-9]{64}/)[0]).pathname
    assert.equal((await h.raw(verification, { form: new URLSearchParams({ confirm: 'yes' }) })).status, 200)
    await api('erasure.approve', { request: erasure.id, confirm: true })
    const erased = await api(`customers/${fixture.customer}`)
    assert.ok(erased.erased_at)
    assert.deepEqual([erased.ledger.invoicedCents, erased.ledger.creditedCents, erased.ledger.paidCents, erased.ledger.balanceCents, erased.ledger.unallocatedCents], [10000, 100, 1000, 8900, 200], 'Retention preserves every independently computed financial figure')
    const frozen = await api(`customers/${fixture.customer}`)
    for (const reader of matrix) await assertProjection(fixture, reader, true)
    assert.deepEqual(await api(`customers/${fixture.customer}`), frozen, 'Erased reads change no retained financial facts')
    await onReady({ fixtures, matrix, phase: fixture === fixtures[1] ? 'erased-child' : 'erased' })
  }
  // A genuine recurring invoice also appears in subscription history and its minimum-spend ledger.
  const subscriptionCustomer = (await api('customer.create', { external_id: 'synthetic-nectar-visibility-subscription', name: 'Visibility subscription', billing_email: mailbox('synthetic-nectar-visibility-subscription') })).id
  const subscription = (await api('subscription.create', { customer: subscriptionCustomer, start_date: '2026-07-01', price: [fixtures[0].price] })).id
  const terms = await api('contract.prepare', { subscription, revision: (await api(`subscriptions/${subscription}`)).revision,
    clause: 'Reviewed minimum for the visibility journey', commitments: [{ from: '2026-07-01', to: '2026-08-01', minimum: '100', taxable: false }], included: [], ramps: [] })
  await h.api('contract.decide', finance, { contract: terms.contract, decision: 'approved' })
  const run = await api('billrun.prepare', { period: '2026-07' })
  const recurring = (await api(`runs/${run.id}`)).invoices.find(row => row.subscription_id === subscription)
  await api('invoice.approve', { invoice: recurring.id, acknowledge: true })
  await api('invoice.finalise', { invoice: recurring.id, issue_date: '2026-08-01' })
  const recurringInvoice = await api(`invoices/${recurring.id}`)
  for (const reader of [matrix[0], matrix.find(row => row.name === 'finance')]) {
    const detail = await h.api(`subscriptions/${subscription}`, reader.who)
    const customer = await h.api(`customers/${subscriptionCustomer}`, reader.who)
    assert.equal(JSON.stringify(detail).includes(recurringInvoice.number), reader.invoices, 'Subscription invoice history and minimum-spend evidence use invoice authority')
    assert.equal(JSON.stringify(customer).includes(recurringInvoice.number), reader.invoices, 'Composed subscription records use invoice authority')
    const html = mainHtml(await h.page(`/app/subscriptions/${subscription}`, reader.who))
    assert.equal(html.includes(recurringInvoice.number), reader.invoices)
    assert.equal(html.includes('No invoices yet.'), false, 'An unauthorized subscription reader gets no invoice empty state')
  }
  const written = await api('writeoff.issue', { invoice: recurring.id, amount: '100', reason: 'Reviewed synthetic uncollectible debt' })
  const recoveryReference = 'synthetic-nectar-visibility-recovery'
  const recoveryPayment = (await api('payment.record', { customer: subscriptionCustomer, amount: '25', received_on: '2026-08-02', method: 'bank_transfer', reference: recoveryReference })).payment
  await api('writeoff.recover', { write_off: written.writeOff, payment: recoveryPayment, amount: '25' })
  for (const reader of readers.filter(row => row.invoices)) {
    const invoice = await h.api(`invoices/${recurring.id}`, reader.who)
    assert.deepEqual([invoice.total_cents, invoice.paidCents, invoice.writtenOffCents, invoice.balanceCents], [10000, 2500, 7500, 0])
    assert.equal(JSON.stringify(invoice).includes(recoveryReference), reader.payments, 'Write-off recovery cannot bypass payment reference authority')
    assert.equal(JSON.stringify(await h.api('write-offs', reader.who)).includes(recoveryReference), reader.payments)
    const customer = await h.api(`customers/${subscriptionCustomer}`, reader.who)
    assert.equal(JSON.stringify(customer).includes(recoveryReference), reader.payments)
  }
  console.log('PROBE GOV-008 1: customer detail, child, search and CSV doors -> invoice figures visible only with invoice authority')
  console.log('PROBE GOV-008 2: same populated doors -> payment references visible only with both financial capabilities')
  console.log('PROBE GOV-008 3: Sales and customer-only and payment-only reads -> financial sections and hints absent')
  console.log('PROBE GOV-008 4: approved erasure -> private identifiers absent; retained invoice totals unchanged')
  console.log('PROBE GOV-008 5: allowed reads, refused reads and next-request revocation -> no financial mutation')
}

// The existing browser sanity journey invokes this against a fresh installation.
// Assertions run at desktop width; the same populated screens get phone proof.
export async function customerVisibilityBrowserJourney(browser) {
  const { harness } = await import('./harness.mjs')
  const { mkdir } = await import('node:fs/promises')
  const directory = `${process.env.NECTAR_EVIDENCE_DIR ?? '.evidence'}/customer-visibility`
  await mkdir(directory, { recursive: true })
  const h = await harness({ assets: true, localTime: '2026-10-15T12:00:00Z' })
  try {
    await h.raw('/auth/bootstrap', { body: { token: h.vars.SETUP_TOKEN, displayName: 'Nectar Owner' } })
    const owner = await h.signIn(h.vars.OWNER_EMAIL)
    await h.raw('/setup', { cookie: owner, form: new URLSearchParams({ confirm: 'yes' }) })
    await h.api('business.configure', owner, { legal_name: 'Cedar Software Inc', timezone: 'UTC', invoice_prefix: 'CD', payment_terms_days: 30 })
    await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: 'CA', tax_mode: 'no_tax', tax_note: 'Reviewed visibility journey' })
    await h.api('tax.review', owner, { revision: (await h.api('business', owner)).revision })
    await financialVisibilityFlow(h, owner, { onReady: async ({ fixtures, matrix, phase, imported }) => {
      for (const reader of matrix.filter(row => ['sales', 'customer-only', 'invoice-only', 'payment-only', 'combined'].includes(row.name))) {
        const context = await browser.newContext({ viewport: { width: 1440, height: 950 } })
        try {
          await context.addCookies(reader.who.split('; ').map(value => {
            const split = value.indexOf('=')
            return { name: value.slice(0, split), value: value.slice(split + 1), url: h.origin }
          }))
          const page = await context.newPage(), customer = imported ?? fixtures[0]
          const paths = [{ name: phase, path: `/app/customers/${customer.customer}` }]
          if (phase === 'ordinary') paths.push({ name: 'invoice-search', path: `/app/customers?search=${encodeURIComponent(customer.before.ledger.invoices[0].number)}` })
          for (const screen of paths) {
            await page.setViewportSize({ width: 1440, height: 950 })
            assert.equal((await page.goto(h.origin + screen.path)).status(), 200)
            const main = page.locator('main'), text = await main.innerText()
            if (screen.name === 'invoice-search') {
              assert.equal(await main.locator(`a[href="/app/customers/${customer.customer}"]`).count(), reader.invoices ? 1 : 0)
            } else {
              assert.equal(text.includes(imported ? customer.before.incumbentHistory.documents[0].number : customer.before.ledger.invoices[0].number), reader.invoices)
              if (!imported) assert.equal(text.includes(customer.reference), reader.payments && phase !== 'erased')
              else for (const value of [customer.before.name, customer.before.billing_email, 'synthetic-nectar-payment-annual']) assert.ok(!text.includes(value))
              if (!reader.invoices) {
                assert.equal(await main.locator('#money,#credits,#one-time').count(), 0, 'Forbidden sections are absent from the actual DOM')
                for (const hint of ['No issued invoices', 'No credit notes', 'Invoiced', 'Owed now', 'No moved documents']) assert.ok(!text.includes(hint))
              }
              if (!reader.payments) for (const hint of ['Unallocated payments', 'Payment receipts', 'Processor payments', 'Credit balance']) assert.ok(!text.includes(hint))
              if (['erased-child','erased'].includes(phase)) for (const value of [fixtures[1].before.name, fixtures[1].before.billing_email, fixtures[1].reference]) assert.ok(!text.includes(value), 'An erased child cannot revive identifiers')
              if (phase === 'erased') for (const value of [customer.before.name, customer.before.billing_email, customer.reference]) assert.ok(!text.includes(value))
            }
            const icons = await page.locator('a,button,[role=button]').evaluateAll(nodes => nodes.filter(node => !node.textContent.trim() && node.querySelector('svg,img')).map(node => ({ tooltip: !!document.getElementById(node.getAttribute('aria-describedby') ?? '') })))
            assert.ok(icons.every(icon => icon.tooltip), 'Icon-only controls have accessible tooltips')
            for (const width of [1440, 390]) {
              await page.setViewportSize({ width, height: 950 })
              assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${reader.name} ${screen.name} fits ${width}`)
              await page.screenshot({ path: `${directory}/${width}-${reader.name}-${screen.name}.png`, fullPage: true })
              console.log('BROWSER GOV-008', width, reader.name, screen.name)
            }
          }
        } finally { await context.close() }
      }
    } })
  } finally { await h.close() }
}
