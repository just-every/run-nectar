import assert from 'node:assert/strict'
import { publishPrice } from './price-helper.mjs'

// SUB-005: native customer forms, real billing and the configured mail edge.
export async function retentionFlow(h,owner,{onState=async()=>{}}={}) {
  await h.advanceClock('2026-01-01T16:00:00Z')
  assert.equal((await h.api('business',owner)).legal_name,'Cedar Software Inc','SUB-005 advancing the local clock preserves the actual installation')
  const initial=await h.api('retention',owner)
  assert.equal(initial.policy.enabled,false)
  async function policy(changes={}) {
    const prior=(await h.api('retention',owner)).policy
    const saved=await h.api('retention.policy.prepare',owner,{...prior,...changes,revision:prior.revision,enabled:true})
    assert.equal((await h.api('retention',owner)).policy.revision,prior.revision,'SUB-005 preparation changes no active policy')
    await h.api('retention.policy.decide',owner,{request:saved.request,decision:'approved',confirm_single:true})
    return saved
  }
  await policy({save_kind:'discount',save_percent:50,save_months:2,winback_enabled:true,winback_days:60,winback_percent:30,winback_months:3})
  const product=(await h.api('product.create',owner,{code:'sub005-platform',name:'Retention platform'})).id
  const price=(await h.api('price.create',owner,{product,kind:'flat',unit_amount:'100',taxable:false})).id
  const customers=[]
  async function subscription(code,start,months=12) {
    const customer=(await h.api('customer.create',owner,{external_id:`SUB005-${code}`,name:({SAVE:'Willow Research Studio',DECLINE:'Juniper Analytics',PAUSE:'Pinecrest Software',DOWNGRADE:'Evergreen Research',STALE:'Cedar Research'})[code]??`Cedar ${code}`,billing_email:`${code.toLowerCase()}@retention.example`})).id
    const sub=(await h.api('subscription.create',owner,{customer,start_date:start,price:[price]})).id
    const term=await h.api('term.prepare',owner,{subscription:sub,revision:(await h.api(`subscriptions/${sub}`,owner)).revision,term_start:start,months,auto_renew:true,notice_days:30,uplift_percent:'0'})
    await h.api('term.decide',owner,{term:term.term,decision:'approved',confirm_single:true})
    const row={sub,customer,term:term.term,code};customers.push(row);return row
  }
  const saved=await subscription('SAVE','2025-01-01',24),declined=await subscription('DECLINE','2025-04-01')
  const linkFor=async s=>new URL((await h.api('term.link',owner,{term:s.term})).cancelUrl).pathname
  const savePath=await linkFor(saved),declinePath=await linkFor(declined)
  const publicPage=async path=>{const response=await h.raw(path);assert.equal(response.status,200,'SUB-005 scoped bearer page opens');return response.text()}
  const content=await publicPage(savePath)
  assert.match(content,/50% off/)
  assert.match(content,/2 monthly periods/)
  assert.equal((content.match(/<form /g)??[]).length,1,'SUB-005 optional save never adds a cancellation step')
  assert.match(content,/Reason \(optional\)/)
  await onState('offer',savePath,saved.sub)
  const saveOffer=(await h.api('retention',owner)).offers.find(o=>o.subscription_id===saved.sub&&o.kind==='save')
  assert.equal((await h.raw(savePath,{form:new URLSearchParams({confirm:'save',offer:saveOffer.id}),headers:{origin:'https://attacker.example'}})).status,403)
  const otherOffer=(await h.api('retention',owner)).offers.find(o=>o.subscription_id===declined.sub&&o.kind==='save')
  assert.equal((await h.raw(savePath,{form:new URLSearchParams({confirm:'save',offer:otherOffer.id})})).status,404,'SUB-005 a cancellation link never accepts another customer’s offer')
  const accepted=await h.raw(savePath,{form:new URLSearchParams({confirm:'save',offer:saveOffer.id,reason:'Budget timing'})})
  assert.equal(accepted.status,200)
  assert.match(await accepted.text(),/Subscription continued/)
  assert.equal((await h.raw(savePath,{form:new URLSearchParams({confirm:'save',offer:saveOffer.id})})).status,404,'SUB-005 save acceptance is once-only')
  const cancel=await h.raw(declinePath,{form:new URLSearchParams({confirm:'cancel',reason:'Project ended'})})
  assert.equal(cancel.status,200)
  assert.equal((await h.api(`subscriptions/${declined.sub}`,owner)).renewal.terms[0].auto_renew,0)
  async function issue(s,period,date,expected) {
    const run=await h.api('billrun.prepare',owner,{period})
    const invoice=(await h.api(`subscriptions/${s.sub}`,owner)).invoices.find(i=>i.period_start===`${period}-01`)
    assert.ok(invoice,`SUB-005 ${period} creates an actual draft`)
    assert.equal(invoice.total_cents,expected,`SUB-005 ${period} actual invoice has the independently expected discount`)
    await h.api('invoice.approve',owner,{invoice:invoice.id,acknowledge:true})
    await h.api('invoice.finalise',owner,{invoice:invoice.id,issue_date:date})
    const issued=await h.api(`invoices/${invoice.id}`,owner)
    assert.equal(issued.status,'issued');assert.equal(issued.total_cents,expected)
    return issued
  }
  await h.advanceClock('2026-04-01T16:00:00Z')
  const originals=[]
  originals.push(await issue(saved,'2026-01','2026-02-01',5000))
  originals.push(await issue(saved,'2026-02','2026-03-01',5000))
  originals.push(await issue(saved,'2026-03','2026-04-01',10000))
  // A customer who ended 90 days earlier is outside the sixty-day window.
  const oldCustomer=(await h.api('customer.create',owner,{external_id:'SUB005-OLD',name:'Older cancellation',billing_email:'old@retention.example'})).id
  const old=(await h.api('subscription.create',owner,{customer:oldCustomer,start_date:'2025-01-01',price:[price]})).id
  await h.api('subscription.cancel',owner,{subscription:old,revision:(await h.api(`subscriptions/${old}`,owner)).revision,mode:'immediate',effective_date:'2026-01-01',reason:'Ended ninety days ago'})
  const before=h.mails.length
  const tick=async stamp=>{const response=await h.raw(`/cdn-cgi/local/scheduled?time=${Date.parse(stamp)}&cron=${encodeURIComponent('0 14 * * *')}`);assert.equal(response.status,200)}
  await tick('2026-04-01T16:00:00Z')
  const mails=h.mails.slice(before).filter(m=>m.subject==='Your subscription return offer')
  assert.equal(mails.length,1,'SUB-005 one eligible declined customer receives exactly one win-back at the mail edge')
  assert.deepEqual(mails[0].to,['decline@retention.example'])
  assert.match(mails[0].text,/30%/);assert.match(mails[0].text,/3 monthly/)
  assert.equal((await h.api('retention',owner)).offers.some(o=>o.subscription_id===old&&o.kind==='winback'),false,'SUB-005 a ninety-day cancellation receives no offer')
  await tick('2026-04-02T16:00:00Z')
  assert.equal(h.mails.filter(m=>m.subject==='Your subscription return offer').length,1,'SUB-005 repeated daily ticks never resend')
  const returnPath=new URL(mails[0].text.match(/http:\/\/[^\s]+\/return\/[a-f0-9]{64}/)[0]).pathname
  const returnedBefore=await h.api(`subscriptions/${declined.sub}`,owner)
  await publicPage(returnPath)
  assert.deepEqual(await h.api(`subscriptions/${declined.sub}`,owner),returnedBefore,'SUB-005 GET never reactivates')
  await onState('return',returnPath,declined.sub)
  assert.equal((await h.raw(returnPath,{form:new URLSearchParams({confirm:'accept'}),headers:{origin:'https://attacker.example'}})).status,403)
  await h.api('webhook.register',owner,{url:'https://receiver.nectar-app.com/events',consent:true})
  const beforeAcceptance=await h.api('webhooks',owner)
  await h.rejectAudit('subscription.state.observe')
  assert.equal((await h.raw(returnPath,{form:new URLSearchParams({confirm:'accept'})})).status,500,'Win-back cannot reactivate when its state audit cannot be retained')
  await h.rejectAudit(null)
  assert.deepEqual(await h.api(`subscriptions/${declined.sub}`,owner),returnedBefore,'State audit failure rolls back all win-back service and history changes')
  assert.deepEqual(await h.api('webhooks',owner),beforeAcceptance,'Failed win-back publishes no webhook')
  const returned=await h.raw(returnPath,{form:new URLSearchParams({confirm:'accept'})})
  assert.equal(returned.status,200);assert.match(await returned.text(),/Subscription resumed/)
  assert.equal((await h.raw(returnPath,{form:new URLSearchParams({confirm:'accept'})})).status,404)
  const resumed=await h.api(`subscriptions/${declined.sub}`,owner)
  assert.equal(resumed.end_date,null)
  assert.equal(returnedBefore.state,'ended')
  assert.equal(resumed.state,'active','Accepted win-back records the reactivated state before any observer tick')
  assert.deepEqual(resumed.stateHistory.slice(0,-1),returnedBefore.stateHistory,'Win-back preserves every earlier transition')
  const reactivation=resumed.stateHistory.at(-1)
  assert.equal(reactivation.previous_id,returnedBefore.stateHistory.at(-1).id)
  assert.equal(reactivation.previous_state,'ended')
  assert.equal(reactivation.state,'active')
  assert.deepEqual(reactivation.cause.sourceActions.map(row=>row.action),['retention.winback.accept'])
  assert.equal(reactivation.cause.lifecycle.at(-1).kind,'reactivate')
  const stateAudit=(await h.api('audit',owner)).find(row=>row.action==='subscription.state.observe'&&JSON.parse(row.detail).transition_id===reactivation.id)
  assert.ok(stateAudit,'Win-back reactivation retains its state audit in the acceptance transaction')
  assert.equal(JSON.parse(stateAudit.detail).state,'active')
  const deliveries=(await h.api('webhooks',owner)).deliveries.filter(row=>row.event_id===reactivation.id)
  assert.equal(deliveries.length,1,'Accepted win-back queues exactly one matching state webhook')
  const stateEvent=JSON.parse((await h.api(`webhooks/${deliveries[0].id}`,owner)).event.payload_json)
  assert.equal(stateEvent.type,'subscription.state_changed')
  assert.deepEqual(stateEvent.data,{subscription_id:declined.sub,customer_id:declined.customer,transition_id:reactivation.id,previous_state:'ended',state:'active',cause:reactivation.cause,observed_at:reactivation.observed_at})
  const replay=await h.raw(returnPath,{form:new URLSearchParams({confirm:'accept'})})
  assert.equal(replay.status,404)
  assert.deepEqual(await h.api(`subscriptions/${declined.sub}`,owner),resumed,'Replay adds no state history or service change')
  await onState('reactivated',`/app/subscriptions/${declined.sub}`,declined.sub)
  await h.advanceClock('2026-08-01T16:00:00Z')
  for(const [period,date,expected] of [['2026-04','2026-05-01',7000],['2026-05','2026-06-01',7000],['2026-06','2026-07-01',7000],['2026-07','2026-08-01',10000]])originals.push(await issue(declined,period,date,expected))
  const report=await h.api('retention',owner)
  assert.ok(report.offers.some(o=>o.kind==='save'&&o.subscription_id===saved.sub&&o.status==='accepted'&&o.reason==='Budget timing'))
  assert.ok(report.offers.some(o=>o.kind==='save'&&o.subscription_id===declined.sub&&o.status==='declined'&&o.reason==='Project ended'))
  assert.ok(report.offers.some(o=>o.kind==='winback'&&o.subscription_id===declined.sub&&o.status==='accepted'&&o.mail_status==='accepted'))
  for(const original of originals)assert.deepEqual(await h.api(`invoices/${original.id}`,owner),original,'SUB-005 later offers and policies preserve issued evidence')
  await onState('report','/app/retention',declined.sub)
  // The full sentence also supports merchant-selected pause and exact downgrade saves.
  await h.advanceClock('2026-09-01T16:00:00Z')
  await policy({save_kind:'pause',pause_months:1,winback_enabled:false})
  const paused=await subscription('PAUSE','2026-01-01'),pausePath=await linkFor(paused)
  await onState('pause-offer',pausePath,paused.sub)
  const pauseOffer=(await h.api('retention',owner)).offers.find(o=>o.subscription_id===paused.sub)
  assert.equal((await h.raw(pausePath,{form:new URLSearchParams({confirm:'save',offer:pauseOffer.id})})).status,200)
  assert.equal((await h.api(`subscriptions/${paused.sub}/upcoming?period=2026-09`,owner)).calculation.totalCents,0,'SUB-005 accepted pause has no charges')
  assert.equal((await h.api(`subscriptions/${paused.sub}/upcoming?period=2026-10`,owner)).calculation.totalCents,10000)
  const cheaper=(await publishPrice(h,owner,{product,kind:'flat',unit_amount:'60',taxable:false})).id
  await policy({save_kind:'downgrade',downgrade_source_price_id:price,downgrade_price_id:cheaper,winback_enabled:false})
  const downgraded=await subscription('DOWNGRADE','2026-01-01'),downPath=await linkFor(downgraded)
  await onState('downgrade-offer',downPath,downgraded.sub)
  const downOffer=(await h.api('retention',owner)).offers.find(o=>o.subscription_id===downgraded.sub)
  assert.equal((await h.raw(downPath,{form:new URLSearchParams({confirm:'save',offer:downOffer.id})})).status,200)
  assert.equal((await h.api(`subscriptions/${downgraded.sub}/upcoming?period=2026-09`,owner)).calculation.totalCents,6000,'SUB-005 accepted downgrade uses its exact catalog price')
  const beforeDown=await h.api(`subscriptions/${downgraded.sub}/upcoming?period=2026-08`,owner)
  assert.equal(beforeDown.calculation.totalCents,10000,'SUB-005 downgrade preserves earlier service price')
  const stale=await subscription('STALE','2026-01-01'),stalePath=await linkFor(stale)
  const staleOffer=(await h.api('retention',owner)).offers.find(o=>o.subscription_id===stale.sub)
  await h.api('subscription.pause',owner,{subscription:stale.sub,revision:(await h.api(`subscriptions/${stale.sub}`,owner)).revision,effective_date:'2026-09-15',resume_date:'2026-10-01',access:'suspend',reason:'Source changed after offer'})
  await onState('stale',stalePath,stale.sub)
  assert.equal((await h.raw(stalePath,{form:new URLSearchParams({confirm:'save',offer:staleOffer.id})})).status,409,'SUB-005 changed service inputs refuse the saved offer')
  assert.equal((await h.api('retention',owner)).offers.find(o=>o.id===staleOffer.id).status,'offered')
  await policy({save_kind:'discount',winback_enabled:true})
  async function endedCustomer(code,date) {
    const customer=(await h.api('customer.create',owner,{external_id:`SUB005-${code}`,name:code==='EXPIRED'?'Aspen Research':'Cobalt Software',billing_email:`${code.toLowerCase()}@retention.example`})).id
    const sub=(await h.api('subscription.create',owner,{customer,start_date:'2026-01-01',price:[price]})).id
    await h.api('subscription.cancel',owner,{subscription:sub,revision:(await h.api(`subscriptions/${sub}`,owner)).revision,mode:'immediate',effective_date:date,reason:'Service ended'})
    return sub
  }
  const expiredSub=await endedCustomer('EXPIRED','2026-08-01')
  await tick('2026-09-01T16:00:00Z')
  const expiryMail=h.mails.findLast(m=>m.subject==='Your subscription return offer'&&m.to.includes('expired@retention.example'))
  assert.ok(expiryMail)
  const expiryPath=new URL(expiryMail.text.match(/http:\/\/[^\s]+\/return\/[a-f0-9]{64}/)[0]).pathname
  await h.advanceClock('2026-10-01T16:00:00Z')
  await onState('expired',expiryPath,expiredSub)
  assert.equal((await h.raw(expiryPath)).status,404,'SUB-005 the sixty-day link stops at its inclusive eligibility window without needing a cron tick')
  await tick('2026-10-01T16:00:00Z')
  assert.equal((await h.api('retention',owner)).offers.find(o=>o.subscription_id===expiredSub&&o.kind==='winback').status,'expired')
  const rejectedSub=await endedCustomer('REJECTED','2026-09-01'),mailCount=h.mails.length
  h.mailResponses.push({status:422,body:{message:'Recipient refused'}})
  await tick('2026-10-01T16:00:00Z')
  assert.equal((await h.api('retention',owner)).offers.find(o=>o.subscription_id===rejectedSub&&o.kind==='winback').mail_status,'rejected','SUB-005 mail refusal is retained honestly')
  await tick('2026-10-02T16:00:00Z')
  assert.equal(h.mails.length,mailCount+1,'SUB-005 refused win-back sends never retry')
  await h.api('access.give',owner,{email:'retention-reader@example.test',role:'accountant',name:'Retention Reader'})
  const accountant=await h.signIn('retention-reader@example.test',{requested:true}),agent={bearer:(await h.api('credential.issue',owner,{name:'Retention reader',scopes:['prepare']})).key}
  for(const who of [accountant,agent]){await h.api('retention',who);for(const action of ['retention.policy.prepare','retention.policy.decide'])await h.api(action,who,{},403)}
  await h.api('retention',null,undefined,401)
  await onState('final-report','/app/retention')
  console.log('SUB-005 optional saves, issued two/three-month discounts, win-back clock/once-only mail, reports, pause/downgrade and authority passed')
}

