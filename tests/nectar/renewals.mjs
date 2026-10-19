import assert from 'node:assert/strict'

// SUB-004: real terms, mail adapter, public cancellation form and scheduled clock.
export async function renewalsFlow(h,owner,{onState=async()=>{}}={}) {
  const product=(await h.api('product.create',owner,{code:'sub004-platform',name:'Cedar annual contract'})).id
  const price=(await h.api('price.create',owner,{product,kind:'flat',unit_amount:'100',taxable:true})).id
  await h.api('feature.grant',owner,{product,feature:'sub004-access'})
  const subscriptions=[]
  for(const [code,name] of [['renew','Evergreen Research'],['cancel','Willow Studio'],['end','Finite Analytics'],['reject','Rejected Mail'],['uncertain','Unconfirmed Mail']]) {
    const customer=(await h.api('customer.create',owner,{external_id:`SUB004-${code}`,name,billing_email:`${code}@renewals.example`})).id
    // Online sign-up is one ordinary form confirmation after choosing a plan.
    const signed=await h.submit('subscription.create',owner,{customer,start_date:'2026-01-01',price,anchor_day:'1'},'/app/subscriptions/{id}')
    assert.equal(signed.searchParams.has('error'),false,'SUB-004 one-step online subscription creation succeeds')
    const sub=signed.pathname.split('/').at(-1),detail=()=>h.api(`subscriptions/${sub}`,owner)
    const payload={subscription:sub,revision:(await detail()).revision,term_start:'2026-01-01',months:12,auto_renew:code!=='end',notice_days:30,uplift_percent:'5',quote:'Annual term; renew at five percent uplift unless cancelled.'}
    for(const notice_days of [14,46])if(code==='renew')assert.equal((await h.api('term.prepare',owner,{...payload,notice_days},400)).error,'annual_notice_must_be_15_to_45_days','SUB-004 out-of-window annual notice setup refused')
    const request=await h.api('term.prepare',owner,payload)
    assert.equal((await detail()).end_date,null,'SUB-004 preparation never installs a policy')
    if(code==='renew')assert.equal((await h.api('term.decide',owner,{term:request.term,decision:'approved'},409)).error,'single_confirmation_required')
    await h.api('term.decide',owner,{term:request.term,decision:'approved',confirm_single:true})
    assert.equal((await detail()).end_date,'2027-01-01')
    assert.equal((await h.api('term.decide',owner,{term:request.term,decision:'approved',confirm_single:true},409)).error,'already_decided')
    subscriptions.push({code,sub,customer,term:request.term,detail})
  }
  const [renew,cancel,ended,rejected,uncertain]=subscriptions
  const oldLink=await h.api('term.link',owner,{term:renew.term}),newLink=await h.api('term.link',owner,{term:renew.term})
  assert.equal((await h.raw(new URL(oldLink.cancelUrl).pathname)).status,404,'SUB-004 reissue invalidates the old cancellation token')
  assert.equal((await h.raw(new URL(newLink.cancelUrl).pathname)).status,200)
  assert.ok(!JSON.stringify(await renew.detail()).includes(new URL(newLink.cancelUrl).pathname.split('/').at(-1)),'SUB-004 raw bearer tokens never appear in record projections')
  await onState('configured',renew.sub)
  const clock=async stamp=>assert.equal((await h.raw(`/cdn-cgi/local/scheduled?time=${Date.parse(stamp)}&cron=${encodeURIComponent('0 14 * * *')}`)).status,200)
  await clock('2026-12-01T14:00:00Z')
  for(const s of subscriptions)assert.equal((await s.detail()).renewal.notices.length,0,'SUB-004 no early mail')
  const before=h.mails.length
  h.mailResponses.push({to:'renew@renewals.example',status:200,body:{id:'sub004-provider-accepted'}},{to:'cancel@renewals.example',status:200,body:{id:'sub004-provider-cancel'}},{to:'reject@renewals.example',status:422,body:{message:'Rejected at mail edge'}},{to:'uncertain@renewals.example',status:200,body:{}})
  await clock('2026-12-02T14:00:00Z')
  const notices=h.mails.slice(before).filter(m=>m.subject.startsWith('Subscription renewal'))
  assert.equal(notices.length,4,'SUB-004 exactly one notice per auto-renewing annual subscription at 30 days')
  const mailFor=s=>notices.find(m=>[m.to].flat().some(v=>v.includes(`${s.code}@renewals.example`)))
  for(const s of [renew,cancel,rejected,uncertain]) {
    const text=mailFor(s).text
    assert.match(text,/January 1, 2027/,'SUB-004 notice names renewal date (PORT-006 English long date)')
    assert.match(text,/105\.00/,'SUB-004 notice names new price after5% uplift')
    assert.match(text,/http:\/\/127\.0\.0\.1:\d+\/renewal\/[a-f0-9]{64}/,'SUB-004 notice includes cancellation link')
    const record=(await s.detail()).renewal.notices[0]
    assert.equal(record.due_date,'2026-12-02')
    assert.equal(JSON.parse(record.snapshot_json).totalCents,10500,'SUB-004 frozen notice agrees with engine')
  }
  assert.equal((await renew.detail()).renewal.notices[0].status,'accepted','SUB-004 renewing customer notice accepted at the provider edge')
  assert.equal((await cancel.detail()).renewal.notices[0].status,'accepted','SUB-004 cancelling customer receives the accepted notice link')
  const outcomes=await Promise.all([renew,cancel,rejected,uncertain].map(async s=>(await s.detail()).renewal.notices[0].status))
  assert.deepEqual(outcomes.sort(),['accepted','accepted','rejected','uncertain'],'SUB-004 real adapter records each provider outcome honestly regardless of UUID processing order')
  await clock('2026-12-03T14:00:00Z')
  assert.equal(h.mails.length,before+4,'SUB-004 accepted/refused/unconfirmed notices never retry')
  await onState('notices',renew.sub)
  const link=new URL(mailFor(cancel).text.match(/http:\/\/[^\s]+\/renewal\/[a-f0-9]{64}/)[0]),path=link.pathname
  const first=await h.raw(path)
  assert.equal(first.status,200)
  assert.equal((await cancel.detail()).renewal.terms[0].cancelled_at,null,'SUB-004 opening link never cancels')
  const html=await first.text()
  assert.equal((html.match(/<form /g)??[]).length,1,'SUB-004 exactly one cancellation confirmation, no extra retention step')
  assert.doesNotMatch(html,/Willow|cancel@renewals\.example/,'SUB-004 cancellation link exposes no customer PII')
  assert.equal(first.headers.get('referrer-policy'),'strict-origin')
  await onState('cancellation',cancel.sub,path)
  const form=new URLSearchParams({confirm:'cancel'})
  assert.equal((await h.raw(path,{form,headers:{origin:'https://other.example'}})).status,403,'SUB-004 cross-site confirmation refused')
  assert.equal((await cancel.detail()).renewal.terms[0].cancelled_at,null)
  const confirmed=await h.raw(path,{form})
  assert.equal(confirmed.status,200)
  assert.match(await confirmed.text(),/will not renew/)
  assert.equal((await h.raw(path,{form})).status,404,'SUB-004 replay cannot change another term')
  await onState('cancelled',cancel.sub,path)
  await clock('2027-01-01T07:59:59Z')
  assert.equal((await renew.detail()).renewal.events.length,0,'SUB-004 business-local midnight boundary excludes previous second')
  await clock('2027-01-01T08:00:00Z')
  const renewed=await renew.detail(),stopped=await cancel.detail()
  assert.equal(renewed.end_date,'2028-01-01','SUB-004 automatic annual term extended once')
  assert.equal(renewed.renewal.events[0].uplift_percent,'5.00')
  assert.equal(stopped.end_date,'2027-01-01','SUB-004 online cancellation prevents renewal')
  assert.equal(stopped.renewal.events[0].kind,'end')
  assert.equal((await ended.detail()).renewal.events[0].kind,'end','SUB-004 nonrenewing term ends automatically')
  const next=await h.api(`subscriptions/${renew.sub}/upcoming?period=2027-01`,owner)
  assert.equal(next.calculation.totalCents,10500,'SUB-004 ordinary billing uses exactly5% uplift')
  const prior=await h.api(`subscriptions/${renew.sub}/upcoming?period=2026-12`,owner)
  assert.equal(prior.calculation.totalCents,10000,'SUB-004 earlier period remains at original price')
  assert.equal((await h.api(`entitlements/${cancel.customer}?feature=sub004-access&date=2027-01-01`,owner)).allowed,false)
  assert.equal((await h.api(`entitlements/${renew.customer}?feature=sub004-access&date=2027-01-01`,owner)).allowed,true)
  await clock('2027-01-01T14:00:00Z')
  assert.equal((await renew.detail()).renewal.events.length,1,'SUB-004 duplicate clock cannot compound twice')
  await clock('2028-01-01T08:00:00Z')
  assert.equal((await h.api(`subscriptions/${renew.sub}/upcoming?period=2028-01`,owner)).calculation.totalCents,11025,'SUB-004 each renewal compounds exact price once')
  assert.equal((await h.api('catalog',owner)).prices.find(p=>p.id===price).unit_amount,'100.00','SUB-004 immutable catalogue remains original')
  const csv=await h.page('/app/exports/subscriptions.csv',owner)
  assert.match(csv,/renewal_json/)
  const audit=await h.api('audit',owner)
  assert.ok(audit.some(e=>e.action==='subscription.renewal.cancel'))
  assert.ok(audit.some(e=>e.action==='subscription.term.renew'))
  await onState('renewed',renew.sub)
  // Current-role authority and separate-person configuration apply to every new door.
  await h.api('access.give',owner,{email:'finance@renewals.example',role:'finance',name:'Renewal Finance'})
  const finance=await h.signIn('finance@renewals.example')
  const base=await renew.detail(),prepared=await h.api('term.prepare',owner,{subscription:renew.sub,revision:base.revision,term_start:'2028-01-01',months:12,auto_renew:true,notice_days:30,uplift_percent:'0'})
  assert.equal((await h.api('term.decide',owner,{term:prepared.term,decision:'approved',confirm_single:true},409)).error,'second_approver_required')
  await h.api('term.decide',finance,{term:prepared.term,decision:'approved'})
  const agent={bearer:(await h.api('credential.issue',owner,{name:'Renewal reader',scopes:['prepare']})).key}
  for(const action of ['term.prepare','term.decide','term.link']){await h.api(action,null,{},401);await h.api(action,agent,{},403)}
  console.log('SUB-004 annual notice, cancellation, uplift, term end, clock, custody and authority passed')
}
