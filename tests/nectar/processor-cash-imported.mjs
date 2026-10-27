// Original imports and owner takeover use public Worker doors; only Stripe is fake.
import assert from 'node:assert/strict'
import { file } from './harness.mjs'
import { processorCashEdge } from './processor-cash.mjs'
import { collectionCapture, stripeCollectionEdge } from '../fixtures/stripe-collection-edge.mjs'
import { csvRows } from './financial-reports.mjs'

export function importedCashEdge() {
 const base=stripeCollectionEdge(),cash=processorCashEdge(base)
 const balanceTransactions=new Map(),cashCharges=new Map(),payouts=new Map(),payoutMembers=new Map()
 let loseDisable=false
 const readCashCharges=async request=>{
  const listed=await(await cash.fetch(request)).json()
  for(const charge of listed.data){
   charge.balance_transaction=`${charge.id}-balance`
   cashCharges.set(charge.id,charge)
   balanceTransactions.set(charge.balance_transaction,{object:'balance_transaction',id:charge.balance_transaction,source:charge.id,type:'charge',amount:charge.amount,fee:17,net:charge.amount-17,currency:'usd',status:'available',created:charge.created,available_on:charge.created})
  }
  return listed
 }
 const fetch=async request=>{
  const url=new URL(request.url),path=url.pathname.replace('/v1','')
  if(request.method==='GET'&&path==='/customers/synthetic-nectar-1')return Response.json({object:'customer',id:'synthetic-nectar-1',livemode:false,invoice_settings:{default_payment_method:'synthetic-nectar-method'}})
  if(request.method==='GET'&&path==='/charges'&&cash.cashIntents.has(url.searchParams.get('payment_intent')))return Response.json(await readCashCharges(request))
  if(request.method==='GET'&&path.startsWith('/charges/')){
   const intent=[...cash.cashIntents.values()].find(row=>row.latest_charge===path.split('/').at(-1))
   if(intent){const listed=await readCashCharges(new Request(`https://api.stripe.com/v1/charges?payment_intent=${intent.id}`,{headers:request.headers}));return Response.json(listed.data.find(row=>row.id===intent.latest_charge))}
  }
  if(path.startsWith('/payouts/'))return Response.json(payouts.get(path.split('/').at(-1)))
  if(path==='/balance_transactions')return Response.json({object:'list',has_more:false,data:payoutMembers.get(url.searchParams.get('payout')).map(id=>{
   const row=balanceTransactions.get(id);return {...row,source:cashCharges.get(row.source)??payouts.get(row.source)??row.source}
  })})
  if(path.startsWith('/balance_transactions/'))return Response.json(balanceTransactions.get(path.split('/').at(-1)))
  if(request.method==='POST'&&path.startsWith('/invoices/')){
   const form=new URLSearchParams(await request.clone().text())
   assert.deepEqual([...form],[['auto_advance','false']],'Takeover only disables automatic advancement')
   const response=await base.fetch(request)
   if(loseDisable){loseDisable=false;return Response.json({},{status:503})}
   return response
  }
  return cash.fetch(request)
 }
 return {...cash,fetch,imported:base,loseDisableResponse(){loseDisable=true},async cashPayout(intent){
  const charge=(await readCashCharges(new Request(`https://api.stripe.com/v1/charges?payment_intent=${intent.id}`,{headers:{authorization:'Bearer synthetic-nectar-1'}}))).data[0]
  const payout={object:'payout',id:'synthetic-nectar-imported-payout',amount:5983,currency:'usd',livemode:false,automatic:true,status:'paid',balance_transaction:'synthetic-nectar-imported-payout-debit'}
  payouts.set(payout.id,payout)
  balanceTransactions.set(payout.balance_transaction,{object:'balance_transaction',id:payout.balance_transaction,source:payout.id,type:'payout',amount:-5983,fee:0,net:-5983,currency:'usd',status:'available',created:intent.created,available_on:intent.created})
  payoutMembers.set(payout.id,[charge.balance_transaction,payout.balance_transaction])
  const id='synthetic-nectar-imported-payout-event'
  cash.cashEvents.set(id,{object:'event',id,type:'payout.paid',created:intent.created,livemode:false,data:{object:payout}})
  return {id,payout,charge}
 }}
}
let edge
export const harnessOptions=()=>{
 edge=importedCashEdge()
 return {localTime:'2026-10-28T10:00:00Z',stripeFetch:edge.fetch,stripeSecret:'synthetic-nectar-1'}
}
export async function processorCashImportedFlow(h,owner,{cashEdge=edge,keepFinancial=false}={}) {
 const api=(path,body,status)=>h.api(path,owner,body,status),remote='synthetic-nectar-1',account='synthetic-nectar-account'
 const capture=collectionCapture(),files=Object.fromEntries(Object.entries(capture).map(([name,value])=>[name,file(`${name}.json`,JSON.stringify(value),'application/json')]))
 const preview=await api('import.preview',files);assert.deepEqual(preview.rejected,[])
 await api('import.apply',{...files,fingerprint:preview.fingerprint})
 const customer=(await api('customers')).find(row=>row.external_id===remote).id
 const shadow=(await api('shadow')).find(row=>row.customer_id===customer)
 assert.ok(shadow)
 await api('subscription.adopt',{subscription:shadow.id,cutover_start:shadow.earliestCutover,acknowledge_unreconciled:true})
 await api('collection.customer.bind',{customer,account_ref:account,stripe_customer_ref:remote,confirm:true})
 const history=()=>api(`customers/${customer}`),originals=(await history()).incumbentHistory.documents
 const first=originals.find(row=>row.provider_ref==='synthetic-nectar-open-1'),second=originals.find(row=>row.provider_ref==='synthetic-nectar-open-2')
 const nativeBefore=(await api(`invoices?customer=${customer}`)).data.map(row=>row.id)
 const consume=event_ref=>api('processor.event.consume',{account_ref:account,event_ref})
 const paymentEvent=async(intent,type='payment_intent.succeeded')=>{
  const id=`synthetic-nectar-imported-payment-event-${cashEdge.cashEvents.size+1}`
  let object=structuredClone(intent)
  if(type.startsWith('charge.'))object=await(await cashEdge.fetch(new Request(`https://api.stripe.com/v1/charges/${intent.latest_charge}`,{headers:{authorization:'Bearer synthetic-nectar-1'}}))).json()
  if(type==='payment_intent.processing')Object.assign(object,{status:'processing',amount_received:0})
  cashEdge.cashEvents.set(id,{object:'event',id,type,created:intent.created,livemode:false,data:{object}})
  await consume(id);assert.equal((await consume(id)).replayed,true)
 }
 const funding=cashEdge.fund(remote,5000,first.number)
 await consume(funding)
 assert.equal(cashEdge.cashCalls.length,0,'Imported open invoices are ineligible before owner takeover')
 assert.equal((await history()).incumbentHistory.totals.remainingCents,44000)
 await api('access.give',{email:'imported-cash-reader@example.test',name:'Imported cash reader',role:'accountant'})
 const reader=await h.signIn('imported-cash-reader@example.test',{requested:true})
 for(const action of ['prepare','confirm'])await h.api(`processor.cash.imported.${action}`,reader,{},403)
 const prepare=invoice=>api('processor.cash.imported.prepare',{invoice,account_ref:account})
 const prepared=await prepare(first.id)
 assert.equal(prepared.amountCents,11000)
 assert.equal(cashEdge.imported.calls.filter(row=>row.method==='POST').length,0,'Preparation makes no provider write')
 await api('processor.cash.imported.confirm',{...prepared.instructions.confirm,confirm:false},400)
 await api('processor.cash.imported.confirm',{...prepared.instructions.confirm,basis_hash:'synthetic-nectar-stale'},409)
 cashEdge.loseDisableResponse()
 const uncertain=await api('processor.cash.imported.confirm',prepared.instructions.confirm)
 assert.equal(uncertain.status,'disabling')
 const active=await api('processor.cash.imported.confirm',uncertain.instructions.observe)
 assert.equal(active.status,'active')
 await api('imported.collection.prepare',{invoice:first.id},409)
 assert.equal(cashEdge.imported.calls.filter(row=>row.method==='POST').length,1,'A lost disable response recovers using provider reads')
 await consume(cashEdge.event(remote));await consume(funding)
 assert.equal(cashEdge.cashCalls.length,1)
 assert.equal((await history()).incumbentHistory.totals.remainingCents,39000)
 const firstIntent=[...cashEdge.cashIntents.values()][0]
 await paymentEvent(firstIntent,'charge.succeeded');await paymentEvent(firstIntent);await paymentEvent(firstIntent,'payment_intent.processing')
 assert.equal((await history()).incumbentHistory.totals.remainingCents,39000,'Repeated and stale payment events retain the original imported receipt')
 assert.equal(cashEdge.imported.invoices.get(first.provider_ref).status,'open','Imported originals are not silently marked paid')
 cashEdge.loseCashResponse()
 await consume(cashEdge.fund(remote,6000))
 assert.equal((await history()).incumbentHistory.totals.remainingCents,39000,'A lost payment response retains an uncertain claim')
 const secondIntent=[...cashEdge.cashIntents.values()][1],payout=await cashEdge.cashPayout(secondIntent)
 await consume(payout.id);await consume(payout.id)
 const early=(await api(`processor-events?customer=${customer}`)).transactions.find(row=>row.transaction_ref===payout.charge.balance_transaction)
 assert.deepEqual([early.invoice_id,early.payment_id,early.payout_ref,early.amount_cents,early.fee_cents,early.net_cents],[null,null,payout.payout.id,6000,17,5983])
 await paymentEvent(secondIntent,'charge.succeeded')
 await consume(cashEdge.event(remote));await consume(cashEdge.event(remote))
 assert.equal(cashEdge.cashCalls.length,2,'Recovery never creates another payment intent')
 assert.equal((await history()).incumbentHistory.totals.remainingCents,33000)
 assert.equal((await api(`processor-events?customer=${customer}`)).transactions.find(row=>row.transaction_ref===payout.charge.balance_transaction).payout_ref,payout.payout.id,'Later imported payment attribution preserves payout membership')
 assert.equal((await api(`processor-events?customer=${customer}`)).events.filter(row=>row.status==='failed').length,0,'Imported payment events reconcile without false failure alerts')
 // A different original is not adopted merely because another invoice was approved.
 const rejected=await prepare(second.id)
 cashEdge.imported.invoices.get(second.provider_ref).amount_remaining=10000
 await api('processor.cash.imported.confirm',rejected.instructions.confirm,409)
 assert.equal(cashEdge.imported.invoices.get(second.provider_ref).auto_advance,true)
 const typed=(await history()).incumbentHistory.documents.find(row=>row.id===first.id)
 assert.deepEqual([typed.total_cents,typed.paid_cents,typed.remaining_cents],[11000,0,11000],'Captured originals remain immutable')
 assert.deepEqual((await api(`invoices?customer=${customer}`)).data.map(row=>row.id),nativeBefore,'Imported settlements never manufacture native invoices')
 assert.equal((await api('payments')).filter(row=>row.customer_id===customer).length,0,'Imported collections retain their original financial custody')
 for(const [metric,total]of [['collections',11000],['ar',33000],['settlements',10966]]){
  const report=await api(`reports/${metric}?period=2026-10&customer=${customer}`)
  assert.equal(report.totalCents,total)
  assert.equal(report.entries.reduce((sum,row)=>sum+row.amountCents,0),total)
  for(const entry of report.entries){const detail=await api(entry.href.replace('/app/',''));assert.equal(detail.components.reduce((sum,row)=>sum+row.amountCents,0),entry.amountCents)}
  const csv=csvRows(await(await h.raw(`/app/exports/reports/${metric}.csv?period=2026-10&customer=${customer}`,{cookie:owner})).text())
  assert.equal(csv.find(row=>row.source==='TOTAL').amount,(total/100).toFixed(2))
 }
 await api('report.schedule',{enabled:true,day:1})
 await h.advanceClock('2026-11-01T12:00:00Z')
 assert.equal((await h.raw(`/cdn-cgi/local/scheduled?time=${Date.parse('2026-11-01T12:00:00Z')}&cron=${encodeURIComponent('0 14 * * *')}`)).status,200)
 const delivery=(await api('report-schedule')).deliveries[0],frozen=await api(`report-deliveries/${delivery.id}`)
 for(const [metric,total]of [['collections',11000],['ar',33000],['settlements',10966]])assert.equal(frozen.reports.find(row=>row.metric===metric).totalCents,total)
 const request=await api('erasure.request',{customer})
 const verify=new URL(h.mails.at(-1).text.match(/https?:\/\/[^\s"<]+\/erase\/[a-f0-9]{64}/)[0]).pathname
 assert.equal((await h.raw(verify,{form:new URLSearchParams({confirm:'yes'})})).status,200)
 const erased=await api('erasure.approve',{request:request.id,confirm:true})
 assert.ok(erased.receipt.changed.some(row=>row.kind==='nc_processor_cash_imported_applications'))
 for(const [metric,total]of [['collections',11000],['ar',33000],['settlements',10966]])assert.equal((await api(`reports/${metric}?period=2026-10&customer=${customer}`)).totalCents,total)
 assert.deepEqual((await history()).incumbentHistory,{documents:[],records:[]})
 assert.deepEqual((await api('erasure.purge',{})).removed,[])
 if(!keepFinancial){
  await h.advanceClock(`${erased.receipt.retained.until}T12:00:00Z`)
  assert.ok((await api('erasure.purge',{})).removed.includes(request.id))
  const receipt=JSON.parse((await api('erasures')).find(row=>row.id===request.id).receipt_json)
  assert.ok(receipt.removal.records.some(row=>row.kind==='nc_processor_cash_imported_applications'&&row.records===2))
  assert.ok(receipt.removal.records.some(row=>row.kind==='nc_processor_cash_imported_takeovers'&&row.records===2))
 }
 return {customer,invoice:first.id,request:request.id,retainUntil:erased.receipt.retained.until}
}
if(process.argv[1]===new URL(import.meta.url).pathname){
 const {processorSetup}=await import('./processor-events.mjs'),options=harnessOptions(),{h,owner}=await processorSetup(undefined,options)
 try{await processorCashImportedFlow(h,owner);console.log('Imported cash: explicit takeover, source custody, partial settlement, uncertainty and report parity passed')}finally{await h.close()}
}
