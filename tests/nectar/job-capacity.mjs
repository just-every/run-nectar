// Dedicated native scale journey, outside push Verify. It retains today's
// explicit invoice consent and owner-confirmed continuation floor. The result
// is not qualification of unattended billing or live processor capacity.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {request} from 'node:http'
import {mkdtempSync} from 'node:fs'
import {rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {nativeCollectionEdge} from './native-collection.mjs'
import {totp} from './mfa.mjs'
import {runIsolated} from './isolated.mjs'
let edge,persistence,captureGate
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve}}
const count=10000,perCustomer=10
async function waitFor(promise,message){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),600_000)})])}finally{clearTimeout(timer)}}
export function harnessOptions(){
  edge=nativeCollectionEdge();captureGate=null;persistence=mkdtempSync(join(tmpdir(),'nectar-native-capacity-'))
  return {persistence,localTime:'2026-11-01T10:00:00Z',stripeSecret:'synthetic-nectar-1',stripeFetch:async request=>{
    const response=await edge.fetch(request)
    if(captureGate&&request.method==='POST'&&new URL(request.url).pathname==='/v1/payment_intents'&&edge.intents.size===100){
      const active=captureGate;active.entered.resolve();await active.release.promise
    }
    return response
  }}
}
async function parallel(items,run){let next=0;await Promise.all(Array.from({length:4},async()=>{while(next<items.length){const index=next++;await run(items[index],index)}}))}
// A billing day can outlast fetch's five-minute header timer. Keep the real
// authenticated HTTP door and the journey's hard twenty-minute process limit.
function continueDay(h,owner,body){
  return new Promise((resolve,reject)=>{
    const req=request(new URL('/api/nectar/invoice.automation.resume',h.origin),{
      method:'POST',headers:{cookie:owner,origin:h.origin,'content-type':'application/json','CF-Connecting-IP':'127.0.0.1'},
    },response=>{
      const chunks=[]
      response.on('data',chunk=>chunks.push(chunk));response.on('error',reject)
      response.on('end',()=>{try{
        const text=Buffer.concat(chunks).toString()
        assert.equal(response.statusCode,200,text.slice(0,400));resolve(JSON.parse(text))
      }catch(error){reject(error)}})
    })
    req.on('error',reject)
    req.setTimeout(15*60_000,()=>req.destroy(new Error('Invoice continuation exceeded fifteen minutes')))
    req.end(JSON.stringify(body))
  })
}
function csvRows(text){
  const rows=[];let row=[],cell='',quoted=false
  for(let i=0;i<text.length;i++){
    const ch=text[i]
    if(ch==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++}else quoted=!quoted}
    else if(ch===','&&!quoted){row.push(cell);cell=''}
    else if(ch==='\n'&&!quoted){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell=''}
    else cell+=ch
  }
  assert.equal(quoted,false);const header=rows.shift()
  return rows.filter(row=>row.some(Boolean)).map(row=>Object.fromEntries(header.map((name,index)=>[name,row[index]])))
}
export async function nativeJobCapacityFlow(h,owner){
  const close=h.close;h.close=async()=>{try{await close()}finally{await rm(persistence,{recursive:true,force:true})}}
  const api=(path,body,status)=>h.api(path,owner,body,status)
  let instant=Date.parse('2026-11-01T10:00:00Z')
  edge.capturedAt(new Date(instant).toISOString())
  const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()
  console.log('NATIVE CAPACITY HEAD',head)
  await api('business.configure',{...await api('business'),timezone:'UTC'})
  const factor=await api('mfa.totp.start',{})
  await api('mfa.totp.confirm',{factor:factor.factor,code:totp(factor.secret,instant)})
  await api('portal.configure',{hosts:[h.origin],parents:[]})
  const product=(await api('product.create',{code:'synthetic-nectar-native-capacity',name:'Synthetic capacity service'})).id
  const price=(await api('price.create',{product,kind:'flat',unit_amount:'1',taxable:false})).id
  const customers=[],subscriptions=new Set(),sources=new Map(),requests=new Map(),seedStart=performance.now()
  await parallel(Array.from({length:count/perCustomer},(_,index)=>index),async index=>{
    const customer=(await api('customer.create',{external_id:`synthetic-nectar-capacity-${index}`,name:`Synthetic capacity customer ${index}`,billing_email:h.vars.OWNER_EMAIL})).id
    const remote=`synthetic-nectar-capacity-customer-${index}`
    edge.customers.set(remote,{account:1,method:`synthetic-nectar-capacity-card-${index}`})
    await api('collection.customer.bind',{customer,account_ref:'synthetic-nectar-native-account-1',stripe_customer_ref:remote,confirm:true})
    for(let n=0;n<perCustomer;n++)subscriptions.add((await api('subscription.create',{customer,start_date:'2026-10-01',price:[price]})).id)
    customers.push(customer);sources.set(customer,remote)
    if(customers.length%100===0)console.log(JSON.stringify({phase:'seed',subscriptions:subscriptions.size,elapsedMs:Math.round(performance.now()-seedStart)}))
  })
  assert.equal(subscriptions.size,count)
  const policy=await api('invoice.automation.prepare',{enabled:true,hour:0})
  await api('invoice.automation.decide',{request:policy.request,decision:'approved',confirm_single:true})
  const tick=()=>h.raw(`/cdn-cgi/local/scheduled?time=${instant}&cron=${encodeURIComponent('* * * * *')}`)
  const started=performance.now()
  await h.rejectAudit('invoice.approve')
  try{assert.equal((await tick()).status,500)}finally{await h.rejectAudit()}
  const originalDispatch=(await api('job-runs')).runs[0]
  assert.equal(originalDispatch.jobs.find(job=>job.job==='invoice-automation').status,'failed')
  const [execution]=(await api('invoice-automation')).runs,run=execution.periods[0].bill_run_id
  const drafts=(await api(`runs/${run}`)).invoices.filter(invoice=>subscriptions.has(invoice.subscription_id))
  assert.equal(drafts.length,count);assert.ok(drafts.every(invoice=>invoice.status==='draft'&&invoice.total_cents===100))
  assert.deepEqual(new Set(drafts.map(invoice=>invoice.subscription_id)),subscriptions,'Every seeded subscription owns exactly one draft')
  const preparedAt=performance.now(),byCustomer=new Map(customers.map(id=>[id,[]]))
  for(const draft of drafts)byCustomer.get(draft.customer_id).push(draft.id)
  // The refused approval leaves every checkpointed draft intact. Restart
  // before collecting the exact customer and sole-owner consents.
  await h.restart(new Date(instant).toISOString())
  assert.equal((await tick()).status,200)
  assert.equal(edge.intents.size,0)
  let consented=0
  await parallel(customers,async customer=>{
    const session=await api('portal.session.issue',{customer,origin:h.origin,audience:'hosted'})
    for(const invoice of byCustomer.get(customer)){
      const request=await api('automatic.collection.prepare',{invoice,issue_date:'2026-11-01'})
      requests.set(invoice,{id:request.id,customer})
      assert.equal((await h.raw(`/portal/automatic-collections/${request.id}?session=${encodeURIComponent(session.token)}`,{body:{request:request.id,basis_hash:request.basis,accept:true}})).status,200)
      await api('automatic.collection.decide',{request:request.id,basis_hash:request.basis,decision:'approved',confirm:true,confirm_single:true})
      if(++consented%1000===0)console.log(JSON.stringify({phase:'consent',invoices:consented,elapsedMs:Math.round(performance.now()-preparedAt)}))
    }
  })
  const consentedAt=performance.now()
  captureGate={entered:deferred(),release:deferred()};const capture=captureGate
  const [prepared]=(await api('invoice-automation')).runs
  const issuing=continueDay(h,owner,{run:prepared.id,revision:prepared.execution_revision,confirm:true}).catch(()=>null)
  await waitFor(capture.entered.promise,'capacity collection did not reach its capture')
  assert.equal(edge.intents.size,100)
  assert.equal((await api('invoice-automation')).runs[0].status,'running')
  instant+=31*60_000
  await h.restart(new Date(instant).toISOString());captureGate=null;capture.release.resolve();await issuing
  edge.capturedAt(new Date(instant).toISOString())
  assert.equal((await tick()).status,200)
  assert.equal(edge.intents.size,100,'ordinary ticks reconcile the claimed payment without recovering the invoice day')
  await api('mfa.verify',{code:totp(factor.secret,instant)})
  const [interrupted]=(await api('invoice-automation')).runs
  assert.equal(interrupted.resumable,true)
  const result=await continueDay(h,owner,{run:interrupted.id,revision:interrupted.execution_revision,confirm:true})
  const completedAt=performance.now()
  assert.equal(result.status,'completed');assert.equal(result.issued.length,count);assert.equal(new Set(result.issued).size,count)
  assert.equal(edge.intents.size,count);assert.equal(edge.charges.size,count)
  assert.ok([...edge.intents.values()].every(row=>row.value.status==='succeeded'&&row.value.amount_received===100))
  const finished=await api(`runs/${run}`)
  assert.equal(finished.status,'finalised')
  const issued=finished.invoices.filter(invoice=>subscriptions.has(invoice.subscription_id))
  assert.equal(issued.length,count);assert.ok(issued.every(invoice=>invoice.status==='issued'&&invoice.total_cents===100))
  assert.deepEqual(new Set(issued.map(invoice=>invoice.subscription_id)),subscriptions,'Restart leaves exactly one issued invoice for every seeded subscription')
  assert.equal(new Set(issued.map(invoice=>invoice.number)).size,count,'Every issued invoice keeps a distinct number')
  assert.ok(issued.every(invoice=>invoice.period_start==='2026-10-01'&&invoice.period_end==='2026-11-01'&&invoice.currency==='USD'))
  const captures=new Map()
  for(const {account,value:intent} of edge.intents.values()){
    const invoice=intent.metadata.nectar_native_invoice,source=requests.get(invoice)
    assert.ok(source,'Every processor capture belongs to a reviewed invoice')
    assert.equal(account,1);assert.equal(intent.customer,sources.get(source.customer))
    assert.equal(intent.metadata.nectar_native_collection_request,source.id)
    assert.equal(intent.currency,'usd');assert.equal(intent.amount,100);assert.equal(intent.amount_received,100)
    assert.equal(captures.has(invoice),false,'No subscription invoice has two processor captures')
    captures.set(invoice,intent.id)
  }
  assert.deepEqual(new Set(captures.keys()),new Set(issued.map(invoice=>invoice.id)))
  const response=await h.raw('/app/exports/invoices.csv',{cookie:owner});assert.equal(response.status,200)
  const invoiceIds=new Set(issued.map(invoice=>invoice.id))
  const csv=csvRows(await response.text())
  assert.ok(csv.every(row=>invoiceIds.has(row.invoice_id)))
  assert.equal(csv.length,count);assert.equal(new Set(csv.map(row=>row.invoice_id)).size,count)
  assert.ok(csv.every(row=>row.total==='1.00'&&row.paid==='1.00'&&row.balance==='0.00'))
  assert.ok(csv.every(row=>row.credited==='0.00'&&row.written_off==='0.00'&&row.tax==='0.00'))
  assert.equal(new Set(csv.map(row=>row.number)).size,count)
  const allocatedCents=csv.reduce((sum,row)=>sum+Math.round(Number(row.paid)*100),0)
  assert.equal(allocatedCents,1000000)
  const collections=await api('reports/collections?period=2026-11')
  assert.equal(collections.entries.length,count);assert.equal(collections.totalCents,count*100)
  assert.equal(new Set(collections.entries.map(row=>row.paymentId)).size,count,'One recorded receipt per captured payment')
  assert.deepEqual(new Set(collections.entries.map(row=>row.number)),new Set([...captures.values()].map(id=>`stripe:synthetic-nectar-native-account-1:${id}`)))
  assert.ok(collections.entries.every(row=>row.sourceKind==='payment'&&row.amountCents===100))
  // Reconcile exact allocation lineage as well as equal aggregate cents.
  const invoiceByNumber=new Map(issued.map(invoice=>[invoice.number,invoice]))
  const receiptIds=new Set(),allocationIds=new Set()
  await parallel(customers,async customer=>{
    const balance=await api(`customers/${customer}/balance`)
    const receipts=balance.ledger.filter(row=>row.kind==='receipt'),allocations=balance.ledger.filter(row=>row.kind==='allocation')
    assert.equal(balance.customer,customer);assert.deepEqual(balance.payments,[])
    assert.equal(receipts.length,perCustomer);assert.equal(allocations.length,perCustomer)
    const references=new Set(receipts.map(row=>row.reference))
    assert.equal(references.size,perCustomer)
    for(const receipt of receipts){
      assert.equal(receipt.amountCents,100);assert.equal(receiptIds.has(receipt.id),false);receiptIds.add(receipt.id)
    }
    for(const allocation of allocations){
      const invoice=invoiceByNumber.get(allocation.invoice)
      assert.ok(invoice);assert.equal(invoice.customer_id,customer)
      assert.equal(allocation.reference,`stripe:synthetic-nectar-native-account-1:${captures.get(invoice.id)}`)
      assert.ok(references.has(allocation.reference));assert.equal(allocation.amountCents,100)
      assert.equal(allocationIds.has(allocation.id),false);allocationIds.add(allocation.id)
    }
  })
  assert.deepEqual(receiptIds,new Set(collections.entries.map(row=>row.paymentId)))
  assert.equal(allocationIds.size,count)
  const readReport=async path=>{const response=await h.raw(path,{cookie:owner});assert.equal(response.status,200);return response.json()}
  const billings=await readReport('/api/nectar/reports/billings?period=2026-11'),ar=await readReport('/api/nectar/reports/ar')
  assert.equal(billings.totalCents,1000000);assert.deepEqual(new Set(billings.entries.map(row=>row.invoiceId)),invoiceIds)
  assert.equal(ar.totalCents,0);assert.deepEqual(ar.entries,[])
  const revenue=await api('revenue?from=2026-10&to=2026-11')
  assert.deepEqual([revenue.openingCents,revenue.netBillingsCents,revenue.recognizedCents,revenue.closingCents],[0,1000000,1000000,0])
  assert.deepEqual(revenue.months.map(row=>[row.period,row.billingsCents,row.recognizedCents,row.closingCents]),[['2026-10',0,1000000,-1000000],['2026-11',1000000,0,0]])
  for(const kind of ['billing','recognition']){
    const rows=revenue.contributions.filter(row=>row.kind===kind)
    assert.equal(rows.length,count);assert.equal(new Set(rows.map(row=>row.lineId)).size,count)
    assert.deepEqual(new Set(rows.map(row=>row.invoiceId)),invoiceIds)
    assert.ok(rows.every(row=>row.custody==='issue-snapshot'&&row.amountCents===100))
  }
  const audit=await api('audit')
  const completion=audit.filter(row=>row.action==='invoice.automation.complete'&&row.subject===interrupted.id)
  assert.equal(completion.length,1);assert.equal(JSON.parse(completion[0].detail).issued.length,count)
  const dispatch=(await api('job-runs')).runs.find(row=>row.id===originalDispatch.id)
  assert.equal(dispatch.status,'failed')
  assert.equal(dispatch.jobs.find(job=>job.job==='invoice-automation').error_code,'storage_failure')
  assert.equal((await tick()).status,200)
  assert.equal(edge.intents.size,count);assert.equal(edge.calls.filter(call=>call.method==='POST'&&call.path==='/payment_intents').length,count)
  const completionMs=Math.round(completedAt-started)
  const receipt={head,activeSubscriptions:subscriptions.size,issuedInvoices:issued.length,capturedPayments:captures.size,allocatedCents,
    recordedReceipts:receiptIds.size,paymentAllocations:allocationIds.size,revenueSchedules:revenue.contributions.filter(row=>row.kind==='recognition').length,reconciled:true,
    realWorkerRestart:true,workerRestarts:2,preparationMs:Math.round(preparedAt-started),explicitConsentMs:Math.round(consentedAt-preparedAt),
    seedCreationMs:Math.round(started-seedStart),completionMs,nativeTimingPassed:completionMs<15*60_000,processingMs:Math.round(preparedAt-started+completedAt-consentedAt),
    qualified:false,boundary:'native processor edge; explicit invoice consent and owner-confirmed continuation; unattended and live provider capacity remain unqualified'}
  console.log('NATIVE CAPACITY RESULT',JSON.stringify(receipt))
  assert.ok(receipt.nativeTimingPassed,'The native billing day, including explicit consents and real restarts, finishes within fifteen minutes')
}
if(process.argv[1]===new URL(import.meta.url).pathname)await runIsolated('job-capacity','nativeJobCapacityFlow',async()=>({harnessOptions,nativeJobCapacityFlow}))
