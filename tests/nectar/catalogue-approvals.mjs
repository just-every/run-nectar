import assert from 'node:assert/strict'

export async function catalogueSingleApproval(h, owner) {
  const product = (await h.api('product.create', owner, { code: 'gov002-solo', name: 'Solo owner platform' })).id
  const first = await h.api('price.create', owner, { product, kind: 'flat', unit_amount: '100', taxable: false })
  assert.equal(first.version, 1)
  const prepared = await h.api('price.create', owner, { product, kind: 'flat', unit_amount: '125', taxable: false, confirm_single: true })
  assert.equal(prepared.status, 'pending')
  assert.equal((await h.api('catalog', owner)).prices.filter(p => p.product_id === product).length, 1)
  await h.api('price.decide', owner, { request: prepared.request, decision: 'approved' }, 409)
  const published = await h.api('price.decide', owner, { request: prepared.request, decision: 'approved', confirm_single: true })
  assert.equal(published.mode, 'single-approver')
  const saved = (await h.api('catalog', owner)).priceRequests.find(r => r.id === prepared.request)
  assert.equal(saved.approval_mode, 'single-approver')
  assert.equal(saved.price_id, published.id)
  assert.equal(JSON.parse((await h.api('audit', owner)).find(r => r.action === 'price.publish' && r.subject === prepared.request).detail).mode, 'single-approver')
  console.log('GOV-002 catalogue v1 setup and explicit single-approver revision history passed')
}

export async function catalogueApprovals(h, owner) {
  const finance = await h.signIn('price-finance@example.test')
  const accountant = await h.signIn('price-accountant@example.test')
  const agent = { bearer: (await h.api('credential.issue', owner, { name: 'Catalogue reader', scopes: ['prepare'] })).key }
  const product = (await h.api('product.create', owner, { code: 'gov002-package-revision', name: 'Gateway package' })).id
  const first = await h.api('price.create', owner, { product, kind: 'flat', unit_amount: '100', taxable: false })
  const meter = (await h.api('meter.create', owner, { code: 'gov002-package', name: 'Gateway events', unit_label: 'events' })).id
  const payload = { product, kind: 'unit', meter, pricing_model: 'package', package_size: '1.5', tiers: [{ up_to: null, unit_amount: '4.25', flat_amount: '0.01' }], taxable: false, nickname: 'Exact event blocks' }
  for (const who of [agent, accountant]) await h.api('price.create', who, payload, 403)
  const old = (await h.api('catalog', owner)).prices.find(p => p.id === first.id)
  const prepared = await h.api('price.create', owner, payload)
  const competing = await h.api('price.create', finance, { ...payload, nickname: 'Competing draft' })
  const read = () => h.api('catalog', owner)
  assert.equal((await read()).prices.filter(p => p.product_id === product).length, 1)
  await h.api('price.decide', owner, { request: prepared.request, decision: 'approved', confirm_single: true }, 409)
  for (const who of [agent, accountant]) await h.api('price.decide', who, { request: prepared.request, decision: 'approved' }, 403)
  assert.deepEqual((await read()).prices.find(p => p.id === first.id), old)
  const approved = await h.api('price.decide', finance, { request: prepared.request, decision: 'approved', unit_amount: '0', taxable: true })
  assert.equal(approved.mode, 'two-person')
  await h.api('price.decide', finance, { request: prepared.request, decision: 'approved' }, 409)
  await h.api('price.decide', owner, { request: competing.request, decision: 'approved' }, 409)
  await h.api('price.decide', finance, { request: competing.request, decision: 'rejected' })
  const catalog = await read(), price = catalog.prices.find(p => p.id === approved.id)
  assert.equal(price.pricing.model, 'package')
  assert.equal(price.pricing.packageSize, '1.50')
  assert.deepEqual(price.pricing.tiers, [{ upTo: null, unitAmount: '4.25', flatAmount: '0.01' }])
  assert.equal(price.taxable, 0)
  assert.equal(price.meter_id, meter)
  assert.deepEqual(catalog.prices.find(p => p.id === first.id), old)
  const customer = (await h.api('customer.create', owner, { external_id: 'GOV002-PACKAGE', name: 'Willow Gateway', billing_email: 'ap@willow.example' })).id
  await h.api('subscription.create', owner, { customer, start_date: '2026-04-01', price: [approved.id] })
  await h.api('usage.submit', owner, { events: [{ event_id: 'gov002-package-events', customer: 'GOV002-PACKAGE', meter: 'gov002-package', quantity: '3.5', occurred_at: '2026-04-10T12:00:00Z' }] })
  const run = await h.api('billrun.prepare', owner, { period: '2026-04' })
  const invoice = (await h.api(`runs/${run.id}`, owner)).invoices.find(i => i.customer_id === customer)
  assert.equal(invoice.total_cents, 1276)
  await h.api('invoice.approve', owner, { invoice: invoice.id, acknowledge: true })
  await h.api('invoice.finalise', owner, { invoice: invoice.id, issue_date: '2026-05-01' })
  assert.equal((await h.api(`invoices/${invoice.id}`, owner)).total_cents, 1276)
  console.log('GOV-002 catalogue revisions: separate approval, no direct-write bypass, stale/duplicate refusal, exact package terms and issued cents passed')
}
