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
  const returned=await h.raw(returnPath,{form:new URLSearchParams({confirm:'accept'})})
  assert.equal(returned.status,200);assert.match(await returned.text(),/Subscription resumed/)
  assert.equal((await h.raw(returnPath,{form:new URLSearchParams({confirm:'accept'})})).status,404)
  assert.equal((await h.api(`subscriptions/${declined.sub}`,owner)).end_date,null)
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
