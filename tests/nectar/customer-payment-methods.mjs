// Extends the native Stripe network edge; application code and storage stay real.
import assert from 'node:assert/strict'

export function customerPaymentMethodsEdge(baseFetch) {
  const calls = [], customer = 'synthetic-nectar-native-customer-1'
  let fault = null
  const fetch = async request => {
    const url = new URL(request.url)
    if (url.pathname !== '/v1/payment_methods') return baseFetch(request)
    assert.equal(request.method, 'GET', 'Inventory never writes to Stripe')
    assert.equal(request.headers.get('authorization'), 'Bearer synthetic-nectar-1')
    assert.equal(url.searchParams.get('customer'), customer)
    const type = url.searchParams.get('type'), cursor = url.searchParams.get('starting_after')
    calls.push({ method: request.method, type, cursor })
    assert.ok(['card', 'us_bank_account'].includes(type))
    const id = type === 'card' ? `synthetic-nectar-native-card-${cursor ? '5' : '1'}` : 'synthetic-nectar-native-bank-1'
    const method = { object: 'payment_method', id, customer, livemode: false, type,
      ...(type === 'card' ? { card: { brand: 'visa', last4: cursor ? '1111' : '4242', exp_month: 12, exp_year: 2035 } }
        : { us_bank_account: { bank_name: 'Synthetic Nectar Bank', last4: '6789', account_type: 'checking', routing_number: '110000000' } }),
      billing_details: { name: 'Synthetic private billing name', email: 'synthetic-nectar-99@example.test' } }
    if (fault === 'customer') method.customer = 'synthetic-nectar-native-customer-99'
    if (fault === 'livemode') method.livemode = true
    if (fault === 'repeat' && type === 'card' && cursor) method.id = cursor
    if (fault === 'empty') return Response.json({ object: 'list', has_more: true, data: [] })
    return Response.json({ object: 'list', has_more: type === 'card' && !cursor, data: [method] })
  }
  return { fetch, calls, setFault: value => { fault = value } }
}

/** Call after native customer binding and fresh owner factor are established. */
export async function assertCustomerPaymentMethods(h, owner, { customer, other, finance, edge,refresh,
  read = async cookie => (await h.api(`customers/${customer}`, cookie)).billingRecord.savedPaymentMethods }) {
  const before = edge.calls.length
  const refreshed = refresh?await refresh({h,owner,customer}):await h.api('customer.payment_methods.refresh', owner, { customer })
  assert.equal(refreshed.length, 1)
  const [snapshot] = refreshed
  assert.equal(snapshot.customer, customer)
  assert.equal(snapshot.historical, true)
  assert.equal(snapshot.debitAuthority, false)
  assert.ok(Number.isSafeInteger(snapshot.fetchedAt))
  assert.deepEqual(snapshot.methods.map(method => method.type).sort(), ['card', 'card', 'us_bank_account'])
  assert.ok(snapshot.methods.some(method => method.type === 'us_bank_account' && method.last4 === '6789'))
  assert.ok(edge.calls.slice(before).some(call => call.cursor), 'All provider pages are read')
  assert.ok(!JSON.stringify(snapshot).includes('routing_number') && !JSON.stringify(snapshot).includes('billing_details'))
  assert.deepEqual(await read(owner), refreshed)
  if (finance) {
    assert.deepEqual(await read(finance), refreshed)
    await h.api('customer.payment_methods.refresh', finance, { customer }, 403)
  }
  if (other) assert.deepEqual((await h.api(`customers/${other}`, owner)).billingRecord.savedPaymentMethods, [])
  for (const fault of ['customer', 'livemode', 'repeat', 'empty']) {
    edge.setFault(fault)
    await h.api('customer.payment_methods.refresh', owner, { customer }, 409)
    assert.deepEqual(await read(owner), refreshed, 'An invalid or incomplete provider read preserves the previous snapshot')
  }
  edge.setFault(null)
  return refreshed
}
