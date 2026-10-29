// Real scheduled retry interruption on both sides of its existing durable
// confirmation claim. Only Stripe's HTTP edge and an audit refusal are faked.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { retryEdge } from './retry-edge.mjs'
import { totp } from './mfa.mjs'

let edge,gate,persistence
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve}}
export function harnessOptions() {
  edge=retryEdge();gate=null;persistence=mkdtempSync(join(tmpdir(),'nectar-retry-restart-'))
  return {persistence,localTime:'2026-10-22T10:00:00Z',stripeSecret:'synthetic-nectar-1',stripeFetch:async request=>{
    const path=new URL(request.url).pathname,active=gate
    if(active?.mode==='before'&&request.method==='GET'&&path.startsWith('/v1/payment_methods/')){
      active.entered.resolve();await active.release.promise
    }
    const response=await edge.fetch(request)
    if(active?.mode==='after'&&request.method==='POST'&&/^\/v1\/payment_intents\/[^/]+\/confirm$/.test(path)){
      active.entered.resolve();await active.release.promise
    }
    return response
  }}
}
export async function retryJobRestartFlow(h,owner) {
  const close=h.close
  h.close=async()=>{try{await close()}finally{await rm(persistence,{recursive:true,force:true})}}
  const api=(path,body,status)=>h.api(path,owner,body,status)
  let instant=Date.parse('2026-10-22T10:00:00Z')
  const tick=()=>h.raw(`/cdn-cgi/local/scheduled?time=${instant}&cron=${encodeURIComponent('* * * * *')}`)
  await api('business.configure',{...await api('business'),timezone:'UTC'})
  const factor=await api('mfa.totp.start',{})
  await api('mfa.totp.confirm',{factor:factor.factor,code:totp(factor.secret,instant)})
  await api('portal.configure',{hosts:[h.origin],parents:[]})
  const customer=(await api('customer.create',{external_id:'synthetic-nectar-retry-restart',name:'Synthetic retry restart',billing_email:h.vars.OWNER_EMAIL})).id
  await api('collection.customer.bind',{customer,account_ref:'synthetic-nectar-native-account-1',stripe_customer_ref:'synthetic-nectar-native-customer-1',confirm:true})
  const invoices=[]
  let verifiedAt=instant
  for(const mode of ['before','after']){
    edge.setTime(instant)
    if(instant-verifiedAt>=14*60_000){await api('mfa.verify',{code:totp(factor.secret,instant)});verifiedAt=instant}
    const charge=(await api('charge.add',{customer,amount:'100',description:'Synthetic retry restart service',effective_date:'2026-10-22',taxable:false})).charge
    const invoice=(await api('invoice.manual',{customer,charges:[charge],service_date:'2026-10-22'})).id
    edge.rules.set('synthetic-nectar-native-card-1',{code:'processing_error',recoverAt:2})
    const request=await api('automatic.collection.prepare',{invoice,issue_date:'2026-10-22',enable_retries:true})
    const session=await api('portal.session.issue',{customer,origin:h.origin,audience:'hosted'})
    assert.equal((await h.raw(`/portal/automatic-collections/${request.id}?session=${encodeURIComponent(session.token)}`,{body:{request:request.id,basis_hash:request.basis,accept:true}})).status,200)
    await api('automatic.collection.decide',{request:request.id,basis_hash:request.basis,decision:'approved',confirm:true,confirm_single:true})
    await api('invoice.approve',{invoice,acknowledge:true})
    await api('invoice.finalise',{invoice,issue_date:'2026-10-22'})
    const failed=await api(`invoices/${invoice}`),intent=edge.writes.at(-1).id
    assert.equal(failed.paidCents,0);assert.ok(failed.next_payment_attempt>instant)
    instant=failed.next_payment_attempt;edge.setTime(instant);await h.advanceClock(new Date(instant).toISOString())
    gate={mode,entered:deferred(),release:deferred()}
    const active=gate,pending=tick().catch(()=>null)
    await Promise.race([active.entered.promise,new Promise((_,reject)=>setTimeout(()=>reject(new Error('retry edge did not pause')),15000))])
    const dispatch=(await api('job-runs')).runs[0]
    assert.equal(dispatch.jobs.find(job=>job.job==='payment-retries').status,'running')
    const before=(await api('automatic-collections')).find(row=>row.id===request.id)
    assert.equal(before.status,mode==='before'?'refused':'claimed')
    assert.equal(edge.writes.filter(write=>write.id===intent).length,mode==='before'?1:2)
    instant+=31*60_000
    await h.restart(new Date(instant).toISOString());gate=null;active.release.resolve();await pending
    edge.setTime(instant)
    if(mode==='before'){
      await h.rejectAudit('retry.claim')
      try{assert.equal((await tick()).status,500)}finally{await h.rejectAudit()}
      assert.equal(edge.writes.filter(write=>write.id===intent).length,1,'refused claim audit cannot confirm at the processor')
      assert.equal((await api(`invoices/${invoice}`)).paidCents,0)
    }
    assert.equal((await tick()).status,200)
    assert.equal((await tick()).status,200)
    const recovered=await api(`invoices/${invoice}`),history=(await api('job-runs')).runs.find(row=>row.id===dispatch.id)
    assert.equal(history.status,'interrupted')
    assert.equal(history.jobs.find(job=>job.job==='payment-retries').status,'interrupted')
    assert.ok(history.jobs.slice(5).every(job=>job.status==='not_started'))
    assert.deepEqual([recovered.paidCents,recovered.balanceCents,recovered.allocations.length],[10000,0,1])
    assert.equal(edge.writes.filter(write=>write.id===intent).length,2,'one creation and one original-intent confirmation across restart')
    const audit=await api('audit')
    assert.equal(audit.filter(row=>row.action==='retry.claim'&&row.subject===invoice).length,1)
    assert.equal(audit.filter(row=>row.action==='automatic.collection.collected'&&row.subject===request.id).length,1)
    invoices.push(invoice)
  }
  const payments=await api('payments')
  assert.equal(edge.intents.size,2);assert.equal(payments.length,2)
  assert.equal(payments.reduce((sum,row)=>sum+row.amount_cents,0),20000)
  for(const invoice of invoices)assert.equal((await api(`invoices/${invoice}`)).total_cents,10000)
  console.log('retryJobRestartFlow: real restart before and after original-intent retry claim, refused audit without processor write, one confirmation and allocation, independent cash and audit reconciliation passed')
}
