import assert from 'node:assert/strict'
import { csvRows } from './financial-reports.mjs'
import { applyPolicy } from './policy-helper.mjs'

// USE-004 public-door historical evidence and governed financial execution.
export async function usageReplayFlow(h, owner, options = {}) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  await api('business.configure', { ...(await api('business')), timezone: 'UTC' })
  await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: 'CA', tax_mode: 'flat_rate', tax_rate: '10', tax_note: 'USE-004 saved historical tax' })
  await api('tax.review', { revision: (await api('business')).revision })
  const customer = (await api('customer.create', { external_id: 'USE004', name: 'Cedar Compute', billing_email: 'billing@cedar.example' })).id
  const source = await api('meter.create', { code: 'use004-snapshots', name: 'Recorded capacity', unit_label: 'units' })
  const events = [
    { event_id: 'use004-predecessor', quantity: '2', occurred_at: '2019-12-31T00:00:00Z' },
    { event_id: 'use004-original', quantity: '20', occurred_at: '2020-01-16T00:00:00Z' },
  ].map(e => ({ ...e, customer: 'USE004', meter: source.code, properties: { resource: 'one', user: 'one' } }))
  await api('usage.submit', { events })
  const prices = [], kinds = new Map()
  for (const aggregation of ['maximum', 'unique', 'latest', 'time_weighted']) {
    const request = await api('meter.prepare', { code: `use004-${aggregation}`, name: aggregation, unit_label: 'units', source_meter: source.id, definition: { aggregation, ...(aggregation === 'unique' ? { unique_property: 'user' } : {}), ...(aggregation === 'time_weighted' ? { entity_property: 'resource', time_unit: 'month' } : {}) } })
    for (const period of ['2019-11', '2019-12', '2020-01']) await api('meter.preview', { request: request.request, customer, period })
    const metric = await api('meter.activate', { request: request.request })
    const product = (await api('product.create', { code: `use004-${aggregation}`, name: `Recorded ${aggregation}` })).id
    const price = (await api('price.create', { product, kind: 'unit', meter: metric.id, unit_amount: '1', taxable: true })).id
    prices.push(price); kinds.set(price, aggregation)
  }
  const subscription = (await api('subscription.create', { customer, start_date: '2020-01-01', price: prices })).id
  const issued = []
  for (const period of ['2020-01', '2020-02']) {
    const run = await api('billrun.prepare', { period })
    const invoice = (await api(`runs/${run.id}`)).invoices.find(i => i.customer_id === customer)
    await api('invoice.approve', { invoice: invoice.id, acknowledge: true })
    await api('invoice.finalise', { invoice: invoice.id, issue_date: invoice.period_end })
    issued.push(await api(`invoices/${invoice.id}`))
  }
  const body = { subscription, from_period: '2020-01', through_period: '2020-02', void_event_ids: [], add_event_ids: [] }
  const snapshot = async () => ({ invoices: await Promise.all(issued.map(i => api(`invoices/${i.id}`))), batches: await api('usage/batches'), payments: await api('payments'), audit: await api('audit'), proposals: await api('proposals'), mails: h.mails.length })
  const original = await snapshot()
  const noChange = await api('usage.correction.preview', body)
  assert.deepEqual(noChange.delta, { subtotalCents: 0, taxCents: 0, totalCents: 0 }, 'USE-004 empty replay reproduces both issued invoices')
  assert.equal(noChange.status, 'unresolved', 'USE-004 a preview never claims disposition or resolution')
  assert.equal(noChange.scope, 'selected-issued-range-only', 'USE-004 downstream scope is explicit')
  assert.deepEqual(await snapshot(), original, 'USE-004 preview leaves all financial, usage, audit, proposal and message custody unchanged')

  // Later current policy cannot rewrite saved historical terms.
  await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: 'CA', tax_mode: 'flat_rate', tax_rate: '20', tax_note: 'USE-004 current tax differs' })
  await api('tax.review', { revision: (await api('business')).revision })
  const late = { ...events[1], event_id: 'use004-late-low', quantity: '5', occurred_at: '2020-01-20T00:00:00Z' }
  await api('usage.submit', { events: [late] })
  const beforeReplay = await snapshot()
  const replay = await api('usage.correction.preview', { ...body, add_event_ids: [late.event_id] })
  const lineDelta = (period, kind) => {
    const p = replay.periods[period], price = [...kinds].find(([, k]) => k === kind)[0]
    return p.after.lines.find(l => l.priceId === price).amountCents - p.before.lines.find(l => l.priceId === price).amountCents
  }
  assert.equal(lineDelta(0, 'maximum'), 0, 'USE-004 a late value below the original maximum adds zero')
  assert.equal(lineDelta(0, 'unique'), 0, 'USE-004 a repeated unique value adds zero')
  assert.equal(lineDelta(0, 'latest'), -1500, 'USE-004 late latest rerates the original window, not a new aggregate')
  assert.equal(lineDelta(0, 'time_weighted'), -581, 'USE-004 January predecessor and full 31-day window give 350/31 -> 170/31 units')
  assert.equal(lineDelta(1, 'latest'), 0, 'USE-004 latest uses in-window events only; an empty later window stays zero')
  assert.equal(lineDelta(1, 'time_weighted'), -1500, 'USE-004 corrected predecessor carries through leap February')
  assert.deepEqual(replay.delta, { subtotalCents: -3581, taxCents: -358, totalCents: -3939 }, 'USE-004 signed total and saved 10% tax are independently calculated across both periods')
  assert.ok(replay.periods.every(p => p.after.lines.some(l => [...(l.evidence.eventIds || []), ...(l.evidence.contextEventIds || [])].includes(late.event_id))), 'USE-004 original-period and predecessor evidence cite the selected late event')
  assert.deepEqual((await api('usage.correction.preview', { ...body, add_event_ids: [late.event_id] })), replay, 'USE-004 unchanged sources give identical fingerprints and complete replay')
  assert.deepEqual(await snapshot(), beforeReplay, 'USE-004 replay does not consume late events or change issued inputs')
  const run = await api('billrun.prepare', { period: '2020-03' })
  const blocked = (await api(`runs/${run.id}`)).invoices.find(i => i.customer_id === customer)
  assert.ok((await api(`invoices/${blocked.id}`)).exceptions.some(e => e.code === 'metric_late_correction'), 'USE-004 unresolved correction keeps the issue block')
  await api('invoice.approve', { invoice: blocked.id, acknowledge: true }, 409)

  const voided = await api('usage.correction.preview', { ...body, void_event_ids: ['use004-original'] })
  assert.equal(voided.periods[0].after.lines.find(l => kinds.get(l.priceId) === 'maximum').amountCents, 0, 'USE-004 proposed void removes the original maximum only in replay')
  assert.equal(voided.periods[0].after.lines.find(l => kinds.get(l.priceId) === 'time_weighted').amountCents, 200, 'USE-004 void restores the full prior state across January')
  assert.deepEqual(await Promise.all(issued.map(i => api(`invoices/${i.id}`))), original.invoices, 'USE-004 proposed void preserves all original issued evidence')

  await api('access.give', { email: 'use004-accountant@example.test', name: 'Replay Accountant', role: 'accountant' })
  const accountant = await h.signIn('use004-accountant@example.test', { requested: true })
  const readerKey = await api('credential.issue', { name: 'Replay reader', scopes: ['prepare'] })
  const usageKey = await api('credential.issue', { name: 'Replay ingestion', scopes: ['usage'] })
  for (const who of [accountant, { bearer: readerKey.key }]) assert.deepEqual((await h.api('usage.correction.preview', who, body)).delta, noChange.delta, 'USE-004 current read roles reach only a read-only preview')
  await h.api('usage.correction.preview', { bearer: usageKey.key }, body, 403)
  await h.api('usage.correction.preview', undefined, body, 401)
  await api('usage.correction.preview', { ...body, void_event_ids: ['missing'] }, 404)
  await api('usage.correction.preview', { ...body, void_event_ids: ['use004-original', 'use004-original'] }, 400)
  await api('usage.correction.preview', { ...body, add_event_ids: ['use004-original'] }, 409)
  await api('usage.correction.preview', { ...body, from_period: '2020-03' }, 400)
  await api('usage.correction.preview', { ...body, through_period: '2020-03' }, 409)
  const foreign = (await api('customer.create', { external_id: 'USE004-FOREIGN', name: 'Separate customer', billing_email: 'foreign@example.test' })).id
  await api('usage.submit', { events: [{ ...late, event_id: 'use004-foreign', customer: 'USE004-FOREIGN' }] })
  await api('usage.correction.preview', { ...body, add_event_ids: ['use004-foreign'] }, 404)
  await api('usage.submit', { events: [{ ...late, event_id: 'use004-outside', occurred_at: '2020-03-20T00:00:00Z' }] })
  await api('usage.correction.preview', { ...body, add_event_ids: ['use004-outside'] }, 409)
  const form = new URLSearchParams({ subscription, from_period: '2020-01', through_period: '2020-02', void_ids: '', add_ids: late.event_id })
  const html = await (await h.raw('/app/usage/replay', { cookie: owner, form })).text()
  assert.ok(html.includes(replay.periods[0].originalFingerprint) && html.includes(late.event_id), 'USE-004 HTML form renders the same original fingerprint and selected event evidence')
  assert.ok(html.includes('−$39.39'), 'USE-004 HTML form agrees with API signed total')
  assert.equal((await h.raw('/app/usage/replay', { cookie: owner, form, headers: { origin: 'https://foreign.example' } })).status, 403, 'USE-004 cross-site form cannot reach replay')
  assert.ok((await h.page(`/app/invoices/${issued[0].id}`, owner)).includes(`/app/usage/replay?subscription=${subscription}`), 'USE-004 invoice links to the correct subscription historical replay')
  await h.page(`/app/usage/replay?subscription=${subscription}&period=2020-01`, accountant)

  // Prove the acceptance-sized preview before executing each disposition below.
  const bulkSource = await api('meter.create', { code: 'use004-bulk', name: 'Bulk events', unit_label: 'events' })
  const bulkProduct = (await api('product.create', { code: 'use004-bulk', name: 'Bulk processing' })).id
  const bulkPrice = (await api('price.create', { product: bulkProduct, kind: 'unit', meter: bulkSource.id, unit_amount: '0.01', taxable: false })).id
  const bulkSub = (await api('subscription.create', { customer: foreign, start_date: '2020-07-01', price: [bulkPrice] })).id
  const bulk = Array.from({ length: 10000 }, (_, i) => ({ event_id: `use004-bulk-${i}`, customer: 'USE004-FOREIGN', meter: bulkSource.code, quantity: '1', occurred_at: '2020-07-10T00:00:00Z' }))
  for (let i = 0; i < bulk.length; i += 500) assert.equal((await api('usage.submit', { events: bulk.slice(i, i + 500) })).accepted, 500)
  const bulkRun = await api('billrun.prepare', { period: '2020-07' })
  const bulkInvoice = (await api(`runs/${bulkRun.id}`)).invoices.find(i => i.customer_id === foreign)
  await api('invoice.approve', { invoice: bulkInvoice.id, acknowledge: true })
  await api('invoice.finalise', { invoice: bulkInvoice.id, issue_date: '2020-08-01' })
  const savedBulk = await api(`invoices/${bulkInvoice.id}`)
  const bulkReplay = await api('usage.correction.preview', { subscription: bulkSub, from_period: '2020-07', through_period: '2020-07', void_event_ids: bulk.map(e => e.event_id), add_event_ids: [] })
  assert.deepEqual(bulkReplay.delta, { subtotalCents: -10000, taxCents: 0, totalCents: -10000 }, 'USE-004 10,000 proposed historical voids replay to the independent exact delta')
  assert.equal(bulkReplay.periods[0].eventIds.length, 10000, 'USE-004 acceptance-sized replay cites every original event')
  assert.deepEqual(await api(`invoices/${bulkInvoice.id}`), savedBulk, 'USE-004 10,000-event replay leaves July immutable')
  const dispositions=await usageDispositionFlow(h,owner,{subscription,customer,issued,late,body,accountant,readerKey,usageKey,bulkSource,bulkPrice,bulkSub,bulk,bulkInvoice,savedBulk,foreign,options})
  console.log('USE-004 historical range, 10,000-event void preview, maximum/unique/latest/time-weighted deltas, predecessor, tax, authority and unresolved blocking passed')
  return { ...dispositions, subscription, invoice: issued[0].id, lateEvent: late.event_id, paths: [`/app/invoices/${issued[0].id}`, `/app/usage/replay?subscription=${subscription}&period=2020-01`] }
}