// CAT-001: the saved count is counted on actual price intervals, through the
// same scoped customer acceptance and ordinary billing doors as monthly saves.
export async function retentionIntervalFlow(h, owner) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  await h.advanceClock('2026-01-01T16:00:00Z')
  const product = (await api('product.create', { code: 'synthetic-nectar-91', name: 'Synthetic Weekly Platform' })).id
  const weekly = (await api('price.create', { product, kind: 'flat', unit_amount: '100', taxable: false, interval_unit: 'week', interval_count: 1, billing_timing: 'arrears' })).id
  async function policy(changes) {
    const current = (await api('retention')).policy
    const request = await api('retention.policy.prepare', { ...current, enabled: true, revision: current.revision, save_kind: 'discount', save_percent: 50, save_months: 2, pause_months: 2, save_price_id: weekly, pause_price_id: weekly, winback_price_id: weekly, winback_enabled: false, winback_percent: 30, winback_months: 2, ...changes })
    assert.equal((await api('retention')).policy.revision, current.revision)
    await api('retention.policy.decide', { request: request.request, decision: 'approved', confirm_single: true })
  }
  async function subscription(number, prices = [weekly], start = '2025-01-01', withTerm = true) {
    const customer = (await api('customer.create', { external_id: `synthetic-nectar-${number}`, name: `Synthetic interval customer ${number}`, billing_email: `synthetic-nectar-${number}@example.test` })).id
    const sub = (await api('subscription.create', { customer, start_date: start, billing_anchor_date: start, price: prices })).id
    let term
    if (withTerm) {
      const prepared = await api('term.prepare', { subscription: sub, revision: (await api(`subscriptions/${sub}`)).revision, term_start: start, months: 36, auto_renew: true, notice_days: 30, uplift_percent: '0' })
      await api('term.decide', { term: prepared.term, decision: 'approved', confirm_single: true })
      term = prepared.term
    }
    return { sub, customer, term }
  }
  async function offerFor(s) {
    const path = new URL((await api('term.link', { term: s.term })).cancelUrl).pathname
    const offer = (await api('retention')).offers.findLast(row => row.subscription_id === s.sub && row.kind === 'save')
    return { path, offer, terms: offer && JSON.parse(offer.terms_json) }
  }
  async function accept(saved) {
    const page = await h.raw(saved.path)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /invoice periods/)
    assert.equal((await h.raw(saved.path, { form: new URLSearchParams({ confirm: 'save', offer: saved.offer.id }) })).status, 200)
    assert.equal((await h.raw(saved.path, { form: new URLSearchParams({ confirm: 'save', offer: saved.offer.id }) })).status, 404)
  }
  async function issueDue(s, month) {
    const run = await api('billrun.prepare', { period: month })
    const drafts = (await api(`runs/${run.id}`)).invoices.filter(row => row.customer_id === s.customer)
    const issued = []
    for (const draft of drafts) {
      const before = await api(`invoices/${draft.id}`)
      await api('invoice.approve', { invoice: draft.id, acknowledge: true })
      await api('invoice.finalise', { invoice: draft.id, issue_date: before.calculation.inputs.billing.dueDate })
      issued.push(await api(`invoices/${draft.id}`))
    }
    return issued.sort((a, b) => a.period_start.localeCompare(b.period_start))
  }
  await policy({})
  const saved = await subscription(92), save = await offerFor(saved)
  assert.deepEqual([save.terms.from, save.terms.to, save.terms.priceId], ['2025-12-31', '2026-01-14', weekly])
  assert.equal(save.terms.preview.length, 2)
  assert.deepEqual(save.terms.preview.map(row => [row.before.totalCents, row.after.totalCents]), [[10000, 5000], [10000, 5000]])
  await accept(save)
  await h.advanceClock('2026-01-22T16:00:00Z')
  const originals = await issueDue(saved, '2026-01')
  assert.deepEqual(originals.map(invoice => invoice.total_cents), [5000, 5000, 10000], 'CAT-001 two weekly save periods stop after fourteen days, rather than two months')
  for (const [i, preview] of save.terms.preview.entries()) assert.equal(originals[i].total_cents, preview.after.totalCents, 'CAT-001 ordinary save invoices equal the same-engine offer preview')

  // A mixed subscription cannot silently count its monthly usage cadence.
  const annualProduct = (await api('product.create', { code: 'synthetic-nectar-93', name: 'Synthetic Annual Platform' })).id
  const annual = (await api('price.create', { product: annualProduct, kind: 'flat', unit_amount: '1200', taxable: false, interval_unit: 'month', interval_count: 12, billing_timing: 'advance' })).id
  const meter = (await api('meter.create', { code: 'synthetic-nectar-94', name: 'Synthetic Monthly Calls', unit_label: 'calls' })).id
  const usageProduct = (await api('product.create', { code: 'synthetic-nectar-94', name: 'Synthetic Monthly Calls' })).id
  const monthlyUsage = (await api('price.create', { product: usageProduct, kind: 'unit', meter, unit_amount: '2', taxable: false })).id
  await policy({ save_price_id: annual })
  const mixed = await subscription(95, [annual, monthlyUsage]), annualSave = await offerFor(mixed)
  assert.deepEqual([annualSave.terms.from, annualSave.terms.to, annualSave.terms.priceId], ['2026-01-01', '2028-01-01', annual])
  assert.deepEqual(annualSave.terms.preview.map(row => row.after.totalCents), [60000, 60000])
  await accept(annualSave)
  const mixedInvoices = await issueDue(mixed, '2026-01')
  assert.equal(mixedInvoices.find(invoice => invoice.lines.some(line => line.price_id === annual)).total_cents, 60000, 'CAT-001 annual advance save discounts the selected annual price at its anniversary')

  await policy({ save_kind: 'pause' })
  const paused = await subscription(96, [weekly], '2026-01-01'), pause = await offerFor(paused)
  assert.deepEqual([pause.terms.from, pause.terms.to], ['2026-01-22', '2026-02-05'])
  assert.deepEqual(pause.terms.preview.map(row => row.after.totalCents), [0, 0])
  assert.equal((await h.raw(pause.path, { form: new URLSearchParams({ confirm: 'save', offer: pause.offer.id }) })).status, 200)
  await h.advanceClock('2026-02-20T16:00:00Z')
  const pausedJanuary = await issueDue(paused, '2026-01')
  assert.equal(pausedJanuary.find(invoice => invoice.period_start === '2026-01-22').total_cents, 0)
  const pausedInvoices = await issueDue(paused, '2026-02')
  assert.deepEqual(pausedInvoices.map(invoice => invoice.total_cents), [0, 10000, 10000], 'CAT-001 a two-week pause resumes on the saved boundary')

  await policy({ save_kind: 'discount', winback_enabled: true })
  const returning = await subscription(97, [weekly], '2026-01-01', false)
  await api('subscription.cancel', { subscription: returning.sub, revision: (await api(`subscriptions/${returning.sub}`)).revision, mode: 'immediate', effective_date: '2026-02-20', reason: 'Synthetic ended service' })
  const beforeMail = h.mails.length
  const tick = async () => assert.equal((await h.raw(`/cdn-cgi/local/scheduled?time=${Date.parse('2026-02-20T16:00:00Z')}&cron=${encodeURIComponent('0 14 * * *')}`)).status, 200)
  await tick(); await tick()
  const mails = h.mails.slice(beforeMail).filter(mail => mail.to.includes('synthetic-nectar-97@example.test'))
  assert.equal(mails.length, 1, 'CAT-001 native win-back preserves the once-only mail reservation')
  assert.match(mails[0].text, /2 invoice periods/)
  const path = new URL(mails[0].text.match(/http:\/\/[^\s]+\/return\/[a-f0-9]{64}/)[0]).pathname
  assert.equal((await h.raw(path, { form: new URLSearchParams({ confirm: 'accept' }) })).status, 200)
  assert.equal((await h.raw(path, { form: new URLSearchParams({ confirm: 'accept' }) })).status, 404)
  const returned = (await api('retention')).offers.find(row => row.subscription_id === returning.sub && row.kind === 'winback')
  const returnTerms = JSON.parse(returned.terms_json)
  assert.deepEqual([returnTerms.from, returnTerms.to], ['2026-02-19', '2026-03-05'])
  assert.deepEqual(returnTerms.preview.map(row => row.after.totalCents), [7000, 7000])
  await h.advanceClock('2026-03-13T16:00:00Z')
  const feb = await issueDue(returning, '2026-02'), march = await issueDue(returning, '2026-03')
  assert.equal(feb.find(invoice => invoice.period_start === '2026-02-19').total_cents, 7000)
  assert.equal(march.find(invoice => invoice.period_start === '2026-02-26').total_cents, 7000)
  assert.equal(march.find(invoice => invoice.period_start === '2026-03-05').total_cents, 10000)
  for (const original of originals) assert.deepEqual(await api(`invoices/${original.id}`), original, 'CAT-001 new cadence retention preserves previously issued invoice evidence')
  console.log('CAT-001/SUB-005 weekly save/pause/win-back periods, explicit annual price scope, same-engine previews and issued evidence passed')
}
