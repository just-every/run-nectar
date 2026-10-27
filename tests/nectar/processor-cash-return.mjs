import assert from 'node:assert/strict'
import { processorCashEdge } from './processor-cash.mjs'
import { applyPolicy } from './policy-helper.mjs'
import { csvRows } from './financial-reports.mjs'

/** Network edge only. The application still uses real auth, D1, approval,
 * provider requests, cash observation and report routes. */
export function processorCashReturnEdge(base=processorCashEdge()) {
 const customers=new Map(),transactions=new Map(),refunds=new Map(),events=new Map(),calls=[],keys=new Set()
 const at=Date.parse('2026-10-28T10:00:00Z')/1000
 let sequence=0,lose=false,mismatch=false,visible=true
 function movement(customer,amount,type,detail={}){
  const owner=customers.get(customer);assert.ok(owner)
  owner.available+=amount;assert.ok(owner.available>=0)
  const row={object:'customer_cash_balance_transaction',id:`synthetic-nectar-cash-return-movement-${++sequence}`,customer,livemode:false,currency:'usd',net_amount:amount,ending_balance:owner.available,type,created:at,...detail}
  transactions.set(row.id,row);return row
 }
 const page=(rows,url)=>{
  const cursor=url.searchParams.get('starting_after'),start=cursor?rows.findIndex(row=>row.id===cursor)+1:0
  assert.ok(!cursor||start>0)
  return Response.json({object:'list',data:rows.slice(start,start+2),has_more:start+2<rows.length})
 }
 const fetch=async request=>{
  const url=new URL(request.url),path=url.pathname.slice(3),customer=path.match(/^\/customers\/([^/]+)(?:\/(cash_balance|cash_balance_transactions))?$/)
  if(customer&&customers.has(customer[1])){
   assert.equal(request.method,'GET');assert.equal(request.headers.get('authorization'),'Bearer synthetic-nectar-1')
   const row=customers.get(customer[1])
   if(!customer[2])return Response.json({object:'customer',id:customer[1],email:row.email,livemode:false,invoice_settings:{default_payment_method:null}})
   if(customer[2]==='cash_balance')return Response.json({object:'cash_balance',customer:customer[1],livemode:false,available:{usd:row.available},settings:{reconciliation_mode:'manual'}})
   return page([...transactions.values()].filter(row=>row.customer===customer[1]).reverse(),url)
  }
  if(path.startsWith('/events/')&&events.has(path.split('/').at(-1)))return Response.json(events.get(path.split('/').at(-1)))
  if(path==='/refunds'&&request.method==='POST'){
   assert.equal(request.headers.get('authorization'),'Bearer synthetic-nectar-1')
   const form=new URLSearchParams(await request.clone().text()),key=request.headers.get('Idempotency-Key')
   assert.equal(form.get('origin'),'customer_balance');assert.equal(form.get('currency'),'usd')
   for(const field of ['instructions_email','charge','payment_intent','receipt_email'])assert.equal(form.get(field),null,'The approved return uses the existing customer and default provider notice')
   assert.ok(key&&!keys.has(key),'A durable return claim sends at most one provider POST');keys.add(key)
   const id=`synthetic-nectar-cash-return-refund-${refunds.size+1}`,amount=Number(form.get('amount')),customerRef=form.get('customer')
   const refund={object:'refund',id,customer:customerRef,charge:null,payment_intent:null,amount,currency:'usd',status:'requires_action',created:at,metadata:Object.fromEntries([...form].filter(([name])=>name.startsWith('metadata[')).map(([name,value])=>[name.slice(9,-1),value]))}
   assert.ok(customers.has(customerRef));assert.ok(amount>0)
   refunds.set(id,refund);movement(customerRef,-amount,'return_initiated')
   calls.push({method:'POST',path,form:Object.fromEntries(form),key})
   if(lose){lose=false;return Response.json({error:{type:'api_error'}},{status:503})}
   if(mismatch){mismatch=false;return Response.json({...refund,amount:amount+1})}
   return Response.json(refund)
  }
  if(path==='/refunds'&&request.method==='GET'){
   calls.push({method:'GET',path});return page(visible?[...refunds.values()].reverse():[],url)
  }
  if(path.startsWith('/refunds/')&&refunds.has(path.split('/').at(-1))){calls.push({method:'GET',path});return Response.json(refunds.get(path.split('/').at(-1)))}
  return base.fetch(request)
 }
 return {...base,fetch,returnCalls:calls,returnRefunds:refunds,returnCustomers:customers,
  addReturnCustomer(ref,email='synthetic-nectar-return@example.test'){customers.set(ref,{available:0,email})},
  fundReturnCustomer(customer,amount){return movement(customer,amount,'funded',{funded:{bank_transfer:{type:'us_bank_transfer',reference:'synthetic-nectar-unmatched-return'}}})},
  returnEvent(customer){const id=`synthetic-nectar-cash-return-event-${events.size+1}`;events.set(id,{object:'event',id,type:'cash_balance.funds_available',livemode:false,created:at,data:{object:{object:'cash_balance',customer}}});return id},
  refundEvent(id){const refund=refunds.get(id),event=`synthetic-nectar-cash-return-observed-${events.size+1}`;events.set(event,{object:'event',id:event,type:'refund.updated',livemode:false,created:at,data:{object:structuredClone(refund)}});return event},
  loseReturn(){lose=true},mismatchReturn(){mismatch=true},returnVisibility(value){visible=value},
  setReturnStatus(id,status){const refund=refunds.get(id);assert.ok(refund);if(['failed','canceled'].includes(status)&&!['failed','canceled'].includes(refund.status))movement(refund.customer,refund.amount,'return_canceled');refund.status=status}
 }
}

