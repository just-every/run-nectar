import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { applyPolicy } from './policy-helper.mjs'
import { publishPrice } from './price-helper.mjs'
import { file } from './harness.mjs'

export const harnessOptions=()=>({assets:true})

// One customer lifecycle through the real portal, ordinary billing and Cron.
export async function portalRenewalFlow(h,owner,{customerContext,onScreen,activate}={}) {
  await h.advanceClock('2026-01-01T16:00:00Z')
  const api=(path,body,status)=>h.api(path,owner,body,status)
  const product=(await api('product.create',{code:'synthetic-nectar-portal-retention',name:'Customer workspace'})).id
  const price=(await publishPrice(h,owner,{product,kind:'flat',unit_amount:'100',taxable:false})).id
  const cheap=(await publishPrice(h,owner,{product,kind:'flat',unit_amount:'60',taxable:false})).id
  const restrict=async pause=>applyPolicy(h,owner,'portal.change.policy',{prices:[price,cheap],minimum_seats:5,pause_allowed:pause})
  await restrict(false)
  await api('portal.configure',{hosts:[h.origin],parents:[]})
  async function policy(changes={}) {
    const prior=(await api('retention')).policy
    const saved=await api('retention.policy.prepare',{...prior,revision:prior.revision,enabled:true,save_kind:'discount',save_percent:50,save_months:2,winback_enabled:true,winback_days:60,winback_percent:30,winback_months:3,...changes})
    await api('retention.policy.decide',{request:saved.request,decision:'approved',confirm_single:true})
  }
  await policy()
  let number=0
  async function subscription({language='en',start='2025-04-01',months=12,term=true}={}) {
    const customer=(await api('customer.create',{external_id:`synthetic-nectar-portal-${++number}`,name:`Customer workspace ${number}`,billing_email:h.vars.OWNER_EMAIL,language})).id
    const sub=(await api('subscription.create',{customer,start_date:start,price:[price]})).id
    if(term) {
      const prepared=await api('term.prepare',{subscription:sub,revision:(await api(`subscriptions/${sub}`)).revision,term_start:start,months,auto_renew:true,notice_days:30,uplift_percent:'5'})
      await api('term.decide',{term:prepared.term,decision:'approved',confirm_single:true})
    }
    return {customer,sub}
  }
  const issue=s=>api('portal.session.issue',{customer:s.customer,origin:h.origin,audience:'hosted'})
  const path=(s,session,kind='renewal')=>`/portal/${kind}/${s.sub}?session=${session.token}`
  async function get(s,session,status=200,kind='renewal') {
    const response=await h.raw(path(s,session,kind),{headers:{accept:'application/json'}})
    assert.equal(response.status,status)
    return status===200?response.json():response.text()
  }
  async function post(s,session,body,status=200,kind='renewal',headers={}) {
    const response=await h.raw(path(s,session,kind),{body,headers})
    assert.equal(response.status,status,`Portal ${kind}: ${response.status} ${await response.clone().text()}`)
    return status===200?response.json():response.text()
  }
  // The same engine estimates an ordinary mid-month change without writing.
  await h.advanceClock('2026-01-16T16:00:00Z')
  const estimated=await subscription({start:'2026-01-01',term:false}),estimateSession=await issue(estimated)
  const expensive=(await publishPrice(h,owner,{product,kind:'flat',unit_amount:'150',taxable:false})).id
  await applyPolicy(h,owner,'portal.change.policy',{prices:[price,cheap,expensive],minimum_seats:5,pause_allowed:false})
  const estimateOptions=await (await h.raw(`/portal/changes/${estimated.sub}?session=${estimateSession.token}`,{headers:{accept:'application/json'}})).json()
  const estimateBody={subscription:estimated.sub,item:estimateOptions.item,target_price:expensive,quantity:1,basis:estimateOptions.basis,policy_revision:estimateOptions.policy.revision}
  const estimatedFacts=async()=>({subscription:await api(`subscriptions/${estimated.sub}`),ledger:(await api(`customers/${estimated.customer}`)).ledger,audit:await api('audit'),mails:h.mails.length})
  const beforeEstimate=await estimatedFacts()
  const preview=await h.raw(`/portal/change.preview?session=${estimateSession.token}`,{body:estimateBody})
  assert.equal(preview.status,200)
  const estimate=await preview.json()
  // January has 31 days: 15 old-price days and 16 new-price days, each
  // independently rounded half away from zero as ordinary invoice lines are.
  assert.deepEqual([estimate.before.totalCents,estimate.after.totalCents,estimate.difference.totalCents],[10000,12581,2581])
  assert.deepEqual([estimate.period,estimate.effectiveDate,estimate.executionAuthority,estimate.paymentAuthority],[{start:'2026-01-01',end:'2026-02-01'},'2026-01-16',false,false])
  assert.deepEqual(await estimatedFacts(),beforeEstimate,'Preview changes no service, invoice, payment, audit or mail')
  const unsafe=await h.raw(`/portal/change.preview?session=${estimateSession.token}`,{body:estimateBody,headers:{origin:'https://synthetic-nectar.example.test'}})
  assert.equal(unsafe.status,403)
  await restrict(false)
  const staleEstimate=await h.raw(`/portal/change.preview?session=${estimateSession.token}`,{body:estimateBody})
  assert.equal(staleEstimate.status,409)
  await h.advanceClock('2026-01-01T16:00:00Z')
  const saved=await subscription(),cancelled=await subscription({language:'es-US'})
  const savedSession=await issue(saved),cancelSession=await issue(cancelled)
  const beforeAudit=await api('audit'),beforeMail=h.mails.length
  const offer=await get(saved,savedSession),cancelOffer=await get(cancelled,cancelSession)
  await h.raw(path(saved,savedSession))
  assert.deepEqual(await api('audit'),beforeAudit,'Reading the portal creates no offer, authority or audit event')
  assert.equal(h.mails.length,beforeMail,'Reading never sends mail')
  assert.deepEqual({...offer.term,upliftPercent:Number(offer.term.upliftPercent)},{start:'2025-04-01',end:'2026-04-01',autoRenew:true,cancelled:false,upliftPercent:5})
  assert.deepEqual(offer.save.preview.map(p=>[p.period,p.beforeCents,p.afterCents]),[
    [{start:'2026-01-01',end:'2026-02-01'},10000,5000],[{start:'2026-02-01',end:'2026-03-01'},10000,5000]])
  assert.deepEqual(cancelOffer.save.preview,offer.save.preview,'English and Spanish expose identical amounts and periods')
  assert.doesNotMatch(JSON.stringify(offer),/token_hash|sourceRevision|inputs|prepared_by|billing_email|customer_id/)
  const money=async s=>{const sub=await api(`subscriptions/${s.sub}`);return {items:sub.items,invoices:sub.invoices,ledger:(await api(`customers/${s.customer}`)).ledger}}
  const original=await money(saved),cancelOriginal=await money(cancelled)
  await get(saved,cancelSession,404)
  await post(saved,cancelSession,{basis:offer.basis,confirm:'cancel'},404)
  await post(saved,savedSession,{basis:offer.basis,confirm:'save',offer:cancelOffer.save.id},409)
  await post(saved,savedSession,{basis:offer.basis,confirm:'cancel'},403,'renewal',{origin:'https://synthetic-nectar.example.test'})
  await post(saved,savedSession,{basis:offer.basis,confirm:'cancel',customer:cancelled.customer},400)
  await post(saved,savedSession,{basis:offer.basis,confirm:'approve'},400)
  const noSession=await h.raw(`/portal/renewal/${saved.sub}`,{cookie:owner,body:{confirm:'cancel',basis:offer.basis}})
  assert.equal(noSession.status,401,'An operator cookie supplies no customer authority')
  const revoked=await issue(saved)
  await api('portal.session.revoke',{session:revoked.id})
  await get(saved,revoked,401)
  await post(saved,revoked,{basis:offer.basis,confirm:'cancel'},401)
  await h.rejectAudit('retention.save.accept')
  await post(saved,savedSession,{basis:offer.basis,confirm:'save',offer:offer.save.id},500)
  await h.rejectAudit(null)
  assert.deepEqual(await money(saved),original,'Audit failure and unsafe saves leave service and money unchanged')
  assert.equal((await api('retention')).offers.length,0,'Audit failure also rolls back new offer custody')

  let browser
  const evidence=process.env.NECTAR_EVIDENCE_DIR
  if(evidence)await mkdir(evidence,{recursive:true})
  try {
    browser=customerContext?.browser()??await chromium.launch({headless:true,...(existsSync('/usr/bin/chromium')?{executablePath:'/usr/bin/chromium'}:{}),args:['--no-sandbox','--use-mock-keychain','--password-store=basic']})
    const context=customerContext??await browser.newContext({viewport:{width:1440,height:950}}),page=await context.newPage()
    const press=control=>activate?activate(control):control.click()
    async function capture(name) {
      if(onScreen)return onScreen(page,name)
      if(!evidence)return
      for(const width of [1440,390]){await page.setViewportSize({width,height:950});await page.screenshot({path:`${evidence}/${name}-${width}.png`,fullPage:true})}
      await page.setViewportSize({width:1440,height:950})
    }
    await page.goto(`${h.origin}/portal/changes?session=${savedSession.token}`)
    await press(page.getByRole('link',{name:'Manage renewal',exact:true}))
    await page.getByRole('button',{name:'Cancel renewal',exact:true}).waitFor()
    assert.equal(await page.locator('form').count(),1,'One confirmation includes both optional save and cancellation')
    assert.equal(await page.getByRole('button',{name:'Accept optional save',exact:true}).count(),1)
    await capture('portal-renewal-save-en')
    await press(page.getByRole('button',{name:'Accept optional save',exact:true}))
    await page.getByRole('button',{name:'Cancel renewal',exact:true}).waitFor()
    assert.equal(await page.getByRole('button',{name:'Accept optional save',exact:true}).count(),0,'Accepted offer does not repeat')
    await capture('portal-renewal-save-applied')
    assert.equal((await api('retention')).offers.find(o=>o.subscription_id===saved.sub).status,'accepted')
    assert.deepEqual(await money(saved),original,'A save does not issue or collect money')
    await post(saved,savedSession,{basis:offer.basis,confirm:'save',offer:offer.save.id},409)

    await page.goto(h.origin+path(cancelled,cancelSession))
    assert.equal(await page.locator('html').getAttribute('lang'),'es-US')
    const cancelButton=page.locator('button[value="cancel"]')
    await cancelButton.waitFor()
    assert.equal(await page.locator('input[name="reason"]').getAttribute('required'),null)
    await capture('portal-renewal-cancel-es')
    await h.rejectAudit('subscription.renewal.cancel')
    await post(cancelled,cancelSession,{basis:cancelOffer.basis,confirm:'cancel'},500)
    await h.rejectAudit(null)
    assert.equal((await get(cancelled,cancelSession)).term.autoRenew,true)
    await press(cancelButton)
    assert.equal(await page.locator('button[value="cancel"]').count(),0)
    await capture('portal-renewal-cancelled-es')
    assert.deepEqual(await money(cancelled),cancelOriginal,'Cancelling renewal preserves issued financial facts')
    assert.equal((await get(cancelled,cancelSession)).term.cancelled,true)
    const declined=(await api('retention')).offers.find(o=>o.subscription_id===cancelled.sub&&o.kind==='save')
    assert.deepEqual([declined.status,declined.reason],['declined','not supplied'],'Cancelling without a reason records the optional offer outcome')
    await post(cancelled,cancelSession,{basis:cancelOffer.basis,confirm:'cancel'},409)

    // The existing customer form reaches the same estimate in both languages.
    await applyPolicy(h,owner,'portal.change.policy',{prices:[price,cheap,expensive],minimum_seats:5,pause_allowed:false})
    const nativeEstimateSession=await issue(estimated)
    for(const language of ['en','es-US']) {
      const customer=await api(`customers/${estimated.customer}`)
      await api('customer.update',{customer:estimated.customer,revision:customer.revision,name:customer.name,billing_email:customer.billing_email,language})
      await page.goto(`${h.origin}/portal/changes/${estimated.sub}?session=${nativeEstimateSession.token}`)
      if(activate)await activate(page.locator('select[name="target_price"]'))
      await page.locator('select[name="target_price"]').selectOption(expensive)
      const facts=await estimatedFacts()
      await press(page.locator('button[formaction]'))
      assert.equal(await page.locator('html').getAttribute('lang'),language)
      assert.match(await page.locator('main').innerText(),/USD 150.00/)
      assert.match(await page.locator('main').innerText(),/USD 50.00/)
      assert.equal(await page.locator('form').count(),0,'An estimate confers no execution confirmation')
      await capture(`portal-change-estimate-${language}`)
      assert.deepEqual(await estimatedFacts(),facts,'The native estimate also leaves plans and money unchanged')
    }

    // Stale source and approved policy changes refuse an old save without writes.
    const stale=await subscription(),staleSession=await issue(stale),staleOffer=await get(stale,staleSession)
    await page.goto(h.origin+path(stale,staleSession))
    await policy({save_percent:25})
    const refused=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===`/portal/renewal/${stale.sub}`)
    await press(page.locator('button[value="save"]'))
    assert.equal((await refused).status(),409)
    await capture('portal-stale-save-refused')
    await post(stale,staleSession,{basis:staleOffer.basis,confirm:'save',offer:staleOffer.save.id},409)
    const fresh=await get(stale,staleSession)
    await api('subscription.pause',{subscription:stale.sub,revision:(await api(`subscriptions/${stale.sub}`)).revision,effective_date:'2026-02-01',resume_date:'2026-03-01',access:'suspend',reason:'Merchant reviewed service change'})
    await post(stale,staleSession,{basis:fresh.basis,confirm:'save',offer:fresh.save.id},409)
    assert.equal((await api('retention')).offers.filter(o=>o.subscription_id===stale.sub).length,0)
    await post(stale,staleSession,{basis:(await get(stale,staleSession)).basis,confirm:'cancel'})

    // Pause is only offered when both approved policies permit it.
    await policy({save_kind:'pause',pause_months:1,winback_enabled:false})
    const paused=await subscription({start:'2025-01-01',months:24}),pauseSession=await issue(paused)
    assert.equal((await get(paused,pauseSession)).save,null)
    await page.goto(h.origin+path(paused,pauseSession))
    assert.equal(await page.locator('button[value="save"]').count(),0,'Forbidden pause has no customer option')
    await capture('portal-pause-forbidden')
    await restrict(true)
    const pause=await get(paused,pauseSession)
    assert.deepEqual([pause.save.kind,pause.save.from,pause.save.to],['pause','2026-01-01','2026-02-01'])
    assert.deepEqual(pause.save.preview.map(p=>[p.beforeCents,p.afterCents]),[[10000,0]])
    await page.goto(h.origin+path(paused,pauseSession));await capture('portal-approved-pause')
    const race=await Promise.all([1,2].map(()=>h.raw(path(paused,pauseSession),{body:{basis:pause.basis,confirm:'save',offer:pause.save.id}})))
    assert.deepEqual(race.map(r=>r.status).sort(),[200,409])
    const pauseDetail=await api(`subscriptions/${paused.sub}`)
    assert.equal(pauseDetail.lifecycle.filter(row=>row.kind==='pause').length,1,'Replay creates exactly one pause')
    assert.equal((await api(`subscriptions/${paused.sub}/upcoming?period=2026-01`)).calculation.totalCents,0)
    assert.equal((await api(`subscriptions/${paused.sub}/upcoming?period=2026-02`)).calculation.totalCents,10000,'Service resumes on the displayed date')

    await policy({save_kind:'downgrade',downgrade_source_price_id:price,downgrade_price_id:cheap,winback_enabled:false})
    const downgraded=await subscription({start:'2025-01-01',months:24}),downSession=await issue(downgraded),down=await get(downgraded,downSession)
    await page.goto(h.origin+path(downgraded,downSession));await capture('portal-approved-downgrade')
    await press(page.locator('button[value="save"]'))
    assert.equal((await api(`subscriptions/${downgraded.sub}/upcoming?period=2026-01`)).calculation.totalCents,6000)
    assert.equal((await api(`subscriptions/${downgraded.sub}/upcoming?period=2025-12`)).calculation.totalCents,10000)

    const minimum=await subscription({start:'2025-01-01',months:24}),minimumSession=await issue(minimum)
    // Create the additional approver through the ordinary member door.
    const reviewerEmail=`reviewer-${h.vars.OWNER_EMAIL}`
    await api('access.give',{email:reviewerEmail,name:'Portal policy reviewer',role:'finance'})
    const reviewer=await h.signIn(reviewerEmail,{requested:true})
    const contract=await api('contract.prepare',{subscription:minimum.sub,revision:(await api(`subscriptions/${minimum.sub}`)).revision,clause:'synthetic-nectar-approved-minimum',commitments:[{from:'2026-01-01',to:'2026-03-01',minimum:'200',taxable:false}]})
    await h.api('contract.decide',reviewer,{contract:contract.contract,decision:'approved'})
    assert.equal((await get(minimum,minimumSession)).save,null,'A downgrade below signed minimum cannot execute as a save')
    const restrictions=await h.raw(`/portal/changes/${minimum.sub}?session=${minimumSession.token}`,{headers:{accept:'application/json'}})
    const requestOptions=await restrictions.json()
    const pending=await h.raw(`/portal/change.request?session=${minimumSession.token}`,{body:{subscription:minimum.sub,item:requestOptions.item,target_price:cheap,quantity:1,basis:requestOptions.basis,policy_revision:requestOptions.policy.revision,confirm:true}})
    assert.equal(pending.status,200)
    assert.equal((await pending.json()).belowContractMinimum,true,'The same customer still has a pending human-review door')
    const member=(await api('members')).find(m=>m.email===reviewerEmail)
    await api('access.end',{member:member.id})

    // Actual invoices prove the two saved periods and the unchanged following one.
    await h.advanceClock('2026-04-01T16:00:00Z')
    const originals=[]
    for(const [period,total] of [['2026-01',5000],['2026-02',5000],['2026-03',10000]]) {
      const run=await api('billrun.prepare',{period}),invoice=(await api(`runs/${run.id}`)).invoices.find(i=>i.subscription_id===saved.sub)
      assert.equal(invoice.total_cents,total)
      await api('invoice.approve',{invoice:invoice.id,acknowledge:true})
      await api('invoice.finalise',{invoice:invoice.id,issue_date:'2026-04-01'})
      originals.push(await api(`invoices/${invoice.id}`))
    }
    await policy({save_kind:'discount',winback_enabled:true})
    const tick=async()=>assert.equal((await h.raw(`/cdn-cgi/local/scheduled?time=${Date.parse('2026-04-01T16:00:00Z')}&cron=${encodeURIComponent('0 14 * * *')}`)).status,200)
    const mailCount=h.mails.length
    await tick();await tick()
    assert.equal(h.mails.slice(mailCount).filter(m=>m.subject==='Tu oferta para volver a la suscripción').length<=1,true)
    const ended=await api(`subscriptions/${cancelled.sub}`)
    assert.equal(ended.renewal.terms[0].status,'ended')
    const returning=await issue(cancelled),returnOffer=await get(cancelled,returning,200,'return')
    assert.deepEqual([returnOffer.percent,returnOffer.periods,returnOffer.expires],[30,3,'2026-05-31'])
    await get(cancelled,await issue(saved),404,'return')
    const returnBody={offer:returnOffer.id,confirm:'accept'}
    await post(cancelled,returning,returnBody,403,'return',{origin:'https://synthetic-nectar.example.test'})
    await page.goto(h.origin+path(cancelled,returning,'return'));await capture('portal-winback-es')
    await press(page.locator('button[value="accept"]'))
    assert.equal((await api(`subscriptions/${cancelled.sub}`)).end_date,null)
    await post(cancelled,returning,returnBody,404,'return')
    await capture('portal-winback-accepted')
    await h.advanceClock('2026-08-01T16:00:00Z')
    for(const [period,total] of [['2026-04',7000],['2026-05',7000],['2026-06',7000],['2026-07',10000]]) {
      const run=await api('billrun.prepare',{period}),invoice=(await api(`runs/${run.id}`)).invoices.find(i=>i.subscription_id===cancelled.sub)
      assert.equal(invoice.total_cents,total,'Dated win-back affects exactly three actual invoices')
      await api('invoice.approve',{invoice:invoice.id,acknowledge:true})
      await api('invoice.finalise',{invoice:invoice.id,issue_date:'2026-08-01'})
    }
    for(const original of originals)assert.deepEqual(await api(`invoices/${original.id}`),original,'Retention preserves issued originals')
  } finally { if(browser&&!customerContext)await browser.close() }

  const expiring=await issue(saved),expiryData=await get(saved,expiring)
  await h.advanceClock(new Date(expiring.expiresAt).toISOString())
  await post(saved,expiring,{basis:expiryData.basis,confirm:'cancel'},401)
  const erasing=await issue(saved),eraseData=await get(saved,erasing)
  const erasure=await api('erasure.request',{customer:saved.customer})
  await api('erasure.verify',{request:erasure.id,reason:'Verified customer request',evidence:file('synthetic-nectar-proof.txt','Synthetic independent ownership evidence','text/plain')})
  await api('erasure.approve',{request:erasure.id,confirm:true})
  await get(saved,erasing,401)
  await post(saved,erasing,{basis:eraseData.basis,confirm:'cancel'},401)
  assert.ok((await api('retention')).offers.filter(o=>o.subscription_id===saved.sub).every(o=>o.status==='expired'))
  // A current approval cannot be replaced by a departed approver's old grant.
  const authorityCustomer=await subscription({start:'2026-01-01',months:24})
  const authoritySession=await issue(authorityCustomer)
  const departingEmail=`departing-${h.vars.OWNER_EMAIL}`
  await api('access.give',{email:departingEmail,name:'Departing reviewer',role:'finance'})
  const departing=await h.signIn(departingEmail,{requested:true})
  const active=(await api('retention')).policy
  const proposal=await api('retention.policy.prepare',{...active,revision:active.revision,enabled:true,save_kind:'discount',save_percent:20,save_months:2})
  await h.api('retention.policy.decide',departing,{request:proposal.request,decision:'approved'})
  const approved=await get(authorityCustomer,authoritySession)
  assert.equal(approved.save.percent,20)
  const member=(await api('members')).find(m=>m.email===departingEmail)
  await api('access.end',{member:member.id})
  assert.equal((await get(authorityCustomer,authoritySession)).save,null)
  const facts=await money(authorityCustomer)
  await post(authorityCustomer,authoritySession,{basis:approved.basis,confirm:'save',offer:approved.save.id},409)
  assert.deepEqual(await money(authorityCustomer),facts,'Revoked approval cannot change billing')
  await post(authorityCustomer,authoritySession,{basis:(await get(authorityCustomer,authoritySession)).basis,confirm:'cancel'})
  console.log('PORT-003 portal cancellation, optional saves, dated win-back, exact invoices and capability custody passed')
}
