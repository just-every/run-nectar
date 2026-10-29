// Dedicated native scale journey, outside push Verify. It retains today's
// explicit invoice consent and owner-confirmed continuation floor. The result
// is not qualification of unattended billing or live processor capacity.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
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
  const customers=[],subscriptions=new Set(),seedStart=performance.now()
  await parallel(Array.from({length:count/perCustomer},(_,index)=>index),async index=>{
    const customer=(await api('customer.create',{external_id:`synthetic-nectar-capacity-${index}`,name:`Synthetic capacity customer ${index}`,billing_email:h.vars.OWNER_EMAIL})).id
    const remote=`synthetic-nectar-capacity-customer-${index}`
    edge.customers.set(remote,{account:1,method:`synthetic-nectar-capacity-card-${index}`})
    await api('collection.customer.bind',{customer,account_ref:'synthetic-nectar-native-account-1',stripe_customer_ref:remote,confirm:true})
    for(let n=0;n<perCustomer;n++)subscriptions.add((await api('subscription.create',{customer,start_date:'2026-10-01',price:[price]})).id)
    customers.push(customer)
    if(customers.length%100===0)console.log(JSON.stringify({phase:'seed',subscriptions:subscriptions.size,elapsedMs:Math.round(performance.now()-seedStart)}))
  })
  assert.equal(subscriptions.size,count)
  // One separate review control pauses preparation at the real alert edge.
  // It is never among the ten thousand supported invoice and charge targets.
  const control=(await api('customer.create',{external_id:'synthetic-nectar-capacity-review',name:'Synthetic review control',billing_email:h.vars.OWNER_EMAIL,invoice_settings:{poRequired:true}})).id
  await api('subscription.create',{customer:control,start_date:'2026-10-01',price:[price]})
  const policy=await api('invoice.automation.prepare',{enabled:true,hour:0})
  await api('invoice.automation.decide',{request:policy.request,decision:'approved',confirm_single:true})
  await api('notification.preferences',{billrun_exceptions:true})
  const alert={entered:deferred(),release:deferred()}
  await h.configureMail({provider:'sendgrid',apiKey:'synthetic-nectar-6',from:h.vars.OWNER_EMAIL},async()=>{
    alert.entered.resolve();await alert.release.promise
    return new Response(null,{status:202})
  })
  const tick=()=>h.raw(`/cdn-cgi/local/scheduled?time=${instant}&cron=${encodeURIComponent('* * * * *')}`)
  const started=performance.now(),pending=tick().catch(()=>null)
  await waitFor(alert.entered.promise,'capacity preparation did not reach its alert')
  const originalDispatch=(await api('job-runs')).runs[0]
  assert.equal(originalDispatch.jobs.find(job=>job.job==='invoice-automation').status,'running')
  const [execution]=(await api('invoice-automation')).runs,run=execution.periods[0].bill_run_id
  const drafts=(await api(`runs/${run}`)).invoices.filter(invoice=>subscriptions.has(invoice.subscription_id))
  assert.equal(drafts.length,count);assert.ok(drafts.every(invoice=>invoice.status==='draft'&&invoice.total_cents===100))
  const preparedAt=performance.now(),byCustomer=new Map(customers.map(id=>[id,[]]))
  for(const draft of drafts)byCustomer.get(draft.customer_id).push(draft.id)
  // Stop preparation before the real provider timeout can let issue continue.
  instant+=31*60_000
  await h.restart(new Date(instant).toISOString());alert.release.resolve();await pending
  assert.equal((await tick()).status,200)
  assert.equal(edge.intents.size,0)
  await api('mfa.verify',{code:totp(factor.secret,instant)})
  edge.capturedAt(new Date(instant).toISOString())
  let consented=0
  await parallel(customers,async customer=>{
    const session=await api('portal.session.issue',{customer,origin:h.origin,audience:'hosted'})
    for(const invoice of byCustomer.get(customer)){
      const request=await api('automatic.collection.prepare',{invoice,issue_date:'2026-11-01'})
      assert.equal((await h.raw(`/portal/automatic-collections/${request.id}?session=${encodeURIComponent(session.token)}`,{body:{request:request.id,basis_hash:request.basis,accept:true}})).status,200)
      await api('automatic.collection.decide',{request:request.id,basis_hash:request.basis,decision:'approved',confirm:true,confirm_single:true})
      if(++consented%1000===0)console.log(JSON.stringify({phase:'consent',invoices:consented,elapsedMs:Math.round(performance.now()-preparedAt)}))
    }
  })
  const consentedAt=performance.now()
  captureGate={entered:deferred(),release:deferred()};const capture=captureGate
  const [prepared]=(await api('invoice-automation')).runs
  const issuing=api('invoice.automation.resume',{run:prepared.id,revision:prepared.execution_revision,confirm:true}).catch(()=>null)
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
  const result=await api('invoice.automation.resume',{run:interrupted.id,revision:interrupted.execution_revision,confirm:true})
  const completedAt=performance.now()
  assert.equal(result.status,'completed');assert.equal(result.issued.length,count);assert.equal(new Set(result.issued).size,count)
  assert.equal(edge.intents.size,count);assert.equal(edge.charges.size,count)
  assert.ok([...edge.intents.values()].every(row=>row.value.status==='succeeded'&&row.value.amount_received===100))
  const issued=(await api(`runs/${run}`)).invoices.filter(invoice=>subscriptions.has(invoice.subscription_id))
  assert.equal(issued.length,count);assert.ok(issued.every(invoice=>invoice.status==='issued'&&invoice.total_cents===100))
  const response=await h.raw('/app/exports/invoices.csv',{cookie:owner});assert.equal(response.status,200)
  const invoiceIds=new Set(issued.map(invoice=>invoice.id))
  const csv=csvRows(await response.text()).filter(row=>invoiceIds.has(row.invoice_id))
  assert.equal(csv.length,count);assert.equal(new Set(csv.map(row=>row.invoice_id)).size,count)
  assert.ok(csv.every(row=>row.total==='1.00'&&row.paid==='1.00'&&row.balance==='0.00'))
  const collections=await api('reports/collections?period=2026-11')
  assert.equal(collections.entries.length,count);assert.equal(collections.totalCents,count*100)
  const dispatch=(await api('job-runs')).runs.find(row=>row.id===originalDispatch.id)
  assert.equal(dispatch.status,'interrupted')
  assert.equal((await tick()).status,200)
  assert.equal(edge.intents.size,count);assert.equal(edge.calls.filter(call=>call.method==='POST'&&call.path==='/payment_intents').length,count)
  const receipt={head,activeSubscriptions:count,issuedInvoices:count,capturedPayments:count,allocatedCents:count*100,
    realWorkerRestart:true,workerRestarts:2,preparationMs:Math.round(preparedAt-started),explicitConsentMs:Math.round(consentedAt-preparedAt),
    completionMs:Math.round(completedAt-started),processingMs:Math.round(preparedAt-started+completedAt-consentedAt),
    qualified:false,boundary:'native processor edge; explicit invoice consent and owner-confirmed continuation; unattended and live provider capacity remain unqualified'}
  console.log('NATIVE CAPACITY RESULT',JSON.stringify(receipt))
}
if(process.argv[1]===new URL(import.meta.url).pathname)await runIsolated('job-capacity','nativeJobCapacityFlow',async()=>({harnessOptions,nativeJobCapacityFlow}))
