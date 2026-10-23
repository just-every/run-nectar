import { NectarBillingApp } from '../../examples/stripe-switch/nectar.mjs'
import assert from 'node:assert/strict'
import { file } from './harness.mjs'
const account='synthetic-nectar-shadow-account',customer='synthetic-nectar-shadow-customer',sub='synthetic-nectar-shadow-subscription',price='synthetic-nectar-shadow-price',item='synthetic-nectar-shadow-item'
let source,requests,drop=false
const initial=()=>({id:sub,object:'subscription',customer,livemode:false,status:'active',start_date:Date.parse('2026-09-01')/1000,billing_cycle_anchor:Date.parse('2026-09-01')/1000,trial_end:null,end_date:null,cancel_at:null,canceled_at:null,ended_at:null,cancel_at_period_end:false,collection_method:'charge_automatically',current_period_end:Date.parse('2026-11-01')/1000,pause_collection:null,metadata:{},discounts:[],items:{object:'list',has_more:false,data:[{id:item,price:{id:price},quantity:2}]}})
export const harnessOptions=()=>{
 source=initial();requests=[];drop=false
 return {stripeSecret:'synthetic-nectar-1',stripeFetch:async request=>{
  const url=new URL(request.url),fields=request.method==='POST'?new URLSearchParams(await request.text()):null
  requests.push({method:request.method,path:url.pathname,fields:fields?Object.fromEntries(fields):null,key:request.headers.get('Idempotency-Key')})
  if(url.pathname==='/v1/account')return Response.json({id:account,object:'account'})
  if(url.pathname===`/v1/subscriptions/${sub}`){
   if(fields){
    assert.match(request.headers.get('Idempotency-Key'),/^nectar-shadow-[a-f0-9-]+$/)
    if(fields.has('items[0][id]')){assert.equal(fields.get('items[0][id]'),item);assert.equal(fields.get('proration_behavior'),'none');source.items.data[0].quantity=Number(fields.get('items[0][quantity]'))}
    if(fields.has('cancel_at_period_end'))source.cancel_at_period_end=fields.get('cancel_at_period_end')==='true'
    source.metadata.nectar_shadow_change=fields.get('metadata[nectar_shadow_change]')
    if(drop){drop=false;throw new Error('synthetic-nectar-response-lost-after-write')}
   }
   return Response.json(source)
  }
  if(url.pathname==='/v1/invoices/create_preview'){
   assert.equal(fields.get('customer'),customer);assert.equal(fields.get('subscription'),sub)
   return Response.json({id:'synthetic-nectar-preview',object:'invoice',livemode:false,customer,currency:'usd',subtotal:source.items.data[0].quantity*2500,total:source.items.data[0].quantity*2500,amount_due:source.items.data[0].quantity*2500,customer_email:'Private source contact excluded'})
  }
  throw new Error('unexpected Stripe shadow app request')
 }}
}
export async function stripeAppFlow(h,owner,{onState=async()=>{}}={}){
 const api=(path,body,status)=>h.api(path,owner,body,status)
 await api('business.configure',{revision:(await api('business')).revision,legal_name:'Synthetic shadow app business',timezone:'UTC',invoice_prefix:'SHADOW',payment_terms_days:30})
 await h.advanceClock('2026-10-20T12:00:00Z')
 const lists={customers:[{id:customer,object:'customer',name:'Synthetic shadow customer',email:'synthetic-shadow@example.test',currency:'usd',tax_exempt:'none'}],products:[{id:'synthetic-nectar-shadow-product',object:'product',name:'Shadow seats',active:true}],prices:[{id:price,object:'price',product:'synthetic-nectar-shadow-product',currency:'usd',unit_amount:2500,unit_amount_decimal:'2500',billing_scheme:'per_unit',recurring:{interval:'month',interval_count:1,usage_type:'licensed'},active:true}],subscriptions:[source]}
 const manifest={source:'stripe',captured_at:'2026-10-20T12:00:00Z',api_version:'2025-09-30.clover',files:Object.fromEntries(Object.entries(lists).map(([name,data])=>[name,{endpoint:`/v1/${name}`,count:data.length,has_more:false}]))}
 const files=Object.fromEntries(Object.entries({manifest,...Object.fromEntries(Object.entries(lists).map(([name,data])=>[name,{object:'list',has_more:false,data}]))}).map(([name,value])=>[name,file(`${name}.json`,JSON.stringify(value),'application/json')]))
 const preview=await api('import.preview',files);assert.deepEqual(preview.rejected,[])
 assert.equal((await api('import.apply',{...files,fingerprint:preview.fingerprint})).state,'completed')
 const local=(await api('customers')).find(c=>c.external_id===customer),subscription=(await api(`customers/${local.id}`)).subscriptions[0]
 let items=(await api(`subscriptions/${subscription.id}`)).items
 const original=items.find(i=>i.provider_ref===item)
 const app=new NectarBillingApp(api)
 const postCount=()=>requests.filter(r=>r.method==='POST'&&r.path.startsWith('/v1/subscriptions/')).length
 const prepare=body=>api('shadow.app.prepare',{subscription:subscription.id,account_ref:account,...body})
 const change=await prepare({item:original.id,quantity:4})
 assert.equal(postCount(),0,'preparation only reads the previous biller')
 await api('shadow.app.confirm',{change:change.id},400)
 drop=true
 const confirmed=await api('shadow.app.confirm',{change:change.id,confirm:true})
 assert.equal(confirmed.status,'uncertain');assert.equal(postCount(),1)
 assert.equal(source.items.data[0].quantity,4,'Stripe accepted the quantity update before its response was lost')
 assert.equal((await api(`subscriptions/${subscription.id}`)).items.find(i=>i.effective_to===null).quantity,2,'unconfirmed source state never changes local billing')
 await api('shadow.app.confirm',{change:change.id,confirm:true},409);assert.equal(postCount(),1)
 const blocked=await h.raw('/api/nectar/subscription.adopt',{cookie:owner,body:{subscription:subscription.id,cutover_start:'2026-11-01',acknowledge_unreconciled:true}})
 assert.equal(blocked.status,409);assert.match((await blocked.json()).error,/shadow_change_unconfirmed/)
 await onState({label:'uncertain',customer:local.id,subscription:subscription.id})
 const restored=await api('shadow.app.reconcile',{change:change.id})
 assert.equal(restored.status,'applied');assert.equal(postCount(),1,'reconciliation is GET-only')
 items=(await api(`subscriptions/${subscription.id}`)).items
 assert.equal(items.find(i=>i.id===original.id).quantity,2,'original dated quantity retained')
 assert.equal(items.find(i=>i.id===original.id).effective_to,'2026-10-20')
 assert.equal(items.find(i=>i.effective_to===null).quantity,4)
 const again=await api('shadow.app.confirm',{change:change.id,confirm:true});assert.equal(again.status,'applied');assert.equal(postCount(),1)
 const quote=await app.invoicePreview({subscription:subscription.id,account_ref:account})
 assert.equal(quote.totalCents,10000);assert.equal(quote.source,'stripe-test-preview');assert.ok(!JSON.stringify(quote).includes('Private'))
 const later=await prepare({cancel_at_period_end:true})
 assert.equal((await api('shadow.app.confirm',{change:later.id,confirm:true})).status,'applied')
 assert.equal((await api(`subscriptions/${subscription.id}`)).end_date,'2026-11-01')
 assert.equal(source.cancel_at_period_end,true)
 await onState({label:'cancel-at-period-end',customer:local.id,subscription:subscription.id})
 // A stale review never sends; wrong accounts and unconfirmed input refuse.
 const resume=await prepare({cancel_at_period_end:false})
 source.status='past_due'
 const before=postCount();await api('shadow.app.confirm',{change:resume.id,confirm:true},409);assert.equal(postCount(),before)
 source.status='active'
 await prepare({cancel_at_period_end:'invalid'}).then(()=>assert.fail('invalid flag accepted'),error=>assert.match(error.message,/invalid_cancel_at_period_end/))
 await api('shadow.app.preview',{subscription:subscription.id,account_ref:'synthetic-nectar-wrong-account'},409)
 assert.equal((await api('shadow.app.confirm',{change:resume.id,confirm:true})).status,'applied')
 await api('subscription.adopt',{subscription:subscription.id,cutover_start:'2026-11-01',acknowledge_unreconciled:true})
 const sourceCalls=requests.length
 const adopted=await app.invoicePreview({subscription:subscription.id,account_ref:account})
 assert.equal(adopted.source,'nectar-preview');assert.equal(adopted.totalCents,quote.totalCents);assert.equal(requests.length,sourceCalls,'the same app preview call switches to Nectar after adoption')
 await api('shadow.app.prepare',{subscription:subscription.id,account_ref:account,cancel_at_period_end:true},409)
 await onState({label:'adopted-native-preview',customer:local.id,subscription:subscription.id})
 const agent={bearer:(await api('credential.issue',{name:'Shadow app agent',scopes:['prepare']})).key}
 for(const action of ['shadow.app.prepare','shadow.app.confirm','shadow.app.reconcile','shadow.app.preview','app.invoice.preview'])await h.api(action,agent,{},403)
 assert.ok((await api('audit')).some(a=>a.action==='shadow.app.confirm'&&JSON.parse(a.detail).confirm===true))
 console.log('stripeAppFlow: explicit source write, lost-response GET recovery, cutover fence, dated quantity mirror, exact Stripe quote, cancellation and stale/role/account refusal passed')
 return {customer:local.id,subscription:subscription.id}
}
