import assert from 'node:assert/strict'
import { applyPolicy } from './policy-helper.mjs'

const issueDate = '2026-09-01'
const dueDate = '2026-10-01'
const rule = { segment: 'transfer-net30', minimum_cents: 1000, subject: '{business}: {invoice}, {balance}, stage {stage}', body: 'Please arrange the recorded transfer for {invoice}: {balance} (stage {stage}).' }
const usd = cents => `USD ${(cents / 100).toFixed(2)}`
const frozen = row => ({ delivery: row.id, recipient: row.recipient, subject: row.subject, body: row.body })
const content = mail => `${mail.text ?? ''} ${mail.html ?? ''}`

async function issued(h, owner, name, amounts = ['100.00', '50.00']) {
  const email = `ap-${name}@cadence.example`
  const customer = (await h.api('customer.create', owner, { external_id: `AR001-${name}`, name: `Cadence ${name}`, billing_email: email })).id
  const charges = []
  for (const [index, amount] of amounts.entries()) charges.push((await h.api('charge.add', owner, { customer, amount, description: `${name} service ${index + 1}`, taxable: true, effective_date: issueDate })).charge)
  const draft = await h.api('invoice.manual', owner, { customer, charges, service_date: issueDate })
  await h.api('invoice.approve', owner, { invoice: draft.id, acknowledge: true })
  await h.api('invoice.finalise', owner, { invoice: draft.id, issue_date: issueDate })
  const invoice = await h.api(`invoices/${draft.id}`, owner)
  assert.equal(invoice.status, 'issued')
  assert.equal(invoice.due_date, dueDate, 'the issued invoice really has Net30 terms')
  assert.equal(invoice.lines.length, 2)
  return { ...invoice, customer, email }
}

/** Ordinary HTTP records for both the journey and a browser proof installation. */
export async function seedCadenceRecords(h, owner) {
  const records = {}
  for (const name of ['primary', 'paid', 'promise', 'segment', 'minimum']) {
    records[name] = await issued(h, owner, name, name === 'minimum' ? ['3.00', '4.00'] : undefined)
    await h.api('cadence.enroll', owner, { invoice: records[name].id, segment: name === 'segment' ? 'unmatched' : rule.segment, transfer_terms: 'Customer pays by bank transfer, Net30; operator recorded from the signed order.' })
  }
  return records
}

