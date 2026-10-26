// PAY-006 public HTTP and D1 journey. Only the paid Stripe network edge is faked.
import assert from 'node:assert/strict'
import { totp } from './mfa.mjs'
import { applyPolicy } from './policy-helper.mjs'

export function paymentLinksEdge(baseFetch=async()=>new Response(null,{status:599})) {
  const customers=new Map(),sessions=new Map(),calls=[];let fault=null,live=false
  const lose=operation=>{if(fault===`lose-${operation}`){fault=null;throw new Error('Synthetic lost provider response')}}
  const fetch=async request=>{
    const url=new URL(request.url),path=url.pathname.slice(3),post=request.method==='POST'
    if(url.hostname!=='api.stripe.com')return baseFetch(request)
    assert.equal(request.headers.get('authorization'),'Bearer synthetic-nectar-1')
    if(path==='/account')return Response.json({object:'account',id:'acct_link_test'})
    if(path==='/balance')return Response.json({object:'balance',livemode:live,available:[],pending:[]})
    if(path==='/customers'&&post) {
      const body=new URLSearchParams(await request.text()),attempt=body.get('metadata[nectar_payment_link_attempt]')
      assert.ok(attempt);assert.equal(request.headers.get('idempotency-key'),`nectar-payment-link-customer-${attempt}`)
      calls.push({operation:'customer',attempt})
      const row={object:'customer',id:`cus_link_${customers.size+1}`,name:body.get('name'),email:body.get('email'),livemode:false,
        metadata:{nectar_payment_link_attempt:attempt,nectar_payment_link:body.get('metadata[nectar_payment_link]')},invoice_settings:{default_payment_method:null}}
      customers.set(row.id,row);lose('customer');return Response.json(row)
    }
    if(path==='/customers'&&!post)return Response.json({object:'list',has_more:false,data:[...customers.values()].filter(row=>row.email===url.searchParams.get('email'))})
    if(path.startsWith('/customers/')) {
      const customer=customers.get(path.split('/').at(-1));assert.ok(customer)
      if(post) {
        const body=new URLSearchParams(await request.text()),method=body.get('invoice_settings[default_payment_method]')
        const session=[...sessions.values()].find(value=>value.method.id===method)
        assert.equal(session.method.customer,customer.id)
        assert.equal(request.headers.get('idempotency-key'),`nectar-hosted-default-${session.session.metadata.nectar_setup_id}`)
        customer.invoice_settings.default_payment_method=method;calls.push({operation:'default',attempt:session.session.metadata.nectar_setup_id});lose('default')
      }
      return Response.json(customer)
    }
    if(path==='/checkout/sessions'&&post) {
      const body=new URLSearchParams(await request.text()),attempt=body.get('metadata[nectar_setup_id]'),customer=body.get('customer')
      const mode=body.get('mode')
      if(mode==='payment') {
        const id=body.get('metadata[nectar_payment_link_attempt]'),n=sessions.size+1,amount=Number(body.get('line_items[0][price_data][unit_amount]'))+Number(body.get('line_items[1][price_data][unit_amount]')??0)
        assert.ok(customers.has(customer));assert.equal(request.headers.get('idempotency-key'),`nectar-payment-link-payment-${id}`)
        const metadata={nectar_native_collection_key:body.get('payment_intent_data[metadata][nectar_native_collection_key]'),nectar_native_collection_request:id,nectar_native_invoice:body.get('payment_intent_data[metadata][nectar_native_invoice]')}
        const common={customer,livemode:false,currency:'usd'},method=`pm_link_${n}`,intent=`pi_link_${n}`,charge=`ch_link_${n}`
        sessions.set(id,{session:{object:'checkout.session',id:`cs_link_${n}`,...common,mode:'payment',status:'open',payment_status:'unpaid',amount_total:amount,metadata:{nectar_payment_link_attempt:id},payment_intent:intent,url:`https://checkout.stripe.com/c/pay/cs_link_${n}`},
          setup:{id:`seti_unused_${n}`},method:{object:'payment_method',id:method,type:'card',livemode:false,customer:null,card:{brand:'visa',last4:'4242',exp_month:12,exp_year:2035}},
          intent:{object:'payment_intent',id:intent,...common,status:'succeeded',amount,amount_received:amount,metadata,payment_method:method,latest_charge:charge},
          charge:{object:'charge',id:charge,...common,payment_intent:intent,payment_method:method,status:'succeeded',paid:true,captured:true,amount,amount_captured:amount,amount_refunded:0,refunded:false,disputed:false,created:1793008800}})
        calls.push({operation:'checkout',attempt:id,mode});lose('checkout');return Response.json(sessions.get(id).session)
      }
      assert.ok(customers.has(customer));assert.equal(mode,'setup');assert.equal(body.get('currency'),'usd')
      assert.equal(body.get('payment_method_types[0]'),'card');assert.equal(body.get('setup_intent_data[metadata][nectar_setup_id]'),attempt)
      assert.equal(request.headers.get('idempotency-key'),`nectar-hosted-setup-${attempt}`)
      const n=sessions.size+1,metadata={nectar_setup_id:attempt},common={customer,livemode:false}
      const row={session:{object:'checkout.session',id:`cs_link_${n}`,...common,mode:'setup',status:'open',metadata,payment_method_types:['card'],setup_intent:`seti_link_${n}`,url:`https://checkout.stripe.com/c/pay/cs_link_${n}`},
        setup:{object:'setup_intent',id:`seti_link_${n}`,...common,status:'succeeded',metadata,payment_method_types:['card'],payment_method:`pm_link_${n}`},
        method:{object:'payment_method',id:`pm_link_${n}`,...common,type:'card',card:{brand:'visa',last4:'4242',exp_month:12,exp_year:2035},billing_details:{name:'Synthetic private billing input'},client_secret:'synthetic-private-link-secret'}}
      sessions.set(attempt,row);calls.push({operation:'checkout',attempt,locale:body.get('locale')});lose('checkout');return Response.json(row.session)
    }
    if(path==='/checkout/sessions'&&!post)return Response.json({object:'list',has_more:false,data:[...sessions.values()].map(row=>row.session).filter(row=>row.customer===url.searchParams.get('customer'))})
    if(path==='/charges')return Response.json({object:'list',has_more:false,data:[...sessions.values()].filter(row=>row.intent?.id===url.searchParams.get('payment_intent')).map(row=>row.charge)})
    const record=[...sessions.values()].find(row=>[row.session.id,row.setup.id,row.method.id,row.intent?.id].filter(Boolean).some(id=>path.endsWith(`/${id}`)))
    if(record&&!post) {
      if(path.startsWith('/checkout/sessions/'))return Response.json({...record.session,...(fault==='wrong-customer'?{customer:'cus_link_foreign'}:{})})
      if(path.startsWith('/setup_intents/'))return Response.json(record.setup)
      if(path.startsWith('/payment_methods/'))return Response.json(record.method)
      if(path.startsWith('/payment_intents/'))return Response.json(record.intent)
    }
    // No fallback application or charge implementation: unexpected processor
    // calls fail the journey, including accidental subscription or debit requests.
    assert.fail(`Unexpected Stripe operation ${request.method} ${path}`)
  }
  return {fetch,calls,sessions,customers,setFault:value=>{fault=value},setLive:value=>{live=value},complete:attempt=>{const row=sessions.get(attempt);row.session.status='complete';if(row.session.mode==='payment')row.session.payment_status='paid'},expire:attempt=>{const row=sessions.get(attempt);row.session.status='expired';row.session.setup_intent=null}}
}

