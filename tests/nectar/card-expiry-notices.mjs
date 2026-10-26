// Owner-confirmed PAY-005 expiry notices through actual HTTP, auth, D1 and
// mail transport. Only the Stripe and Resend network edges are simulated.
import assert from 'node:assert/strict'
import { nativeCollectionEdge } from './native-collection.mjs'
import { publishPrice } from './price-helper.mjs'
import { totp } from './mfa.mjs'

let edge
export const harnessOptions=()=>{
  const base=nativeCollectionEdge(),cards=new Map()
  for(let n=1;n<=7;n++){
    base.customers.set(`synthetic-nectar-native-customer-${n}`,{account:1,method:`synthetic-nectar-native-card-${n}`})
    cards.set(`synthetic-nectar-native-card-${n}`,{brand:'visa',last4:'4242',exp_month:10,exp_year:2026})
  }
  const fetch=async request=>{
    const response=await base.fetch(request)
    if(request.method==='GET' && new URL(request.url).pathname.startsWith('/v1/payment_methods/')){
      const row=await response.json(),card=cards.get(row.id)
      return card?Response.json({...row,card}):Response.json(row,{status:response.status})
    }
    return response
  }
  edge={...base,fetch,cards,posts:()=>base.calls.filter(call=>call.method==='POST').length}
  return {localTime:'2026-10-22T06:59:00Z',stripeFetch:fetch,stripeSecret:'synthetic-nectar-1',stripeSecondarySecret:'synthetic-nectar-2'}
}