/** AR-001: named, real Worker/D1 public HTTP, form and Cron collection journey. */
export async function cadencesFlow(h, owner) {
  const business = await h.api('business', owner)
  assert.equal(business.payment_terms_days, 30)
  assert.equal(business.timezone, 'America/Los_Angeles')
  const report = () => h.api('cadences', owner)
  let instant = '2026-09-01T19:00:00Z'
  const tick = async time => {
    instant = time
    await h.advanceClock(time)
    const response = await h.raw(`/cdn-cgi/local/scheduled?time=${Date.parse(time)}&cron=${encodeURIComponent('0 14 * * *')}`)
    assert.equal(response.status, 200, `real scheduled entry point: ${await response.text()}`)
  }
  const policy = async (human, approver) => {
    const prepared = await h.api('cadence.policy.prepare', owner, { enabled: true, require_human: human, rules: [rule] })
    await h.api('cadence.policy.decide', approver, { request: prepared.request, decision: 'approved', confirm_single: approver === owner })
    return prepared.request
  }
  const mails = invoice => h.mails.filter(mail => content(mail).includes(`Invoice ${invoice.number};`))
  const deliveries = async invoice => (await report()).deliveries.filter(row => row.invoice_id === invoice.id)
  const delivery = async (invoice, stage) => {
    const rows = (await deliveries(invoice)).filter(row => row.stage === stage)
    assert.equal(rows.length, 1, `${invoice.number} has one durable reservation for stage ${stage}`)
    return rows[0]
  }
  const invoiceState = async invoice => (await report()).invoices.find(row => row.id === invoice.id)
  const pay = async (invoice, amount, reference) => {
    const payment = await h.api('payment.record', owner, { customer: invoice.customer, amount, received_on: instant.slice(0, 10), method: 'bank_transfer', reference })
    await h.api('payment.allocate', owner, { payment: payment.payment, invoice: invoice.id, amount })
  }
  const assertSent = async (invoice, stage, collectible, disputes = []) => {
    const row = await delivery(invoice, stage)
    assert.equal(row.status, 'accepted', 'provider acceptance is recorded without claiming delivery')
    assert.ok(row.provider_ref)
    assert.equal(row.collectible_cents, collectible)
    assert.equal(row.recipient, invoice.email)
    assert.equal(row.subject, `${business.legal_name}: ${invoice.number}, ${usd(collectible)}, stage ${stage}`)
    const excluded = disputes.map(d => `Dispute ${d.id}, line ${d.line}: ${usd(d.amount)} excluded.`)
    assert.equal(row.body, `Please arrange the recorded transfer for ${invoice.number}: ${usd(collectible)} (stage ${stage}).\n\nInvoice ${invoice.number}; due ${dueDate}.\nAmount requested: ${usd(collectible)}.${excluded.length ? `\n${excluded.join('\n')}` : ''}`)
    const sent = mails(invoice).filter(mail => mail.subject === row.subject)
    assert.equal(sent.length, 1)
    assert.deepEqual([sent[0].to].flat(), [invoice.email])
    assert.equal(sent[0].text, row.body, 'the network request contains the exact approved wording')
    return row
  }

  await h.advanceClock(instant)
  await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: 'CA', tax_mode: 'flat_rate', tax_rate: '10', tax_note: 'Declared service rate for the transfer collection journey.' })
  await h.api('tax.review', owner, { revision: (await h.api('business', owner)).revision })
  const sole = await h.api('cadence.policy.prepare', owner, { enabled: true, require_human: false, rules: [rule] })
  await h.api('cadence.policy.decide', owner, { request: sole.request, decision: 'approved' }, 409)
  assert.equal((await h.api('cadence.policy.decide', owner, { request: sole.request, decision: 'approved', confirm_single: true })).mode, 'single-approver')
  await h.api('access.give', owner, { email: 'cadence-finance@example.test', name: 'Cadence Finance', role: 'finance' })
  await h.api('access.give', owner, { email: 'cadence-accountant@example.test', name: 'Cadence Accountant', role: 'accountant' })
  const finance = await h.signIn('cadence-finance@example.test', { requested: true })
  const accountant = await h.signIn('cadence-accountant@example.test', { requested: true })
  const prepare = { bearer: (await h.api('credential.issue', owner, { name: 'Cadence prepare agent', scopes: ['prepare'] })).key }
  const usage = { bearer: (await h.api('credential.issue', owner, { name: 'Cadence usage agent', scopes: ['usage'] })).key }
  const request = await h.api('cadence.policy.prepare', owner, { enabled: true, require_human: false, rules: [rule] })
  await h.api('cadence.policy.decide', owner, { request: request.request, decision: 'approved', confirm_single: true }, 409)
  await h.submit('cadence.policy.decide', finance, { request: request.request, decision: 'approved' }, '/app/receivables')
  assert.equal((await report()).requests.find(row => row.id === request.request).approval_mode, 'two-person')
  for (const action of ['cadence.policy.prepare', 'cadence.policy.decide', 'cadence.enroll', 'cadence.promise', 'cadence.dispute', 'cadence.resolve', 'cadence.approve', 'cadence.run']) {
    await h.api(action, undefined, {}, 401)
    for (const who of [accountant, prepare, usage]) await h.api(action, who, {}, 403)
  }
  await h.api('cadence.policy.prepare', finance, {}, 403)
  await h.api('cadences', undefined, undefined, 401)
  await h.api('cadences', usage, undefined, 403)
  assert.equal((await h.api('cadences', accountant)).policy.enabled, true)
  assert.equal((await h.api('cadences', prepare)).policy.enabled, true)

  const { primary, paid, promise, segment, minimum } = await seedCadenceRecords(h, owner)
  assert.equal(primary.tax_cents, 1500, 'nonzero issued tax remains collectible without allocating it to a dispute')
  const line = primary.lines.find(row => row.amount_cents === 10000)
  assert.ok(line)
  const dispute = await h.api('cadence.dispute', finance, { invoice: primary.id, line: line.id, amount_cents: 4000, reason: 'Only the recorded implementation service is contested.' })
  const excluded = [{ id: dispute.dispute, line: line.id, amount: 4000 }]
  await h.api('cadence.dispute', finance, { invoice: primary.id, line: line.id, amount_cents: 6001, reason: 'Would cumulatively exceed this line.' }, 409)
  await h.api('cadence.dispute', finance, { invoice: primary.id, line: paid.lines[0].id, amount_cents: 1, reason: 'A different invoice cannot supply the line.' }, 400)
  assert.equal((await invoiceState(primary)).disputedCents, 4000)
  await tick('2026-09-28T06:59:59Z')
  assert.equal((await deliveries(primary)).length, 0, 'UTC has crossed the date but the business has not reached day -3')
  await tick('2026-09-28T07:00:00Z')
  await assertSent(primary, -3, primary.total_cents - 4000, excluded)
  for (const invoice of [paid, promise]) await assertSent(invoice, -3, invoice.total_cents)
  for (const invoice of [segment, minimum]) assert.equal((await deliveries(invoice)).length, 0, 'unmatched segments and amounts below the rule minimum stay quiet')
  await tick(instant)
  assert.equal(mails(primary).length, 1, 'duplicate Cron ticks do not send twice')

  await h.advanceClock('2026-10-02T07:00:00Z')
  instant = '2026-10-02T07:00:00Z'
  const approvedNotice = (await h.api('reminder.prepare', finance, { customer: promise.customer })).notice
  const notice = (await h.api('notices', owner)).find(row => row.id === approvedNotice)
  await h.api('reminder.approve', finance, { notice: approvedNotice, recipient: notice.recipient, subject: notice.subject, body: notice.body })
  const originalDownload = await h.raw(`/app/notices/${approvedNotice}.txt`, { cookie: finance })
  assert.equal(originalDownload.status, 200, 'NEC-12 an unchanged approved reminder still downloads through its original public door')
  assert.ok((await originalDownload.text()).includes((promise.total_cents / 100).toFixed(2)))
  const partialNotice = await h.api('reminder.prepare', finance, { customer: primary.customer })
  const partialDraft = (await h.api('notices', owner)).find(row => row.id === partialNotice.notice)
  assert.equal(partialDraft.balance_cents, primary.total_cents - 4000, 'AR-001 the original manual door chases only the nondisputed line amount')
  const pendingNotice = (await h.api('reminder.prepare', finance, { customer: promise.customer })).notice
  const proposal = await h.api('proposal.create', prepare, { kind: 'collection', title: 'Promised transfer follow-up', payload: { customer: promise.customer } })
  await h.submit('cadence.promise', finance, { invoice: promise.id, pay_date: '2026-10-08', note: 'Accounts payable confirmed the Thursday transfer.' }, '/app/receivables')
  await h.api('reminder.prepare', finance, { customer: promise.customer }, 409)
  await h.api('proposal.create', prepare, { kind: 'collection', title: 'Cannot bypass promise', payload: { customer: promise.customer } }, 409)
  await h.api('reminder.approve', finance, { notice: pendingNotice, recipient: notice.recipient, subject: notice.subject, body: notice.body }, 409)
  await h.api('proposal.decide', owner, { proposal: proposal.id, decision: 'approved', recipient: promise.email }, 409)
  assert.equal((await h.raw(`/app/notices/${approvedNotice}.txt`, { cookie: finance })).status, 409)
  await h.api('credit.issue', owner, { invoice: primary.id, amount: '10.00', reason: 'Actual goodwill credit, separate from the disputed line.' })
  await pay(primary, '20.00', 'AR001-PARTIAL')
  await pay(paid, (paid.total_cents / 100).toFixed(2), 'AR001-SETTLED')
  await tick(instant)
  await assertSent(primary, 1, primary.total_cents - 7000, excluded)
  assert.equal(mails(paid).length, 1, 'allocated payment prevents all later reminders')
  assert.equal(mails(promise).length, 1)
  const ledger = await h.api(`invoices/${primary.id}`, owner)
  assert.equal(ledger.balanceCents, primary.total_cents - 3000, 'a dispute changes collection only, after actual payments and credits')
  assert.equal(ledger.tax_cents, primary.tax_cents)
  assert.deepEqual(ledger.calculation, primary.calculation)

  await tick('2026-10-08T07:00:00Z')
  assert.equal((await invoiceState(promise)).paused, true, 'a promise holds through its entire pay date')
  assert.equal(mails(promise).length, 1)
  await assertSent(primary, 7, primary.total_cents - 7000, excluded)
  await tick('2026-10-09T06:59:59Z')
  assert.equal(mails(promise).length, 1, 'the last second of the promised business date is held')
  await tick('2026-10-09T07:00:00Z')
  await assertSent(promise, 7, promise.total_cents)
  assert.equal((await delivery(promise, 1)).status, 'superseded', 'resume catches up only the latest active stage')
  await h.api('cadence.resolve', finance, { dispute: dispute.dispute, outcome: 'Customer accepted the implementation line after reviewing delivery evidence.' })
  assert.equal((await invoiceState(primary)).collectibleCents, primary.total_cents - 3000)
  await tick('2026-10-16T07:00:00Z')
  await assertSent(primary, 15, primary.total_cents - 3000)
  assert.equal(mails(primary).length, 4)
  assert.deepEqual((await deliveries(primary)).map(row => row.stage).sort((a, b) => a - b), [-3, 1, 7, 15])
  const escalation = (await report()).escalations.find(row => row.invoice_id === primary.id)
  assert.equal(escalation.owner_email, h.vars.OWNER_EMAIL)
  assert.equal(escalation.task_status, 'open')
  assert.ok((await h.api('tasks', owner)).some(row => row.id === escalation.task_id && row.invoice_id === primary.id))
  await tick(instant)
  assert.equal((await report()).escalations.filter(row => row.invoice_id === primary.id).length, 1)
  assert.equal(mails(primary).length, 4)
  assert.equal(mails(paid).length, 1)

  const ordinaryProposal = await h.api('proposal.create', prepare, { kind: 'collection', title: 'Reviewed nondisputed balance', payload: { customer: primary.customer } })
  const ordinaryDecision = await h.api('proposal.decide', finance, { proposal: ordinaryProposal.id, decision: 'approved' })
  const ordinaryNotice = (await h.api('notices', owner)).find(row => row.id === ordinaryDecision.notice)
  assert.equal(ordinaryNotice.balance_cents, primary.total_cents - 3000, 'NEC-14 ordinary approved collection proposals retain the current collectible amount')
  assert.equal((await h.raw(`/app/notices/${ordinaryNotice.id}.txt`, { cookie: finance })).status, 200)

  await policy(true, finance)
  const human = await issued(h, owner, 'human')
  await h.api('cadence.enroll', finance, { invoice: human.id, segment: rule.segment, transfer_terms: 'Signed Net30 transfer terms.' })
  await tick('2026-10-17T07:00:00Z')
  let pending = await delivery(human, 15)
  assert.equal(pending.status, 'awaiting_approval')
  assert.equal(mails(human).length, 0, 'human-required stages never send on preparation')
  for (const [field, value] of [['recipient', 'other@cadence.example'], ['subject', 'Changed subject'], ['body', 'Changed body']]) await h.api('cadence.approve', finance, { ...frozen(pending), [field]: value }, 409)
  await h.api('cadence.dispute', finance, { invoice: human.id, line: human.lines[0].id, amount_cents: 1000, reason: 'Source changed after the draft was frozen.' })
  await h.api('cadence.approve', finance, frozen(pending), 409)
  await tick(instant)
  pending = await delivery(human, 15)
  await policy(true, finance)
  await h.api('cadence.approve', finance, frozen(pending), 409)
  await tick(instant)
  pending = await delivery(human, 15)
  const customer = await h.api(`customers/${human.customer}`, owner)
  human.email = 'revised-ap@cadence.example'
  await h.api('customer.update', finance, { customer: human.customer, revision: customer.revision, name: customer.name, billing_email: human.email, address: customer.address })
  await h.api('cadence.approve', finance, frozen(pending), 409)
  assert.equal(mails(human).length, 0, 'source, policy and recipient changes all refuse stale approval without mail')
  await tick(instant)
  pending = await delivery(human, 15)
  const approvedForm = await h.submit('cadence.approve', finance, frozen(pending), '/app/receivables')
  assert.equal(approvedForm.searchParams.get('error'), null, 'AR-001 the exact frozen reminder succeeds through the human form')
  assert.equal((await delivery(human, 15)).status, 'pending')
  assert.equal(mails(human).length, 0)
  await tick(instant)
  const humanDispute = (await report()).disputes.find(row => row.invoice_id === human.id)
  await assertSent(human, 15, human.total_cents - 1000, [{ id: humanDispute.id, line: humanDispute.line_id, amount: 1000 }])
  for (const stage of [-3, 1, 7]) assert.equal((await delivery(human, stage)).status, 'superseded')
  await tick(instant)
  assert.equal(mails(human).length, 1)

  await policy(false, finance)
  const provider = h.vars.MAIL_PROVIDER
  try {
    for (const [name, configured, response, expected] of [
      ['development', 'development', null, 'suppressed'], ['failed', null, null, 'failed'],
      ['rejected', 'resend', { status: 400, body: { name: 'validation_error' } }, 'rejected'],
      ['uncertain', 'resend', { status: 500, body: { name: 'provider_error' } }, 'uncertain'],
    ]) {
      // Restore the real transport for ordinary record creation; only the send under test changes provider.
      h.vars.MAIL_PROVIDER = provider
      await h.advanceClock(instant)
      const invoice = await issued(h, owner, name)
      await h.api('cadence.enroll', finance, { invoice: invoice.id, segment: rule.segment, transfer_terms: 'Recorded Net30 transfer terms.' })
      if (response) h.mailResponses.push({ ...response, to: invoice.email })
      if (configured) h.vars.MAIL_PROVIDER = configured
      else delete h.vars.MAIL_PROVIDER
      await tick(instant)
      assert.equal((await delivery(invoice, 15)).status, expected)
      assert.equal((await delivery(invoice, 15)).provider_ref, null)
      assert.equal(mails(invoice).length, response ? 1 : 0)
      await tick(instant)
      assert.equal(mails(invoice).length, response ? 1 : 0, 'terminal and uncertain outcomes never automatically retry')
    }
  } finally { h.vars.MAIL_PROVIDER = provider; await h.advanceClock(instant) }

  const audit = await h.api('audit', owner)
  for (const row of (await deliveries(primary)).filter(row => row.status === 'accepted')) {
    for (const action of ['cadence.stage.reserve', 'cadence.mail.claim', 'cadence.mail.outcome'])
      assert.equal(audit.filter(event => event.action === action && event.subject === row.id).length, 1, 'AR-001 each actual reminder retains exactly one reservation, claim and outcome audit')
  }
  for (const action of ['cadence.policy.prepare', 'cadence.policy.apply', 'cadence.enroll', 'cadence.promise', 'cadence.dispute.open', 'cadence.dispute.resolve', 'cadence.stage.reserve', 'cadence.stage.refresh', 'cadence.stage.supersede', 'cadence.stage.approve', 'cadence.escalate', 'cadence.mail.claim', 'cadence.mail.outcome']) assert.ok(audit.some(row => row.action === action), `${action} has durable audit evidence`)
  const approved = audit.find(row => row.action === 'cadence.stage.approve' && row.subject === pending.id)
  assert.equal(approved.actor, 'cadence-finance@example.test')
  const detail = JSON.parse(approved.detail)
  assert.deepEqual([detail.recipient, detail.subject, detail.body], [pending.recipient, pending.subject, pending.body])
  assert.equal((await report()).disputes.find(row => row.id === dispute.dispute).outcome, 'Customer accepted the implementation line after reviewing delivery evidence.')
  console.log('AR-001 scheduled transfer cadence, exact human approvals, holds, line disputes, ledger balances, roles and truthful mail outcomes passed')
  return { invoice: primary.id, customer: primary.customer, promise: promise.id, human: human.id }
}
