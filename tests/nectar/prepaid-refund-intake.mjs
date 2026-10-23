// CAT-012's new behaviour extends the existing paid-lot journey, preserving
// the real Worker, D1, native sessions and original processor capture.
import assert from 'node:assert/strict'

export async function configureNotices(h,owner,{refunded='nectar',failed='nectar',language='en'}={}){
  const saved=await h.api('prepaid/refund-notices',owner),t=saved.templates[language]
  return h.api('prepaid.refund.notice.configure',owner,{revision:saved.revision,language,refunded_sender:refunded,failed_sender:failed,refunded_subject:t.refunded.subject,refunded_body:t.refunded.body,failed_subject:t.failed.subject,failed_body:t.failed.body})
}
export async function supportIntake(h,owner,support,row,{onIntakeState=async()=>{},requestIntake}={}){
  const before=await h.api(`prepaid/${row.subscription}`,owner),request=()=>h.api('prepaid.refund.request',support,{grant:row.grant})
  await onIntakeState({label:'support-request-form',row,support})
  const first=requestIntake?await requestIntake({row,support}):await request()
  const repeats=await Promise.all([request(),request()]);assert.ok(repeats.every(r=>r.id===first.id),'Repeated or concurrent submission returns one pending request')
  const facts=(await h.api(`prepaid/refunds?subscription=${row.subscription}`,support)).filter(r=>r.id===first.id)
  assert.equal(facts.length,1);assert.equal(facts[0].status,'pending');assert.equal(facts[0].requestedBy,(await h.api('me',support)).id)
  assert.equal(facts[0].requestedByKind,'member');assert.equal(facts[0].reasonCategory,'unused_paid_credit');assert.equal(facts[0].preparedBy,null)
  assert.equal(Object.hasOwn(facts[0],'quote'),false);assert.equal(Object.hasOwn(facts[0],'reason'),false)
  assert.deepEqual(await h.api(`prepaid/${row.subscription}`,owner),before,'Intake does not reserve or consume credit')
  await h.api('prepaid.refund.decide',owner,{refund:first.id,decision:'approved'},404)
  await h.api('prepaid.refund.prepare',owner,{grant:row.grant,reason:'Must review the intake id'},409)
  await onIntakeState({label:'support-pending',row,refund:facts[0],support})
  return first
}
export async function portalIntake(h,owner,row,foreign,{onIntakeState=async()=>{},requestPortalIntake}={}){
  const customer=await h.api(`customers/${row.customer}`,owner)
  await h.api('customer.update',owner,{customer:customer.id,revision:customer.revision,name:customer.name,billing_email:customer.billing_email,address:customer.address,language:'es-US'})
  const session=await h.api('portal.session.issue',owner,{customer:row.customer,origin:h.origin,audience:'hosted'})
  const path=`/portal/prepaid-refund.request?session=${encodeURIComponent(session.token)}`
  const before=await h.api(`prepaid/${row.subscription}`,owner)
  const post=(grant,headers)=>h.raw(path,{body:{grant},headers})
  assert.equal((await post(row.grant,{origin:'https://foreign.example.test'})).status,403)
  assert.equal((await post(foreign.grant)).status,404,'A portal session cannot request another customer refund')
  await onIntakeState({label:'portal-request-form',row,session})
  const response=requestPortalIntake?null:await post(row.grant)
  if(response)assert.equal(response.status,200)
  const first=requestPortalIntake?await requestPortalIntake({row,session}):await response.json()
  const repeated=await post(row.grant);assert.equal(repeated.status,200);assert.equal((await repeated.json()).id,first.id)
  const facts=(await h.api(`prepaid/refunds?subscription=${row.subscription}`,owner)).find(r=>r.id===first.id)
  assert.equal(facts.requestedBy,row.customer);assert.equal(facts.requestedByKind,'customer');assert.equal(facts.status,'pending');assert.equal(facts.preparedBy,null)
  assert.equal(facts.reasonCategory,'unused_paid_credit');assert.deepEqual(await h.api(`prepaid/${row.subscription}`,owner),before)
  const page=await h.raw(`/portal/prepaid?session=${encodeURIComponent(session.token)}`,{headers:{accept:'text/html'}})
  assert.equal(page.status,200);const text=await page.text();assert.ok(text.includes(first.id));assert.doesNotMatch(text,/untranslated_key|quote_json|payment_method_ref|charge_ref/)
  await onIntakeState({label:'portal-pending',row,session,refund:facts})
  return first
}
export async function assertNotice(h,owner,refund,expectedStatus,{outcome='refunded',language='en'}={}){
  const state=await h.api('prepaid/refund-notices',owner),rows=state.deliveries.filter(r=>r.refund===refund.id)
  assert.equal(rows.length,1);const row=rows[0]
  assert.equal(row.status,expectedStatus);assert.equal(row.outcome,outcome)
  if(expectedStatus==='processor')assert.equal(h.mails.filter(m=>[m.to].flat().includes(row.recipient)&&m.subject===row.subject).length,0)
  else{
    assert.equal(row.language,language)
    const mails=h.mails.filter(m=>[m.to].flat().includes(row.recipient)&&m.subject===row.subject)
    assert.equal(mails.length,1);assert.equal(mails[0].text,row.body)
    const expectedAmount=new Intl.NumberFormat(language==='en'?'en-US':'es-US',{style:'currency',currency:'USD',currencyDisplay:'code'}).format(refund.quote.amountCents/100).replace(/[  ]/g,' ')
    assert.ok(row.body.includes(expectedAmount),`The mail preserves its exact localized amount: ${expectedAmount}`)
    assert.ok(row.body.includes(row.purchaseNumber));if(outcome==='refunded')assert.ok(row.body.includes(row.creditNumber));else assert.equal(row.creditNumber,null)
    assert.doesNotMatch(row.body,/undefined|\{(?:amount|units|purchase|credit)\}/)
    if(refund.quote.kind==='units')assert.ok(row.body.includes('2.5'))
    assert.doesNotMatch(row.body,/Synthetic unused paid service|chargeRef|paymentMethodRef|succeeded-refund/)
  }
  return row
}
