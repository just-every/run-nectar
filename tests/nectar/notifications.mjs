import assert from 'node:assert/strict'

const choices = (enabled = []) => Object.fromEntries(['mentions', 'payment_mismatch', 'billrun_exceptions', 'proposals'].map(event => [event, enabled.includes(event)]))
const content = mail => `${mail.subject} ${mail.text ?? ''} ${mail.html ?? ''}`
const recipients = mails => mails.flatMap(mail => [mail.to].flat()).sort()

// INT-003: preferences, event delivery and custody through the real HTTP doors.
export async function notificationsFlow(h, owner) {
  const initial = (await h.api('notifications', owner)).preferences
  const ownerPerson = { who: owner, email: (await h.api('me', owner)).email }
  const save = (who, enabled) => h.api('notification.preferences', who, choices(enabled))
  const invite = async (suffix, role) => {
    const email = `int003-${suffix}@example.test`
    const member = await h.api('access.give', owner, { email, name: `Notification ${suffix}`, role })
    return { ...member, email, who: await h.signIn(email, { requested: true }) }
  }
  await save(owner, ['mentions'])
  const finance = await invite('finance', 'finance')
  const quiet = await invite('quiet', 'finance')
  const accountant = await invite('accountant', 'accountant')
  const ended = await invite('ended', 'finance')
  await save(quiet.who, [])
  // Stored choices never grant approval/receivables capability to an accountant.
  await save(accountant.who, ['mentions', 'payment_mismatch', 'billrun_exceptions', 'proposals'])
  await save(ended.who, ['mentions', 'payment_mismatch', 'billrun_exceptions', 'proposals'])
  await h.api('access.end', owner, { member: ended.id })
  const credential = await h.api('credential.issue', owner, { name: 'INT003 preparation', scopes: ['prepare'] })
  const agent = { bearer: credential.key }

  const workingLink = async (mail, href, who) => {
    const expected = new URL(href, h.origin).href
    const links = [...(mail.html ?? '').matchAll(/href="([^"]+)"/g)].map(match => match[1].replaceAll('&amp;', '&'))
    assert.ok(links.includes(expected), 'mail links to the exact item, including its fragment')
    const target = new URL(expected)
    const html = await h.page(target.pathname + target.search, who)
    if (target.hash) assert.ok(html.includes(`id="${target.hash.slice(1)}"`), 'the linked record anchor exists')
    const signedOut = await h.raw(target.pathname + target.search)
    assert.equal(signedOut.status, 303)
    assert.equal(new URL(signedOut.headers.get('location'), h.origin).pathname, '/signin')
  }
  const alert = async (start, event, subject, href, people) => {
    const mails = h.mails.slice(start)
    assert.deepEqual(recipients(mails), people.map(person => person.email).sort(), 'one mail per active eligible subscriber only')
    assert.equal(mails.length, people.length)
    for (const person of people) {
      const mail = mails.find(message => [message.to].flat().includes(person.email))
      assert.doesNotMatch(content(mail), /\$\s*\d|\bUSD\b|\b(?:50|75|100|175)\.00\b|INT003-PRIVATE/, 'new alerts contain no financial figures or record body')
      await workingLink(mail, href, person.who)
      const rows = (await h.api('notifications', person.who)).deliveries.filter(row => row.event === event && row.subject === subject)
      assert.equal(rows.length, 1, 'one durable delivery per event and member')
      assert.equal(rows[0].href, href)
      assert.equal(rows[0].status, 'accepted', 'provider acceptance is saved, without claiming mailbox delivery')
      assert.equal(rows[0].provider_ref, `test-${h.mails.indexOf(mail) + 1}`, 'receipt is the actual mail-edge response')
    }
  }
  const customer = (await h.api('customer.create', owner, { external_id: 'INT003-ALERTS', name: 'Cedar Notifications', billing_email: 'ap@cedar.example' })).id
  const product = (await h.api('product.create', owner, { code: 'int003-flat', name: 'Notification platform' })).id
  const price = (await h.api('price.create', owner, { product, kind: 'flat', unit_amount: '100', taxable: false })).id
  const subscription = (await h.api('subscription.create', owner, { customer, start_date: '2025-01-01', price: [price] })).id
  const manual = async amount => {
    const charge = (await h.api('charge.add', owner, { customer, amount, description: 'INT003-PRIVATE service detail', taxable: false, effective_date: '2025-01-05' })).charge
    const invoice = (await h.api('invoice.manual', owner, { customer, charges: [charge], service_date: '2025-01-05' })).id
    await h.api('invoice.approve', owner, { invoice, acknowledge: true })
    await h.api('invoice.finalise', owner, { invoice, issue_date: '2025-01-05' })
    return invoice
  }
  const invoice = await manual('100')
  const secondInvoice = await manual('175')
  const payment = (amount, reference, target = customer) => h.api('payment.record', owner, { customer: target, amount, reference, received_on: '2025-01-06', method: 'bank_transfer', evidence: 'INT003-PRIVATE bank statement' })

  // Newly invited members receive mentions, but financial categories require opt-in.
  let start = h.mails.length
  const defaultNote = await h.api('note.add', owner, { kind: 'customer', record: customer, body: 'Default mention preference', mention: [finance.id, finance.id] })
  assert.deepEqual(recipients(h.mails.slice(start)), [finance.email])
  await workingLink(h.mails[start], `/app/customers/${customer}#notes`, finance.who)
  const firstMention = (await h.api(`notes/customer/${customer}`, finance.who)).find(note => note.id === defaultNote.note).mentions[0]
  assert.equal(firstMention.status, 'accepted')
  assert.equal(firstMention.provider_ref, `test-${start + 1}`)
  start = h.mails.length
  await payment('50', 'INT003-DEFAULT')
  assert.equal(h.mails.length, start, 'financial alerts start opted out')

  // Preferences are self-only even when a caller supplies another member id.
  const before = await h.api('notifications', finance.who)
  for (const spoof of [{ member: accountant.id }, { member_id: accountant.id }, { email: accountant.email }])
    await h.api('notification.preferences', finance.who, { ...choices([]), ...spoof }, 400)
  assert.deepEqual(await h.api('notifications', finance.who), before)
  assert.equal((await h.api('notifications', accountant.who)).preferences.mentions, true)
  await h.api('notifications', undefined, undefined, 401)
  await h.api('notification.preferences', undefined, choices([]), 401)
  await h.api('notifications', agent, undefined, 403)
  await h.api('notification.preferences', agent, choices(['mentions']), 403)
  await h.api('notifications', ended.who, undefined, 401)
  for (const request of [
    { body: choices([]) },
    { form: new URLSearchParams({ returnTo: '/app/more', mentions: 'on' }) },
  ]) {
    const path = request.body ? '/api/nectar/notification.preferences' : '/app/do/notification.preferences'
    assert.equal((await h.raw(path, { cookie: finance.who, ...request, headers: { origin: 'https://other.example' } })).status, 403)
  }
  assert.deepEqual(await h.api('notifications', finance.who), before, 'rejected writes leave preferences and receipts untouched')

  await save(owner, ['mentions', 'payment_mismatch'])
  await save(finance.who, ['mentions', 'payment_mismatch'])
  start = h.mails.length
  const short = await payment('50', 'INT003-SHORT')
  const paymentHref = `/app/customers/${customer}#payment-${short.payment}`
  await alert(start, 'payment_mismatch', short.payment, paymentHref, [ownerPerson, finance])
  await h.api('payment.record', owner, { customer, amount: '50', reference: 'INT003-SHORT', received_on: '2025-01-06', method: 'bank_transfer' }, 409)
  assert.equal(h.mails.length, start + 2, 'a refused duplicate payment cannot resend its alert')
  assert.ok(!(await h.api('notifications', accountant.who)).deliveries.some(row => row.subject === short.payment))
  assert.ok(!(await h.api('notifications', quiet.who)).deliveries.some(row => row.subject === short.payment))

  await save(finance.who, ['mentions'])
  start = h.mails.length
  const optedOut = await payment('50', 'INT003-OPTOUT')
  await alert(start, 'payment_mismatch', optedOut.payment, `/app/customers/${customer}#payment-${optedOut.payment}`, [ownerPerson])
  assert.ok(!(await h.api('notifications', finance.who)).deliveries.some(row => row.subject === optedOut.payment))
  assert.ok((await h.page('/app/settings',finance.who)).includes('/app/more#notifications'), 'settings links to member email choices')
  const more = await h.page('/app/more', finance.who)
  const form = more.match(/<form\b[^>]*action="\/app\/do\/notification\.preferences"[^>]*>[\s\S]*?<\/form>/)?.[0]
  assert.ok(form, 'More exposes the member preference form')
  for (const name of Object.keys(choices())) assert.ok(form.includes(`name="${name}"`))
  const saved = await h.submit('notification.preferences', finance.who, { mentions: 'on', payment_mismatch: 'on' }, '/app/more')
  assert.equal(saved.pathname, '/app/more')
  assert.deepEqual((await h.api('notifications', finance.who)).preferences, choices(['mentions', 'payment_mismatch']))
  start = h.mails.length
  const enabledAgain = await payment('50', 'INT003-REENABLED')
  await alert(start, 'payment_mismatch', enabledAgain.payment, `/app/customers/${customer}#payment-${enabledAgain.payment}`, [ownerPerson, finance])

  start = h.mails.length
  const matchingSecond = await payment('175', 'INT003-ANY-BALANCE')
  assert.equal(h.mails.length, start, 'matching any owed invoice suppresses mismatch mail')
  await h.api('credit.issue', owner, { invoice, amount: '25', reason: 'INT003-PRIVATE service adjustment' })
  const matchingBalance = await payment('75', 'INT003-CURRENT-BALANCE')
  assert.equal(h.mails.length, start, 'the current balance after credit, rather than original total, is matched')
  const oldTotal = await payment('100', 'INT003-ORIGINAL-TOTAL')
  await alert(start, 'payment_mismatch', oldTotal.payment, `/app/customers/${customer}#payment-${oldTotal.payment}`, [ownerPerson, finance])
  await h.api('payment.allocate', owner, { payment: matchingBalance.payment, invoice, amount: '75' })
  await h.api('payment.allocate', owner, { payment: matchingSecond.payment, invoice: secondInvoice, amount: '175' })
  start = h.mails.length
  await payment('1', 'INT003-NOTHING-OWED')
  const unbilled = (await h.api('customer.create', owner, { external_id: 'INT003-UNBILLED', name: 'Unbilled Cedar', billing_email: 'ap@unbilled.example' })).id
  await payment('1', 'INT003-NO-INVOICES', unbilled)
  assert.equal(h.mails.length, start, 'fully settled and never-invoiced customers generate no mismatch alerts')
  const pendingCharge = (await h.api('charge.add', owner, { customer: unbilled, amount: '100', description: 'Unissued service', taxable: false, effective_date: '2025-01-05' })).charge
  await h.api('invoice.manual', owner, { customer: unbilled, charges: [pendingCharge], service_date: '2025-01-05' })
  await payment('1', 'INT003-DRAFT-ONLY', unbilled)
  assert.equal(h.mails.length, start, 'draft invoices are not owed issued balances')

  // The three financial choices are independent; read-only members stay excluded.
  await save(owner, ['mentions', 'proposals'])
  start = h.mails.length
  const proposalInput = { kind: 'amendment', title: 'INT003-PRIVATE renewal terms', payload: { subscription, kind: 'discount_percent', value: '10', effective_from: '2025-02-01', note: 'INT003-PRIVATE commercial terms' }, evidence: { clauses: [{ quote: 'INT003-PRIVATE fee reduced ten percent from February.' }] } }
  const proposal = await h.api('proposal.create', agent, proposalInput)
  const proposalHref = `/app/proposals/${proposal.id}`
  await alert(start, 'proposals', proposal.id, proposalHref, [ownerPerson])
  await h.api('proposal.create', accountant.who, { kind: 'amendment', title: 'Cannot prepare', payload: {} }, 403)
  assert.ok(!(await h.api(`notifications?member=${(await h.api('me', owner)).id}`, finance.who)).deliveries.some(row => row.subject === proposal.id), 'a query cannot reveal another member delivery log')
  const ownerPage = await h.page('/app/more', owner)
  const financePage = await h.page('/app/more', finance.who)
  assert.ok(ownerPage.includes(proposalHref))
  assert.ok(!financePage.includes(proposalHref))
  assert.ok(financePage.includes(paymentHref))
  assert.ok(!(await h.page('/app/more', accountant.who)).includes(paymentHref))

  // Provider rejection and uncertain submission remain distinct from acceptance.
  const unsuccessful = []
  for (const [status, outcome] of [[400, 'rejected'], [500, 'uncertain']]) {
    start = h.mails.length
    h.mailResponses.push({ status, body: { name: 'provider_error' } })
    const item = await h.api('proposal.create', agent, { ...proposalInput, title: `INT003-PRIVATE ${outcome} submission` })
    unsuccessful.push(item.id)
    assert.deepEqual(recipients(h.mails.slice(start)), [ownerPerson.email])
    await workingLink(h.mails[start], `/app/proposals/${item.id}`, owner)
    const receipt = (await h.api('notifications', owner)).deliveries.find(row => row.event === 'proposals' && row.subject === item.id)
    assert.equal(receipt.status, outcome)
    assert.equal(receipt.provider_ref, null, 'an unsuccessful submission has no acceptance receipt')
  }
  const custody = (await h.api('notifications', owner)).deliveries
  start = h.mails.length
  for (let tick = 0; tick < 2; tick++) {
    const response = await h.raw(`/cdn-cgi/local/scheduled?time=${Date.parse('2026-07-10T14:00:00Z')}&cron=${encodeURIComponent('0 14 * * *')}`)
    assert.equal(response.status, 200, await response.text())
  }
  assert.equal(h.mails.slice(start).filter(mail => [proposal.id, ...unsuccessful].some(id => content(mail).includes(`/app/proposals/${id}`))).length, 0, 'scheduled recovery never retries accepted, rejected or uncertain sends')
  assert.deepEqual((await h.api('notifications', owner)).deliveries, custody, 'recovery preserves the original provider outcomes')

  await save(finance.who, ['mentions', 'billrun_exceptions'])
  start = h.mails.length
  // Earlier than other journey subscriptions, so this is an isolated clean run.
  const clean = await h.api('billrun.prepare', owner, { period: '2025-01' })
  assert.deepEqual(clean.summary.exceptions, {})
  assert.equal(h.mails.length, start, 'clean runs do not send exception alerts')
  const meter = (await h.api('meter.create', owner, { code: 'int003-meter', name: 'INT003-PRIVATE readings', unit_label: 'readings' })).id
  const meteredProduct = (await h.api('product.create', owner, { code: 'int003-usage', name: 'INT003-PRIVATE processing' })).id
  const unit = (await h.api('price.create', owner, { product: meteredProduct, kind: 'unit', unit_amount: '1', meter, taxable: false })).id
  await h.api('subscription.create', owner, { customer: unbilled, start_date: '2025-01-01', price: [unit] })
  const run = await h.api('billrun.prepare', owner, { period: '2025-01' })
  assert.ok(run.summary.exceptions.missing_usage > 0, 'the event comes from a real billing exception')
  await alert(start, 'billrun_exceptions', run.id, `/app/billing/${run.id}`, [finance])
  assert.ok(!(await h.api('notifications', owner)).deliveries.some(row => row.subject === run.id))
  assert.ok((await h.page('/app/more', finance.who)).includes(`/app/billing/${run.id}`))
  assert.ok(!(await h.page('/app/more', owner)).includes(`/app/billing/${run.id}`))

  // Mention opt-out is separately recorded on the immutable note; re-enable works.
  await save(finance.who, ['billrun_exceptions'])
  await save(accountant.who, ['payment_mismatch', 'billrun_exceptions', 'proposals'])
  start = h.mails.length
  const suppressed = await h.api('note.add', owner, { kind: 'customer', record: customer, body: 'Opted-out internal note', mention: [finance.id, accountant.id, quiet.id] })
  assert.equal(h.mails.length, start)
  const suppressedNote = (await h.api(`notes/customer/${customer}`, owner)).find(note => note.id === suppressed.note)
  assert.equal(suppressedNote.mentions.length, 3)
  for (const mention of suppressedNote.mentions) {
    assert.equal(mention.status, 'suppressed')
    assert.equal(mention.provider_ref, null)
  }
  await save(accountant.who, ['mentions', 'payment_mismatch', 'billrun_exceptions', 'proposals'])
  const restored = await h.api('note.add', owner, { kind: 'customer', record: customer, body: 'Restored accountant mention', mention: [accountant.id, accountant.id, finance.id] })
  assert.deepEqual(recipients(h.mails.slice(start)), [accountant.email])
  await workingLink(h.mails[start], `/app/customers/${customer}#notes`, accountant.who)
  const restoredMentions = (await h.api(`notes/customer/${customer}`, owner)).find(note => note.id === restored.note).mentions
  assert.equal(restoredMentions.find(mention => mention.member_id === accountant.id).status, 'accepted')
  assert.equal(restoredMentions.find(mention => mention.member_id === accountant.id).provider_ref, `test-${start + 1}`)
  assert.equal(restoredMentions.find(mention => mention.member_id === finance.id).status, 'suppressed')
  assert.ok(!(await h.api('notifications', accountant.who)).deliveries.length, 'accountants receive mentions but no financial alerts even with all categories enabled')

  await h.api('notification.preferences', owner, initial)
  for (const person of [finance, quiet, accountant]) await h.api('access.end', owner, { member: person.id })
  await h.api('credential.revoke', owner, { key: credential.id })
  console.log('INT-003 member email choices, independent event alerts, exact private links, provider receipts and mention suppression passed')
  return { customer, subscription, invoice, proposal: proposal.id, run: run.id }
}
