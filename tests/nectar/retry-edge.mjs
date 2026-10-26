// Only the processor network edge supplies known failure outcomes.
import { nativeCollectionEdge } from './native-collection.mjs'
export function retryEdge(){
 const base=nativeCollectionEdge(),rules=new Map(),attempts=new Map(),writes=[],delivered=[]
 let instant=Date.parse('2026-10-22T10:00:00Z'),lose=false
 const bank='synthetic-nectar-retry-bank',mandate='synthetic-nectar-retry-mandate'
 base.customers.get('synthetic-nectar-native-customer-3').method=bank
 const apply=(intent,form)=>{
  const method=form.get('payment_method'),rule=rules.get(method),count=(attempts.get(intent.id)??0)+1;attempts.set(intent.id,count)
  intent.payment_method=method
  if(rule?.authenticate&&form.get('off_session')==='false'){
   Object.assign(intent,{status:'requires_action',amount_received:0,next_action:{type:'redirect_to_url',redirect_to_url:{url:rule.redirect??`https://hooks.stripe.com/redirect/authenticate/${intent.id}`,return_url:form.get('return_url')}}})
   delete intent.last_payment_error
   base.intents.get(intent.id).value=intent
   return intent
  }
  const failed=rule&&count<rule.recoverAt
  const charge=`synthetic-nectar-retry-charge-${writes.length}`
  Object.assign(intent,{status:failed?'requires_payment_method':'succeeded',amount_received:failed?0:intent.amount,latest_charge:charge})
  if(failed){intent.last_payment_error={code:rule.declineCode?'card_declined':rule.code,...(rule.declineCode?{decline_code:rule.declineCode}:{}),payment_method:{id:method}};intent.payment_method=null}else delete intent.last_payment_error
  base.intents.get(intent.id).value=intent
  base.charges.set(charge,{account:1,value:{object:'charge',id:charge,status:failed?'failed':'succeeded',paid:!failed,captured:!failed||method===bank,customer:intent.customer,payment_method:method,payment_intent:intent.id,currency:'usd',amount:intent.amount,amount_captured:failed?0:intent.amount,amount_refunded:0,refunded:false,disputed:false,created:instant/1000,livemode:false,balance_transaction:'synthetic-nectar-retry-balance',...(rule?.advice?{outcome:{advice_code:rule.advice}}:{})}})
  return intent
 }
 const fetch=async request=>{
  const url=new URL(request.url),path=url.pathname,form=request.method==='POST'?new URLSearchParams(await request.clone().text()):null
  if(path===`/v1/payment_methods/${bank}`)return Response.json({object:'payment_method',id:bank,type:'us_bank_account',customer:'synthetic-nectar-native-customer-3',livemode:false,us_bank_account:{bank_name:'Synthetic bank',last4:'6789',account_type:'checking'}})
  if(path===`/v1/mandates/${mandate}`)return Response.json({object:'mandate',id:mandate,status:'active',type:'multi_use',livemode:false,payment_method:bank})
  if(path.startsWith('/v1/charges/'))return Response.json(base.charges.get(path.split('/').at(-1))?.value??{})
  if(path.startsWith('/v1/balance_transactions/'))return Response.json({object:'balance_transaction',id:path.split('/').at(-1),type:'payment',status:'available',source:[...base.charges.values()].at(-1).value.id,amount:10000,currency:'usd',available_on:instant/1000})
  if(request.method==='POST'&&path.match(/^\/v1\/payment_intents\/[^/]+\/confirm$/)){
   const id=path.split('/').at(-2),intent=structuredClone(base.intents.get(id).value)
   writes.push({id,at:instant,key:request.headers.get('idempotency-key'),form:Object.fromEntries(form)})
   const result=apply(intent,form)
   if(lose){lose=false;return new Response(null,{status:503})}
   return Response.json(result)
  }
  const response=await base.fetch(request)
  if(request.method==='POST'&&path==='/v1/payment_intents'&&response.ok){
   const intent=await response.json();writes.push({id:intent.id,at:instant,key:request.headers.get('idempotency-key')})
   base.charges.delete(intent.latest_charge)
   return Response.json(apply(intent,form))
  }
  return response
 }
 return {...base,fetch,bank,mandate,writes,delivered,rules,attempts,authenticate(id,success=true){
  const intent=base.intents.get(id).value,method=intent.payment_method
  const charge=`synthetic-nectar-auth-charge-${base.charges.size}`
  Object.assign(intent,{status:success?'succeeded':'requires_payment_method',amount_received:success?intent.amount:0,latest_charge:charge})
  delete intent.next_action
  if(success)delete intent.last_payment_error
  else{intent.payment_method=null;intent.last_payment_error={code:'authentication_required',payment_method:{id:method}}}
  base.charges.set(charge,{account:1,value:{object:'charge',id:charge,status:success?'succeeded':'failed',paid:success,captured:success,customer:intent.customer,payment_method:method,payment_intent:id,currency:'usd',amount:intent.amount,amount_captured:success?intent.amount:0,amount_refunded:0,refunded:false,disputed:false,created:instant/1000,livemode:false}})
 },setTime(at){instant=at;base.capturedAt(new Date(at).toISOString())},lose(){lose=true}}
}
