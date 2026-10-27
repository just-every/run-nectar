// Fake only the paid network edge. Worker, authentication, D1 and reports are real.
import assert from 'node:assert/strict'
export function processorEdge() {
 const account='synthetic-nectar-account',customerRef='synthetic-nectar-customer',calls=[],events=new Map(),objects=new Map(),transactions=new Map()
 let fail=false
 const list=data=>({object:'list',data,has_more:false})
 const fetch=async request=>{
  const url=new URL(request.url),path=url.pathname.slice(3)
  assert.equal(request.headers.get('authorization'),'Bearer synthetic-nectar-1')
  calls.push({method:request.method,path,query:Object.fromEntries(url.searchParams)})
  assert.equal(request.method,'GET','Event observation never initiates a debit, refund or payout')
  if(path==='/account')return Response.json({object:'account',id:account})
  if(path===`/customers/${customerRef}`)return Response.json({object:'customer',id:customerRef,livemode:false,invoice_settings:{default_payment_method:null}})
  if(path.startsWith('/events/'))return Response.json(events.get(path.split('/').at(-1))??{},{status:events.has(path.split('/').at(-1))?200:404})
  if(fail)return Response.json({},{status:503})
  if(path.startsWith('/balance_transactions/'))return Response.json(transactions.get(path.split('/').at(-1)))
  if(path==='/balance_transactions')return Response.json(list([...transactions.values()]))
  if(path==='/refunds')return Response.json(list([...objects.values()].filter(row=>row.object==='refund'&&row.charge===url.searchParams.get('charge'))))
  const object=objects.get(path.split('/').at(-1))
  if(object)return Response.json(object)
  throw new Error(`Unexpected processor edge request ${path}`)
 }
 const at=Date.parse('2026-10-22T10:00:00Z')/1000
 function seed(invoice,amount=10000,suffix='1') {
  const intent={object:'payment_intent',id:`synthetic-nectar-intent-${suffix}`,customer:customerRef,status:'succeeded',currency:'usd',livemode:false,amount,amount_received:amount,metadata:{nectar_native_invoice:invoice},latest_charge:`synthetic-nectar-charge-${suffix}`}
  const charge={object:'charge',id:intent.latest_charge,customer:customerRef,payment_intent:intent.id,status:'succeeded',paid:true,captured:true,amount,amount_captured:amount,amount_refunded:0,refunded:false,disputed:false,currency:'usd',livemode:false,created:at,metadata:{},balance_transaction:`synthetic-nectar-txn-${suffix}`,payment_method_details:{type:'card'}}
  const transaction={object:'balance_transaction',id:charge.balance_transaction,type:'charge',source:charge.id,amount,fee:320,net:amount-320,currency:'usd',status:'available',created:at,available_on:at+1}
  objects.set(intent.id,intent);objects.set(charge.id,charge);transactions.set(transaction.id,transaction)
  return {intent,charge,transaction}
 }
 const event=(id,type,object,created=at)=>{const value={object:'event',id,type,livemode:false,created,data:{object:structuredClone(object)}};events.set(id,value);return value}
 return {account,customerRef,calls,events,objects,transactions,fetch,seed,event,at,setFailure(value){fail=value}}
}