export async function processorCashReturnFlow(h,owner,{cashReturnEdge:edge,onState=async()=>{},prepareReturn}) {
 const api=(path,body,status)=>h.api(path,owner,body,status),account='synthetic-nectar-native-account-1'
 await h.advanceClock('2026-10-28T10:00:00Z')
 await api('access.give',{email:'synthetic-nectar-return-finance@example.test',name:'Synthetic cash return finance',role:'finance'})
 const finance=await h.signIn('synthetic-nectar-return-finance@example.test',{requested:true})
 await api('access.give',{email:'synthetic-nectar-return-accountant@example.test',name:'Synthetic cash return accountant',role:'accountant'})
 const reader=await h.signIn('synthetic-nectar-return-accountant@example.test',{requested:true})
 const agent={bearer:(await api('credential.issue',{name:'Synthetic cash return agent',scopes:['prepare']})).key}
 await applyPolicy(h,owner,'credit.policy',{two_person_above:'1000'})
 const customer=(await api('customer.create',{external_id:'synthetic-nectar-cash-return-1',name:'Synthetic unapplied cash owner',billing_email:'synthetic-nectar-return@example.test'})).id
 const remote='synthetic-nectar-return-unapplied-customer';edge.addReturnCustomer(remote)
 await api('collection.customer.bind',{customer,account_ref:account,stripe_customer_ref:remote,confirm:true})
 edge.fundReturnCustomer(remote,600000)
 const event=edge.returnEvent(remote);await api('processor.event.consume',{account_ref:account,event_ref:event})
 const quote=amount=>api('processor.cash.return.preview',{customer,account_ref:account,currency:'usd',amount})
 const prepare=q=>prepareReturn?prepareReturn({customer,account_ref:account,currency:'usd',amount:String(q.amountCents/100),basis:q.basis,confirm:true}):api('processor.cash.return.prepare',{customer,account_ref:account,currency:'usd',amount:String(q.amountCents/100),basis:q.basis,confirm:true})
 const execute=(r,who=owner,status)=>h.api('processor.cash.return.execute',who,{request:r.id,basis:r.basis,confirm:true},status)
 const writes=()=>edge.returnCalls.filter(row=>row.method==='POST').length
 const high=await quote('1500');assert.equal(high.needsSecondApprover,true)
 const beforeRefusal=await api('audit'),mails=h.mails.length
 await api('processor.cash.return.execute',{customer,account_ref:account,currency:'usd',amount:'1500',basis:high.basis,confirm:true},400)
 for(const who of [reader,agent,undefined])for(const action of ['prepare','execute','reconcile'])await h.api(`processor.cash.return.${action}`,who,{},who?403:401)
 await h.api('processor.cash.return.prepare',finance,{},403)
 assert.equal(writes(),0);assert.deepEqual(await api('audit'),beforeRefusal)
 const prepared=await prepare(high),ownerId=(await api('me')).id,financeId=(await h.api('me',finance)).id
 assert.deepEqual(await prepare(high),prepared,'Duplicate preparation changes neither approval nor source')
 await execute(prepared,owner,409);assert.equal(writes(),0)
 const returned=await execute(prepared,finance)
 assert.deepEqual([returned.status,returned.amountCents,returned.cashAmountCents,returned.preparedBy,returned.approvedBy],['requires_action',150000,0,ownerId,financeId])
 assert.equal(writes(),1);await execute(prepared,finance);assert.equal(writes(),1)
 assert.equal((await api(`reports/refunds?period=2026-10&customer=${customer}`)).totalCents,0,'Bank details requested is not successful cash return')
 let ledger=await api(`processor-events?customer=${customer}`)
 assert.equal(ledger.cashBalances.find(row=>row.currency==='usd').amount_cents,450000)
 edge.setReturnStatus(returned.refundRef,'pending')
 const pending=await api('processor.cash.return.reconcile',{request:prepared.id});assert.deepEqual([pending.status,pending.cashAmountCents],['pending',0]);assert.equal(writes(),1)
 edge.setReturnStatus(returned.refundRef,'succeeded')
 const succeededEvent=edge.refundEvent(returned.refundRef)
 await api('processor.event.consume',{account_ref:account,event_ref:succeededEvent});await api('processor.event.consume',{account_ref:account,event_ref:succeededEvent})
 const report=await api(`reports/refunds?period=2026-10&customer=${customer}`)
 assert.equal(report.totalCents,-150000);assert.equal(report.entries.length,1)
 const detail=await api(report.entries[0].href.replace('/app/',''))
 assert.equal(detail.invoice,null);assert.equal(detail.cashReturn.refundRef,returned.refundRef);assert.equal(detail.components.reduce((sum,row)=>sum+row.amountCents,0),-150000)
 const csv=csvRows(await(await h.raw(`/app/exports/reports/refunds.csv?period=2026-10&customer=${customer}`,{cookie:owner})).text())
 assert.equal(csv.find(row=>row.source==='TOTAL').amount,"'-1500.00")
 const low=await prepare(await quote('900')),lowOutcome=await execute(low)
 assert.deepEqual([lowOutcome.status,lowOutcome.preparedBy,lowOutcome.approvedBy],['requires_action',ownerId,ownerId]);assert.equal(writes(),2)
 edge.setReturnStatus(lowOutcome.refundRef,'canceled');await api('processor.cash.return.reconcile',{request:low.id})
 const stale=await prepare(await quote('100'));edge.fundReturnCustomer(remote,100)
 await execute(stale,owner,409);assert.equal(writes(),2)
 const changed=await prepare(await quote('100'));await execute(stale,owner,409)
 await applyPolicy(h,owner,'credit.policy',{two_person_above:'500'})
 await execute(changed,owner,409);assert.equal(writes(),2)
 const lost=await prepare(await quote('100'));edge.loseReturn()
 const unknown=await execute(lost);assert.equal(unknown.status,'uncertain');assert.equal(writes(),3)
 await execute(lost);assert.equal(writes(),3)
 edge.returnVisibility(false);await api('processor.cash.return.reconcile',{request:lost.id},409);assert.equal(writes(),3)
 edge.returnVisibility(true)
 const recovered=await api('processor.cash.return.reconcile',{request:lost.id});assert.equal(recovered.status,'requires_action');assert.equal(writes(),3)
 edge.setReturnStatus(recovered.refundRef,'failed');await api('processor.cash.return.reconcile',{request:lost.id})
 const mismatch=await prepare(await quote('100'));edge.mismatchReturn()
 assert.equal((await execute(mismatch)).status,'uncertain');assert.equal(writes(),4)
 const corrected=await api('processor.cash.return.reconcile',{request:mismatch.id});assert.equal(corrected.amountCents,10000);assert.equal(corrected.status,'requires_action');assert.equal(writes(),4)
 ledger=await api(`processor-events?customer=${customer}`)
 assert.equal(ledger.cashBalances.find(row=>row.currency==='usd').amount_cents,edge.returnCustomers.get(remote).available)
 assert.equal(h.mails.length,mails,'Only the explicitly approved provider request owns its normal customer notice')
 const audit=await api('audit'),claim=audit.find(row=>row.action==='processor.cash.return.claim'&&row.subject===prepared.id)
 const custody=typeof claim.detail==='string'?JSON.parse(claim.detail):claim.detail
 assert.deepEqual([custody.preparedBy,custody.approvedBy,custody.amountCents],[ownerId,financeId,150000])
 await api('report.schedule',{enabled:true,day:1})
 await h.advanceClock('2026-11-01T12:00:00Z')
 const tick=await h.raw(`/cdn-cgi/local/scheduled?time=${Date.parse('2026-11-01T12:00:00Z')}&cron=${encodeURIComponent('0 14 * * *')}`)
 assert.equal(tick.status,200)
 const delivery=(await api('report-schedule')).deliveries.find(row=>row.period==='2026-10')
 assert.ok(delivery)
 const snapshot=await api(`report-deliveries/${delivery.id}`)
 const frozen=snapshot.sourceEvidence.find(row=>row.metric==='refunds'&&row.detail.cashReturn?.request===prepared.id)
 assert.ok(frozen);assert.equal(frozen.detail.totalCents,-150000);assert.equal(frozen.detail.cashReturn.refundRef,returned.refundRef)
 assert.equal(snapshot.sourceEvidence.filter(row=>row.metric==='refunds'&&row.detail.cashReturn?.customerId===customer).reduce((sum,row)=>sum+row.detail.totalCents,0),-150000)
 await h.advanceClock('2026-10-28T10:00:00Z')
 await api('report.schedule',{enabled:false,day:1})
 await onState({customer,remote,request:prepared.id,refund:returned.refundRef,status:'succeeded'})
 return {customer,remote,requests:[prepared,low,stale,changed,lost,mismatch]}
}
