import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'

const pdfText = bytes => [...bytes.toString('latin1').matchAll(/<([0-9a-f]+)> Tj/g)].map(m => Buffer.from(m[1], 'hex').toString('latin1')).join('\n')

// Runs inside the existing customer-session flow and through the built Worker.
export async function portalReceiptsFlow(h, owner, { onState } = {}) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  const previousClock = h.vars.NECTAR_LOCAL_TIME
  const at = '2026-10-21T09:00:00Z'
  await h.advanceClock(at)
  await api('portal.configure', { hosts: [h.origin], parents: [] })
  const make = async (n, language = 'en') => (await api('customer.create', {
    external_id: `synthetic-nectar-receipt-${n}`, name: ['Northwind Robotics','Pinecrest Labs','Larch Studio'][n - 1],
    billing_email: `synthetic-nectar-receipt-${n}` + '@' + 'example.test', language,
  })).id
  const own = await make(1), foreign = await make(2), empty = await make(3)
  const issue = customer => api('portal.session.issue', { customer, origin: h.origin, audience: 'hosted' })
  const invoice = async (customer, n) => {
    const charge = await api('charge.add', { customer, amount: '10', description: `Receipt service ${n}`, effective_date: '2026-10-01', taxable: false })
    const draft = await api('invoice.manual', { customer, charges: [charge.charge], service_date: '2026-10-01' })
    await api('invoice.approve', { invoice: draft.id, acknowledge: true })
    await api('invoice.finalise', { invoice: draft.id, issue_date: '2026-10-02' })
    return api(`invoices/${draft.id}`)
  }
  const invoices = [await invoice(own, 1), await invoice(own, 2)], foreignInvoice = await invoice(foreign, 3)
  const record = async (customer, amount, n) => (await api('payment.record', {
    customer, amount, method: 'bank_transfer', received_on: '2026-10-03',
    reference: `synthetic-nectar-private-reference-${n}`, evidence: `synthetic-nectar-private-bank-evidence-${n}`,
  })).payment
  const allocated = await record(own, '25', 1), unallocated = await record(own, '7.50', 2), other = await record(foreign, '18', 3)
  await api('balance.return', { customer: own, payment: unallocated, amount: '2.50', reason: 'Recorded cash returned', reference: 'synthetic-nectar-private-return' })
  const initial = await api(`payments/${allocated}/receipt`)
  for (const saved of invoices) await api('payment.allocate', { payment: allocated, invoice: saved.id, amount: '10' })
  await api('payment.allocate', { payment: allocated, invoice: foreignInvoice.id, amount: '1' }, 409)
  const session = await issue(own), foreignSession = await issue(foreign), emptySession = await issue(empty)
  const path = (token, id, format) => `/portal/receipts${id ? `/${id}` : ''}?session=${encodeURIComponent(token)}${format ? '&format=pdf' : ''}`
  const load = async (token, id, format) => {
    const response = await h.raw(path(token, id, format))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
    if (!format) return response.text()
    assert.equal(response.headers.get('content-type'), 'application/pdf')
    assert.match(response.headers.get('content-disposition'), /^attachment; filename=RCT-\d+\.pdf$/)
    const bytes = Buffer.from(await response.arrayBuffer())
    assert.match(bytes.toString('latin1'), /^%PDF-1.4/)
    const xref = Number(bytes.toString('latin1').match(/startxref\n(\d+)/)[1])
    assert.equal(bytes.subarray(xref, xref + 4).toString(), 'xref', 'Downloaded PDF has usable cross references')
    return pdfText(bytes)
  }
  const ledger = (await api(`customers/${own}`)).ledger
  assert.equal(ledger.payments.reduce((sum, p) => sum + p.amount_cents, 0), 3250)
  assert.equal(ledger.paidCents, 2000); assert.equal(ledger.unallocatedCents, 1000)
  const receipt = await api(`payments/${allocated}/receipt`), unused = await api(`payments/${unallocated}/receipt`), foreignReceipt = await api(`payments/${other}/receipt`)
  assert.equal(receipt.returnedCents, 0)
  assert.equal(unused.returnedCents, 250)
  assert.equal(unused.unallocatedCents, 500)
  assert.equal(receipt.number, initial.number, 'Allocation keeps the original receipt identity')
  for (const format of [false, true]) {
    const text = await load(session.token, allocated, format)
    for (const value of [initial.number, 'USD 25.00', 'USD 20.00', 'USD 5.00', 'October 3, 2026', ...invoices.map(i => i.number)]) assert.ok(text.includes(value), `Allocated receipt preserves ${value}`)
    assert.match(text, /does not confirm processor settlement/)
    assert.doesNotMatch(text, /synthetic-nectar-private|provider_ref|recorded_by|payment_intent|Pinecrest Labs/)
    assert.ok(!text.includes(foreignReceipt.number)); assert.ok(!text.includes(foreignInvoice.id))
    const cash = await load(session.token, unallocated, format)
    for (const value of [unused.number, 'USD 7.50', 'USD 2.50', 'USD 5.00', 'USD 0.00']) assert.ok(cash.includes(value))
    assert.ok(!cash.includes(invoices[0].number), 'Unallocated cash invents no invoice allocation')
  }
  const overview = await load(session.token)
  for (const value of [receipt.number, unused.number]) assert.ok(overview.includes(value))
  assert.ok((await h.page(`/portal?session=${session.token}`)).includes('/portal/receipts?session='), 'Receipts are reachable from the billing overview')
  assert.match(await load(emptySession.token), /No recorded receipts/)
  const audit = await api('audit')
  await load(session.token, allocated); await load(session.token, allocated, true)
  assert.deepEqual(await api('audit'), audit, 'Receipt views never mutate custody')
  await onState?.({ label: 'billing-overview', path: `/portal?session=${session.token}` })
  await onState?.({ label: 'issued-invoice', path: `/portal/invoices/${invoices[0].id}?session=${session.token}` })
  await onState?.({ label: 'english-list', path: path(session.token), number: receipt.number })
  await onState?.({ label: 'english-allocated', path: path(session.token, allocated), number: receipt.number, pdfPath: path(session.token, allocated, true) })
  await onState?.({ label: 'english-unallocated', path: path(session.token, unallocated), number: unused.number, pdfPath: path(session.token, unallocated, true) })
  await onState?.({ label: 'empty', path: path(emptySession.token) })
  const ownRecord = await api(`customers/${own}`)
  await api('customer.update', { customer: own, revision: ownRecord.revision, name: ownRecord.name, billing_email: ownRecord.billing_email, language: 'es-US' })
  for (const format of [false, true]) {
    const text = await load(session.token, allocated, format)
    for (const value of [receipt.number, 'USD 25.00', 'USD 20.00', 'USD 5.00', '3 de octubre de 2026', 'no confirma la liquidación']) assert.ok(text.includes(value), `Spanish receipt preserves ${value}`)
  }
  await onState?.({ label: 'spanish-allocated', path: path(session.token, allocated), number: receipt.number, pdfPath: path(session.token, allocated, true) })
  await onState?.({ label: 'spanish-list', path: path(session.token), number: receipt.number })
  await onState?.({ label: 'spanish-unallocated', path: path(session.token, unallocated), number: unused.number, pdfPath: path(session.token, unallocated, true) })

  const refusal = async (token, id, status) => {
    for (const format of [false, true]) {
      const response = await h.raw(path(token, id, format))
      assert.equal(response.status, status)
      const text = await response.text()
      assert.ok(!text.includes(receipt.number)); assert.ok(!text.includes('USD 25.00'))
      assert.notEqual(response.headers.get('content-type'), 'application/pdf')
    }
  }
  await refusal(foreignSession.token, allocated, 404)
  await refusal(session.token, other, 404)
  const selector = await h.raw(path(session.token, allocated) + `&customer=${foreign}`)
  assert.equal(selector.status, 200)
  assert.ok((await selector.text()).includes(receipt.number), 'A query selector cannot switch receipt ownership')
  await refusal(session.token, 'unknown', 404)
  await refusal('altered', allocated, 401)
  assert.equal((await h.raw(`/portal/receipts/${allocated}?format=pdf`, { cookie: owner })).status, 401)
  const [body] = session.token.split('.'), claims = JSON.parse(Buffer.from(body, 'base64url'))
  const forgedBody = Buffer.from(JSON.stringify({ ...claims, customer: foreign })).toString('base64url')
  const forged = `${forgedBody}.${createHmac('sha256', h.vars.PORTAL_KEY).update(`nectar-portal-v1.${forgedBody}`).digest('base64url')}`
  await refusal(forged, other, 401)
  for (const format of [false, true]) {
    assert.equal((await h.raw(path(session.token, allocated, format), { method: 'POST', body: {} })).status, 405)
    const head = await h.raw(path(session.token, allocated, format), { method: 'HEAD' })
    assert.equal(head.status, 200); assert.equal(await head.text(), '')
  }
  const revoked = await issue(own)
  await api('portal.session.revoke', { session: revoked.id })
  await refusal(revoked.token, allocated, 401)
  const expiry = await issue(own)
  await h.advanceClock(new Date(expiry.expiresAt).toISOString())
  await refusal(expiry.token, allocated, 401)
  await h.advanceClock(at)
  const beforeErasure = await issue(own)
  await api('erasure.request', { customer: own })
  const mail = h.mails.findLast(m => String(m.text).includes('/erase/'))
  const erase = new URL(mail.text.match(/https?:\/\/[^\s]+\/erase\/[a-f0-9]+/)[0]).pathname
  assert.equal((await h.raw(erase, { form: new URLSearchParams({ confirm: 'yes' }) })).status, 200)
  await api('erasure.approve', { request: (await api('erasures')).find(r => r.customer_id === own).id, confirm: true })
  await refusal(beforeErasure.token, allocated, 401)
  await onState?.({ label: 'erased-session', path: path(beforeErasure.token, allocated), status: 401 })
  assert.ok((await load(foreignSession.token, other)).includes(foreignReceipt.number), 'Erasure leaves the unrelated receipt available')
  await api('portal.session.issue', { customer: own, origin: h.origin, audience: 'hosted' }, 404)
  if (previousClock) await h.advanceClock(previousClock)
  console.log('Customer receipt HTML and PDF preserve cash custody, language and session isolation')
}
