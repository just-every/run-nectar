// A failed report snapshot is safe to prepare again; a claimed external send
// is not. Run both through ordinary scheduled HTTP, a real restart and D1.
import assert from 'node:assert/strict'
import {mkdtempSync} from 'node:fs'
import {rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
let persistence
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve}}
export function harnessOptions(){persistence=mkdtempSync(join(tmpdir(),'nectar-report-restart-'));return {persistence,localTime:'2026-11-01T10:00:00Z'}}
export async function reportJobRestartFlow(h,owner){
  const close=h.close;h.close=async()=>{try{await close()}finally{await rm(persistence,{recursive:true,force:true})}}
  const api=(path,body,status)=>h.api(path,owner,body,status)
  let instant=Date.parse('2026-11-01T10:00:00Z')
  const tick=()=>h.raw(`/cdn-cgi/local/scheduled?time=${instant}&cron=${encodeURIComponent('0 14 * * *')}`)
  await api('business.configure',{...await api('business'),timezone:'UTC'})
  const customer=(await api('customer.create',{external_id:'synthetic-nectar-report-restart',name:'Synthetic report private customer',billing_email:h.vars.OWNER_EMAIL})).id
  const charge=(await api('charge.add',{customer,amount:'100',description:'Synthetic report private service',effective_date:'2026-10-01',taxable:false})).charge
  const invoice=(await api('invoice.manual',{customer,charges:[charge],service_date:'2026-10-01'})).id
  await api('invoice.approve',{invoice,acknowledge:true});await api('invoice.finalise',{invoice,issue_date:'2026-10-01'})
  const payment=(await api('payment.record',{customer,amount:'40',received_on:'2026-10-31',method:'bank_transfer',reference:'synthetic-nectar-report-restart-cash'})).payment
  await api('payment.allocate',{payment,invoice,amount:'40'})
  const email=`synthetic-nectar-report-finance${h.vars.OWNER_EMAIL.slice(h.vars.OWNER_EMAIL.indexOf('@'))}`
  await api('access.give',{email,name:'Synthetic report finance',role:'finance'})
  const finance=await h.signIn(email,{requested:true})
  await api('report.schedule',{enabled:true,day:1})
  const mails=[]
  let gate
  await h.configureMail({provider:'sendgrid',apiKey:'synthetic-nectar-report-mail',from:h.vars.OWNER_EMAIL},async request=>{
    const active=gate;mails.push(await request.text())
    if(active){active.entered.resolve();await active.release.promise}
    return new Response(null,{status:202,headers:{'x-message-id':'synthetic-nectar-report-mail'}})
  })
  const financial=JSON.stringify([await api('payments'),await api(`invoices/${invoice}`)])
  await h.rejectAudit('report.snapshot')
  try{assert.equal((await tick()).status,200)}finally{await h.rejectAudit()}
  const [failed]=(await api('report-schedule')).deliveries
  assert.equal(failed.status,'failed');assert.equal(mails.length,0)
  assert.equal((await api('job-runs')).runs[0].jobs.find(job=>job.job==='scheduled-reports').status,'failed')
  const empty=await api(`report-deliveries/${failed.id}`)
  assert.deepEqual(empty.reports,[]);assert.equal(empty.csv,null)
  assert.equal(JSON.stringify([await api('payments'),await api(`invoices/${invoice}`)]),financial)
  await h.restart(new Date(instant).toISOString())
  gate={entered:deferred(),release:deferred()}
  const active=gate,pending=[tick().catch(()=>null),tick().catch(()=>null)]
  await Promise.race([active.entered.promise,new Promise((_,reject)=>setTimeout(()=>reject(new Error('report mail edge did not pause')),15000))])
  const running=(await api('job-runs')).runs.find(run=>run.jobs.find(job=>job.job==='scheduled-reports')?.status==='running')
  assert.ok(running)
  const snapshot=await api(`report-deliveries/${failed.id}`)
  assert.equal(snapshot.status,'sending')
  assert.equal(snapshot.reports.find(report=>report.metric==='billings').totalCents,10000)
  assert.equal(snapshot.reports.find(report=>report.metric==='collections').totalCents,4000)
  assert.equal(snapshot.reports.find(report=>report.metric==='ar').totalCents,6000)
  assert.ok(snapshot.sourceEvidence.some(source=>source.sourceId===invoice))
  await h.api(`report-deliveries/${failed.id}`,finance,undefined,404)
  await h.api('report.schedule',finance,{enabled:true,day:1})
  instant+=31*60_000
  await h.restart(new Date(instant).toISOString());gate=null;active.release.resolve();await Promise.all(pending)
  assert.equal((await tick()).status,200)
  assert.equal((await tick()).status,200)
  const ownerDelivery=(await api('report-schedule')).deliveries
  const financeDelivery=(await h.api('report-schedule',finance)).deliveries
  assert.equal(ownerDelivery.length,1);assert.equal(ownerDelivery[0].id,failed.id);assert.equal(ownerDelivery[0].status,'uncertain')
  assert.equal(financeDelivery.length,1);assert.equal(financeDelivery[0].status,'accepted')
  assert.equal(mails.filter(body=>body.includes(failed.id)).length,1,'claimed report never resends after Worker interruption')
  assert.equal(mails.filter(body=>body.includes(financeDelivery[0].id)).length,1,'unstarted member work continues once')
  const interrupted=(await api('job-runs')).runs.find(run=>run.id===running.id)
  assert.equal(interrupted.status,'interrupted')
  assert.equal(interrupted.jobs.find(job=>job.job==='scheduled-reports').status,'interrupted')
  assert.equal(interrupted.jobs.find(job=>job.job==='correction-mail').status,'not_started')
  assert.equal(JSON.stringify([await api('payments'),await api(`invoices/${invoice}`)]),financial)
  const audit=await api('audit')
  assert.equal(audit.filter(event=>event.action==='report.reserve'&&event.subject===failed.id).length,1)
  assert.equal(audit.filter(event=>event.action==='report.preparation.resume'&&event.subject===failed.id).length,1)
  assert.equal(audit.filter(event=>event.action==='report.mail.claim'&&event.subject===failed.id).length,1)
  assert.equal(audit.filter(event=>event.action==='report.delivery.interrupted'&&event.subject===failed.id).length,1)
  await api('report.schedule',{enabled:false,day:1});await h.api('report.schedule',finance,{enabled:false,day:1})
  assert.equal((await tick()).status,200);assert.equal(mails.length,2)
  console.log('reportJobRestartFlow: refused snapshot resumes once under current opt-in, concurrent preparation claim, actual Worker interruption preserves uncertain send, unstarted recipient completes, exact report and audit and financial parity passed')
}
