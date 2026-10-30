// Public Worker and D1 journey; only Stripe's network boundary is simulated.
import assert from 'node:assert/strict'
import { nativeCollectionEdge } from './native-collection.mjs'
import { file } from './harness.mjs'
import { totp } from './mfa.mjs'

const edge = nativeCollectionEdge()
let inventory = 'expired', observedMethod = 'synthetic-nectar-native-card-1'
const fetch = async request => {
  const path = new URL(request.url).pathname
  if (path === '/v1/payment_methods') {
    const type = new URL(request.url).searchParams.get('type')
    return Response.json({ object: 'list', has_more: false, data: type === 'card' ? [{ object: 'payment_method', id: observedMethod,
      customer: 'synthetic-nectar-native-customer-1', livemode: false, type: 'card',
      card: { brand: 'visa', last4: '4242', exp_month: 9, exp_year: inventory === 'expired' ? 2026 : 2035 } }] : [] })
  }
  const response = await edge.fetch(request)
  if (path.startsWith('/v1/payment_methods/')) {
    const method = await response.json()
    if (method.card) Object.assign(method.card, { exp_month: 9, exp_year: 2026 })
    return Response.json(method, { status: response.status })
  }
  return response
}
export const harnessOptions = () => ({ stripeFetch: fetch, stripeSecret: 'synthetic-nectar-1' })

