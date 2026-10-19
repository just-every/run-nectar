import assert from 'node:assert/strict'

// CUS-002 / INT-003 mention-mail slice: internal history is append-only; mentions cross only the mail edge.
export async function notesFlow(h, owner) {
  const customer = (await h.api('customer.create', owner, { external_id: 'CUS002-NOTES', name: 'Willow Research', billing_email: 'ap@willow.example' })).id
  const other = (await h.api('customer.create', owner, { external_id: 'CUS002-OTHER', name: 'Unrelated Research', billing_email: 'ap@unrelated.example' })).id
  const charge = (await h.api('charge.add', owner, { customer, amount: '125', description: 'Research workshop', taxable: false, effective_date: '2026-01-05' })).charge
  const invoiceId = (await h.api('invoice.manual', owner, { customer, charges: [charge], service_date: '2026-01-05' })).id
  const reference = 'CUS002-WIRE-14'
  const payment = (await h.api('payment.record', owner, { customer, amount: '125', received_on: '2026-01-06', method: 'bank_transfer', reference })).payment
  const financeEmail = 'notes-finance@example.test', accountantEmail = 'notes-accountant@example.test'
  const financeMember = await h.api('access.give', owner, { email: financeEmail, name: 'Notes Finance', role: 'finance' })
  const accountantMember = await h.api('access.give', owner, { email: accountantEmail, name: 'Notes Accountant', role: 'accountant' })
  const inactive = await h.api('access.give', owner, { email: 'notes-ended@example.test', name: 'Former Notes Operator', role: 'finance' })
  const finance = await h.signIn(financeEmail, { requested: true })
  const accountant = await h.signIn(accountantEmail, { requested: true })
  await h.api('access.end', owner, { member: inactive.id })
  const credential = await h.api('credential.issue', owner, { name: 'Notes preparation', scopes: ['prepare'] })
  const agent = { bearer: credential.key }
  const ownerEmail = (await h.api('me', owner)).email
  const members = await h.api('note-members', finance)
  assert.ok(members.some(m => m.id === financeMember.id && m.email === financeEmail && m.name === 'Notes Finance'))
  assert.ok(members.some(m => m.id === accountantMember.id && m.email === accountantEmail))
  assert.ok(!members.some(m => m.id === inactive.id), 'ended members cannot be selected for mention')

  const customerPath = `/app/customers/${customer}#notes`, invoicePath = `/app/invoices/${invoiceId}#notes`
  const body = 'Discussed renewal, "priority" account.\n<script>alert("CUS002")</script> & follow up.'
  const started = Date.now()
  let mailStart = h.mails.length
  const added = await h.api('note.add', owner, { kind: 'customer', record: customer, body, mention: [financeMember.id, accountantMember.id, financeMember.id] })
  assert.equal(added.id, customer)
  assert.ok(added.note)
  const customerMails = h.mails.slice(mailStart)
  assert.equal(customerMails.length, 2, 'one email per distinct mention')
  for (const email of [financeEmail, accountantEmail]) {
    const delivered = customerMails.filter(mail => [mail.to].flat().includes(email))
    assert.equal(delivered.length, 1)
    assert.ok(`${delivered[0].html ?? ''} ${delivered[0].text ?? ''}`.includes(customerPath))
  }
  const initial = await h.api(`notes/customer/${customer}`, owner)
  assert.equal(initial.length, 1)
  const saved = initial[0]
  assert.equal(saved.id, added.note)
  assert.equal(saved.kind, 'customer')
  assert.equal(saved.record_id, customer)
  assert.equal(saved.body, body)
  assert.equal(saved.author, ownerEmail)
  const created = typeof saved.created_at === 'number' ? saved.created_at : Date.parse(saved.created_at)
  assert.ok(created >= started && created <= Date.now(), 'server records the creation date')
  assert.deepEqual(saved.mentions.map(m => m.member_id).sort(), [financeMember.id, accountantMember.id].sort())
  for (const mention of saved.mentions) {
    assert.equal(mention.email, mention.member_id === financeMember.id ? financeEmail : accountantEmail)
    assert.equal(mention.status, 'accepted')
    assert.match(mention.provider_ref, /^test-\d+$/)
  }

  const followUp = await h.api('note.add', finance, { kind: 'customer', record: customer, body: 'Follow-up: finance confirmed the renewal call.', mention: [] })
  mailStart = h.mails.length
  const invoiceNote = await h.api('note.add', finance, { kind: 'invoice', record: invoiceId, body: 'Invoice query <img src=x onerror=alert("CUS002")> resolved.', mention: [accountantMember.id] })
  const invoiceMails = h.mails.slice(mailStart)
  assert.equal(invoiceMails.length, 1)
  assert.ok(`${invoiceMails[0].html ?? ''} ${invoiceMails[0].text ?? ''}`.includes(invoicePath))
  mailStart = h.mails.length
  const paymentNote = await h.api('note.add', owner, { kind: 'payment', record: payment, body: 'Bank confirmed this transfer; retain its reference.', mention: [financeMember.id] })
  const paymentMails = h.mails.slice(mailStart)
  assert.equal(paymentMails.length, 1)
  assert.ok(`${paymentMails[0].html ?? ''} ${paymentMails[0].text ?? ''}`.includes(customerPath))
  assert.ok(`${paymentMails[0].subject} ${paymentMails[0].text ?? ''}`.includes(reference), 'payment mention identifies the transfer')
  assert.equal(invoiceNote.id, customer)
  assert.equal(paymentNote.id, customer)
  const notes = (await h.api(`customers/${customer}`, owner)).notes
  assert.deepEqual(notes.map(n => n.id).sort(), [added.note, followUp.note, invoiceNote.note, paymentNote.note].sort())
  assert.deepEqual(notes.find(n => n.id === added.note), saved, 'follow-up preserves original body, author, date and mention receipts')
  assert.equal(notes.find(n => n.id === followUp.note).author, financeEmail)
  assert.deepEqual((await h.api(`notes/invoice/${invoiceId}`, owner)).map(n => n.id), [invoiceNote.note])
  assert.deepEqual((await h.api(`notes/payment/${payment}`, owner)).map(n => n.id), [paymentNote.note])
  assert.deepEqual((await h.api(`customers/${other}`, owner)).notes, [])
  assert.deepEqual(await h.api(`notes/customer/${other}`, owner), [])

  // Rejected mentions and spoofed identities cannot leave a partial note or mail.
  mailStart = h.mails.length
  for (const mention of [[financeMember.id, inactive.id], [financeMember.id, 'missing-member']])
    await h.api('note.add', owner, { kind: 'customer', record: customer, body: 'Must not be saved', mention }, 400)
  for (const spoof of [{ id: added.note }, { note: added.note }, { customer: other }])
    await h.api('note.add', owner, { kind: 'invoice', record: invoiceId, body: 'Must not overwrite or move', mention: [], ...spoof }, 400)
  await h.api('note.add', owner, { kind: 'customer', record: customer, body: '   ', mention: [] }, 400)
  for (const action of ['note.update', 'note.remove'])
    await h.api(action, owner, { note: added.note, body: 'Changed' }, 404)
  assert.equal(h.mails.length, mailStart)
  assert.deepEqual((await h.api(`customers/${customer}`, owner)).notes, notes)

  for (const who of [accountant, agent]) {
    assert.deepEqual((await h.api(`customers/${customer}`, who)).notes, notes)
    assert.deepEqual(await h.api(`notes/payment/${payment}`, who), notes.filter(n => n.kind === 'payment'))
    await h.api('note.add', who, { kind: 'customer', record: customer, body: 'Forbidden write', mention: [] }, 403)
  }
  for (const path of ['note-members', `notes/customer/${customer}`, `notes/invoice/${invoiceId}`, `notes/payment/${payment}`])
    await h.api(path, undefined, undefined, 401)
  await h.api('note.add', undefined, { kind: 'customer', record: customer, body: 'Private', mention: [] }, 401)
  const signedOut = await h.raw('/app/exports/customers.csv')
  assert.equal(signedOut.status, 303)
  assert.match(signedOut.headers.get('location'), /\/signin/)

  const customerHtml = await h.page(`/app/customers/${customer}`, accountant)
  const invoiceHtml = await h.page(`/app/invoices/${invoiceId}`, accountant)
  assert.ok(customerHtml.includes('&lt;script&gt;'))
  assert.ok(!customerHtml.includes('<script>alert("CUS002")</script>'))
  assert.ok(invoiceHtml.includes('&lt;img'))
  assert.ok(!invoiceHtml.includes('<img src=x onerror='))
  assert.ok(customerHtml.includes('Follow-up: finance confirmed'))
  assert.ok(customerHtml.includes('Bank confirmed this transfer'))
  assert.ok(invoiceHtml.includes('Invoice query'))

  const exported = await h.raw('/app/exports/customers.csv', { cookie: accountant })
  assert.equal(exported.status, 200)
  assert.match(exported.headers.get('content-type'), /text\/csv/)
  const csv = await exported.text()
  // Parse quoted CSV so commas, newlines and quotes in the note body round-trip.
  const rows = []; let row = [], value = '', quoted = false
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i]
    if (char === '"') {
      if (quoted && csv[i + 1] === '"') { value += '"'; i++ } else quoted = !quoted
    } else if (char === ',' && !quoted) { row.push(value); value = '' }
    else if (char === '\n' && !quoted) { row.push(value.replace(/\r$/, '')); rows.push(row); row = []; value = '' }
    else value += char
  }
  const header = rows.shift(), notesColumn = header.indexOf('notes_json')
  assert.ok(notesColumn >= 0)
  const customerRow = rows.find(r => r.includes('CUS002-NOTES'))
  const otherRow = rows.find(r => r.includes('CUS002-OTHER'))
  assert.ok(customerRow && otherRow)
  assert.deepEqual(JSON.parse(customerRow[notesColumn]), notes)
  assert.deepEqual(JSON.parse(otherRow[notesColumn]), [])
  const audit = await h.api('audit', owner)
  for (const note of notes) {
    const event = audit.find(e => e.action === 'note.add' && e.subject === note.id)
    assert.ok(event, `audit retains note ${note.id}`)
    assert.equal(event.actor, note.author)
  }
  await h.api('credential.revoke', owner, { key: credential.id })
  console.log('CUS-002 / INT-003 append-only customer, invoice and payment notes, mention receipts, privacy and export passed')
  return { customer, invoiceId, paths: [customerPath, invoicePath] }
}
