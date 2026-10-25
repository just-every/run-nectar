import assert from 'node:assert/strict'

export async function reconciliationFlow(h, owner, onState=async()=>{}) {
  await h.advanceClock('2026-10-25T12:00:00Z')
  const customer = (await h.api('customer.create', owner, { external_id: 'source-control', name: 'Cedar Source Systems', billing_email: 'ap@cedar.example' })).id
  const product = (await h.api('product.create', owner, { code: 'source-product', name: 'Source processing' })).id
  await h.api('meter.create', owner, { code: 'source-events', name: 'Source events', unit_label: 'events' })
  const price = (await h.api('price.create', owner, { product, kind: 'unit', meter: 'source-events', unit_amount: '2' })).id
  const subscription=(await h.api('subscription.create', owner, { customer, start_date: '2026-06-01', price: [price], quantity: [''] })).id
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

  // Acceptance rechecks both parties through ordinary case-linked proposals.
  const proposerEmail='synthetic-nectar-proposer@example.test'
  const assigneeEmail='synthetic-nectar-assignee@example.test'
  const give=async(email,role)=>h.api('access.give',owner,{email,name:'Synthetic case participant',role})
  const proposerId=(await give(proposerEmail,'finance')).id
  const proposer=await h.signIn(proposerEmail,{requested:true})
  const assigneeId=(await give(assigneeEmail,'finance')).id
  const assign=who=>h.api('assurance.assign',owner,{case:sourceCase.id,owner:who})
  await assign(assigneeId)
  const fix=who=>h.api('proposal.create',who,{assurance_case:sourceCase.id,kind:'amendment',title:'Synthetic reviewed case fix',payload:{subscription,kind:'fixed_credit',value:'1',effective_from:'2027-06-01',note:'Synthetic reviewed adjustment'},evidence:{clauses:[{quote:'Synthetic executed agreement permits a one dollar adjustment'}]}})
  const accept=(id,status=200)=>h.api('proposal.decide',owner,{proposal:id,decision:'approved'},status)
  const unchanged=async(id,code)=>{
    const before=await h.api(`subscriptions/${subscription}`,owner),mails=h.mails.length
    assert.equal((await accept(id,409)).error,code)
    assert.deepEqual(await h.api(`subscriptions/${subscription}`,owner),before,'refused acceptance changes no signed or financial records')
    assert.equal((await h.api(`proposals/${id}`,owner)).status,'pending')
    assert.equal(h.mails.length,mails,'refused acceptance sends no message')
  }
  const pending=await fix(proposer)
  await h.api('access.end',owner,{member:proposerId})
  await unchanged(pending.id,'assurance_proposer_unavailable')
  await give(proposerEmail,'accountant')
  await unchanged(pending.id,'assurance_proposer_unavailable')
  await h.api('access.end',owner,{member:proposerId})
  await give(proposerEmail,'finance')
  await h.api('access.end',owner,{member:assigneeId})
  await unchanged(pending.id,'assurance_owner_unavailable')
  await give(assigneeEmail,'accountant')
  await unchanged(pending.id,'assurance_owner_unavailable')
  const refused=await h.submit('proposal.decide',owner,{proposal:pending.id,decision:'approved'},`/app/proposals/${pending.id}`)
  assert.equal(refused.searchParams.get('error'),'assurance_owner_unavailable')
  await onState({label:'assignee-demoted',path:refused.pathname+refused.search})
  await h.api('access.end',owner,{member:assigneeId})
  await give(assigneeEmail,'finance')
  await assign(ownerId)
  await unchanged(pending.id,'assurance_case_changed')
  await assign(assigneeId)
  const linked=await h.api(`proposals/${pending.id}`,owner)
  assert.deepEqual(linked.evidence.assurance,{case:sourceCase.id,owner:assigneeId,proposer:proposerId,kind:'member'})
  await onState({label:'authorized-fix',path:`/app/proposals/${pending.id}`})
  await accept(pending.id)
  assert.equal((await h.api(`proposals/${pending.id}`,owner)).status,'approved')
  assert.equal((await h.api(`assurance-cases/${sourceCase.id}`,owner)).status,'open','approval of a financial proposal never closes an investigation')
  await accept(pending.id,409)
  const revokedKey=await h.api('credential.issue',owner,{name:'Synthetic revoked case proposer',scopes:['prepare']})
  const revokedProposal=await fix({bearer:revokedKey.key})
  await h.api('credential.revoke',owner,{key:revokedKey.id})
  await unchanged(revokedProposal.id,'assurance_proposer_unavailable')
  // A proposal cannot attach itself to another customer's investigation.
  const other=(await h.api('customer.create',owner,{external_id:'synthetic-nectar-case-peer',name:'Synthetic peer',billing_email:'peer@example.test'})).id
  const peerSub=(await h.api('subscription.create',owner,{customer:other,start_date:'2026-06-01',price:[price],quantity:['']})).id
  await h.api('proposal.create',agent,{assurance_case:sourceCase.id,kind:'amendment',title:'Synthetic foreign fix',payload:{subscription:peerSub,kind:'fixed_credit',value:'1',effective_from:'2027-06-01'},evidence:{clauses:[{quote:'Synthetic foreign terms'}]}},409)
  await assign(ownerId)

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
