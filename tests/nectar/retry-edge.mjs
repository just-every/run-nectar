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
  const failed=rule&&count<rule.recoverAt
  const charge=`synthetic-nectar-retry-charge-${writes.length}`
  Object.assign(intent,{status:failed?'requires_payment_method':'succeeded',amount_received:failed?0:intent.amount,latest_charge:charge})
  if(failed){intent.last_payment_error={code:rule.code,payment_method:{id:method}};intent.payment_method=null}else delete intent.last_payment_error
  base.intents.get(intent.id).value=intent
  base.charges.set(charge,{account:1,value:{object:'charge',id:charge,status:failed?'failed':'succeeded',paid:!failed,captured:!failed,customer:intent.customer,payment_method:method,payment_intent:intent.id,currency:'usd',amount:intent.amount,amount_captured:failed?0:intent.amount,amount_refunded:0,refunded:false,disputed:false,created:instant/1000,livemode:false,balance_transaction:'synthetic-nectar-retry-balance',...(rule?.advice?{outcome:{advice_code:rule.advice}}:{})}})
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
   writes.push({id,at:instant,key:request.headers.get('idempotency-key')})
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
 return {...base,fetch,bank,mandate,writes,delivered,rules,attempts,setTime(at){instant=at;base.capturedAt(new Date(at).toISOString())},lose(){lose=true}}
}
