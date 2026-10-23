import assert from 'node:assert/strict'

// Read quoted exports, including metadata containing commas, quotes and newlines.
function csvRows(text) {
  const rows = []; let row = [], cell = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++ } else quoted = !quoted
    } else if (char === ',' && !quoted) { row.push(cell); cell = '' }
    else if (char === '\n' && !quoted) { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = '' }
    else cell += char
  }
  return rows
}

const originalFields = value => Array.isArray(value) ? value.map(originalFields)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => !['metadata', 'metadata_revision'].includes(key)).map(([key, item]) => [key, originalFields(item)])) : value

// DEV-005: annotate existing records without changing their financial custody.
export async function metadataFlow(h, owner) {
  const customer = (await h.api('customer.create', owner, { external_id: 'DEV005-ALDER', name: 'Alder Metadata', billing_email: 'ap@alder-metadata.example' })).id
  const other = (await h.api('customer.create', owner, { external_id: 'DEV005-OTHER', name: 'Unrelated Metadata', billing_email: 'ap@other-metadata.example' })).id
  const product = (await h.api('product.create', owner, { code: 'dev005-platform', name: 'Metadata platform' })).id
  const price = (await h.api('price.create', owner, { product, kind: 'flat', unit_amount: '100', taxable: false })).id
  const subscription = (await h.api('subscription.create', owner, { customer, start_date: '2026-01-01', price: [price] })).id
  const charge = (await h.api('charge.add', owner, { customer, amount: '125', description: 'Metadata workshop', taxable: false, effective_date: '2026-01-05' })).charge
  const invoice = (await h.api('invoice.manual', owner, { customer, charges: [charge], service_date: '2026-01-05' })).id
  await h.api('invoice.approve', owner, { invoice, acknowledge: true })
  await h.api('invoice.finalise', owner, { invoice, issue_date: '2026-01-05' })
  const payment = (await h.api('payment.record', owner, { customer, amount: '100', received_on: '2026-01-06', method: 'bank_transfer', reference: 'DEV005-WIRE' })).payment
  await h.api('payment.allocate', owner, { payment, invoice, amount: '100' })
  const credit = (await h.api('credit.issue', owner, { invoice, amount: '25', reason: 'Workshop adjustment' })).credit
  const ids = { customer, subscription, price, invoice, payment, 'credit-note': credit }
  const ownerEmail = (await h.api('me', owner)).email
  const invite = async (email, name, role) => {
    const member = await h.api('access.give', owner, { email, name, role })
    return { ...member, who: await h.signIn(email, { requested: true }) }
  }
  // Ampersand is valid in an email address and must be escaped in author markup.
  const finance = await invite('dev005-author&finance@example.test', 'Metadata <script>alert("DEV005-author")</script>', 'finance')
  const accountant = await invite('dev005-accountant@example.test', 'Metadata Accountant', 'accountant')
  const key = await h.api('credential.issue', owner, { name: 'Metadata reader', scopes: ['prepare'] })
  const agent = { bearer: key.key }
  const read = (kind, who = owner) => h.api(`metadata/${kind}/${ids[kind]}`, who)
  const write = (kind, revision, metadata, who = owner) => h.api('metadata.write', who, { kind, record: ids[kind], revision, metadata })
  const projections = async () => {
    const [c, s, catalog, i, payments] = await Promise.all([
      h.api(`customers/${customer}`, owner), h.api(`subscriptions/${subscription}`, owner), h.api('catalog', owner), h.api(`invoices/${invoice}`, owner), h.api('payments', owner),
    ])
    return { customer: c, subscription: s, price: catalog.prices.find(row => row.id === price), invoice: i, payment: payments.find(row => row.id === payment), 'credit-note': i.credits.find(row => row.id === credit) }
  }
  const originals = await projections()
  assert.equal(originals.invoice.status, 'issued')
  assert.deepEqual([originals.invoice.total_cents, originals.invoice.paidCents, originals.invoice.creditedCents, originals.invoice.balanceCents], [12500, 10000, 2500, 0])
  const expectedMetadata = {}, started = Date.now()
  for (const [kind, id] of Object.entries(ids)) {
    const empty = await read(kind)
    assert.equal(empty.kind, kind); assert.equal(empty.id, id)
    assert.deepEqual(empty.metadata, {}); assert.deepEqual(empty.history, [])
    const metadata = Object.fromEntries([
      ['app_account_id', `DEV005-${kind}-ACCOUNT`], ['old_only', 'initial annotation'],
      [' padded key ', '  café, "quoted"\n第二行  '], ['__proto__', 'literal prototype key'],
      ['constructor', 'literal constructor key'], ['', 'empty key is preserved'],
      ['markup', '<script>alert("DEV005")</script> & <img src=x onerror=alert(1)>'],
    ])
    expectedMetadata[kind] = metadata
    const written = await write(kind, empty.revision, metadata)
    assert.equal(written.revision, empty.revision + 1)
    assert.deepEqual(written.metadata, metadata, 'keys and string values survive byte for byte')
    for (const who of [owner, accountant.who, agent]) {
      const view = await read(kind, who)
      assert.deepEqual(view.metadata, metadata)
      assert.equal(view.history.length, 1)
      assert.deepEqual(view.history[0].metadata, metadata)
      assert.equal(view.history[0].author, ownerEmail)
      assert.ok(view.history[0].created_at >= started && view.history[0].created_at <= Date.now())
    }
    await h.api('metadata.write', accountant.who, { kind, record: id, revision: written.revision, metadata: {} }, 403)
    await h.api('metadata.write', agent, { kind, record: id, revision: written.revision, metadata: {} }, 403)
    await h.api(`metadata/${kind}/${id}`, undefined, undefined, 401)
    const page = await h.page(`/app/metadata/${kind}/${id}`, accountant.who)
    assert.ok(page.includes('&lt;script&gt;'))
    assert.ok(!page.includes('<script>alert("DEV005")</script>'))
    assert.ok(!page.includes('action="/app/do/metadata.write"'), 'accountants have history without a write form')
    const signedOut = await h.raw(`/app/metadata/${kind}/${id}`)
    assert.equal(signedOut.status, 303)
    assert.equal(new URL(signedOut.headers.get('location'), h.origin).pathname, '/signin')
  }

  // The declared object schema accepts a full 50-pair annotation atomically.
  const fifty = { ...expectedMetadata.customer, ...Object.fromEntries(Array.from({ length: 50 - Object.keys(expectedMetadata.customer).length }, (_, i) => [`dimension_${i}`, `value ${i}`])) }
  let current = await read('customer')
  await write('customer', current.revision, fifty, finance.who)
  current = await read('customer')
  assert.deepEqual(current.metadata, fifty)
  await h.api('metadata.write', finance.who, { kind: 'customer', record: customer, revision: current.revision, metadata: { ...fifty, extra_dimension: 'exceeds the free-form object schema' } }, 400)
  assert.deepEqual(await read('customer'), current, 'over-cap replacement leaves values and history intact')
  const replacement = Object.fromEntries([
    ['app_account_id', 'DEV005-CUSTOMER-FINAL'], ['form_value', '  form, "quote"\nΔ café  '],
    ['markup', '<script>alert("DEV005")</script>'], ['__proto__', 'still a literal key'],
  ])
  const editorPath = `/app/metadata/customer/${customer}`
  assert.ok((await h.page(editorPath, finance.who)).includes('action="/app/do/metadata.write"'))
  const saved = await h.submit('metadata.write', finance.who, { kind: 'customer', record: customer, revision: String(current.revision), metadata: JSON.stringify(replacement) }, editorPath)
  assert.equal(saved.pathname, editorPath)
  expectedMetadata.customer = replacement
  const afterForm = await read('customer')
  assert.deepEqual(afterForm.metadata, replacement, 'form replaces the entire map, removing omitted keys')
  assert.equal(afterForm.revision, current.revision + 1)
  assert.deepEqual(afterForm.history.map(row => row.metadata), [replacement, fifty, current.history.at(-1).metadata])
  assert.deepEqual(afterForm.history.map(row => row.author), [finance.email, finance.email, ownerEmail])
  const authorPage = await h.page(editorPath, accountant.who)
  const authorMarkup=authorPage.replace(/<wbr>|<\/?span\b[^>]*>/g,'')
  assert.ok(authorMarkup.includes('DEV005-author'))
  assert.ok(authorMarkup.includes('&lt;script&gt;'), 'the recorded author is escaped as well as metadata values')
  assert.ok(!authorPage.includes('<script>alert("DEV005-author")</script>'))
  for (const metadata of [null, [], 'scalar', 3, { number: 1 }, { boolean: true }, { nested: {} }, { array: [] }, { nil: null }])
    await h.api('metadata.write', owner, { kind: 'customer', record: customer, revision: afterForm.revision, metadata }, 400)
  await h.api('metadata.write', owner, { kind: 'customer', record: customer, revision: afterForm.revision, metadata: {}, author: 'forged<script>author</script>' }, 400)
  await h.api('metadata.write', finance.who, { kind: 'customer', record: customer, revision: current.revision, metadata: { overwritten: 'stale editor' } }, 409)
  await h.api('metadata.write', undefined, { kind: 'customer', record: customer, revision: afterForm.revision, metadata: {} }, 401)
  const crossSite = await h.raw('/api/nectar/metadata.write', { cookie: finance.who, body: { kind: 'customer', record: customer, revision: afterForm.revision, metadata: {} }, headers: { origin: 'https://other.example' } })
  assert.equal(crossSite.status, 403)
  assert.deepEqual(await read('customer'), afterForm, 'invalid, forbidden and stale writes cannot add history')
  await h.api('metadata/unknown-kind/missing', owner, undefined, 400)
  await h.api('metadata/customer/missing', owner, undefined, 404)
  await h.api('metadata.write', owner, { kind: 'unknown-kind', record: customer, revision: 0, metadata: {} }, 400)
  await h.api('metadata.write', owner, { kind: 'customer', record: 'missing', revision: 0, metadata: {} }, 404)

  const projected = await projections(), records = []
  for (const [kind, id] of Object.entries(ids)) {
    const view = await read(kind), metadata = expectedMetadata[kind]
    assert.deepEqual(projected[kind].metadata, metadata, `${kind} original API projects its annotation`)
    assert.equal(projected[kind].metadata_revision, view.revision)
    const currentRecord = originalFields(projected[kind]), originalRecord = originalFields(originals[kind])
    if (kind === 'customer') {
      const events = currentRecord.billingRecord.auditEvents, additions = events.slice(0, 7)
      assert.deepEqual(additions.map(({ action, subject }) => ({ action, subject })), [customer, customer, credit, payment, invoice, subscription, customer].map(subject => ({ action: 'metadata.replace', subject })), 'Customer billing history includes each related metadata write')
      assert.deepEqual(events.slice(7), originalRecord.billingRecord.auditEvents, 'Metadata writes retain every previous customer audit event unchanged')
      assert.ok(additions.every(event => event.seq > Math.max(0, ...originalRecord.billingRecord.auditEvents.map(prior => prior.seq))))
      currentRecord.billingRecord.auditEvents = originalRecord.billingRecord.auditEvents
    }
    assert.deepEqual(currentRecord, originalRecord, `${kind} annotation preserves the original record, calculation, fingerprints and money`)
    const filter = new URLSearchParams({ metadata_key: 'app_account_id', metadata_value: metadata.app_account_id })
    const listed = await h.api(`objects/${kind}?${filter}`, accountant.who)
    assert.deepEqual(listed.data.map(row => row.id), [id])
    assert.deepEqual(listed.data[0].metadata, metadata)
    assert.equal(listed.data[0].metadata_revision, view.revision)
    for (const wrong of [{ metadata_key: 'App_account_id', metadata_value: metadata.app_account_id }, { metadata_key: 'app_account_id', metadata_value: `${metadata.app_account_id} ` }])
      assert.deepEqual((await h.api(`objects/${kind}?${new URLSearchParams(wrong)}`, agent)).data, [], 'list filters compare exact current key/value pairs')
    const exported = await h.raw(`/app/exports/objects/${kind}.csv?${filter}`, { cookie: accountant.who })
    assert.equal(exported.status, 200)
    assert.match(exported.headers.get('content-type'), /text\/csv/)
    const [header, ...rows] = csvRows(await exported.text())
    assert.equal(rows.length, 1)
    assert.equal(rows[0][header.indexOf('record_id')], id)
    assert.deepEqual(JSON.parse(rows[0][header.indexOf('metadata_json')]), metadata, 'filtered CSV round-trips exact string pairs')
    const conventional = { customer: ['customers','customer_id'], subscription: ['subscriptions','subscription_id'], invoice: ['invoices','invoice_id'] }[kind]
    if (conventional) {
      const response=await h.raw(`/app/exports/${conventional[0]}.csv?${filter}`,{cookie:accountant.who})
      assert.equal(response.status,200)
      const [columns,...lines]=csvRows(await response.text())
      assert.equal(lines.length,1,'the existing CSV applies the current metadata filter')
      assert.equal(lines[0][columns.indexOf(conventional[1])],id)
      assert.deepEqual(JSON.parse(lines[0][columns.indexOf('metadata_json')]),metadata)
    }
    if(kind==='customer')assert.deepEqual((await h.api(`customers?${filter}`,accountant.who)).map(r=>r.id),[id])
    if(kind==='price')assert.deepEqual((await h.api(`catalog?${filter}`,accountant.who)).prices.map(r=>r.id),[id])
    if(kind==='payment')assert.deepEqual((await h.api(`payments?${filter}`,accountant.who)).map(r=>r.id),[id])
    if(kind==='invoice')assert.deepEqual((await h.api(`invoices?customer=${customer}`,accountant.who)).data.find(r=>r.id===id).metadata,metadata)
    const denied = await h.raw(`/app/exports/objects/${kind}.csv?${filter}`)
    assert.equal(denied.status, 303)
    records.push({ kind, id, revision: view.revision, metadata })
  }
  for (const value of [expectedMetadata.customer.app_account_id, expectedMetadata.subscription.app_account_id]) {
    const found = await h.api(`customers?${new URLSearchParams({ search: value })}`, accountant.who)
    assert.deepEqual(found.map(row => row.id), [customer], 'customer and subscription metadata both find the owning customer')
  }
  const historicalValue = afterForm.history.at(-1).metadata.app_account_id
  assert.deepEqual((await h.api(`objects/customer?${new URLSearchParams({ metadata_key: 'app_account_id', metadata_value: historicalValue })}`, accountant.who)).data, [], 'retained history cannot leak into current filters')
  assert.deepEqual(await h.api(`customers?${new URLSearchParams({ search: historicalValue })}`, accountant.who), [], 'search uses the current annotation')
  assert.deepEqual((await read('customer')).history, afterForm.history)
  assert.deepEqual((await h.api(`metadata/customer/${other}`, owner)).metadata, {})
  await h.api('credential.revoke', owner, { key: key.id })
  await h.api('access.end', owner, { member: finance.id })
  await h.api('access.end', owner, { member: accountant.id })
  console.log('DEV-005 exact metadata on six record kinds, revisions, role custody, search/filter/export and immutable financial originals passed')
  return { customer, subscription, price, invoice, payment, credit, records, expectedMetadata }
}
