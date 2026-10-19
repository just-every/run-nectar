import { applyPolicy } from './policy-helper.mjs'
import assert from 'node:assert/strict'

export async function creditPolicy(h, owner) {
  await h.api('access.give', owner, { email: 'credit-finance@example.test', name: 'Casey Credit Finance', role: 'finance' })
  await h.api('access.give', owner, { email: 'credit-accountant@example.test', name: 'Alex Credit Accountant', role: 'accountant' })
  const finance = await h.signIn('credit-finance@example.test', { requested: true })
  const accountant = await h.signIn('credit-accountant@example.test', { requested: true })
  const agent = { bearer: (await h.api('credential.issue', owner, { name: 'Credit proposal reader', scopes: ['prepare'] })).key }
  const customer = (await h.api('customer.create', owner, { external_id: 'GOV002-CREDIT', name: 'Cedar Credit Systems', billing_email: 'ap@cedar-credit.example' })).id
  const product = (await h.api('product.create', owner, { code: 'gov002-credit-platform', name: 'Credit policy platform' })).id
  const price = (await h.api('price.create', owner, { product, kind: 'flat', unit_amount: '10000.00', taxable: false })).id
  await h.api('subscription.create', owner, { customer, start_date: '2026-04-01', anchor_day: '1', price: [price] })
  const run = await h.api('billrun.prepare', owner, { period: '2026-04' })
  const draft = (await h.api(`runs/${run.id}`, owner)).invoices.find(row => row.customer_id === customer)
  assert.ok(draft, 'the credit journey bills its real subscription')
  await h.api('invoice.approve', owner, { invoice: draft.id, acknowledge: true })
  await h.api('invoice.finalise', owner, { invoice: draft.id, issue_date: '2026-05-01' })
  const invoice = draft.id
  const issued = await h.api(`invoices/${invoice}`, owner)
  assert.equal(issued.status, 'issued')
  assert.equal(issued.total_cents, 1_000_000)

  const read = () => h.api(`invoices/${invoice}`, owner)
  const credits = async expected => {
    const detail = await read()
    assert.deepEqual(detail.credits.map(row => [row.amount_cents, row.reason]).sort(), expected.slice().sort())
    const credited = expected.reduce((sum, [amount]) => sum + amount, 0)
    assert.equal(detail.creditedCents, credited)
    assert.equal(detail.balanceCents, issued.total_cents - credited)
    assert.equal(detail.number, issued.number)
    assert.deepEqual(detail.calculation, issued.calculation, 'credit decisions preserve the issued calculation')
  }
  const prepare = async reason => {
    const result = await h.api('credit.prepare', finance, { invoice, amount: '1500.00', reason })
    assert.equal(result.id, invoice)
    assert.ok(typeof result.request === 'string' && result.request.length > 0)
    return result.request
  }

  let request
  await applyPolicy(h, owner, 'credit.policy', { two_person_above: '1000.00' })
  try {
    for (const who of [finance, accountant, agent]) {
      await h.api('credit.policy', who, { two_person_above: '' }, 403)
    }
    for (const who of [accountant, agent]) {
      await h.api('credit.issue', who, { invoice, amount: '900.00', reason: 'Unauthorized direct credit' }, 403)
      await h.api('credit.prepare', who, { invoice, amount: '1500.00', reason: 'Unauthorized preparation' }, 403)
    }
    await credits([])

    const lowReason = 'Single-person credit below the owner threshold'
    await h.api('credit.issue', finance, { invoice, amount: '900.00', reason: lowReason })
    const expected = [[90_000, lowReason]]
    await credits(expected)
    await h.api('credit.issue', finance, { invoice, amount: '1500.00', reason: 'Cannot bypass second approval' }, 409)
    await h.api('credit.issue', owner, { invoice, amount: '1500.00', reason: 'Owner also needs second approval' }, 409)
    await credits(expected)

    const highReason = 'Two-person credit for the service outage'
    request = await prepare(highReason)
    await h.api('credit.approve', finance, { request }, 409)
    for (const who of [accountant, agent]) await h.api('credit.approve', who, { request }, 403)
    await credits(expected)
    await h.api('credit.approve', owner, { request })
    expected.push([150_000, highReason])
    await credits(expected)
    await h.api('credit.approve', owner, { request }, 409)
    await credits(expected)

    // A smaller intervening credit invalidates the saved balance even though
    // enough money remains for the requested credit.
    const staleBalance = await prepare('Credit prepared before the balance changed')
    const smallReason = 'Intervening one-dollar adjustment'
    await h.api('credit.issue', owner, { invoice, amount: '1.00', reason: smallReason })
    expected.push([100, smallReason])
    await h.api('credit.approve', owner, { request: staleBalance }, 409)
    await credits(expected)

    // The request retains the exact policy it was prepared under. The new
    // threshold still requires two people; its revision alone makes it stale.
    const stalePolicy = await prepare('Credit prepared before the policy changed')
    await applyPolicy(h, owner, 'credit.policy', { two_person_above: '1200.00' })
    await h.api('credit.approve', owner, { request: stalePolicy }, 409)
    await credits(expected)
  } finally {
    await applyPolicy(h, owner, 'credit.policy', { two_person_above: '' })
  }
  console.log('GOV-002 credit threshold, separate approver, exact balance and policy approvals passed')
  return { invoice, request }
}