let edge
export const harnessOptions=()=>{edge=paymentLinksEdge();return {stripeFetch:edge.fetch,stripeSecret:'synthetic-nectar-1',localTime:'2026-10-26T10:00:00Z'}}

export async function paymentLinksFlow(h,owner,{onState=async()=>{},interaction={}}={}) {
  const api=(path,body,status=200)=>interaction.action&&status===200&&['payment_link.create','payment_link.deactivate'].includes(path)?interaction.action({h,owner,action:path,payload:body}):h.api(path,owner,body,status)
  const instant=Date.parse('2026-10-26T10:00:00Z');await h.advanceClock(new Date(instant).toISOString())
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'flat_rate',tax_rate:'5',tax_note:'Synthetic payment-link tax declaration'})
  await api('tax.review',{revision:(await api('business')).revision})
  const factor=await api('mfa.totp.start',{});await api('mfa.totp.confirm',{factor:factor.factor,code:totp(factor.secret,instant)})
  const product=(await api('product.create',{code:'pay006-monthly',name:'Monthly workspace'})).id
  const seats=(await api('product.create',{code:'pay006-seats',name:'Monthly seats'})).id
  const price=(await api('price.create',{product,kind:'flat',unit_amount:'100',taxable:true})).id
  const seat=(await api('price.create',{product:seats,kind:'seat',unit_amount:'12.50',taxable:true})).id
  const coupon=(await api('coupon.create',{name:'Link launch discount',kind:'percent',value:'20',duration:'repeating',months:3})).id
  await api('promotion.create',{code:'LINK20',coupon,max_redemptions:10,first_time_only:true})
  const create=(extra={},status=200)=>api('payment_link.create',{name:'Workspace signup',price:[price,seat],quantity:['1','3'],trial_days:14,months:1,auto_renew:true,notice_days:7,uplift_percent:'0',confirm:true,confirm_single:true,...extra},status)
  await api('payment_link.create',{name:'No consent',price:[price],confirm:false},400)
  edge.setLive(true);await create({},409)
  // A mode-bearing provider read must reject a live credential before a write.
  assert.equal(edge.calls.length,0);edge.setLive(false)
  const link=await create({max_uses:1,promotion_code:'LINK20'})
  const getOffer=async(id,language='en',status=200)=>{
    const response=await h.raw(`/pay-links/${id}?language=${language}`,{headers:{accept:'application/json'}})
    assert.equal(response.status,status);return response.json()
  }
  const offer=await getOffer(link.id),spanish=await getOffer(link.id,'es-US')
  assert.deepEqual(spanish.terms,offer.terms,'Language changes no chosen catalog, trial, promotion or tax figures')
  assert.deepEqual([offer.terms.subtotalCents,offer.terms.taxCents,offer.terms.totalCents],[13750,688,14438])
  const beforeRead=await api('audit')
  for(const language of ['en','es-US']) {
    const page=await h.page(`/pay-links/${link.id}?language=${language}`)
    assert.match(page,new RegExp(`lang="${language}"`));assert.ok(!page.includes('paymentLink.'))
  }
  assert.deepEqual(await api('audit'),beforeRead,'Presenting terms accepts nothing')
  const start=async(id,language,email,extra={})=>{
    const shown=await getOffer(id,language)
    const payload={name:`Signup ${email}`,billing_email:email,address:'10 Synthetic Lane',language,offer_hash:shown.offerHash,attempt_token:shown.attemptToken,confirm:true,make_default:true,...extra}
    if(interaction.start)return interaction.start({h,id,language,payload})
    const response=await h.raw(`/pay-links/${id}/start`,{body:payload})
    assert.equal(response.status,201);const body=await response.json()
    return {body,payload,cookie:response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ')}
  }
  const post=async(attempt,operation,status=200,options={})=>{
    if(interaction.post&&status===200&&!Object.keys(options).length)return interaction.post({h,attempt,operation})
    const response=await h.raw(`/pay-links/attempts/${attempt.body.id}/${operation}`,{cookie:attempt.cookie,body:{confirm:true},...options})
    const body=await response.json();assert.equal(response.status,status,body.error??operation);return body
  }
  const signup=await start(link.id,'es-US','pay006-first@example.test')
  assert.equal(signup.body.status,'open');assert.equal(new URL(signup.body.url).hostname,'checkout.stripe.com')
  assert.equal(edge.calls.find(call=>call.operation==='checkout').locale,'es')
  const posts=edge.calls.length
  const replay=await h.raw(`/pay-links/${link.id}/start`,{body:signup.payload});assert.equal(replay.status,201)
  assert.equal((await replay.json()).id,signup.body.id);assert.equal(edge.calls.length,posts,'Replayed accepted form creates no second customer or Checkout')
  await getOffer(link.id,'en',409)
  await post(signup,'finish',401,{cookie:undefined})
  await post(signup,'finish',403,{headers:{origin:'https://foreign.example'}})
  await post(signup,'finish',409)
  assert.deepEqual(await api('customers?search=pay006-first@example.test'),[],'No native subscription exists before verified capture')
  edge.complete(signup.body.id);edge.setFault('wrong-customer');await post(signup,'finish',409);edge.setFault(null)
  const completed=await post(signup,'finish');assert.equal(completed.status,'complete');assert.equal(completed.debitAuthority,false)
  const afterWrites=edge.calls.length;assert.deepEqual(await post(signup,'finish'),completed);assert.equal(edge.calls.length,afterWrites)
  const customer=await api(`customers/${completed.customer}`),subscription=await api(`subscriptions/${completed.subscription}`)
  assert.equal(customer.language,'es-US');assert.equal(subscription.trial_end,'2026-11-09')
  assert.deepEqual(subscription.items.map(item=>[item.price_id,item.quantity]).sort(),[[price,1],[seat,3]].sort())
  assert.deepEqual([customer.ledger.invoicedCents,customer.ledger.paidCents,customer.ledger.creditedCents,customer.ledger.balanceCents],[0,0,0,0],'Setup signup records no cash or debt')
  const attribution=customer.billingRecord.paymentLinks.find(row=>row.subscription===completed.subscription)
  assert.equal(attribution.link,link.id);assert.equal(attribution.method.last4,'4242');assert.equal(attribution.defaultChoice,true)
  assert.equal((await api('promotions')).codes.find(row=>row.code==='LINK20').redemptions,1)
  assert.ok(customer.billingRecord.auditEvents.some(event=>event.action==='payment_link.complete'&&event.subject===completed.id))
  assert.ok(customer.billingRecord.subscriptionHistory.some(row=>row.id===completed.subscription))
  assert.deepEqual((await api('customers?search=pay006-first@example.test')).map(row=>row.id),[completed.customer])
  assert.ok((await api('customers?search=visa%204242')).some(row=>row.id===completed.customer))
  await onState({h,owner,link,signup,completed,customer,subscription,state:'complete'})
  const renewal=subscription.renewal.terms[0]
  assert.equal(renewal.end_date,'2026-11-26');assert.equal(renewal.auto_renew,1);assert.equal(renewal.approval_mode,'single-approver')
  const management=await post(signup,'cancellation'),cancelPath=new URL(management.cancelUrl).pathname
  const managePage=await h.raw(cancelPath);assert.equal(managePage.status,200)
  const manageHtml=await managePage.text();assert.equal((manageHtml.match(/<form /g)??[]).length,1)
  if(interaction.cancelRenewal)await interaction.cancelRenewal({cancelPath})
  else assert.equal((await h.raw(cancelPath,{form:new URLSearchParams({confirm:'cancel'})})).status,200)
  const cancelled=await api(`subscriptions/${completed.subscription}`)
  assert.equal(cancelled.end_date,renewal.end_date);assert.equal(cancelled.renewal.terms[0].auto_renew,0)
  assert.equal((await h.raw(cancelPath,{form:new URLSearchParams({confirm:'cancel'})})).status,404)
  await onState({h,owner,link,signup,completed,customer,subscription:cancelled,state:'cancelled',cancelPath})
  const other=await create({});await api('payment_link.deactivate',{link:other.id,revision:other.revision});await getOffer(other.id,'en',404)
  // Every unknown stage remains reserved, recovered by reads, and never repeats
  // the customer, session or default POST whose outcome might already exist.
  for(const operation of ['customer','checkout','default']) {
    const recoverable=await create({max_uses:1});if(operation!=='default')edge.setFault(`lose-${operation}`)
    const attempt=await start(recoverable.id,'en',`pay006-${operation}@example.test`)
    assert.equal(attempt.body.defaultChoice,true);assert.notEqual(attempt.body.id,signup.body.id)
    if(operation!=='default')await post(attempt,'reconcile')
    edge.complete(attempt.body.id)
    if(operation==='default'){edge.setFault('lose-default');await post(attempt,'finish',503)}
    const before=edge.calls.filter(call=>call.attempt===attempt.body.id&&call.operation===operation).length
    const result=await post(attempt,operation==='default'?'reconcile':'finish')
    assert.equal(result.status,'complete');assert.equal(edge.calls.filter(call=>call.attempt===attempt.body.id&&call.operation===operation).length,before)
  }
  const expires=await create({max_uses:1}),expired=await start(expires.id,'en','pay006-expired@example.test')
  edge.expire(expired.body.id);assert.equal((await post(expired,'reconcile')).status,'expired');assert.ok((await getOffer(expires.id)).offerHash)
  const cashLink=await api('payment_link.create',{name:'One-time workshop',kind:'one_time',amount:'50.25',description:'Workshop registration',taxable:true,max_uses:1,confirm:true})
  const cashOffer=await getOffer(cashLink.id,'es-US');assert.deepEqual([cashOffer.terms.subtotalCents,cashOffer.terms.taxCents,cashOffer.terms.totalCents],[5025,251,5276])
  const cash=await start(cashLink.id,'es-US','pay006-cash@example.test',{make_default:false})
  const cashWrites=edge.calls.length
  // Deactivation stops new visits while retaining captured original cash.
  edge.complete(cash.body.id);await api('payment_link.deactivate',{link:cashLink.id,revision:cashLink.revision});await getOffer(cashLink.id,'es-US',404)
  const paid=await post(cash,'reconcile');assert.equal(paid.status,'complete');assert.equal(paid.subscription,null);assert.ok(paid.payment&&paid.invoice)
  const cashCustomer=await api(`customers/${paid.customer}`),cashInvoice=await api(`invoices/${paid.invoice}`)
  assert.deepEqual([cashCustomer.ledger.invoicedCents,cashCustomer.ledger.paidCents,cashCustomer.ledger.creditedCents,cashCustomer.ledger.balanceCents],[5276,5276,0,0])
  assert.equal(cashCustomer.ledger.payments.find(row=>row.id===paid.payment).received_on,'2026-10-26')
  assert.equal(cashInvoice.total_cents,5276);assert.ok(cashInvoice.number);assert.equal(cashCustomer.billingRecord.receipts.find(row=>row.payment===paid.payment).amountCents,5276)
  assert.equal(cashCustomer.billingRecord.paymentLinks.find(row=>row.invoice===paid.invoice).kind,'one_time')
  assert.deepEqual(await post(cash,'reconcile'),paid);assert.equal(edge.calls.length,cashWrites,'Cash recording and replay submit no additional provider mutation')
  await onState({h,owner,link:cashLink,signup:cash,completed:paid,customer:cashCustomer,invoice:cashInvoice,state:'one-time-complete'})
  const parent=(await api('customer.create',{external_id:'synthetic-nectar-link-parent',name:'Workspace family',billing_email:'family@example.test'})).id
  for(const person of [completed,paid])await api('hierarchy.configure',{customer:person.customer,parent,billing_mode:'separate',revision:0,consent:true})
  const family=await api(`customers/${parent}`)
  for(const person of [completed,paid]){
    const child=family.childAccounts.find(row=>row.record.id===person.customer).record
    assert.equal(child.billingRecord.paymentLinks[0].id,person.id)
    assert.equal(child.ledger.paidCents,person.payment?5276:0)
    if(person.payment)assert.equal(child.billingRecord.receipts.find(row=>row.payment===person.payment).amountCents,5276)
  }
  assert.equal(family.ledger.paidCents,0,'Separate child cash is never copied onto its parent')
  await onState({h,owner,link,signup,completed:{...completed,customer:parent},customer:family,state:'family'})
  const role=await api('role.define',{name:'Signup customer reader',capabilities:['read.customers']})
  await api('access.give',{email:'pay006-reader@example.test',name:'Customer reader',role:'custom',custom_role:role.id})
  const reader=await h.signIn('pay006-reader@example.test',{requested:true})
  for(const person of [completed,paid]){
    const restricted=await h.api(`customers/${person.customer}`,reader)
    assert.equal(restricted.billingRecord.paymentLinks,null);assert.equal(restricted.billingRecord.receipts,null)
    const subjects=new Set([person.customer,...restricted.contacts.map(row=>row.id),...restricted.notes.filter(row=>row.kind==='customer').map(row=>row.id)])
    assert.ok(restricted.billingRecord.auditEvents.every(row=>subjects.has(row.subject)))
  }
  const cashSource=cashCustomer.billingRecord.paymentLinks[0]
  assert.ok((await api(`customers?search=${cashSource.paymentIntentRef}`)).some(row=>row.id===paid.customer))
  assert.deepEqual(await h.api(`customers?search=${cashSource.paymentIntentRef}`,reader),[])
  const account=await api('access.give',{email:'pay006-accountant@example.test',name:'Signup reader',role:'accountant'})
  assert.ok(account);const accountant=await h.signIn('pay006-accountant@example.test',{requested:true})
  await h.api('payment_link.create',accountant,{name:'Refused'},403);await h.api('payment-links',accountant,undefined,403)
  await h.api('payment_link.create',undefined,{},401)
  for(const [person,attempt,email] of [[completed,signup,'pay006-first@example.test'],[paid,cash,'pay006-cash@example.test']]) {
    const privacy=await api('erasure.request',{customer:person.customer}),mail=h.mails.toReversed().find(value=>[value.to].flat().includes(email))
    const confirmation=new URL(`${mail.text??''} ${mail.html??''}`.match(/https?:\/\/[^\s"<]+\/erase\/[a-f0-9]{64}/)[0]).pathname
    assert.equal((await h.raw(confirmation,{form:new URLSearchParams({confirm:'yes'})})).status,200)
    const erased=await api('erasure.approve',{request:privacy.id,confirm:true})
    assert.ok(erased.receipt.changed.some(row=>row.kind==='nc_payment_link_attempts'))
    const writeCount=edge.calls.length;await post(attempt,'finish',401);assert.equal(edge.calls.length,writeCount)
    if(person.payment){const retained=await api(`customers/${person.customer}`);assert.equal(retained.ledger.paidCents,5276);const receipt=await api(`payments/${person.payment}/receipt`);assert.equal(receipt.amountCents,5276);assert.equal(receipt.erased,true);assert.deepEqual(receipt.provenance,[])}
  }
  assert.equal((await api('payment-links')).find(row=>row.id===link.id).uses,1,'Erasure does not replenish a consumed signup')
  await api('access.give',{email:'pay006-finance@example.test',name:'Policy approver',role:'finance'})
  const finance=await h.signIn('pay006-finance@example.test',{requested:true}),financeFactor=await h.api('mfa.totp.start',finance,{})
  await h.api('mfa.totp.confirm',finance,{factor:financeFactor.factor,code:totp(financeFactor.secret,instant)})
  const pending=await create({name:'Independent approved link',price:[price],quantity:['1']})
  await getOffer(pending.id,'en',404)
  let pendingRow=(await api('payment-links')).find(row=>row.id===pending.id)
  await api('payment_link.approve',{link:pending.id,basis_hash:pendingRow.basis,decision:'approved',confirm:true,confirm_single:true},409)
  if(interaction.approvePolicy)await interaction.approvePolicy({finance,pending:pendingRow})
  else await h.api('payment_link.approve',finance,{link:pending.id,basis_hash:pendingRow.basis,decision:'approved',confirm:true})
  pendingRow=(await api('payment-links')).find(row=>row.id===pending.id)
  assert.equal(pendingRow.approvalMode,'two-person')
  if(interaction.activatePolicy)await interaction.activatePolicy({pending:pendingRow})
  else await api('payment_link.activate',{link:pending.id,revision:pendingRow.revision,confirm:true})
  assert.equal((await getOffer(pending.id)).terms.renewal.months,1)
  await h.assertStorageExcludes(['synthetic-private-link-secret','Synthetic private billing input','4242424242424242'])
}
