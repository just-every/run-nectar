import assert from 'node:assert/strict'

// DEV-002: traverse a real issued-invoice snapshot across a later issue.
export async function invoicePaginationFlow(h, owner) {
  const customer = (await h.api('customer.create', owner, { external_id: 'DEV002-PAGES', name: 'Cedar Invoice Archive', billing_email: 'ap@cedar-archive.example' })).id
  const other = (await h.api('customer.create', owner, { external_id: 'DEV002-OTHER', name: 'Maple Invoice Archive', billing_email: 'ap@maple-archive.example' })).id
  const prepare = async (customerId, label) => {
    const charge = (await h.api('charge.add', owner, { customer: customerId, amount: '1.00', description: label, taxable: false, effective_date: '2026-01-05' })).charge
    return (await h.api('invoice.manual', owner, { customer: customerId, charges: [charge], service_date: '2026-01-05' })).id
  }
  const issue = async id => {
    await h.api('invoice.approve', owner, { invoice: id, acknowledge: true })
    await h.api('invoice.finalise', owner, { invoice: id, issue_date: '2026-01-05' })
  }
  // This draft predates every invoice in the snapshot. Creation time cannot
  // substitute for the immutable issue sequence when bounding later pages.
  const lateDraft = await prepare(customer, 'Issue after snapshot starts')
  const invoiceIds = []
  for (let index = 0; index < 250; index++) {
    const id = await prepare(customer, `Archive service ${index + 1}`)
    await issue(id)
    invoiceIds.push(id)
  }
  const foreignInvoice = await prepare(other, 'Separate customer service')
  await issue(foreignInvoice)
  const base = `invoices?customer=${encodeURIComponent(customer)}`
  const first = await h.api(`${base}&limit=100`, owner)
  assert.equal(first.data.length, 100)
  assert.equal(typeof first.next_cursor, 'string')
  assert.ok(first.next_cursor.length > 0)
  assert.ok(first.data.every(row => row.customer_id === customer && row.number))
  assert.ok(!first.data.some(row => row.id === lateDraft), 'drafts are absent from issued listings')
  assert.deepEqual((await h.api(base, owner)).data, first.data, 'default page size uses the same first 100 invoices')
  const unfiltered = await h.api('invoices', owner)
  assert.equal(unfiltered.data.length, 100)
  assert.ok(unfiltered.data.every(row => row.number), 'unfiltered listings also contain issued invoices')

  await issue(lateDraft)
  const secondPath = `${base}&limit=100&cursor=${encodeURIComponent(first.next_cursor)}`
  const second = await h.api(secondPath, owner)
  assert.equal(second.data.length, 100)
  assert.equal(typeof second.next_cursor, 'string')
  assert.ok(second.next_cursor.length > 0)
  assert.deepEqual(await h.api(secondPath, owner), second, 'replaying a cursor preserves the snapshot and order')
  const third = await h.api(`${base}&limit=100&cursor=${encodeURIComponent(second.next_cursor)}`, owner)
  assert.equal(third.data.length, 50)
  assert.equal(third.next_cursor, null)
  const snapshot = [...first.data, ...second.data, ...third.data]
  assert.equal(new Set(snapshot.map(row => row.id)).size, 250, 'no duplicate invoices between pages')
  assert.deepEqual(snapshot.map(row => row.id).sort(), [...invoiceIds].sort(), 'all original invoices appear exactly once, with no later issue')
  const ascending = snapshot[0].id === invoiceIds[0]
  assert.deepEqual(snapshot.map(row => row.id), ascending ? invoiceIds : [...invoiceIds].reverse(), 'pages preserve the immutable issue order')
  assert.equal(new Set(snapshot.map(row => row.number)).size, 250)
  assert.ok(snapshot.every(row => row.customer_id === customer))

  // A fresh traversal includes the later issue, while the saved cursor above
  // remains tied to its original snapshot.
  const fresh = await h.api(`${base}&limit=100`, owner)
  const freshSecond = await h.api(`${base}&limit=100&cursor=${encodeURIComponent(fresh.next_cursor)}`, owner)
  const freshThird = await h.api(`${base}&limit=100&cursor=${encodeURIComponent(freshSecond.next_cursor)}`, owner)
  assert.deepEqual([fresh.data.length, freshSecond.data.length, freshThird.data.length], [100, 100, 51])
  assert.equal(freshThird.next_cursor, null)
  const current = [...fresh.data, ...freshSecond.data, ...freshThird.data]
  assert.deepEqual(current.map(row => row.id).sort(), [...invoiceIds, lateDraft].sort())
  const issueOrder = [...invoiceIds, lateDraft]
  assert.deepEqual(current.map(row => row.id), ascending ? issueOrder : issueOrder.reverse(), 'the older draft sorts by its later issue, rather than draft creation')
  assert.equal(new Set(current.map(row => row.number)).size, 251, 'issued numbers remain unique across page boundaries')
  const foreign = await h.api(`invoices?customer=${encodeURIComponent(other)}&limit=100`, owner)
  assert.deepEqual(foreign.data.map(row => row.id), [foreignInvoice])
  assert.ok(foreign.data.every(row => row.customer_id === other))
  assert.equal(foreign.next_cursor, null)

  for (const limit of ['0', '101', '-1', '1.5', 'invalid'])
    await h.api(`${base}&limit=${limit}`, owner, undefined, 400)
  await h.api(`${base}&limit=100&cursor=not-a-cursor`, owner, undefined, 400)
  await h.api(`${base}&limit=100&cursor=${encodeURIComponent(first.next_cursor + 'tampered')}`, owner, undefined, 400)
  await h.api(`${base}&limit=50&cursor=${encodeURIComponent(first.next_cursor)}`, owner, undefined, 400)
  await h.api(`invoices?customer=${encodeURIComponent(other)}&limit=100&cursor=${encodeURIComponent(first.next_cursor)}`, owner, undefined, 400)
  await h.api(`invoices?limit=100&cursor=${encodeURIComponent(first.next_cursor)}`, owner, undefined, 400)
  await h.api(`${base}&limit=100`, undefined, undefined, 401)
  await h.api(secondPath, undefined, undefined, 401)
  await h.api('access.give', owner, { email: 'pagination-accountant@example.test', name: 'Archive Accountant', role: 'accountant' })
  const accountant = await h.signIn('pagination-accountant@example.test', { requested: true })
  assert.deepEqual(await h.api(secondPath, accountant), second, 'accountants can traverse the same issued snapshot')
  assert.deepEqual((await h.api(`${base}&limit=100`, accountant)).data, fresh.data)
  console.log('DEV-002 250 issued invoices traverse without gaps or duplicates; later issue, customer filters and bound cursors passed')
  return { customer, invoiceIds: [...invoiceIds, lateDraft] }
}
