import { publishPrice } from './price-helper.mjs'
import assert from 'node:assert/strict'

export async function priceSwitches(h, owner) {
  const finance = await h.signIn('price-finance@example.test')
  const accountant = await h.signIn('price-accountant@example.test')
  const agent = { bearer: (await h.api('credential.issue', owner, { name: 'Price switch reader', scopes: ['prepare'] })).key }
  const customer = (await h.api('customer.create', owner, { external_id: 'GOV002-SWITCH', name: 'Aspen Research', billing_email: 'ap@aspen.example' })).id
  const product = (await h.api('product.create', owner, { code: 'gov002-seat-switch', name: 'Research seats' })).id
  const price = (await h.api('price.create', owner, { product, kind: 'seat', unit_amount: '10.00', taxable: false })).id
  const next = (await publishPrice(h, owner, { product, kind: 'seat', unit_amount: '20.00', taxable: false })).id
  const subscription = (await h.api('subscription.create', owner, { customer, start_date: '2026-01-01', price: [price], quantity: ['5'] })).id
  const read = () => h.api(`subscriptions/${subscription}`, owner)
  const original = await read()
  const prepare = (quantity, effective_date) => h.api('change.prepare', owner, { subscription, item: original.items[0].id, price: next, quantity, effective_date })
  const change = await prepare(5, '2026-04-16')
  assert.equal(change.preview.before.cents, 5000)
  assert.equal(change.preview.after.cents, 7500)
  assert.equal(change.preview.nextPeriod.cents, 10000)
  const decide = (id, who, status = 200, decision = 'approved') => h.api('change.decide', who, { change: id, decision }, status)
  await decide(change.change, owner, 409)
  for (const who of [agent, accountant]) await decide(change.change, who, 403)
  assert.deepEqual((await read()).items, original.items)
  assert.equal((await read()).revision, original.revision)
  const competing = await prepare(7, '2026-04-16')
  await decide(change.change, finance)
  await decide(change.change, finance, 409)
  await decide(competing.change, finance, 409)
  await decide(competing.change, owner, 200, 'discarded')
  const applied = await read()
  assert.equal(applied.changes.find(c => c.id === change.change).decided_by, 'price-finance@example.test')
  const current = applied.items.find(i => !i.effective_to)
  assert.equal(current.price_id, next)
  // A pure seat quantity change keeps the same unit price and retains the
  // existing single-person NEC-08 approval behavior.
  const quantity = await h.api('change.prepare', owner, { subscription, item: current.id, quantity: 6, effective_date: '2026-05-16' })
  await decide(quantity.change, owner)
  const run = await h.api('billrun.prepare', owner, { period: '2026-04' })
  const invoice = (await h.api(`runs/${run.id}`, owner)).invoices.find(i => i.customer_id === customer)
  assert.equal(invoice.total_cents, change.preview.after.cents)
  await h.api('invoice.approve', owner, { invoice: invoice.id, acknowledge: true })
  await h.api('invoice.finalise', owner, { invoice: invoice.id, issue_date: '2026-05-01' })
  assert.equal((await h.api(`invoices/${invoice.id}`, owner)).total_cents, 7500)
  console.log('GOV-002 subscription price switches: separate approval, no bypass, stale/duplicate refusal, proration and quantity-only behavior passed')
  return { subscription, finance, price, next }
}
