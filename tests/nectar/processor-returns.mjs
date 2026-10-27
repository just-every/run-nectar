import assert from 'node:assert/strict'

// Part of processorEventFlow: real public doors, fake only the Stripe edge.
export async function processorReturnFlow(h,owner,edge) {
 const api=(path,body,status)=>h.api(path,owner,body,status)
 const customer=(await api('customer.create',{external_id:'synthetic-nectar-returns',name:'Synthetic return customer',billing_email:'synthetic-nectar-returns@example.test'})).id
 const remote='synthetic-nectar-return-customer'
 edge.objects.set(remote,{object:'customer',id:remote,livemode:false,invoice_settings:{default_payment_method:null}})
 await api('collection.customer.bind',{customer,account_ref:edge.account,stripe_customer_ref:remote,confirm:true})
 const cases=[['R01','insufficient_funds'],['R09','insufficient_funds'],['R02','bank_account_closed'],['R03','bank_account_invalid_details'],['R04','bank_account_invalid_details'],['R10','debit_not_authorized'],[null,'insufficient_funds'],['R1','insufficient_funds']]
 const sources=[]
 for(const [index,[raw,normalized]] of cases.entries()) {
  const charge=(await api('charge.add',{customer,amount:'12',description:'Synthetic network return',taxable:false,effective_date:'2026-10-22'})).charge
  const invoice=(await api('invoice.manual',{customer,charges:[charge],service_date:'2026-10-22'})).id
  await api('invoice.approve',{invoice,acknowledge:true});await api('invoice.finalise',{invoice,issue_date:'2026-10-22'})
  const source=edge.seed(invoice,1200,`return-${index}`)
  Object.assign(source.intent,{customer:remote,status:'requires_payment_method',amount_received:0,last_payment_error:{code:normalized,payment_method:{type:'us_bank_account'},...(raw?{network_decline_code:raw}:{})}})
  Object.assign(source.charge,{customer:remote,status:'failed',paid:false,captured:false,amount_captured:0,failure_code:normalized,outcome:{network_decline_code:raw},payment_method_details:{type:'us_bank_account'},failure_balance_transaction:`synthetic-nectar-return-txn-${index}`})
  if(raw==='R09')delete source.charge.outcome.network_decline_code
  if(raw==='R04')delete source.intent.last_payment_error.network_decline_code
  source.transaction.fee=10;source.transaction.net=1190
  edge.transactions.set(source.charge.failure_balance_transaction,{object:'balance_transaction',id:source.charge.failure_balance_transaction,type:'payment_failure_refund',source:source.charge.id,amount:-1200,fee:0,net:-1200,currency:'usd',status:'available',created:edge.at+30+index,available_on:edge.at+30+index})
  const events=[edge.event(`synthetic-nectar-return-charge-${index}`,'charge.failed',source.charge,edge.at+30+index),edge.event(`synthetic-nectar-return-intent-${index}`,'payment_intent.payment_failed',source.intent,edge.at+30+index)]
  // A stale envelope cannot override current provider facts.
  if(raw==='R09')events[0].data.object.outcome.network_decline_code='R01'
  if(index%2)events.reverse()
  for(const [arrival,event] of [...events,...events.toReversed()].entries()){
   await api('processor.event.consume',{account_ref:edge.account,event_ref:event.id})
   if(arrival===0){
    const first=(await api(`processor-events?customer=${customer}`)).objects.find(row=>row.object_ref===source.charge.id)
    assert.deepEqual([first?.kind,first?.code],['ach_return',/^R\d{2}$/.test(raw??'')?raw:null],'Either event independently observes the current verified bank return')
   }
  }
  const record=await api(`invoices/${invoice}`),ledger=await api(`processor-events?customer=${customer}`)
  assert.deepEqual([record.balanceCents,record.allocations.length,record.processorReversals.length],[1200,0,0],'Failed bank funds never become allocated cash')
  const returned=ledger.objects.find(row=>row.object_ref===source.charge.id),intent=ledger.objects.find(row=>row.object_ref===source.intent.id)
  assert.deepEqual([returned.kind,returned.code,intent.code],['ach_return',/^R\d{2}$/.test(raw??'')?raw:null,normalized],'Raw NACHA identity is retained separately from the normalized provider failure')
  assert.equal(ledger.events.filter(row=>events.some(event=>event.id===row.event_ref)).length,2,'Both genuine event identities are deduplicated')
  assert.deepEqual(ledger.transactions.filter(row=>row.source_ref===source.charge.id).map(row=>[row.amount_cents,row.fee_cents,row.net_cents]).sort((a,b)=>a[0]-b[0]),[[-1200,0,-1200],[1200,10,1190]],'Failure balance movement and original fee reconcile exactly once')
  sources.push({invoice,...source,raw,normalized})
 }
 const ledger=await api(`processor-events?customer=${customer}`)
 assert.equal(ledger.objects.filter(row=>row.kind==='ach_return').length,cases.length)
 assert.equal(edge.calls.filter(row=>row.method!=='GET').length,0,'Return event intake never initiates a retry or any other provider mutation')
 return {customer,sources}
}
