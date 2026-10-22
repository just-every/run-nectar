// Real Worker, portal signatures, approval, purchase invoices, balances and
// receipts. Only Stripe's network boundary is synthetic.
import assert from 'node:assert/strict'
import { applyPolicy } from './policy-helper.mjs'
import { nativeCollectionEdge } from './native-collection.mjs'
import { totp } from './mfa.mjs'
const edge=nativeCollectionEdge()
export const harnessOptions=()=>({stripeFetch:edge.fetch,stripeSecret:'synthetic-nectar-1',stripeSecondarySecret:'synthetic-nectar-2'})
export async function prepaidTopupFlow(h,owner,{onState=async()=>{}}={}){
  const api=(path,body,status)=>h.api(path,owner,body,status),posts=()=>edge.calls.filter(call=>call.method==='POST'&&call.path==='/payment_intents').length
  let instant='2026-11-02T18:00:00Z'
  await h.advanceClock(instant);edge.capturedAt(instant)
  await api('business.configure',{...await api('business'),timezone:'UTC'})
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Synthetic customer-authorized prepaid topup'})
  await api('tax.review',{revision:(await api('business')).revision})
  await api('access.give',{email:'synthetic-nectar-501@example.test',name:'Synthetic independent finance',role:'finance'})
  const finance=await h.signIn('synthetic-nectar-501@example.test',{requested:true})
  await api('access.give',{email:'synthetic-nectar-504@example.test',name:'Synthetic topup support',role:'support'})
  const support=await h.signIn('synthetic-nectar-504@example.test',{requested:true}),agent={bearer:(await api('credential.issue',{name:'Synthetic topup observer',scopes:['prepare']})).key}
  const product=(await api('product.create',{code:'synthetic-nectar-502',name:'Synthetic daily service'})).id
  const meter=(await api('meter.create',{code:'synthetic-nectar-503',name:'Synthetic daily units',unit_label:'units'})).id
  const price=(await api('price.create',{product,meter,kind:'unit',unit_amount:'1',taxable:false,billing_interval:'daily',billing_timing:'arrears'})).id
  const rows=[]
  const submit=(row,id,amount,date)=>api('usage.submit',{events:[{event_id:`synthetic-nectar-${id}`,customer:row.external,meter:'synthetic-nectar-503',quantity:amount,occurred_at:`${date}T12:00:00Z`}]})
  const issue=async row=>{
    const run=await api('billrun.prepare',{period:'2026-11'}),invoices=(await api(`runs/${run.id}`)).invoices.filter(invoice=>invoice.subscription_id===row.subscription)
    assert.ok(invoices.length)
    for(const invoice of invoices){await api('invoice.approve',{invoice:invoice.id,acknowledge:true});await api('invoice.finalise',{invoice:invoice.id,issue_date:instant.slice(0,10)})}
  }
  for(let n=1;n<=4;n++){
    // Network-edge customer two belongs to the second configured account.
    const external=`synthetic-nectar-${510+n}`,customer=(await api('customer.create',{external_id:external,name:`Synthetic topup ${n}`,billing_email:`${external}@example.test`})).id
    const subscription=(await api('subscription.create',{customer,start_date:'2026-11-01',price:[price]})).id
    const row={customer,subscription,external,n};rows.push(row)
    const terms={subscription,mode:'grant',kind:'money',source:'purchase',amount:'10000',effective_date:'2026-11-01',expires_date:'2027-02-01',priority:10,expiry_consent:true}
    const grant=await api('prepaid.prepare',terms);await h.api('prepaid.decide',finance,{request:grant.request,decision:'approved'})
    const invoice=(await api('prepaid.purchase.prepare',{intent:grant.request,issue_date:'2026-11-01'})).invoice
    await api('invoice.approve',{invoice,acknowledge:true});await api('invoice.finalise',{invoice,issue_date:'2026-11-01'})
    const payment=await api('payment.record',{customer,amount:'10000',received_on:'2026-11-01',method:'bank_transfer',reference:`synthetic-nectar-${520+n}`})
    await api('payment.allocate',{payment:payment.payment,invoice,amount:'10000'});await api('prepaid.funding.confirm',{intent:grant.request,confirm:true})
    const consent=await api('prepaid.prepare',{...terms,mode:'consent',amount:'5000',threshold:'1000',funding_consent:true});await h.api('prepaid.decide',finance,{request:consent.request,decision:'approved'})
    row.consent=consent.request
    await submit(row,530+n,'9100','2026-11-01');await issue(row)
    row.account=`synthetic-nectar-native-account-${n===2?2:1}`
    await api('collection.customer.bind',{customer,account_ref:row.account,stripe_customer_ref:`synthetic-nectar-native-customer-${n}`,confirm:true})
    assert.equal((await api(`prepaid/${subscription}`)).balances[0].remainingN,90000)
  }
  assert.equal(posts(),0)
  await api('prepaid.topup.run',{authorization:rows[0].consent},404)
  assert.equal(posts(),0,'Merchant consent and a low balance alone never authorize a charge')
  await api('portal.configure',{hosts:[h.origin],parents:[]})
  const factor=await api('mfa.totp.start',{})
  await api('mfa.totp.confirm',{factor:factor.factor,code:totp(factor.secret,Date.parse(instant))});await api('mfa.policy',{scope:'roles',roles:['owner']})
  const portal=async row=>api('portal.session.issue',{customer:row.customer,origin:h.origin,audience:'hosted'})
  const portalPost=async(path,session,body,status=200)=>{const response=await h.raw(`${path}?session=${encodeURIComponent(session.token)}`,{body});assert.equal(response.status,status);return response.status===200?response.json():null}
  for(const row of rows){
    row.authorization=await api('prepaid.topup.prepare',{consent:row.consent,period_cap:'5000',start_date:'2026-11-02',end_date:'2027-01-01',account_ref:row.account})
    await api('prepaid.topup.run',{authorization:row.authorization.id},409)
    await h.api('prepaid.topup.decide',finance,{authorization:row.authorization.id,basis_hash:row.authorization.basis,decision:'approved'},409)
    row.portal=await portal(row)
    const quote=await h.raw(`/portal/prepaid-topups/${row.authorization.id}?session=${encodeURIComponent(row.portal.token)}`)
    assert.equal(quote.status,200);const viewed=await quote.json()
    assert.deepEqual([viewed.quote.thresholdN,viewed.quote.amountCents,viewed.quote.periodCapCents],[100000,500000,500000])
    assert.equal(viewed.quote.period,'business_calendar_month');assert.equal(viewed.quote.timezone,'UTC')
    await portalPost('/portal/prepaid-topup.accept',row.portal,{authorization:row.authorization.id,basis_hash:'changed',accept:true},409)
    await portalPost('/portal/prepaid-topup.accept',row.portal,{authorization:row.authorization.id,basis_hash:row.authorization.basis,accept:true})
    await api('prepaid.topup.decide',{authorization:row.authorization.id,basis_hash:row.authorization.basis,decision:'approved'},409)
    await h.api('prepaid.topup.decide',finance,{authorization:row.authorization.id,basis_hash:row.authorization.basis,decision:'approved'})
  }
  const readsBefore=edge.calls.length
  const financeQuotes=await h.api(`prepaid/topup-authorizations?subscription=${rows[0].subscription}`,finance)
  assert.equal(financeQuotes[0].basis,rows[0].authorization.basis);assert.equal(financeQuotes[0].quote.amountCents,500000)
  assert.equal(financeQuotes[0].acceptance.basis,rows[0].authorization.basis)
  for(const who of [support,agent])await h.api(`prepaid/topup-authorizations?subscription=${rows[0].subscription}`,who,undefined,403)
  assert.equal(edge.calls.length,readsBefore,'Reviewing the exact approved financial/card quote performs no provider request')
  const first=rows[0],before=posts()
  await portalPost('/portal/prepaid-topup.accept',rows[1].portal,{authorization:first.authorization.id,basis_hash:first.authorization.basis,accept:true},404)
  await h.api('prepaid.topup.prepare',finance,{consent:first.consent},403)
  const attempts=await Promise.all([1,2].map(()=>h.raw('/api/nectar/prepaid.topup.run',{cookie:owner,body:{authorization:first.authorization.id}})))
  assert.ok(attempts.every(response=>[200,409].includes(response.status)))
  assert.equal(posts(),before+1,'Concurrent jobs own one durable crossing and one off-session PaymentIntent')
  const claims=await api(`prepaid/topup-claims?subscription=${first.subscription}`),claim=claims[0]
  assert.equal(claim.status,'collected');assert.equal(claim.amount_cents,500000);assert.ok(claim.payment_id)
  assert.equal((await api(`prepaid/${first.subscription}`)).balances[0].remainingN,590000)
  assert.equal((await api(`invoices/${claim.invoice_id}`)).balanceCents,0)
  const invoiceOriginal=(await api(`invoices/${claim.invoice_id}`)).calculation
  const ledger=await api(`prepaid/${first.subscription}`)
  assert.equal(ledger.fundingIntents.filter(intent=>intent.consent_id===first.consent&&intent.status==='pending').length,0,'Unissued manual requests cannot compete with the automatic funded purchase')
  const post=edge.calls.filter(call=>call.method==='POST').at(-1)
  assert.equal(post.form.off_session,'true');assert.equal(post.form['payment_method_types[0]'],'card');assert.equal(post.form.receipt_email,undefined)
  await api('prepaid.topup.run',{authorization:first.authorization.id});assert.equal(posts(),before+1)
  await onState({label:'funded',row:first,claim})
  instant='2026-11-03T18:00:00Z';await h.advanceClock(instant);edge.capturedAt(instant)
  await submit(first,540,'5000','2026-11-02');await issue(first)
  assert.equal((await api(`prepaid/${first.subscription}`)).balances[0].remainingN,90000)
  const capped=await api('prepaid.topup.run',{authorization:first.authorization.id},409)
  assert.equal(capped.error,'topup_monthly_cap');assert.equal(posts(),before+1,'A second crossing in the same business calendar month stops at the exact signed cap')
  const unknown=rows[1];edge.loseBeforePayment()
  const lost=await api('prepaid.topup.run',{authorization:unknown.authorization.id})
  assert.equal(lost.status,'uncertain');const afterUnknown=posts(),reads=edge.calls.length
  await api('prepaid.topup.run',{authorization:unknown.authorization.id})
  assert.equal((await api('prepaid.topup.reconcile',{claim:lost.id})).status,'uncertain')
  assert.equal(posts(),afterUnknown,'Unknown results never retry the provider write')
  assert.ok(edge.calls.slice(reads).some(call=>call.method==='GET'&&call.path==='/payment_intents/search'))
  assert.ok(edge.calls.slice(reads).some(call=>call.method==='GET'&&call.path==='/payment_intents'))
  await api('mfa.verify',{code:totp(factor.secret,Date.parse(instant))})
  const revoked=rows[2],session=await portal(revoked)
  await portalPost('/portal/prepaid-topup.revoke',session,{authorization:revoked.authorization.id})
  await api('prepaid.topup.run',{authorization:revoked.authorization.id},409);assert.equal(posts(),afterUnknown)
  const replaced=rows[3],card=edge.customers.get('synthetic-nectar-native-customer-4'),originalMethod=card.method
  card.method='synthetic-nectar-native-replaced-card'
  await api('prepaid.topup.run',{authorization:replaced.authorization.id},409)
  card.method=originalMethod
  await api('prepaid.topup.run',{authorization:replaced.authorization.id},409);assert.equal(posts(),afterUnknown,'Card replacement permanently ends standing authorization')
  const authorizations=await api(`prepaid/topup-authorizations?subscription=${replaced.subscription}`)
  assert.equal(authorizations[0].status,'card_changed')
  assert.deepEqual((await api(`invoices/${claim.invoice_id}`)).calculation,invoiceOriginal)
  await onState({label:'refusals',rows,claim,lost})
  const erasure=await api('erasure.request',{customer:first.customer})
  const link=h.mails.at(-1).text.match(/https?:\/\/[^\s"<]+\/erase\/[a-f0-9]{64}/)[0]
  assert.equal((await h.raw(new URL(link).pathname,{form:new URLSearchParams({confirm:'yes'})})).status,200)
  const erased=await api('erasure.approve',{request:erasure.id,confirm:true})
  for(const family of ['nc_prepaid_topup_authorizations','nc_prepaid_topup_claims'])assert.ok(erased.receipt.changed.some(change=>change.kind===family))
  await api('prepaid.topup.run',{authorization:first.authorization.id},404)
  assert.deepEqual(await api(`prepaid/topup-authorizations?subscription=${first.subscription}`),[])
  assert.deepEqual(await api(`prepaid/topup-claims?subscription=${first.subscription}`),[])
  assert.equal(posts(),afterUnknown,'Erasure removes capability/source proof and cannot create another charge')
  console.log('CAT-010 signed portal acceptance, independent approval, one crossing, exact funded purchase, monthly cap, GET-only uncertainty, revocation, card replacement and erasure passed')
  return {rows,claim,lost}
}
