// A consented webhook retains its stable event identity across a real Worker
// restart. The shipped receiver deduplicates its permitted at-least-once sends.
import assert from 'node:assert/strict'
import {mkdtempSync} from 'node:fs'
import {rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {receiver,verify} from '../../examples/webhook-receiver/server.mjs'

let persistence,receive,gate,instant,secret,requests,received,refuse
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve}}
export function harnessOptions(){
  persistence=mkdtempSync(join(tmpdir(),'nectar-webhook-restart-'));gate=null;requests=[];received=[];refuse=false
  instant=Date.parse('2026-11-01T10:00:00Z')
  return {persistence,localTime:new Date(instant).toISOString(),webhookFetch:async request=>{
    if(refuse)return new Response('Synthetic private receiver unavailable',{status:503})
    const body=await request.text(),header=request.headers.get('nectar-signature')
    requests.push({body,header,at:instant})
    const response=await receive(new Request(request.url,{method:'POST',headers:request.headers,body}))
    const active=gate
    if(active){active.entered.resolve();await active.release.promise}
    return response
  }}
}
async function entered(promise){let timer;try{await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('webhook receiver did not pause')),15000)})])}finally{clearTimeout(timer)}}
export async function webhookJobRestartFlow(h,owner){
  const close=h.close;h.close=async()=>{try{await close()}finally{await rm(persistence,{recursive:true,force:true})}}
  const api=(path,body,status)=>h.api(path,owner,body,status)
  const tick=()=>h.raw(`/cdn-cgi/local/scheduled?time=${instant}&cron=${encodeURIComponent('* * * * *')}`)
  await api('business.configure',{...await api('business'),timezone:'UTC'})
  const customer=(await api('customer.create',{external_id:'synthetic-nectar-webhook-financial',name:'Synthetic financial control',billing_email:h.vars.OWNER_EMAIL})).id
  const charge=(await api('charge.add',{customer,amount:'100',description:'Synthetic webhook control',effective_date:'2026-10-01',taxable:false})).charge
  const invoice=(await api('invoice.manual',{customer,charges:[charge],service_date:'2026-10-01'})).id
  await api('invoice.approve',{invoice,acknowledge:true});await api('invoice.finalise',{invoice,issue_date:'2026-10-01'})
  const payment=(await api('payment.record',{customer,amount:'40',received_on:'2026-10-31',method:'bank_transfer',reference:'synthetic-nectar-webhook-cash'})).payment
  await api('payment.allocate',{payment,invoice,amount:'40'})
  const financial=JSON.stringify([await api(`invoices/${invoice}`),await api('payments')])
  const endpoint=await api('webhook.register',{url:'https://receiver.nectar-app.com/webhooks',consent:true})
  secret=endpoint.secret
  receive=receiver({secrets:()=>[secret],stateFile:join(persistence,'receipts.json'),clock:()=>instant,onEvent:async event=>received.push(event)})
  assert.equal((await api('webhooks')).deliveries.length,0,'Registration grants no historical sends')
  const first=(await api('customer.create',{external_id:'synthetic-nectar-webhook-restart',name:'Synthetic private restart customer',billing_email:h.vars.OWNER_EMAIL})).id
  const delivery=(await api('webhooks')).deliveries.find(row=>row.subject===first)
  assert.ok(delivery)
  gate={entered:deferred(),release:deferred()}
  const active=gate,pending=tick().catch(()=>null)
  await entered(active.entered.promise)
  assert.equal(received.length,1)
  assert.equal((await api(`webhooks/${delivery.id}`)).status,'sending')
  const dispatch=(await api('job-runs')).runs[0]
  assert.equal(dispatch.jobs.find(job=>job.job==='webhooks').status,'running')
  instant+=31*60_000
  await h.restart(new Date(instant).toISOString());gate=null;active.release.resolve();await pending
  for(const response of await Promise.all([tick(),tick()]))assert.equal(response.status,200)
  const completed=await api(`webhooks/${delivery.id}`)
  assert.equal(completed.status,'delivered');assert.equal(completed.attempts.length,1)
  assert.equal(completed.attempts[0].attempt,2)
  assert.equal(received.length,1,'A lost acknowledgement does not repeat the receiving business action')
  assert.deepEqual(requests.map(row=>JSON.parse(row.body).id),[delivery.event_id,delivery.event_id])
  for(const row of requests)assert.equal(verify(row.body,row.header,[secret],row.at),true)
  const interrupted=(await api('job-runs')).runs.find(row=>row.id===dispatch.id)
  assert.equal(interrupted.status,'interrupted')
  assert.equal(interrupted.jobs.find(job=>job.job==='webhooks').status,'interrupted')
  assert.equal(interrupted.jobs.find(job=>job.job==='payment-link-expiry').status,'not_started')
  const second=(await api('customer.create',{external_id:'synthetic-nectar-webhook-audit',name:'Synthetic audit customer',billing_email:h.vars.OWNER_EMAIL})).id
  const refused=(await api('webhooks')).deliveries.find(row=>row.subject===second)
  await h.rejectAudit('webhook.delivery')
  try{assert.equal((await tick()).status,500)}finally{await h.rejectAudit()}
  assert.equal(received.length,2)
  assert.equal((await api(`webhooks/${refused.id}`)).status,'sending')
  assert.equal((await api('job-runs')).runs[0].jobs.find(job=>job.job==='webhooks').error_code,'storage_failure')
  instant+=6*60_000;await h.advanceClock(new Date(instant).toISOString())
  assert.equal((await tick()).status,200)
  assert.equal((await api(`webhooks/${refused.id}`)).status,'delivered')
  assert.equal(received.length,2,'Refused local outcome storage preserves receiver deduplication')
  assert.equal(requests.filter(row=>JSON.parse(row.body).id===refused.event_id).length,2)
  const audit=await api('audit')
  for(const id of [delivery.id,refused.id])assert.equal(audit.filter(row=>row.action==='webhook.delivery'&&row.subject===id).length,1)
  const unavailable=(await api('customer.create',{external_id:'synthetic-nectar-webhook-unavailable',name:'Synthetic receiver outage',billing_email:h.vars.OWNER_EMAIL})).id
  const waiting=(await api('webhooks')).deliveries.find(row=>row.subject===unavailable)
  refuse=true
  try{
    assert.equal((await tick()).status,200)
    const [failure]=(await api('job-runs')).runs
    assert.equal(failure.status,'failed')
    assert.equal(failure.jobs.find(job=>job.job==='webhooks').error_code,'job_reported_failure')
    assert.equal(failure.jobs.at(-1).status,'completed')
    const attempt=await api(`webhooks/${waiting.id}`)
    assert.equal(attempt.status,'pending');assert.equal(attempt.attempts[0].http_status,503)
    assert.equal(received.length,2,'a receiver refusal performs no receiving business action')
  }finally{refuse=false}
  instant+=2*60_000;await h.advanceClock(new Date(instant).toISOString())
  assert.equal((await tick()).status,200)
  assert.equal((await api(`webhooks/${waiting.id}`)).status,'delivered')
  assert.equal((await api('job-runs')).runs[0].status,'completed')
  assert.equal(received.length,3)
  await api('webhook.disable',{endpoint:endpoint.id})
  await api('webhook.replay',{delivery:delivery.id},409)
  await api('customer.create',{external_id:'synthetic-nectar-webhook-disabled',name:'Synthetic disabled endpoint control',billing_email:h.vars.OWNER_EMAIL})
  const count=requests.length
  assert.equal((await tick()).status,200);assert.equal(requests.length,count)
  assert.equal(JSON.stringify([await api(`invoices/${invoice}`),await api('payments')]),financial)
  const observations=JSON.stringify(await api('job-runs'))
  for(const value of [secret,first,second,'Synthetic private restart customer'])assert.ok(!observations.includes(value))
  console.log('webhookJobRestartFlow: real lost-acknowledgement restart, stable signed event identity, receiver deduplication, concurrent ticks, audit refusal, retired endpoint and unchanged nonempty financial records passed')
}