export async function collectionDiagnosisFlow(h, owner, { onState = async () => {}, approve } = {}) {
  let instant = Date.parse('2026-10-22T10:00:00Z')
  const clock = async value => { instant = Date.parse(value); await h.advanceClock(value); edge.capturedAt(value) }
  await clock('2026-10-22T10:00:00Z')
  const api = (path, body, status) => h.api(path, owner, body, status)
  await api('business.configure', { ...await api('business'), timezone: 'UTC', payment_terms_days: 0 })
  const customer = (await api('customer.create', { external_id: 'synthetic-nectar-301', name: 'Synthetic collection account', billing_email: address(301) })).id
  const other = (await api('customer.create', { external_id: 'synthetic-nectar-302', name: 'Synthetic other account', billing_email: address(302) })).id
  const invoice = async (target = customer) => {
    const charge = await api('charge.add', { customer: target, amount: '100', description: 'Synthetic collection source', effective_date: '2026-10-20', taxable: false })
    const draft = await api('invoice.manual', { customer: target, charges: [charge.charge], service_date: '2026-10-20' })
    await api('invoice.approve', { invoice: draft.id, acknowledge: true })
    await api('invoice.finalise', { invoice: draft.id, issue_date: '2026-10-20' })
    return api(`invoices/${draft.id}`)
  }
  const failed = await invoice(), unproved = await invoice(), foreign = await invoice(other)
  const factor = await api('mfa.totp.start', {})
  await api('mfa.totp.confirm', { factor: factor.factor, code: totp(factor.secret, instant) })
  await api('mfa.policy', { scope: 'all' })
  const binding = await api('collection.customer.bind', { customer, account_ref: 'synthetic-nectar-native-account-1', stripe_customer_ref: 'synthetic-nectar-native-customer-1', confirm: true })
  const prepared = await api('collection.prepare', { invoice: failed.id })
  edge.refuseNext('card_declined', 'expired_card')
  const refusal = await api('collection.confirm', prepared.instructions.confirm)
  assert.equal(refusal.status, 'declined')
  assert.equal(refusal.proof.declineCode, 'expired_card')
  const credential = await api('credential.issue', { name: 'Synthetic collection investigator', scopes: ['prepare'] })
  const agent = { bearer: credential.key }
  const propose = (target = customer, payload = {}, status = 200) => h.api('proposal.create', agent, {
    kind: 'collection', title: 'Review collection request', payload: { customer: target, ...payload },
  }, status)
  const detail = id => api(`proposals/${id}`)
  const diagnosis = row => row.impact.diagnoses.find(value => value.invoice === failed.id)
  const noticeCount = async () => (await api('notices')).length
  const taskCount = async () => (await api('tasks')).length
  const writes = () => edge.calls.filter(call => call.method === 'POST').length
  const refresh = () => api('customer.payment_methods.refresh', { customer })

  // Expiry on an invoice cannot be inferred from the method date alone.
  const absent = await propose()
  assert.equal(diagnosis(await detail(absent.id)).cause, 'unknown')
  await refresh()
  const freshRace = await Promise.all([propose(), propose()])
  assert.equal(freshRace[0].id, freshRace[1].id, 'Concurrent first preparation has one exact-source claim')
  const known = freshRace[0], review = await detail(known.id), found = diagnosis(review)
  assert.equal(found.cause, 'expired_card')
  assert.deepEqual(found.card, { brand: 'visa', last4: '4242', expMonth: 9, expYear: 2026 })
  assert.equal(found.citations.find(c => c.kind === 'invoice').record, failed.id)
  assert.equal(found.citations.find(c => c.kind === 'payment_failure').record, refusal.id)
  assert.equal(found.citations.find(c => c.kind === 'payment_failure').intent, refusal.payment_intent_ref)
  assert.equal(found.citations.find(c => c.kind === 'payment_method').record, (await api(`customers/${customer}`)).billingRecord.savedPaymentMethods[0].snapshot)
  assert.equal(review.impact.diagnoses.find(value => value.invoice === unproved.id).cause, 'unknown')
  assert.ok(review.impact.diagnoses.every(value => value.invoice !== foreign.id))
  assert.ok(review.payload.body.includes(failed.number) && review.payload.body.includes('card ending 4242 expired'))
  assert.ok(!review.payload.body.includes(`invoice ${unproved.number} was declined`))
  assert.equal(review.payload.recipient, address(301))
  const read = await h.api(`customers/${customer}/collection-diagnosis`, agent)
  assert.equal(read.diagnoses.find(value => value.invoice === failed.id).cause, 'expired_card')
  await h.api(`customers/${customer}/collection-diagnosis`, undefined, undefined, 401)
  await propose(customer, { recipient: address(302) }, 409)
  await propose(customer, { body: 'Unsupported invented payment cause' }, 409)
  const counts = [await noticeCount(), await taskCount(), writes(), h.mails.length]
  const concurrent = await Promise.all([1, 2].map(() => propose()))
  assert.ok(concurrent.every(value => value.id === known.id), 'Replayed and concurrent exact-source preparation returns one proposal')
  await h.api('proposal.decide', agent, { proposal: known.id, decision: 'approved' }, 403)
  for (const changed of [{ recipient: address(302) }, { subject: 'Unreviewed subject' }, { body: 'Unreviewed demand' }]) {
    await api('proposal.decide', { proposal: known.id, decision: 'approved', ...changed }, 409)
  }
  assert.deepEqual([await noticeCount(), await taskCount(), writes(), h.mails.length], counts)
  await onState({ label: 'expired-card-review', customer, proposal: known.id, review })
  await h.rejectAudit('proposal.approve')
  await api('proposal.decide', { proposal: known.id, decision: 'approved' }, 500)
  await h.rejectAudit(null)
  assert.equal((await detail(known.id)).status, 'pending')
  assert.deepEqual([await noticeCount(), await taskCount()], counts.slice(0, 2), 'Audit failure rolls back the decision, reminder and follow-up task')
  const approved = approve ? await approve({ proposal: known.id, review }) : await api('proposal.decide', { proposal: known.id, decision: 'approved', recipient: review.payload.recipient, subject: review.payload.subject, body: review.payload.body })
  assert.equal((await detail(known.id)).status, 'approved')
  assert.deepEqual((await api(`invoices/${failed.id}`)).calculation, failed.calculation, 'Reminder approval preserves issued financial evidence')
  assert.equal((await api(`invoices/${failed.id}`)).balanceCents, 10000)
  await api('proposal.decide', { proposal: known.id, decision: 'approved' }, 409)
  const notice = (await api('notices')).find(row => row.id === approved.notice)
  assert.deepEqual([notice.recipient, notice.subject, notice.body], [review.payload.recipient, review.payload.subject, review.payload.body])
  assert.deepEqual([await noticeCount(), await taskCount()], [counts[0] + 1, counts[1] + 1])
  const exportedText = await h.page(`/app/notices/${notice.id}.txt`, owner)
  assert.ok(exportedText.includes(`To: ${address(301)}`) && exportedText.includes(review.payload.body))
  await h.page(`/app/notices/${notice.id}.txt`, owner)
  assert.equal((await propose()).id, known.id, 'Approval and repeated download confer no new proposal or send')
  assert.deepEqual([writes(), h.mails.length], counts.slice(2), 'Approval only exports a reviewed reminder; no provider POST or customer mail')
  await onState({ label: 'approved-download', customer, proposal: known.id, notice: notice.id })

  // Conflicting, missing, and stale observations yield unknown and invalidate review.
  inventory = 'future'
  await refresh()
  const conflict = await propose(), conflictDetail = await detail(conflict.id)
  assert.equal(diagnosis(conflictDetail).cause, 'unknown')
  assert.ok(!conflictDetail.payload.body.includes('card ending 4242 expired'))
  assert.equal((await detail(absent.id)).stale, true)
  await api('proposal.decide', { proposal: absent.id, decision: 'approved' }, 409)
  await h.page(`/app/notices/${notice.id}.txt`, owner, 409)
  observedMethod = 'synthetic-nectar-native-card-4'
  inventory = 'expired'; await refresh()
  const mismatch = await propose()
  assert.equal(diagnosis(await detail(mismatch.id)).cause, 'unknown')
  observedMethod = 'synthetic-nectar-native-card-1'; await refresh()
  const current = await propose()
  await clock('2026-10-22T10:16:00Z')
  assert.equal((await detail(current.id)).stale, true)
  const old = await propose()
  assert.equal(diagnosis(await detail(old.id)).cause, 'unknown')
  await api('proposal.decide', { proposal: current.id, decision: 'approved' }, 409)
  await onState({ label: 'stale-evidence', customer, proposal: current.id })

  await api('mfa.verify', { code: totp(factor.secret, instant) })

  // A changed contact or balance cannot approve an old request.
  const recipient = await propose()
  const c = await api(`customers/${customer}`)
  await api('customer.update', { customer, revision: c.revision, name: c.name, billing_email: address(303) })
  await api('proposal.decide', { proposal: recipient.id, decision: 'approved' }, 409)
  const beforeFailedCreate = await api('proposals')
  await h.rejectAudit('proposal.create')
  await propose(customer, {}, 500)
  await h.rejectAudit(null)
  assert.deepEqual(await api('proposals'), beforeFailedCreate, 'A failed preparation audit leaves no proposal or source claim')
  const balanced = await propose()
  await api('credit.issue', { invoice: unproved.id, amount: '10', reason: 'Synthetic approved correction' })
  await api('proposal.decide', { proposal: balanced.id, decision: 'approved' }, 409)

  // A dispute on any invoice stops the account, including its other invoice
  // and the undisputed remainder. A later dispute also blocks downloads.
  const held = await propose(), beforeHold = await noticeCount()
  const dispute = await api('cadence.dispute', { invoice: unproved.id, line: unproved.lines[0].id, amount_cents: 100, reason: 'Synthetic disputed item' })
  await propose(customer, {}, 409)
  await api('proposal.decide', { proposal: held.id, decision: 'approved' }, 409)
  await h.page(`/app/notices/${notice.id}.txt`, owner, 409)
  assert.equal(await noticeCount(), beforeHold)
  await api('cadence.resolve', { dispute: dispute.dispute, outcome: 'Synthetic authorized resolution' })

  // An unknown processor result is never presented as an expired-card cause.
  const pending = await api('collection.prepare', { invoice: unproved.id })
  edge.pendingPayment()
  const uncertain = await api('collection.confirm', pending.instructions.confirm)
  assert.equal(uncertain.status, 'uncertain')
  const unknown = await propose()
  assert.equal((await detail(unknown.id)).impact.diagnoses.find(row => row.invoice === unproved.id).cause, 'unknown')
  assert.equal((await api(`invoices/${unproved.id}`)).balanceCents, 9000)

  // Revocation and erasure invalidate saved proposals as well as fresh requests.
  const revoke = await propose()
  const key = (await api('credentials')).find(row => row.name === 'Synthetic collection investigator')
  await api('credential.revoke', { key: key.id })
  await propose(customer, {}, 401)
  await api('proposal.decide', { proposal: revoke.id, decision: 'approved' }, 409)
  const erased = await api('erasure.request', { customer })
  await api('erasure.verify', { request: erased.id, reason: 'Synthetic verified account owner', evidence: file('identity.txt', 'Synthetic customer evidence') })
  await api('erasure.approve', { request: erased.id, confirm: true })
  await api('proposal.decide', { proposal: revoke.id, decision: 'approved' }, 409)
  await h.page(`/app/notices/${notice.id}.txt`, owner, 409)
  assert.ok(!(await h.page('/app/proposals', owner)).includes('card ending 4242 expired'))
  const erasedPage = await h.page(`/app/proposals/${revoke.id}`, owner, 410)
  assert.ok(!erasedPage.includes('card ending 4242 expired') && !erasedPage.includes(address(303)))
  await api('proposal.create', { kind: 'collection', title: 'Erased account replay', payload: { customer } }, 404)
  await api(`customers/${customer}/collection-diagnosis`, undefined, 404)
  await api('customer.payment_methods.refresh', { customer }, 404)

  // Fully paid accounts have nothing to chase; no proposal or contact is created.
  const payment = await api('payment.record', { customer: other, amount: '100', received_on: '2026-10-22', method: 'bank_transfer', reference: 'synthetic-nectar-304' })
  await api('payment.allocate', { payment: payment.payment, invoice: foreign.id, amount: '100' })
  await api('proposal.create', { kind: 'collection', title: 'Paid account', payload: { customer: other } }, 409)
  assert.equal(edge.calls.filter(call => call.method === 'POST').length, counts[2] + 1, 'The only later provider write is the explicitly confirmed uncertain payment')
  console.log('collectionDiagnosisFlow passed: evidence, exact human review, stops, replay, revocation, erasure and atomic audit')
}

const address = number => `synthetic-nectar-${number}${String.fromCharCode(64)}example.test`
