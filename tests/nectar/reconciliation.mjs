import assert from 'node:assert/strict'

export async function reconciliationFlow(h, owner) {
  await h.advanceClock('2026-10-25T12:00:00Z')
  const customer = (await h.api('customer.create', owner, { external_id: 'source-control', name: 'Cedar Source Systems', billing_email: 'ap@cedar.example' })).id
  const product = (await h.api('product.create', owner, { code: 'source-product', name: 'Source processing' })).id
  await h.api('meter.create', owner, { code: 'source-events', name: 'Source events', unit_label: 'events' })
  const price = (await h.api('price.create', owner, { product, kind: 'unit', meter: 'source-events', unit_amount: '2' })).id
  await h.api('subscription.create', owner, { customer, start_date: '2026-06-01', price: [price], quantity: [''] })
  const send = async events => {
    const result = await h.api('usage.submit', owner, { events: events.map(([event_id, quantity, day]) => ({ event_id, quantity, occurred_at: `${day}T12:00:00-07:00`, customer: 'source-control', meter: 'source-events' })) })
    assert.equal(result.accepted, events.length)
  }
  await send([['source-a', '3', '2026-06-01'], ['source-b', '2', '2026-06-02']])
  const control = async (day, count, quantity) => h.api('usage.control', owner, { customer, meter: 'source-events', day, expected_count: count, expected_quantity: quantity })
  const first = await control('2026-06-01', 2, '5')
  const second = await control('2026-06-02', 0, '0')
  // The assurance agent investigates source totals without changing a bill or event.
  const ownerId=(await h.api('me',owner)).id
  const agent={bearer:(await h.api('credential.issue',owner,{name:'Synthetic source investigator',scopes:['prepare']})).key}
  const scan=()=>h.api('assurance.scan',agent,{period:'2026-06',owner:ownerId})
  const sourcesBefore=await (await h.raw('/app/exports/usage.csv',{cookie:owner})).text()
  const runsBefore=await h.api('runs',owner)
  await h.rejectAudit('assurance.scan')
  await h.api('assurance.scan',agent,{period:'2026-06',owner:ownerId},500)
  assert.deepEqual(await h.api('assurance-cases',agent),[],'a failed audit rolls back every opened case')
  await h.rejectAudit(null)
  const investigation=await scan()
  assert.equal(investigation.compared,2)
  assert.equal(investigation.opened.length,2)
  assert.deepEqual((await scan()).opened,[],'repeated scans do not duplicate cases')
  const cases=await h.api('assurance-cases',agent)
  const sourceCase=cases.find(c=>c.source_id===first.id)
  assert.equal(sourceCase.owner_id,ownerId)
  assert.equal(sourceCase.status,'open')
  assert.deepEqual(sourceCase.evidence,{kind:'usage_source_control',source:first.id,customer,meter:'source-events',day:'2026-06-01',expectedCount:2,actualCount:1,expectedQuantity:'5.00',actualQuantity:'3.00',countDifference:-1,quantityDifference:'-2.00',mismatch:true,basis:sourceCase.basis_hash})
  const page=await h.api('assurance-cases?limit=1',agent)
  assert.equal(page.data.length,1)
  assert.equal((await h.api(`assurance-cases?limit=1&cursor=${encodeURIComponent(page.next_cursor)}`,agent)).data.length,1)
  await h.api('assurance.approve',agent,{case:sourceCase.id,basis:sourceCase.basis_hash},403)
  await h.api('assurance.assign',agent,{case:sourceCase.id,owner:ownerId},403)
  await h.api('assurance.approve',owner,{case:sourceCase.id,basis:sourceCase.basis_hash},409)
  await h.api('assurance.scan',agent,{period:'2026-13',owner:ownerId},400)
  await h.api('assurance.scan',agent,{period:'2026-06',owner:'synthetic-nectar-absent'},409)
  assert.deepEqual(await h.api('runs',owner),runsBefore,'investigation prepares no bill run')
  assert.equal(await (await h.raw('/app/exports/usage.csv',{cookie:owner})).text(),sourcesBefore,'investigation leaves raw events unchanged')

  const prepare = async () => {
    const run = await h.api('billrun.prepare', owner, { period: '2026-06' })
    const invoice = (await h.api(`runs/${run.id}`, owner)).invoices.find(i => i.customer_id === customer)
    return { run: run.id, invoice }
  }
  let draft = await prepare()
  const mismatches = draft.invoice.exceptions.filter(e => e.code === 'usage_reconciliation')
  assert.equal(mismatches.length, 2)
  assert.deepEqual(mismatches.map(e => [e.detail.day, e.detail.meter, e.detail.countDifference, e.detail.quantityDifference]), [['2026-06-01', 'source-events', -1, '-2.00'], ['2026-06-02', 'source-events', 1, '2.00']])
  assert.equal((await h.api('invoice.approve', owner, { invoice: draft.invoice.id, acknowledge: true }, 409)).error, 'blocking_exception')
  await send([['source-replay', '2', '2026-06-01']])
  let view = await h.api('usage/inspect?period=2026-06', owner)
  assert.equal(view.controls.find(c => c.id === first.id).mismatch, false)
  assert.equal((await h.api('assurance.recheck',agent,{case:sourceCase.id})).status,'open','agreement alone cannot waive human confirmation')
  const reconciledBasis=view.controls.find(c=>c.id===first.id).basis
  await h.api('assurance.approve',owner,{case:sourceCase.id,basis:sourceCase.basis_hash},409)
  await h.api('assurance.approve',owner,{case:sourceCase.id,basis:reconciledBasis})
  await h.rejectAudit('assurance.recheck')
  await h.api('assurance.recheck',agent,{case:sourceCase.id},500)
  assert.equal((await h.api(`assurance-cases/${sourceCase.id}`,agent)).status,'open','closure and its observation roll back with audit failure')
  await h.rejectAudit(null)
  assert.equal((await h.api('assurance.recheck',agent,{case:sourceCase.id})).status,'resolved')
  const resolved=await h.api(`assurance-cases/${sourceCase.id}`,agent)
  assert.equal(resolved.approved_by,'owner@example.test')
  assert.equal(resolved.observations.length,3)
  assert.equal(resolved.observations[0].evidence.actualQuantity,'3.00','the original discrepancy is retained')

  const surplus = view.controls.find(c => c.id === second.id)
  const usageKey = await h.api('credential.issue', owner, { name: 'source-control-ingester', scopes: ['usage'] })
  await h.api('usage.acknowledge', { bearer: usageKey.key }, { control: second.id, basis: surplus.basis, reason: 'Source counted only completed work' }, 403)
  await h.api('usage.acknowledge', owner, { control: second.id, basis: surplus.basis, reason: 'Source counted only completed work' })
  draft = await prepare()
  assert.equal(draft.invoice.exceptions.some(e => e.code === 'usage_reconciliation'), false)
  await h.api('invoice.approve', owner, { invoice: draft.invoice.id, acknowledge: true })
  // A control update after approval invalidates the exact inputs at issue.
  await control('2026-06-01', 3, '6')
  assert.ok((await scan()).rechecked.includes(sourceCase.id),'a repeated scan pursues existing cases when their sources change')
  assert.equal((await h.api(`assurance-cases/${sourceCase.id}`,agent)).status,'open','a source regression reopens the same case')
  assert.equal((await h.api(`assurance-cases/${sourceCase.id}`,agent)).approved_basis,null,'old approval cannot resolve a changed source')
  await h.api('access.give',owner,{email:'synthetic-nectar-investigator@example.test',name:'Synthetic case owner',role:'finance'})
  const financeId=(await h.api('members',owner)).find(m=>m.email==='synthetic-nectar-investigator@example.test').id
  await h.api('assurance.assign',owner,{case:sourceCase.id,owner:financeId})
  assert.equal((await h.api(`assurance-cases/${sourceCase.id}`,agent)).owner_id,financeId)
  await h.api('access.end',owner,{member:financeId})
  await h.api('assurance.recheck',agent,{case:sourceCase.id},409)
  const reassigned=await h.submit('assurance.assign',owner,{case:sourceCase.id,owner:ownerId},'/app/usage?period=2026-06')
  assert.equal(reassigned.searchParams.get('error'),null,'case assignment also uses the ordinary form door')
  const trail=await h.api('audit',owner)
  assert.ok(trail.some(r=>r.action==='assurance.scan'&&r.actor==='agent:Synthetic source investigator'&&JSON.parse(r.detail).opened.includes(sourceCase.id)))
  assert.ok(trail.some(r=>r.action==='assurance.approve'&&r.subject===sourceCase.id&&r.actor==='owner@example.test'&&JSON.parse(r.detail).basis===reconciledBasis))
  assert.ok(trail.some(r=>r.action==='assurance.recheck'&&r.subject===sourceCase.id&&r.actor==='agent:Synthetic source investigator'&&JSON.parse(r.detail).status==='resolved'))
  assert.ok(trail.some(r=>r.action==='assurance.assign'&&r.subject===sourceCase.id&&r.actor==='owner@example.test'&&JSON.parse(r.detail).owner===financeId))


  assert.equal((await h.api('invoice.finalise', owner, { invoice: draft.invoice.id }, 409)).error, 'source_changed')
  await send([['source-later', '1', '2026-06-01'], ['source-surplus', '1', '2026-06-02']])
  view = await h.api('usage/inspect?period=2026-06', owner)
  assert.equal(view.controls.find(c => c.id === second.id).acknowledged, false, 'new events revoke acknowledgement')
  await h.api('usage.acknowledge', owner, { control: second.id, basis: surplus.basis, reason: 'Stale view' }, 409)
  // Reconcile the remaining source assertion, then approve and issue once.
  await control('2026-06-02', 2, '3')
  draft = await prepare()
  assert.equal(draft.invoice.exceptions.some(e => e.code === 'usage_reconciliation'), false)
  assert.equal(draft.invoice.subtotal_cents, 1800)
  await h.api('invoice.approve', owner, { invoice: draft.invoice.id, acknowledge: true })
  await h.api('invoice.finalise', owner, { invoice: draft.invoice.id })
  assert.equal((await h.api(`invoices/${draft.invoice.id}`, owner)).status, 'issued')
  await h.page('/app/usage?period=2026-06', owner)
  await h.page(`/app/billing/${draft.run}`, owner)
  // A late event changes the source day, so the next invoice must reconcile it too.
  await send([['source-late-after-issue', '1', '2026-06-02']])
  const july = (await h.api('billrun.prepare', owner, { period: '2026-07' })).id
  const late = (await h.api(`runs/${july}`, owner)).invoices.find(i => i.customer_id === customer)
  assert.equal(late.exceptions.filter(e => e.code === 'usage_reconciliation').length, 1)
  assert.equal((await h.api('invoice.approve', owner, { invoice: late.id, acknowledge: true }, 409)).error, 'blocking_exception')
  await control('2026-06-02', 3, '4')
  const cleanJuly = (await h.api('billrun.prepare', owner, { period: '2026-07' })).id
  const cleanLate = (await h.api(`runs/${cleanJuly}`, owner)).invoices.find(i => i.customer_id === customer)
  assert.equal(cleanLate.exceptions.some(e => e.code === 'usage_reconciliation'), false)
  assert.equal(cleanLate.subtotal_cents, 200)
  assert.equal((await h.api(`invoices/${draft.invoice.id}`, owner)).subtotal_cents, 1800, 'the issued historical invoice stays unchanged')
  console.log('USE-007 source control totals, replay, surplus acknowledgement and exact approval passed')
}
