// Outside push Verify: held-key Stripe test events -> authenticated Nectar
// capture -> signed receiving app. Only our own clock/customer/catalog is used.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { harness, file } from './harness.mjs'
import { applyPolicy } from './policy-helper.mjs'
import { receiver } from '../../examples/webhook-receiver/server.mjs'
import { stripeSandbox, safeError, check, reference } from './stripe-sandbox-client.mjs'
const evidence=process.env.NECTAR_EVIDENCE_DIR??'.evidence'
const receipt={journey:'DEV-001 authenticated Stripe shadow-event mapping',head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),status:'running',events:[],cleanup:{clockDeleted:false}}
const directory=await mkdtemp(join(tmpdir(),'nectar-shadow-receiver-'))
let phase='initialize',h,stripe,clock,product,price,feature,receive
const received=[]
try{
  stripe=stripeSandbox(process.env.STRIPE_SECRET_KEY)
  h=await harness({stripeSecret:process.env.STRIPE_SECRET_KEY,stripeFetch:r=>stripe.forward(r),webhookFetch:r=>receive(r)})
  await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Synthetic shadow sandbox owner'}})
  const owner=await h.signIn(h.vars.OWNER_EMAIL)
  await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
  const api=(path,body,status)=>h.api(path,owner,body,status)
  await api('business.configure',{legal_name:'Synthetic shadow event sandbox',timezone:'UTC',invoice_prefix:'SHADOW',payment_terms_days:30})
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Owned Stripe test-clock webhook mapping'})
  await api('tax.review',{revision:(await api('business')).revision})
  const endpoint=await api('webhook.register',{url:'https://receiver.nectar-app.com/webhooks',consent:true})
  receive=receiver({secrets:()=>[endpoint.secret],stateFile:join(directory,'receipts.json'),onEvent:async e=>received.push(e)})
  phase='owned-test-fixture'
  const started=Math.floor(Date.now()/1000)
  const account=await stripe.request('GET','/v1/account');receipt.accountId=account.id
  clock=(await stripe.request('POST','/v1/test_helpers/test_clocks',{frozen_time:started,name:`Nectar webhook ${stripe.run}`})).id
  const method=await stripe.request('POST','/v1/payment_methods',{type:'card','card[token]':'tok_visa'})
  const customer=await stripe.request('POST','/v1/customers',{name:`Synthetic shadow ${stripe.run}`,test_clock:clock,payment_method:method.id,'invoice_settings[default_payment_method]':method.id})
  receipt.customerId=customer.id
  product=await stripe.request('POST','/v1/products',{name:`Synthetic shadow ${stripe.run}`})
  feature=await stripe.request('POST','/v1/entitlements/features',{name:`Synthetic access ${stripe.run}`,lookup_key:`synthetic-nectar-${stripe.run}`})
  await stripe.request('POST',`/v1/products/${product.id}/features`,{entitlement_feature:feature.id})
  price=await stripe.request('POST','/v1/prices',{product:product.id,currency:'usd',unit_amount:19900,'recurring[interval]':'month'})
  let subscription=await stripe.request('POST','/v1/subscriptions',{customer:customer.id,'items[0][price]':price.id,collection_method:'send_invoice',days_until_due:30})
  receipt.subscriptionId=subscription.id
  const lists={customers:[customer],products:[product],prices:[price],subscriptions:[subscription]}
  const capture=Object.fromEntries(Object.entries(lists).map(([name,data])=>[name,{object:'list',url:`/v1/${name}`,has_more:false,data}]))
  const manifest={source:'stripe',captured_at:new Date().toISOString(),api_version:stripe.apiVersion,captured_by:'Owned DEV-001 Stripe test-clock journey',files:Object.fromEntries(Object.entries(lists).map(([name,data])=>[name,{endpoint:`/v1/${name}`,count:data.length,has_more:false}]))}
  const files=Object.fromEntries(Object.entries({manifest,...capture}).map(([name,value])=>[name,file(`${name}.json`,JSON.stringify(value),'application/json')]))
  phase='public-import'
  const preview=await api('import.preview',files);assert.deepEqual(preview.rejected,[])
  assert.equal((await api('import.apply',{...files,fingerprint:preview.fingerprint})).state,'completed')
  const local=(await api('customers')).find(c=>c.external_id===customer.id);assert.ok(local)
  const localSub=(await api(`customers/${local.id}`)).subscriptions[0]
  await api('metadata.write',{kind:'customer',record:local.id,revision:0,metadata:{app_account_id:`synthetic-nectar-${stripe.run}`}})
  await api('metadata.write',{kind:'subscription',record:localSub.id,revision:0,metadata:{app_account_id:`synthetic-nectar-sub-${stripe.run}`}})
  phase='provider-lifecycle'
  await stripe.request('POST',`/v1/customers/${customer.id}`,{name:`Synthetic changed ${stripe.run}`})
  subscription=await stripe.request('POST',`/v1/subscriptions/${subscription.id}`,{'items[0][id]':subscription.items.data[0].id,'items[0][quantity]':2,proration_behavior:'none'})
  const invoiceId=reference(subscription.latest_invoice)
  let invoice=await stripe.request('GET',`/v1/invoices/${invoiceId}`)
  if(invoice.status==='draft')invoice=await stripe.request('POST',`/v1/invoices/${invoice.id}/finalize`,{auto_advance:false})
  if(invoice.status==='open')await stripe.request('POST',`/v1/invoices/${invoice.id}/pay`,{payment_method:method.id})
  const extra=await stripe.request('POST','/v1/payment_methods',{type:'card','card[token]':'tok_visa'})
  await stripe.request('POST',`/v1/payment_methods/${extra.id}/attach`,{customer:customer.id})
  await stripe.request('POST',`/v1/payment_methods/${extra.id}`,{'billing_details[name]':`Synthetic update ${stripe.run}`})
  await stripe.request('POST',`/v1/payment_methods/${extra.id}/detach`,{})
  await stripe.request('POST',`/v1/subscriptions/${subscription.id}`,{cancel_at_period_end:true})
  // No provider cancellation or financial mutation is performed by Nectar.
  // The receiver observes the actual provider event, with explicit custody.
  phase='capture-and-deliver'
  const mapping={
    'customer.created':'customer.created','customer.updated':'customer.updated',
    'customer.subscription.created':'subscription.created','customer.subscription.updated':'subscription.updated',
    'invoice.created':'invoice.created','invoice.finalized':'invoice.issued','invoice.paid':'invoice.paid',
    'invoice.payment_succeeded':'payment.recorded',
    'payment_method.attached':'payment_method.attached','payment_method.updated':'payment_method.updated','payment_method.detached':'payment_method.detached',
    'entitlements.active_entitlement_summary.updated':'entitlements.updated',
  }
  const owned=new Set([customer.id,subscription.id,invoice.id,method.id,extra.id])
  const own=e=>owned.has(reference(e.data.object.id))||reference(e.data.object.customer)===customer.id||reference(e.data.previous_attributes?.customer)===customer.id
  const events=new Map(),deadline=Date.now()+90000
  do{
    const listed=await stripe.list('/v1/events',{'created[gte]':started})
    for(const e of listed.data)if(mapping[e.type]&&own(e))events.set(e.id,e)
    if(Object.keys(mapping).every(type=>[...events.values()].some(e=>e.type===type)))break
    if(Date.now()<deadline)await delay(5000)
  }while(Date.now()<deadline)
  const found=new Set([...events.values()].map(e=>e.type))
  receipt.missingTypes=Object.keys(mapping).filter(type=>!found.has(type))
  check(Object.keys(mapping).every(type=>found.has(type)),'stripe_expected_events_missing')
  for(const event of [...events.values()].sort((a,b)=>a.created-b.created||a.id.localeCompare(b.id))){
    phase=`consume:${event.type}`
    const body={customer:local.id,account_ref:account.id,event_ref:event.id,consent:true}
    const [first,second]=await Promise.all([api('webhook.stripe.consume',body),api('webhook.stripe.consume',body)])
    assert.equal(first.id,second.id)
    await api('webhook.dispatch',{})
    const messages=received.filter(e=>e.data.source?.event_ref===event.id)
    assert.equal(messages.length,1);assert.equal(messages[0].id,first.id);assert.equal(messages[0].type,mapping[event.type])
    assert.equal(messages[0].data.custody,'stripe-test-shadow-event')
    assert.equal(messages[0].metadata.find(m=>m.kind==='customer').metadata.app_account_id,`synthetic-nectar-${stripe.run}`)
    assert.ok(!JSON.stringify(messages[0]).includes(`Synthetic changed ${stripe.run}`),'provider names excluded')
    assert.ok(!JSON.stringify(messages[0]).includes(`Synthetic update ${stripe.run}`),'card details excluded')
    const replay=await api('webhook.stripe.consume',body);assert.equal(replay.id,first.id);assert.equal(replay.replayed,true)
    receipt.events.push({stripeType:event.type,stripeEventId:event.id,nectarType:messages[0].type,nectarEventId:first.id,received:1})
  }
  await api('webhook.dispatch',{})
  for(const item of receipt.events)assert.equal(received.filter(e=>e.id===item.nectarEventId).length,1)
  receipt.mappedFamilies=[...found].sort();receipt.status='passed'
}catch(error){receipt.status='failed';receipt.failure={phase,...safeError(error)};process.exitCode=1;console.error('SHADOW_SANDBOX_FAILED',JSON.stringify(receipt.failure))}
finally{
  await h?.close()
  if(clock)try{const deleted=await stripe.request('DELETE',`/v1/test_helpers/test_clocks/${clock}`);check(deleted.deleted===true,'owned_clock_cleanup_failed');receipt.cleanup.clockDeleted=true}catch(error){receipt.status='failed';receipt.cleanup.error=safeError(error);process.exitCode=1}
  for(const [path,id]of [['prices',price?.id],['products',product?.id]])if(id)try{await stripe.request('POST',`/v1/${path}/${id}`,{active:false})}catch(error){receipt.status='failed';receipt.cleanup.error=safeError(error);process.exitCode=1}
  await rm(directory,{recursive:true,force:true});receipt.completedAt=new Date().toISOString();receipt.requestCounts=stripe?.counts
  await mkdir(evidence,{recursive:true});await writeFile(join(evidence,'webhook-shadow-sandbox.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600})
  console.log(`SHADOW_SANDBOX ${receipt.status} events=${receipt.events.length} clockDeleted=${receipt.cleanup.clockDeleted}`)
}