// Immutable money and source fields, independent of later ledger projections.
const issuedEvidence = invoice => Object.fromEntries(['id','number','status','subtotal_cents','tax_cents','total_cents','source_fingerprint','approved_fingerprint','calc_version','calculation','lines','approved_by','approved_at','issued_by','issued_at','issue_date','due_date'].map(k=>[k,invoice[k]]))

export async function usageDispositionFlow(h,owner,ctx) {
  const api=(path,body,status)=>h.api(path,owner,body,status), read=id=>api(`invoices/${id}`)
  const corrections=sub=>api(`usage/corrections?subscription=${sub}`)
  const decision=(id,who=owner,status=200)=>h.api('usage.correction.decide',who,{correction:id,decision:'approved'},status)
  const prepare=(payload,who=owner,status=200)=>h.api('usage.correction.prepare',who,{...payload,reason:'Reviewed source correction',explanation:'We reviewed the retained source events and corrected the recorded usage. The original invoice stays unchanged.'},status)
  const observe=async (state,paths,data={})=>ctx.options.observe?.(state,paths,data)
  await api('access.give',{email:'synthetic-nectar-finance@example.test',name:'Independent Finance',role:'finance'})
  const finance=await h.signIn('synthetic-nectar-finance@example.test',{requested:true})
  await applyPolicy(h,owner,'credit.policy',{two_person_above:'10.00'})
  // A selected-range preview is never enough to execute a historical chain.
  assert.equal((await prepare({...ctx.body,through_period:'2020-01',add_event_ids:[ctx.late.event_id]},owner,409)).error,'complete_downstream_replay_required')
  for(const who of [ctx.accountant,{bearer:ctx.usageKey.key}])await prepare({...ctx.body,add_event_ids:[ctx.late.event_id]},who,403)
  const negative=await prepare({...ctx.body,add_event_ids:[ctx.late.event_id]},{bearer:ctx.readerKey.key})
  assert.deepEqual(negative.plan.delta,{subtotalCents:-3581,taxCents:-358,totalCents:-3939},'USE-004 executed metric correction uses independently calculated historical 10% deltas')
  assert.deepEqual(negative.plan.periods.map(p=>p.postingRevenue),[[{period:negative.plan.issueDate.slice(0,7),amountCents:-2081,method:'credit-contra-issue-month'}],[{period:negative.plan.issueDate.slice(0,7),amountCents:-1500,method:'credit-contra-issue-month'}]],'USE-004 credit revenue preview uses the existing issue-month contra policy and excludes tax')
  await observe('metric-pending',[`/app/usage/replay?subscription=${ctx.subscription}&period=2020-01`])
  const messagesBefore=h.mails.length
  await decision(negative.id,{bearer:ctx.readerKey.key},403)
  await decision(negative.id,ctx.accountant,403)
  assert.equal((await decision(negative.id,finance,409)).error,'second_approver_required','USE-004 agent preparation cannot satisfy human credit governance')
  await api('usage.correction.authorize',{correction:negative.id})
  assert.equal((await decision(negative.id,owner,409)).error,'second_approver_required','USE-004 above-threshold human preparation needs a different approver')
  const executed=await decision(negative.id,finance)
  assert.equal(executed.documents.length,2,'USE-004 every affected issued period has its own exact negative disposition')
  assert.equal(new Set(executed.documents.map(d=>d.number)).size,2,'USE-004 sequential credits reserve distinct numbers in one atomic execution')
  assert.equal(executed.carriedCents,3939,'USE-004 next-invoice negative correction creates the full carried credit, even while originals are unpaid')
  assert.equal(h.mails.length,messagesBefore+1,'USE-004 approval reserves and attempts one frozen customer message')
  const saved=(await corrections(ctx.subscription)).find(c=>c.id===negative.id)
  assert.equal(saved.mail.status,'accepted')
  assert.ok(saved.mail.body===negative.plan.message.body,'USE-004 approved wording and exact calculated tax/revenue citations are preserved')
  assert.ok(h.mails.at(-1).text===saved.mail.body,'USE-004 actual network-edge message equals the frozen approved reservation')
  for(const invoice of ctx.issued)assert.deepEqual(issuedEvidence(await read(invoice.id)),issuedEvidence(invoice),'USE-004 all original versions, inputs, tax and issued lines remain immutable')
  const issueMonth=negative.plan.issueDate.slice(0,7)
  const taxCredits=await api(`reports/tax?period=${issueMonth}&customer=${ctx.customer}`)
  assert.equal(taxCredits.totalCents,-358,'USE-004 attributed tax report reverses the exact saved 10% deltas and leaves originals in their original issue months')
  for(const entry of taxCredits.entries){const detail=await api(entry.href.replace('/app/',''));assert.equal(detail.components.reduce((n,c)=>n+c.amountCents,0),entry.amountCents)}
  const creditRevenue=await api(`revenue?period=${issueMonth}&customer=${ctx.customer}`)
  assert.deepEqual([creditRevenue.netBillingsCents,creditRevenue.recognizedCents],[-3581,-3581],'USE-004 tax is excluded from the actual credit contra-revenue journal')
  await observe('tax-revenue',[`/app/reports/tax?period=${issueMonth}&customer=${ctx.customer}`,`/app/revenue?period=${issueMonth}&customer=${ctx.customer}`,'/app/settings#policy-changes'])
  await decision(negative.id,finance,409)
  await prepare({...ctx.body,add_event_ids:[ctx.late.event_id]},owner,409)
  assert.deepEqual((await api('usage.correction.preview',ctx.body)).delta,{subtotalCents:0,taxCents:0,totalCents:0},'USE-004 cumulative replay starts from the approved effective basis, not the original money again')
  const unblocked=await api(`subscriptions/${ctx.subscription}/upcoming?period=2020-03`)
  assert.ok(!unblocked.calculation.exceptions.some(e=>e.code==='metric_late_correction'),'USE-004 only governed resolution clears the late-nonadditive issue block')

  // A second late event changes a previously corrected chain. Actual positive
  // billing uses original 10% tax, despite today's 20% policy.
  await applyPolicy(h,owner,'usage.correction.policy',{disposition:'correcting_invoice'})
  const high={...ctx.late,event_id:'synthetic-nectar-late-high',quantity:'40',occurred_at:'2020-01-25T00:00:00Z'}
  await api('usage.submit',{events:[high]})
  assert.equal((await prepare({...ctx.body,from_period:'2020-02',add_event_ids:[high.event_id]},owner,409)).error,'complete_upstream_replay_required')
  const positive=await prepare({...ctx.body,add_event_ids:[high.event_id]})
  assert.deepEqual(positive.plan.delta,{subtotalCents:9791,taxCents:979,totalCents:10770},'USE-004 maximum/latest/time-weighted second correction bills only the independently calculated cumulative delta')
  const corrected=await decision(positive.id,finance)
  assert.ok(corrected.invoice,'USE-004 correcting policy creates a real separate invoice')
  let debit=await read(corrected.invoice)
  assert.deepEqual([debit.subtotal_cents,debit.tax_cents,debit.total_cents],[9791,979,10770])
  assert.ok(debit.lines.filter(l=>l.kind==='usage_correction').every(l=>l.evidence.eventIds.includes(high.event_id)))
  const smallCharge=await api('charge.add',{customer:ctx.customer,amount:'1',description:'Recorded service after correction',taxable:false,effective_date:positive.plan.issueDate})
  const smallInvoice=await api('invoice.manual',{customer:ctx.customer,charges:[smallCharge.charge],service_date:positive.plan.issueDate})
  await api('invoice.approve',{invoice:smallInvoice.id,acknowledge:true});await api('invoice.finalise',{invoice:smallInvoice.id})
  assert.equal((await read(smallInvoice.id)).balanceCents,0,'USE-004 carried liability also applies through the ordinary standalone-invoice door')
  assert.equal((await api('invoice.approve',{invoice:debit.id,acknowledge:true},409)).error,'source_changed','USE-004 changed available liability invalidates the old correcting draft')
  const oldDebit=debit.id
  const refreshed=await api('invoice.correction.refresh',{invoice:oldDebit})
  assert.equal((await read(oldDebit)).status,'discarded')
  debit=await read(refreshed.id)
  await api('invoice.approve',{invoice:debit.id,acknowledge:true})
  await api('invoice.finalise',{invoice:debit.id})
  debit=await read(debit.id)
  assert.equal(debit.status,'issued')
  assert.equal(debit.carriedApplications.reduce((n,a)=>n+a.amount_cents,0),3839,'USE-004 carried credits also apply once to a later correcting invoice')
  assert.equal(debit.balanceCents,6931)
  assert.deepEqual([debit.subtotal_cents,debit.tax_cents,debit.total_cents],[9791,979,10770],'USE-004 correcting invoice issue matches its exact approved preview')
  await api('invoice.finalise',{invoice:debit.id},409)
  await api('invoice.correction.refresh',{invoice:debit.id},409)
  const sourceRevenue=await api(`revenue/${debit.id}?from=2020-01&to=2020-02`)
  assert.deepEqual(sourceRevenue.schedules.filter(s=>s.kind==='usage_correction').flatMap(s=>s.entries).map(e=>[e.period,e.amountCents]),[['2020-01',6291],['2020-02',3500]],'USE-004 actual correcting-invoice recognition matches independently calculated original-service deltas')
  assert.equal((await api(`reports/tax?period=${issueMonth}&customer=${ctx.customer}`)).totalCents,621,'USE-004 separate debit and credit tax contributions reconcile without changing original tax')
  assert.ok(JSON.stringify(sourceRevenue).includes('historical-usage-replay-delta'),'USE-004 correcting invoice revenue is backed by persisted original-service delta schedules')
  for(const invoice of ctx.issued)assert.deepEqual(issuedEvidence(await read(invoice.id)),issuedEvidence(invoice))
  const receiptPage=await h.raw(`/app/usage/replay?subscription=${ctx.subscription}&period=2020-01`,{cookie:owner})
  const receiptHtml=await receiptPage.text()
  assert.ok(receiptHtml.includes(`/app/invoices/${debit.id}#recv`),'USE-004 approved receipt links to the current refreshed correcting invoice through the ordinary review door')
  await observe('metric-approved',[`/app/usage/replay?subscription=${ctx.subscription}&period=2020-01`,`/app/invoices/${debit.id}`,`/app/invoices/${ctx.issued[0].id}`])

  // The full 10,000-event acceptance is executed under each approved business
  // policy. Next-period negatives are numbered credits applied on the August
  // statement; negative correcting balances never become negative invoices.
  const product=(await api('product.create',{code:'synthetic-nectar-base',name:'Monthly base'})).id
  const base=(await api('price.create',{product,kind:'flat',unit_amount:'40',taxable:true})).id
  const outcomes=[]
  for(const [index,disposition] of ['next_invoice','correcting_invoice','credit_note'].entries()) {
    await applyPolicy(h,owner,'usage.correction.policy',{disposition})
    let customer,sub,events,invoice
    if(index===0){customer=ctx.foreign;sub=ctx.bulkSub;events=ctx.bulk;invoice=ctx.savedBulk}
    else {
      const external=`synthetic-nectar-${index}`
      customer=(await api('customer.create',{external_id:external,name:`Correction customer ${index}`,billing_email:`synthetic-nectar-${index}@example.test`,...(index===2?{language:'es-US'}:{})})).id
      sub=(await api('subscription.create',{customer,start_date:'2020-07-01',price:[ctx.bulkPrice]})).id
      events=Array.from({length:10000},(_,n)=>({event_id:`synthetic-nectar-${index}-${n}`,customer:external,meter:ctx.bulkSource.code,quantity:'1',occurred_at:'2020-07-10T00:00:00Z'}))
      for(let n=0;n<events.length;n+=500)assert.equal((await api('usage.submit',{events:events.slice(n,n+500)})).accepted,500)
      const run=await api('billrun.prepare',{period:'2020-07'})
      invoice=(await api(`runs/${run.id}`)).invoices.find(i=>i.subscription_id===sub||i.customer_id===customer)
      await api('invoice.approve',{invoice:invoice.id,acknowledge:true})
      await api('invoice.finalise',{invoice:invoice.id,issue_date:'2020-08-01'})
      invoice=await read(invoice.id)
    }
    // Paid and partly-paid source invoices must never acquire a negative AR
    // balance or imply a cash refund; the entire liability stays visible.
    const paid=index===0?10000:index===1?7500:0
    if(paid){const payment=await api('payment.record',{customer,amount:(paid/100).toFixed(2),received_on:'2020-08-02',method:'bank_transfer',reference:`synthetic-nectar-paid-${index}`});await api('payment.allocate',{invoice:invoice.id,payment:payment.payment,amount:(paid/100).toFixed(2)})}
    await api('subscription.addon',{subscription:sub,price:base,effective_date:'2020-08-01'})
    const payload={subscription:sub,from_period:'2020-07',through_period:'2020-07',void_event_ids:events.map(e=>e.event_id),add_event_ids:[]}
    let proposal
    if(index===2){
      const location=await h.submit('usage.correction.prepare',owner,{subscription:sub,from_period:'2020-07',through_period:'2020-07',void_ids:payload.void_event_ids.join('\n'),add_ids:'',reason:'Reviewed source correction',explanation:'We reviewed the retained source events and corrected the recorded usage. The original invoice stays unchanged.'},`/app/usage/replay?subscription=${sub}&correction={id}`)
      assert.equal(location.searchParams.get('error'),null,'USE-004 ordinary HTML form accepts the complete 10,000-event proposal')
      proposal=(await corrections(sub)).find(c=>c.id===location.searchParams.get('correction'))
      assert.ok(proposal)
    }else proposal=await prepare(payload)
    assert.deepEqual(proposal.plan.delta,{subtotalCents:-10000,taxCents:0,totalCents:-10000})
    assert.equal(proposal.plan.periods[0].eventIds.length,10000)
    assert.equal(proposal.plan.carriedCents,paid,'USE-004 paid/partly-paid corrections retain the exact unapplied liability')
    const pendingInvoiceRun=await api('billrun.prepare',{period:'2020-08'})
    const pendingInvoice=(await api(`runs/${pendingInvoiceRun.id}`)).invoices.find(i=>i.customer_id===customer)
    assert.ok((await read(pendingInvoice.id)).exceptions.some(e=>e.code==='usage_correction_pending'),'USE-004 even void-only pending corrections block issue')
    await api('invoice.approve',{invoice:pendingInvoice.id,acknowledge:true},409)
    if(index===1)h.mailResponses.push({status:500,body:{name:'provider_error'}})
    const beforeMessages=h.mails.length
    await decision(proposal.id,owner,409)
    let result
    if(index===2){const location=await h.submit('usage.correction.decide',finance,{correction:proposal.id,decision:'approved'},`/app/usage/replay?subscription=${sub}`);assert.equal(location.searchParams.get('error'),null);const saved=(await corrections(sub)).find(c=>c.id===proposal.id);assert.equal(saved.status,'approved');result={carriedCents:saved.plan.carriedCents}}
    else result=await decision(proposal.id,finance)
    assert.equal(h.mails.length,beforeMessages+1)
    assert.equal(result.carriedCents,paid)
    const original=await read(invoice.id)
    assert.deepEqual(issuedEvidence(original),issuedEvidence(invoice),'USE-004 10,000-event execution preserves July issued evidence under every policy')
    assert.equal(original.balanceCents,0,'USE-004 applied credit is bounded by the unpaid original')
    assert.equal(original.credits[0].amount_cents,10000)
    assert.equal(original.credits[0].applied_cents,10000-paid)
    const ledger=(await api(`customers/${customer}`)).ledger
    assert.equal(ledger.carriedUsageCredits.reduce((n,c)=>n+c.availableCents,0),paid)
    const receipt=(await corrections(sub)).find(c=>c.id===proposal.id)
    assert.equal(receipt.mail.status,index===1?'uncertain':'accepted')
    if(index===2)assert.equal(receipt.mail.subject,'Corrección histórica de uso','USE-004 generated customer messages follow the existing complete Spanish catalogue; authored text is unchanged')
    await observe(`bulk-${disposition}`,[`/app/usage/replay?subscription=${sub}&period=2020-07`,`/app/invoices/${invoice.id}`,`/app/customers/${customer}`])
    // Explicit issue consumes available liability once, after the exact same
    // current-tax invoice calculation the human reviewed.
    assert.equal((await api(`reports/credit-balances?customer=${customer}`)).totalCents,paid,'USE-004 company/customer liability report equals the current carried ledger')
    let remaining=paid
    const applied=[]
    for(const month of ['2020-08','2020-09','2020-10']) {
      const preview=await api(`subscriptions/${sub}/upcoming?period=${month}`)
      assert.deepEqual([preview.calculation.subtotalCents,preview.calculation.taxCents,preview.calculation.totalCents],[4000,800,4800])
      const expected=Math.min(remaining,4800)
      assert.equal(preview.balanceAfterCreditsCents,4800-expected)
      const run=await api('billrun.prepare',{period:month})
      const next=(await api(`runs/${run.id}`)).invoices.find(i=>i.customer_id===customer)
      await api('invoice.approve',{invoice:next.id,acknowledge:true})
      if(index===0&&month==='2020-08')assert.equal((await api('invoice.finalise',{invoice:next.id,issue_date:next.period_end},409)).error,'credit_after_invoice_date','USE-004 carried credit cannot be applied on an invoice dated before it existed')
      await api('invoice.finalise',{invoice:next.id})
      const issued=await read(next.id)
      assert.equal(issued.carriedApplications.reduce((n,a)=>n+a.amount_cents,0),expected)
      assert.equal(issued.balanceCents,4800-expected,'USE-004 credit applications affect only owed balance, not new consideration/tax/revenue')
      assert.equal(issued.total_cents,4800)
      if(expected)assert.ok(issued.lines.some(l=>l.kind==='usage_credit_application'&&l.evidence.appliedCents===expected),'USE-004 August statement line cites the original correction credit and exact application')
      await api('invoice.finalise',{invoice:next.id},409)
      remaining-=expected;applied.push(next.id)
      const creditBalance=await api(`reports/credit-balances?customer=${customer}`)
      assert.equal(creditBalance.totalCents,remaining)
      for(const entry of creditBalance.entries){const source=await api(entry.href.replace('/app/',''));assert.equal(source.components.reduce((n,c)=>n+c.amountCents,0),entry.amountCents)}
      if(month==='2020-08')await observe(`august-${disposition}`,[`/app/invoices/${next.id}`])
    }
    assert.equal(remaining,0)
    assert.equal((await api(`customers/${customer}`)).ledger.carriedUsageCredits.length,0,'USE-004 sequential applications exhaust the liability exactly once')
    const register=await api('number-register')
    assert.ok(register.entries.some(e=>e.id===original.credits[0].id&&e.totalCents===10000),'USE-004 numbered note face value is preserved in the unified register')
    outcomes.push({sub,customer,correction:proposal.id,invoice:invoice.id,applications:applied})
  }
  // Positive next-period corrections use the same saved-basis tax arithmetic
  // as correcting invoices, rather than billing a fresh aggregate.
  await applyPolicy(h,owner,'usage.correction.policy',{disposition:'next_invoice'})
  const next=outcomes[0],lateUnit={event_id:'synthetic-nectar-next-debit',customer:'USE004-FOREIGN',meter:ctx.bulkSource.code,quantity:'1',occurred_at:'2020-07-20T00:00:00Z'}
  await api('usage.submit',{events:[lateUnit]})
  assert.ok((await api(`subscriptions/${next.sub}/upcoming?period=2020-11`)).calculation.exceptions.some(e=>e.code==='historical_usage_correction'),'USE-004 a native late event cannot bypass the historical policy')
  const nextDebit=await prepare({subscription:next.sub,from_period:'2020-07',through_period:'2020-10',void_event_ids:[],add_event_ids:[lateUnit.event_id]})
  assert.deepEqual(nextDebit.plan.delta,{subtotalCents:1,taxCents:0,totalCents:1})
  await decision(nextDebit.id,finance)
  const november=await api(`subscriptions/${next.sub}/upcoming?period=2020-11`)
  assert.deepEqual([november.calculation.subtotalCents,november.calculation.taxCents,november.calculation.totalCents],[4001,800,4801],'USE-004 historical untaxed one-cent difference is never taxed at the current 20% rate')
  const nextRun=await api('billrun.prepare',{period:'2020-11'})
  const nextInvoice=(await api(`runs/${nextRun.id}`)).invoices.find(i=>i.customer_id===next.customer)
  await api('invoice.approve',{invoice:nextInvoice.id,acknowledge:true})
  await api('invoice.finalise',{invoice:nextInvoice.id})
  const nextIssued=await read(nextInvoice.id)
  assert.deepEqual([nextIssued.subtotal_cents,nextIssued.tax_cents,nextIssued.total_cents],[4001,800,4801])
  assert.ok(nextIssued.lines.some(l=>l.kind==='usage_correction'&&l.amount_cents===1&&l.evidence.eventIds.includes(lateUnit.event_id)))
  await observe('next-debit',[`/app/invoices/${nextInvoice.id}`])
  // A void in an early minimum window must propagate through the later true-up;
  // selected-period-only replay would incorrectly issue a net credit here.
  await applyPolicy(h,owner,'usage.correction.policy',{disposition:'correcting_invoice'})
  const commitmentCustomer=(await api('customer.create',{external_id:'synthetic-nectar-commitment',name:'Commitment customer',billing_email:'synthetic-nectar-commitment@example.test'})).id
  const commitmentProduct=(await api('product.create',{code:'synthetic-nectar-commitment',name:'Committed usage'})).id
  const commitmentPrice=(await api('price.create',{product:commitmentProduct,kind:'unit',meter:ctx.bulkSource.id,unit_amount:'1',taxable:true})).id
  const commitmentSub=(await api('subscription.create',{customer:commitmentCustomer,start_date:'2020-07-01',price:[commitmentPrice]})).id
  const terms=await api('contract.prepare',{subscription:commitmentSub,revision:(await api(`subscriptions/${commitmentSub}`)).revision,clause:'Two-month minimum $200 before tax',commitments:[{from:'2020-07-01',to:'2020-09-01',minimum:'200',taxable:true}],included:[],ramps:[]})
  await h.api('contract.decide',finance,{contract:terms.contract,decision:'approved'})
  const commitmentEvents=['07','08'].map(month=>({event_id:`synthetic-nectar-commitment-${month}`,customer:'synthetic-nectar-commitment',meter:ctx.bulkSource.code,quantity:'100',occurred_at:`2020-${month}-10T00:00:00Z`}))
  await api('usage.submit',{events:commitmentEvents})
  const commitmentOriginals=[]
  for(const month of ['2020-07','2020-08']){const run=await api('billrun.prepare',{period:month});const invoice=(await api(`runs/${run.id}`)).invoices.find(i=>i.customer_id===commitmentCustomer);await api('invoice.approve',{invoice:invoice.id,acknowledge:true});await api('invoice.finalise',{invoice:invoice.id,issue_date:invoice.period_end});commitmentOriginals.push(await read(invoice.id))}
  const commitmentPayment=await api('payment.record',{customer:commitmentCustomer,amount:'120',received_on:'2020-08-02',method:'bank_transfer',reference:'synthetic-nectar-commitment-payment'})
  await api('payment.allocate',{invoice:commitmentOriginals[0].id,payment:commitmentPayment.payment,amount:'120'})
  const commitment=await prepare({subscription:commitmentSub,from_period:'2020-07',through_period:'2020-08',void_event_ids:[commitmentEvents[0].event_id],add_event_ids:[]})
  assert.deepEqual(commitment.plan.periods.map(p=>[p.subtotalCents,p.taxCents,p.totalCents]),[[-10000,-2000,-12000],[10000,2000,12000]],'USE-004 a historical void replays the later minimum settlement with original tax')
  assert.deepEqual(commitment.plan.delta,{subtotalCents:0,taxCents:0,totalCents:0})
  const commitmentExecution=await decision(commitment.id,finance)
  assert.ok(commitmentExecution.invoice)
  await api('invoice.approve',{invoice:commitmentExecution.invoice,acknowledge:true})
  await api('invoice.finalise',{invoice:commitmentExecution.invoice})
  for(const original of commitmentOriginals)assert.deepEqual(issuedEvidence(await read(original.id)),issuedEvidence(original))
  const settled=(await api(`subscriptions/${commitmentSub}`)).burnDown[0]
  assert.deepEqual([settled.earnedCents,settled.trueUpCents,settled.remainingCents],[10000,10000,0],'USE-004 subsequent commitment consumers use the effective replay chain and do not settle twice')
  await observe('commitment',[`/app/usage/replay?subscription=${commitmentSub}&period=2020-07`,`/app/invoices/${commitmentExecution.invoice}`])
  const longCustomer=(await api('customer.create',{external_id:'synthetic-nectar-long',name:'Long retained history',billing_email:'synthetic-nectar-long@example.test'})).id
  const longSub=(await api('subscription.create',{customer:longCustomer,start_date:'2015-01-01',price:[ctx.bulkPrice]})).id
  const longEvent={event_id:'synthetic-nectar-long-event',customer:'synthetic-nectar-long',meter:ctx.bulkSource.code,quantity:'100',occurred_at:'2015-01-10T00:00:00Z'}
  await api('usage.submit',{events:[longEvent]})
  const longInvoices=[]
  for(let index=0;index<37;index++){
    const period=new Date(Date.UTC(2015,index,1)).toISOString().slice(0,7),run=await api('billrun.prepare',{period})
    const invoice=(await api(`runs/${run.id}`)).invoices.find(i=>i.customer_id===longCustomer)
    await api('invoice.approve',{invoice:invoice.id,acknowledge:true});await api('invoice.finalise',{invoice:invoice.id,issue_date:invoice.period_end});longInvoices.push(await read(invoice.id))
  }
  const longPayment=await api('payment.record',{customer:longCustomer,amount:'1',received_on:'2015-02-02',method:'bank_transfer',reference:'synthetic-nectar-long-payment'})
  await api('payment.allocate',{invoice:longInvoices[0].id,payment:longPayment.payment,amount:'1'})
  const longPayload={subscription:longSub,from_period:'2015-01',through_period:'2018-01',void_event_ids:[longEvent.event_id],add_event_ids:[]}
  assert.equal((await api('usage.correction.preview',longPayload,400)).error,'correction_range_too_large','USE-004 published read-only exploration bound is preserved')
  const longCorrection=await prepare(longPayload)
  assert.equal(longCorrection.plan.periods.length,37,'USE-004 required downstream financial replay is not truncated at the read-only preview limit')
  assert.deepEqual(longCorrection.plan.delta,{subtotalCents:-100,taxCents:0,totalCents:-100})
  await observe('long-history',[`/app/usage/replay?subscription=${longSub}&period=2015-01`])
  await decision(longCorrection.id,finance)
  for(const original of longInvoices)assert.deepEqual(issuedEvidence(await read(original.id)),issuedEvidence(original))
  const availableReport=await api(`reports/credit-balances?customer=${longCustomer}`)
  assert.equal(availableReport.totalCents,100)
  const availableSource=await api(availableReport.entries[0].href.replace('/app/',''))
  assert.equal(availableSource.components.reduce((n,c)=>n+c.amountCents,0),100)
  await observe('credit-balance-report',[`/app/reports/credit-balances?customer=${longCustomer}`,availableReport.entries[0].href])
  // Existing customer-only doors must reflect the applied liability without
  // exposing operator explanations, calculation inputs or other customers.
  await api('portal.configure',{hosts:[h.origin],parents:[]})
  const portal=await api('portal.session.issue',{customer:next.customer,origin:h.origin,audience:'hosted'})
  const portalData=await(await h.raw(`/portal/data?session=${encodeURIComponent(portal.token)}`)).json()
  for(const invoice of portalData.invoices){const operator=await read(invoice.id);assert.equal(invoice.balance_cents,operator.balanceCents);assert.equal(invoice.credited_cents,operator.creditedCents)}
  const portalPath=`/portal/invoices/${next.applications[0]}?session=${encodeURIComponent(portal.token)}`
  const portalHtml=await(await h.raw(portalPath)).text()
  assert.ok(portalHtml.includes('USD 48.00'))
  assert.ok(portalHtml.includes('Reviewed source correction'),'USE-004 existing customer-visible credit reasons agree with the operator record')
  assert.ok(!/calculation_json|api\/nectar|source_fingerprint/.test(portalHtml),'USE-004 customer statement excludes operator-only custody')
  const publicCorrection=await(await h.raw(`/portal/corrections/${next.correction}?session=${encodeURIComponent(portal.token)}`)).json()
  const frozenCorrection=(await corrections(next.sub)).find(c=>c.id===next.correction)
  assert.equal(publicCorrection.corrections[0].message.body,frozenCorrection.mail.body,'USE-004 customer sees the identical frozen approved explanation')
  assert.deepEqual(publicCorrection.corrections[0].periods.map(p=>p.delta),frozenCorrection.plan.periods.map(p=>({subtotalCents:p.subtotalCents,taxCents:p.taxCents,totalCents:p.totalCents})))
  assert.ok(!/recipient|provider_ref|calculation_json|\/app\/|\/api\/nectar\//.test(JSON.stringify(publicCorrection)),'USE-004 correction projection preserves the existing portal allowlist')
  assert.equal((await h.raw(`/portal/corrections/${outcomes[1].correction}?session=${encodeURIComponent(portal.token)}`)).status,404,'USE-004 foreign correction receipts are refused')
  await observe('portal-explanation',[`/portal/adjustments?session=${encodeURIComponent(portal.token)}`],{customerOnly:true})
  await observe('portal-credit',[portalPath],{customerOnly:true})
  // Preparation and rejection have no financial/message effect; an intervening
  // source or policy change refuses execution and cannot consume events.
  await applyPolicy(h,owner,'usage.correction.policy',{disposition:'next_invoice'})
  const lateNew={...ctx.late,event_id:'synthetic-nectar-stale',quantity:'45',occurred_at:'2020-02-10T00:00:00Z'}
  await api('usage.submit',{events:[lateNew]})
  const stale=await prepare({...ctx.body,add_event_ids:[lateNew.event_id]})
  await applyPolicy(h,owner,'usage.correction.policy',{disposition:'credit_note'})
  assert.equal((await decision(stale.id,finance,409)).error,'correction_stale')
  const mailCount=h.mails.length
  await api('usage.correction.decide',{correction:stale.id,decision:'rejected'})
  assert.equal(h.mails.length,mailCount)
  assert.ok((await api(`subscriptions/${ctx.subscription}/upcoming?period=2020-03`)).calculation.exceptions.some(e=>e.code==='metric_late_correction'),'USE-004 rejection leaves the unresolved late event blocking issue')
  for(let tick=0;tick<2;tick++)assert.equal((await h.raw(`/cdn-cgi/local/scheduled?time=${Date.now()}&cron=${encodeURIComponent('0 14 * * *')}`)).status,200)
  assert.equal(h.mails.length,mailCount,'USE-004 ordinary daily recovery never retries accepted or uncertain correction mail')
  const taxReport=await api(`reports/tax?period=${issueMonth}`)
  assert.equal(taxReport.totalCents,8621,'USE-004 original, reversing and correcting tax reconciles across every financial disposition')
  const taxCsv=csvRows(await(await h.raw(`/app/exports/reports/tax.csv?period=${issueMonth}`,{cookie:owner})).text())
  assert.equal(taxCsv.find(r=>r.source==='TOTAL').amount,'86.21')
  assert.equal(taxCsv.filter(r=>r.source!=='TOTAL').reduce((n,r)=>n+Math.round(Number(r.amount.replace(/^'/,''))*100),0),8621,'USE-004 attributed-tax CSV independently reconciles every source contribution')
  const usageCsv=csvRows(await(await h.raw('/app/exports/usage.csv',{cookie:owner})).text())
  const voidCsv=usageCsv.find(r=>r.event_id===ctx.bulk[0].event_id)
  assert.deepEqual([voidCsv.status,voidCsv.effective_status,voidCsv.correction_id],['active','voided',next.correction],'USE-004 CSV preserves original event custody and separately identifies the effective void')
  assert.equal(usageCsv.find(r=>r.event_id===lateUnit.event_id).correction_id,nextDebit.id)
  const inspection=await api('usage/inspect?period=2020-07')
  assert.equal(Number(inspection.subscriptions.find(s=>s.subscription===next.sub).meters[0].total),1,'USE-004 usage inspection uses the effective event set without rewriting raw rows')
  await api('report.schedule',{enabled:true,day:1})
  const scheduleDate=new Date(`${issueMonth}-01T14:00:00Z`);scheduleDate.setUTCMonth(scheduleDate.getUTCMonth()+1)
  await h.advanceClock(scheduleDate.toISOString())
  const scheduled=()=>h.raw(`/cdn-cgi/local/scheduled?time=${scheduleDate.getTime()}&cron=${encodeURIComponent('0 14 * * *')}`)
  assert.equal((await scheduled()).status,200)
  const deliveries=(await api('report-schedule')).deliveries
  assert.equal(deliveries.length,1)
  const delivery=await api(`report-deliveries/${deliveries[0].id}`)
  assert.equal(delivery.status,'accepted')
  assert.equal(delivery.reports.find(r=>r.metric==='tax').totalCents,8621,'USE-004 frozen scheduled reports include the same exact attributed tax figures')
  assert.equal(csvRows(delivery.csv).find(r=>r.report==='tax'&&r.source==='TOTAL').amount,'86.21')
  assert.equal(delivery.reports.find(r=>r.metric==='credit-balances').totalCents,100,'USE-004 scheduled balance snapshot equals the positive outstanding credit liability')
  assert.equal(csvRows(delivery.csv).find(r=>r.report==='credit-balances'&&r.source==='TOTAL').amount,'1.00')
  const sent=h.mails.length;assert.equal((await scheduled()).status,200);assert.equal(h.mails.length,sent,'USE-004 new correction report sources retain once-only snapshot delivery')
  const erased={customer:commitmentCustomer,sub:commitmentSub},request=await api('erasure.request',{customer:erased.customer})
  const verification=h.mails.at(-1).text.match(/https?:\/\/[^\s"<]+\/erase\/[a-f0-9]{64}/)[0]
  assert.equal((await h.raw(new URL(verification).pathname,{form:new URLSearchParams({confirm:'yes'})})).status,200)
  const erasure=await api('erasure.approve',{request:request.id,confirm:true})
  for(const kind of ['nc_usage_corrections','nc_usage_voids','nc_usage_replays','nc_usage_correction_mail','nc_usage_adjustments'])assert.ok(erasure.receipt.changed.some(row=>row.kind===kind),`USE-004 approved erasure withdraws ${kind} personal evidence`)
  assert.equal((await read(commitmentExecution.invoice)).carriedApplications.reduce((n,a)=>n+a.amount_cents,0),12000,'USE-004 erasure retains only the minimal financial allocation facts')
  assert.deepEqual(await corrections(erased.sub),[],'USE-004 erased explanations and source event IDs cannot reappear in correction receipts')
  await api('usage.correction.preview',{subscription:erased.sub,from_period:'2020-07',through_period:'2020-07',void_event_ids:[],add_event_ids:[]},410)
  console.log('USE-004 governed cumulative metric dispositions, all three 10,000-event policies, original tax/revenue, paid liability, once-only applications, messages and refusal journeys passed')
  return {outcomes,debit:debit.id,metricCorrection:negative.id}
}