export async function cardExpiryNoticesFlow(h,owner,{onState=async()=>{}}={}) {
  const api=(path,body,status)=>h.api(path,owner,body,status)
  let instant=Date.parse('2026-10-22T06:59:00Z')
  await h.advanceClock(new Date(instant).toISOString())
  await api('business.configure',{...await api('business'),timezone:'America/Los_Angeles'})
  await api('portal.configure',{hosts:[h.origin],parents:[]})
  const factor=await api('mfa.totp.start',{})
  await api('mfa.totp.confirm',{factor:factor.factor,code:totp(factor.secret,instant)})
  const product=(await api('product.create',{code:'expiry-service',name:'Expiry notice subscription'})).id
  const price=(await publishPrice(h,owner,{product,kind:'flat',unit_amount:'100',taxable:false})).id
  const records=[]
  for(let n=1;n<=7;n++){
    const language=n===2?'es-US':'en'
    const customer=(await api('customer.create',{external_id:`expiry-customer-${n}`,name:`Expiry customer ${n}`,billing_email:`expiry-${n}@example.test`,language})).id
    const subscription=(await api('subscription.create',{customer,start_date:'2026-10-05',anchor_day:5,price:[price]})).id
    const detail=await api(`subscriptions/${subscription}`)
    const term=await api('term.prepare',{subscription,revision:detail.revision,term_start:'2026-10-05',months:1,auto_renew:true,notice_days:1,uplift_percent:'0'})
    await api('term.decide',{term:term.term,decision:'approved',confirm_single:true})
    const binding=await api('collection.customer.bind',{customer,account_ref:'synthetic-nectar-native-account-1',stripe_customer_ref:`synthetic-nectar-native-customer-${n}`,confirm:true})
    const setup=await api('checkout.setup.prepare',{customer,binding:binding.id,method:'card',confirm:true})
    records.push({customer,subscription,setup:setup.id,language,method:`synthetic-nectar-native-card-${n}`})
  }
  const prepare=(r,extra={},status=200)=>api('card.expiry.prepare',{customer:r.customer,subscription:r.subscription,setup:r.setup,confirm:true,...extra},status)
  const send=(n,extra={},status=200)=>api('card.expiry.send',{notice:n.id,basis_hash:n.basis,confirm:true,...extra},status)
  const read=async r=>(await api(`customers/${r.customer}`)).billingRecord.cardExpiryNotices
  const initialMail=h.mails.length,providerWrites=edge.posts()
  await prepare(records[0],{},409)
  assert.deepEqual(await read(records[0]),[],'UTC date alone cannot make a warning due before local midnight')
  instant=Date.parse('2026-10-22T07:00:00Z');await h.advanceClock(new Date(instant).toISOString())
  await prepare(records[0],{setup:records[1].setup},409)
  await prepare(records[0],{confirm:false},400)
  await prepare(records[0],{recipient:'unapproved@example.test'},400)
  edge.cards.get(records[6].method).exp_year=2027
  await prepare(records[6],{},409)
  const ordinary=await h.signIn(h.vars.OWNER_EMAIL),payload={...records[0],confirm:true}
  await h.api('card.expiry.prepare',ordinary,{customer:payload.customer,subscription:payload.subscription,setup:payload.setup,confirm:true},403)
  await h.api('card.expiry.prepare',undefined,{},401)
  const agent={bearer:(await api('credential.issue',{name:'Expiry read observer',scopes:['prepare']})).key}
  await h.api('card.expiry.prepare',agent,{},403)
  const before=h.mails.length,prepared=[]
  for(const r of records.slice(0,6))prepared.push(await prepare(r))
  assert.equal(h.mails.length,before,'Preparation never dispatches or queues customer mail')
  assert.equal(edge.posts(),providerWrites,'Warning preparation never writes to Stripe')
  await prepare(records[0],{},409)
  for(const n of prepared){
    assert.equal(n.dueDate,'2026-10-22');assert.equal(n.renewalDate,'2026-11-05')
    assert.equal(n.last4,'4242');assert.equal(n.expMonth,10);assert.equal(n.expYear,2026)
    assert.equal(n.debitAuthority,false)
    assert.ok(n.expiresAt>instant && n.expiresAt<=instant+15*60*1000)
    const L=new Intl.DateTimeFormat(n.language,{dateStyle:'long',timeZone:'UTC'})
    assert.ok(n.preview.text.includes(L.format(new Date('2026-11-05T00:00:00Z'))))
    assert.match(n.preview.html,new RegExp(`lang="${n.language}"`))
  }
  assert.notEqual(prepared[0].preview.subject,prepared[1].preview.subject,'Customer language changes the actual warning')
  assert.deepEqual((await read(records[0])).map(n=>n.id),[prepared[0].id])
  assert.equal((await h.api(`customers/${records[0].customer}`,agent)).billingRecord.cardExpiryNotices[0].preview,null,'Read credentials never receive a customer bearer link')
  await onState({state:'prepared',customer:records[0].customer,subscription:records[0].subscription,notice:prepared[0]})
  await send(prepared[0],{confirm:false},400)
  await send(prepared[0],{basis_hash:'wrong-basis'},409)
  const concurrent=await Promise.all([1,2].map(()=>h.raw('/api/nectar/card.expiry.send',{cookie:owner,body:{notice:prepared[0].id,basis_hash:prepared[0].basis,confirm:true}})))
  assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409])
  assert.equal((await read(records[0]))[0].status,'accepted')
  const sent=h.mails.slice(before).filter(m=>[m.to].flat().includes('expiry-1@example.test'))
  assert.equal(sent.length,1)
  assert.equal(sent[0].text,prepared[0].preview.text);assert.equal(sent[0].html,prepared[0].preview.html)
  assert.equal(sent[0].subject,prepared[0].preview.subject)
  assert.equal((await send(prepared[0])).replayed,true)
  const updateLink=new URL(sent[0].text.match(/https?:\/\/[^\s]+\/portal\/payment-methods\?session=[^\s]+/)[0])
  assert.equal((await h.raw(updateLink.pathname+updateLink.search)).status,200,'The emailed link opens real hosted setup')
  assert.equal((await send(prepared[1])).status,'accepted')
  assert.equal(h.mails.at(-1).text,prepared[1].preview.text)
  edge.cards.get(records[2].method).exp_year=2035
  assert.equal((await send(prepared[2])).status,'suppressed','An updater that removes expiry risk suppresses the frozen warning')
  h.mailResponses.push({to:'expiry-4@example.test',status:422,body:{message:'Provider definitively refused message'}})
  assert.equal((await send(prepared[3])).status,'failed')
  h.mailResponses.push({to:'expiry-5@example.test',status:200,body:{}})
  assert.equal((await send(prepared[4])).status,'uncertain')
  const claims=h.mails.length
  for(const n of prepared.slice(0,5))assert.equal((await send(n)).replayed,true)
  assert.equal(h.mails.length,claims,'Accepted, failed, uncertain and suppressed claims never retry')
  const auditRows=(await api('audit')).map(row=>({...row,detail:JSON.parse(row.detail)}))
  const preparation=auditRows.find(row=>row.action==='card.expiry.prepare'&&row.detail.notice===prepared[0].id)
  assert.equal(preparation.detail.recipient,'expiry-1@example.test')
  assert.equal(preparation.detail.approvedWording.subject,prepared[0].preview.subject)
  assert.equal(preparation.detail.approvedWording.text,prepared[0].preview.text.replaceAll(updateLink.href,'[Customer update link]'))
  assert.equal(preparation.detail.factorVerification.at,Date.parse('2026-10-22T06:59:00Z'))
  assert.equal(auditRows.filter(row=>row.action==='card.expiry.claim'&&row.detail.notice===prepared[0].id).length,1)
  const audit=JSON.stringify(auditRows)
  assert.ok(!audit.includes(updateLink.searchParams.get('session')),'Audit never contains customer bearer tokens')
  assert.ok(!audit.includes(prepared[0].preview.text),'Audit retains custody facts and digests rather than outbound bodies')
  instant+=16*60*1000;await h.advanceClock(new Date(instant).toISOString())
  await api('mfa.verify',{code:totp(factor.secret,instant)})
  assert.equal((await send(prepared[5])).status,'suppressed','A fresh owner factor cannot revive the original expired update link')
  assert.equal(h.mails.length,claims)
  assert.equal((await h.raw(updateLink.pathname+updateLink.search)).status,401)
  assert.equal(edge.posts(),providerWrites,'No expiry-warning state authorizes a charge or setup POST')
  await onState({state:'accepted',customer:records[0].customer,subscription:records[0].subscription,notice:(await read(records[0]))[0]})
  assert.ok(h.mails.length>initialMail)
  console.log('PAY-005 exact local-day expiry warning, frozen English and Spanish review, scoped setup link, explicit once-only claim, honest mail outcomes and no debit passed')
}
