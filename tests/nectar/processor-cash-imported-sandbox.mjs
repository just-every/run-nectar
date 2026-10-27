// Executed only by the held-key sandbox parent. Provider facts remain genuine.
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { file } from './harness.mjs'
import { reference, safeError } from './stripe-sandbox-client.mjs'

export async function proveImportedCash(stripe,h,owner,account) {
 assert.equal(account.country,'US')
 const api=(path,body,status)=>h.api(path,owner,body,status),started=Math.floor(Date.now()/1000)-5
 const cleanup=[],receipts=[]
 let remote,original,failure
 async function eventFor(type,id) {
  for(let attempt=0;attempt<8;attempt++){
   const listed=await stripe.request('GET','/v1/events',{type,'created[gte]':started,limit:100})
   assert.equal(listed.object,'list');assert.equal(listed.has_more,false,'sandbox_imported_event_page_limit')
   const event=listed.data.find(row=>row.data?.object?.id===id||reference(row.data?.object?.customer)===id)
   if(event)return event
   await delay(1000)
  }
  throw Object.assign(new Error('sandbox_imported_event_unavailable'),{code:'sandbox_imported_event_unavailable'})
 }
 const ingest=event=>api('processor.event.consume',{account_ref:account.id,event_ref:event.id})
 try {
  remote=await stripe.request('POST','/v1/customers',{name:`Synthetic Nectar imported cash ${stripe.run}`,
   'cash_balance[settings][reconciliation_mode]':'manual','metadata[nectar_run]':stripe.run})
  assert.equal(remote.livemode,false)
  original=await stripe.request('POST','/v1/invoices',{customer:remote.id,currency:'usd',collection_method:'send_invoice',days_until_due:30,auto_advance:false,
   'automatic_tax[enabled]':false,'metadata[nectar_run]':stripe.run})
  await stripe.request('POST','/v1/invoiceitems',{customer:remote.id,invoice:original.id,currency:'usd',amount:25000,description:'Synthetic existing receivable'})
  await stripe.request('POST',`/v1/invoices/${original.id}/finalize`,{auto_advance:false})
  original=await stripe.request('GET',`/v1/invoices/${original.id}`)
  if(original.lines.has_more)original.lines=await stripe.list(`/v1/invoices/${original.id}/lines`)
  assert.deepEqual([original.status,original.total,original.amount_paid,original.amount_remaining,original.auto_advance],['open',25000,0,25000,false])
  assert.ok(original.number);assert.equal(original.lines.has_more,false)
  const funding=await stripe.request('POST',`/v1/test_helpers/customers/${remote.id}/fund_cash_balance`,{amount:30000,currency:'usd',reference:original.number})
  assert.deepEqual([funding.type,funding.net_amount],['funded',30000])
  const beforeImport=await stripe.request('GET',`/v1/customers/${remote.id}/cash_balance`)
  assert.equal(beforeImport.settings.reconciliation_mode,'manual');assert.equal(beforeImport.available.usd,30000)
  // Scope is this owned customer and original only. Empty collections assert no
  // owned catalog or subscriptions; no synthetic provider objects enter import.
  const currentCustomer=await stripe.request('GET',`/v1/customers/${remote.id}`)
  const list=(url,data)=>({object:'list',url,has_more:false,data})
  const capture={customers:list('/v1/customers',[currentCustomer]),products:list('/v1/products',[]),prices:list('/v1/prices',[]),
   subscriptions:list('/v1/subscriptions',[]),invoices:list('/v1/invoices',[original])}
  capture.manifest={source:'stripe',captured_at:new Date().toISOString(),api_version:stripe.apiVersion,
   coverage:'Only this journey-owned customer and standalone original invoice; no catalog or subscription objects were created.',
   files:Object.fromEntries(Object.entries(capture).map(([name,value])=>[name,{endpoint:value.url,count:value.data.length,has_more:false}]))}
  const files=Object.fromEntries(Object.entries(capture).map(([name,value])=>[name,file(`${name}.json`,JSON.stringify(value),'application/json')]))
  const preview=await api('import.preview',files)
  assert.deepEqual(preview.rejected,[]);assert.equal(preview.create.invoice,1)
  const imported=await api('import.apply',{...files,fingerprint:preview.fingerprint})
  assert.equal((await api('import.apply',{...files,fingerprint:preview.fingerprint})).job,imported.job)
  const customer=(await api('customers')).find(row=>row.external_id===remote.id)
  assert.ok(customer)
  const history=()=>api(`customers/${customer.id}`)
  const source=(await history()).incumbentHistory.documents.find(row=>row.provider_ref===original.id)
  assert.deepEqual([source.total_cents,source.paid_cents,source.remaining_cents],[25000,0,25000])
  await api('collection.customer.bind',{customer:customer.id,account_ref:account.id,stripe_customer_ref:remote.id,confirm:true})
  const prepared=await api('processor.cash.imported.prepare',{invoice:source.id,account_ref:account.id})
  const approved=await api('processor.cash.imported.confirm',prepared.instructions.confirm)
  assert.equal(approved.status,'active')
  assert.equal((await stripe.request('GET',`/v1/invoices/${original.id}`)).auto_advance,false)
  const day=new Date().toISOString().slice(0,10),period=day.slice(0,7)
  const line=await api('charge.add',{customer:customer.id,amount:'50',description:'Synthetic native receivable',taxable:false,effective_date:day})
  const native=(await api('invoice.manual',{customer:customer.id,charges:[line.charge],service_date:day})).id
  await api('invoice.approve',{invoice:native,acknowledge:true});await api('invoice.finalise',{invoice:native,issue_date:day})
  const fundingEvent=await eventFor('cash_balance.funds_available',remote.id)
  await ingest(fundingEvent)
  assert.equal((await history()).incumbentHistory.totals.remainingCents,0)
  assert.equal((await api(`invoices/${native}`)).balanceCents,5000,'Reference applies held cash to the original before the native amount candidate')
  assert.equal((await stripe.request('GET',`/v1/customers/${remote.id}/cash_balance`)).available.usd,5000)
  const allocation={customer:customer.id,account_ref:account.id,transfer_ref:funding.id,invoice:native,amount:'50',confirm:true}
  const allocated=await api('processor.cash.allocate',allocation)
  assert.equal(allocated.status,'collected')
  const intents=(await stripe.list('/v1/payment_intents',{customer:remote.id})).data.filter(row=>row.metadata?.nectar_cash_transfer===funding.id)
  assert.equal(intents.length,2)
  assert.deepEqual(intents.map(row=>row.amount).sort((a,b)=>a-b),[5000,25000])
  const actual=[]
  for(const intent of intents){
   assert.equal(intent.status,'succeeded');assert.equal(intent.amount_received,intent.amount)
   const charge=await stripe.request('GET',`/v1/charges/${reference(intent.latest_charge)}`)
   assert.deepEqual([charge.status,charge.paid,charge.captured,charge.amount_captured,charge.payment_method_details.type],['succeeded',true,true,intent.amount,'customer_balance'])
   const transaction=await stripe.request('GET',`/v1/balance_transactions/${reference(charge.balance_transaction)}`)
   assert.equal(transaction.net,transaction.amount-transaction.fee)
   actual.push({intent,charge,transaction,event:await eventFor('payment_intent.succeeded',intent.id)})
  }
  const posts=stripe.counts.POST
  for(const item of actual){await ingest(item.event);assert.equal((await ingest(item.event)).replayed,true)}
  assert.equal((await ingest(fundingEvent)).replayed,true)
  assert.equal((await api('processor.cash.allocate',allocation)).replayed,true)
  assert.equal(stripe.counts.POST,posts,'Event and manual-allocation replay cannot apply held funds twice')
  const cash=await stripe.request('GET',`/v1/customers/${remote.id}/cash_balance`)
  const transactions=(await stripe.list(`/v1/customers/${remote.id}/cash_balance_transactions`)).data
  assert.equal(cash.available?.usd??0,0)
  assert.equal(transactions.filter(row=>row.type==='funded').length,1)
  assert.equal(transactions.filter(row=>row.type==='applied_to_payment').length,2)
  assert.equal(transactions.reduce((sum,row)=>sum+row.net_amount,0),0)
  const record=await api(`invoices/${native}`),state=await api(`processor-events?customer=${customer.id}`)
  assert.deepEqual([record.balanceCents,record.allocations.length],[0,1])
  assert.equal(state.importedCashApplications.filter(row=>row.invoice_id===source.id&&row.status==='collected').length,1)
  assert.equal(state.events.filter(row=>row.status==='failed').length,0)
  assert.deepEqual(state.cashTransactions.map(row=>[row.transaction_ref,row.amount_cents,row.ending_balance_cents]).sort(),transactions.map(row=>[row.id,row.net_amount,row.ending_balance]).sort())
  const unchanged=(await history()).incumbentHistory.documents.find(row=>row.id===source.id)
  assert.deepEqual([unchanged.total_cents,unchanged.paid_cents,unchanged.remaining_cents],[25000,0,25000])
  assert.deepEqual((await api(`invoices?customer=${customer.id}`)).data.map(row=>row.id),[native],'Original settlement never creates a native copy')
  for(const item of actual){
   const row=state.transactions.find(row=>row.transaction_ref===item.transaction.id)
   assert.ok(row);assert.deepEqual([row.amount_cents,row.fee_cents,row.net_cents],[item.transaction.amount,item.transaction.fee,item.transaction.net])
   if(item.intent.metadata.nectar_imported_invoice)assert.deepEqual([row.invoice_id,row.payment_id],[null,null])
  }
  assert.equal((await api(`reports/collections?period=${period}&customer=${customer.id}`)).totalCents,30000)
  assert.equal((await api(`reports/ar?period=${period}&customer=${customer.id}`)).totalCents,0)
  const availableNet=actual.filter(row=>row.transaction.status==='available'&&new Date(row.transaction.available_on*1000).toISOString().slice(0,10)<=day).reduce((sum,row)=>sum+row.transaction.net,0)
  assert.equal((await api(`reports/settlements?period=${period}&customer=${customer.id}`)).totalCents,availableNet)
  receipts.push({kind:'held_cash_imported_and_native',customer:remote.id,originalInvoice:original.id,importedInvoice:source.id,nativeInvoice:native,
   takeover:approved.id,importJob:imported.job,funding:funding.id,fundedBeforeImport:true,fundedCents:30000,importedAppliedCents:25000,nativeAppliedCents:5000,
   remainingCents:0,eventRefs:[fundingEvent.id,...actual.map(row=>row.event.id)],movements:actual.map(row=>({paymentIntent:row.intent.id,charge:row.charge.id,
    transaction:row.transaction.id,grossCents:row.transaction.amount,feeCents:row.transaction.fee,netCents:row.transaction.net,status:row.transaction.status})),apiVersion:stripe.apiVersion})
 }catch(error){failure=error}finally{
  if(remote){
   try{
    const charges=(await stripe.list('/v1/charges',{customer:remote.id})).data
    assert.ok(charges.length<=10,'sandbox_imported_cleanup_scope')
    for(const charge of charges)if(charge.paid&&!charge.disputed&&charge.amount_refunded<charge.amount){
     const refund=await stripe.request('POST','/v1/refunds',{charge:charge.id,amount:charge.amount-charge.amount_refunded})
     cleanup.push({kind:'refund',charge:charge.id,refund:refund.id,amountCents:refund.amount,status:refund.status})
    }
   }catch(error){cleanup.push({kind:'refund',status:'unconfirmed',error:safeError(error)})}
   if(original)try{
    const current=await stripe.request('GET',`/v1/invoices/${original.id}`)
    if(current.status==='open'){const voided=await stripe.request('POST',`/v1/invoices/${original.id}/void`);assert.equal(voided.status,'void');cleanup.push({kind:'original_invoice',invoice:original.id,status:'void'})}
    else if(current.status==='draft'){const deleted=await stripe.request('DELETE',`/v1/invoices/${original.id}`);cleanup.push({kind:'original_invoice',invoice:original.id,status:deleted.deleted?'deleted':'unconfirmed'})}
   }catch(error){cleanup.push({kind:'original_invoice',status:'unconfirmed',error:safeError(error)})}
   try{const deleted=await stripe.request('DELETE',`/v1/customers/${remote.id}`);cleanup.push({kind:'customer',customer:remote.id,status:deleted.deleted?'deleted':'unconfirmed'})}
   catch(error){cleanup.push({kind:'customer',status:'unconfirmed',error:safeError(error)})}
  }
 }
 if(failure){failure.cleanup=cleanup;throw failure}
 return [...receipts,{kind:'held_cash_cleanup',records:cleanup}]
}
