// One operational journey through real scheduled HTTP, Worker, D1 and sessions.
// Only the processor edge and audit-storage fault are substituted.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeCollectionEdge } from './native-collection.mjs'
import { totp } from './mfa.mjs'
import { file } from './harness.mjs'
import { publishPrice } from './price-helper.mjs'

let edge, gate, persistence, refuseReads
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
export function harnessOptions() {
  edge = nativeCollectionEdge()
  refuseReads = false
  persistence = mkdtempSync(join(tmpdir(), 'nectar-job-runs-'))
  return {
    persistence, localTime: '2026-10-22T10:00:00Z',
    stripeSecret: 'synthetic-nectar-1', stripeSecondarySecret: 'synthetic-nectar-2',
    stripeFetch: async request => {
      const path = new URL(request.url).pathname
      if (refuseReads && path.startsWith('/v1/payment_intents')) return Response.json({ error: { message: 'Synthetic private provider detail' } }, { status: 503 })
      if (gate?.mode === 'reconcile' && path === '/v1/payment_intents/search') {
        const active = gate, search = ++active.searches
        if (search === 2) active.bothSearching.resolve()
        await active.bothSearching.promise
        if (search === 2) await active.allowSecond.promise
      }
      if (['reconcile','capture-proof'].includes(gate?.mode) && path === '/v1/charges') {
        const active = gate
        active.entered.resolve()
        await active.release.promise
      }
      if (gate && ['before','after'].includes(gate.mode) && path.startsWith('/v1/payment_methods/')) {
        const active = gate
        active.reads++
        if (active.reads === 1 || active.mode === 'before') {
          if (active.reads === 2) active.entered.resolve()
          await active.release.promise
        }
      }
      const response = await edge.fetch(request)
      if (['after','invoice-after'].includes(gate?.mode) && path === '/v1/payment_intents' && request.method === 'POST') {
        const active = gate
        active.entered.resolve()
        await active.release.promise
      }
      return response
    },
  }
}

export async function jobRunsFlow(h, owner) {
  const close = h.close
  h.close = async () => { try { await close() } finally { await rm(persistence, { recursive: true, force: true }) } }
  const api = (path, body, status) => h.api(path, owner, body, status)
  const read = async () => (await api('job-runs')).runs
  let instant = Date.parse('2026-10-22T10:00:00Z')
  const tick = (cron = '* * * * *') => h.raw(`/cdn-cgi/local/scheduled?time=${instant}&cron=${encodeURIComponent(cron)}`)
  const writes = () => edge.calls.filter(call => call.method === 'POST' && call.path === '/payment_intents').length
  await api('business.configure', { ...await api('business'), timezone: 'UTC' })
  const factor = await api('mfa.totp.start', {})
  await api('mfa.totp.confirm', { factor: factor.factor, code: totp(factor.secret, instant) })
  await api('portal.configure', { hosts: [h.origin], parents: [] })
  const agent = { bearer: (await api('credential.issue', { name: 'Synthetic operational reader', scopes: ['prepare'] })).key }
  const email = `synthetic-nectar-operations-1${h.vars.OWNER_EMAIL.slice(h.vars.OWNER_EMAIL.indexOf('@'))}`
  await api('access.give', { email, name: 'Synthetic finance reader', role: 'finance' })
  const finance = await h.signIn(email, { requested: true })
  const financeFactor = await h.api('mfa.totp.start', finance, {})
  await h.api('mfa.totp.confirm', finance, { factor: financeFactor.factor, code: totp(financeFactor.secret, instant) })
  assert.equal((await h.raw('/api/nectar/job-runs')).status, 401)
  await h.api('job-runs', finance, undefined, 403)
  await h.api('job-runs', agent, undefined, 403)
  await api('credential.revoke', { key: (await api('credentials')).find(row => row.name === 'Synthetic operational reader').id })
  await h.api('job-runs', agent, undefined, 401)
  assert.deepEqual(await read(), [])

  // The default-off real jobs run, but observation activates no financial work.
  const before = JSON.stringify([await api('runs'), await api('payments'), await api('audit'), h.mails.length])
  assert.equal((await tick()).status, 200)
  let [first] = await read()
  assert.equal(first.status, 'completed')
  assert.deepEqual(first.jobs.map(job => job.job), ['subscription-states-before', 'webhooks', 'payment-link-expiry', 'automatic-collections', 'payment-retries', 'invoice-automation', 'subscription-states-after-invoices'])
  assert.ok(first.jobs.every(job => job.status === 'completed' && job.started_at === instant && job.finished_at === instant && job.error_code === null))
  assert.equal(first.cron, '* * * * *'); assert.equal(first.scheduled_at, instant)
  assert.equal(JSON.stringify([await api('runs'), await api('payments'), await api('audit'), h.mails.length]), before)
  assert.equal(writes(), 0)

  // A real job's refused audit fails the dispatcher, leaving its downstream
  // jobs visibly unstarted; a subsequent ordinary tick recovers.
  await h.rejectAudit('assurance.run.start')
  try {
    assert.equal((await tick('0 14 * * *')).status, 500)
    const [failed] = await read(), assurance = failed.jobs.find(job => job.job === 'assurance')
    assert.equal(failed.status, 'failed'); assert.equal(failed.error_code, 'storage_failure')
    assert.equal(assurance.status, 'failed'); assert.equal(assurance.error_code, 'storage_failure')
    assert.deepEqual(failed.jobs.at(-1), { ordinal: 22, job: 'subscription-states-final', status: 'not_started', started_at: null, finished_at: null, error_code: null })
    assert.deepEqual(await api('assurance-runs'), [])
  } finally { await h.rejectAudit() }
  assert.equal((await tick('0 14 * * *')).status, 200)
  assert.equal((await read())[0].jobs.length, 23)
  assert.equal((await api('assurance-runs'))[0].status, 'completed')

  await h.rejectAudit('assurance.scan')
  try {
    assert.equal((await tick('0 14 * * *')).status, 200, 'handled failure preserves existing continuation')
    const [reported] = await read()
    assert.equal(reported.status, 'failed'); assert.equal(reported.error_code, 'job_reported_failure')
    assert.equal(reported.jobs.find(job => job.job === 'assurance').status, 'failed')
    assert.equal(reported.jobs.at(-1).status, 'completed')
  } finally { await h.rejectAudit() }

  const customer = (await api('customer.create', { external_id: 'synthetic-nectar-operations-1', name: 'Synthetic private customer', billing_email: email })).id
  await api('collection.customer.bind', { customer, account_ref: 'synthetic-nectar-native-account-1', stripe_customer_ref: 'synthetic-nectar-native-customer-1', confirm: true })
  const prepare = async suffix => {
    edge.capturedAt(new Date(instant).toISOString())
    const day = new Date(instant).toISOString().slice(0, 10)
    const charge = await api('charge.add', { customer, amount: '100', description: `Synthetic private service ${suffix}`, effective_date: day, taxable: false })
    const invoice = (await api('invoice.manual', { customer, charges: [charge.charge], service_date: day })).id
    const request = await api('automatic.collection.prepare', { invoice, issue_date: day })
    const session = await api('portal.session.issue', { customer, origin: h.origin, audience: 'hosted' })
    assert.equal((await h.raw(`/portal/automatic-collections/${request.id}?session=${encodeURIComponent(session.token)}`, { body: { request: request.id, basis_hash: request.basis, accept: true } })).status, 200)
    await h.api('automatic.collection.decide', finance, { request: request.id, basis_hash: request.basis, decision: 'approved', confirm: true })
    await api('invoice.approve', { invoice, acknowledge: true })
    return { invoice, request, day }
  }
  const settled = []
  for (const mode of ['before', 'after']) {
    const { invoice, request, day } = await prepare(mode), count = writes()
    gate = { mode, reads: 0, entered: deferred(), release: deferred() }
    const active = gate
    // Issuance commits first, then waits at its existing processor read.
    const issuing = api('invoice.finalise', { invoice, issue_date: day }).catch(() => null)
    // Observe committed issuance through its public door before invoking cron.
    for (let attempts = 0; ; attempts++) {
      if ((await api(`invoices/${invoice}`)).status === 'issued') break
      assert.ok(attempts < 100, 'ordinary issue reaches its committed state')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const scheduled = tick().catch(() => null)
    await Promise.race([active.entered.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('collection edge did not pause')), 15000))])
    const [running] = await read()
    assert.equal(running.status, 'running')
    assert.equal(running.jobs.find(job => job.job === 'automatic-collections').status, 'running')
    assert.ok(running.jobs.slice(4).every(job => job.status === 'not_started'))
    const collection = (await api('automatic-collections')).find(row => row.id === request.id)
    assert.equal(collection.status, mode === 'before' ? 'active' : 'claimed')
    assert.equal(writes(), count + (mode === 'after' ? 1 : 0))
    assert.equal((await api(`invoices/${invoice}`)).paidCents, 0)

    // Kill and recreate the actual workerd runtime, retaining only durable D1
    // and installation settings; no test writes execution or financial rows.
    instant += 31 * 60_000
    const restarting = h.restart(new Date(instant).toISOString())
    await restarting
    gate = null
    active.release.resolve()
    await Promise.all([issuing, scheduled])
    edge.capturedAt(new Date(instant).toISOString())
    assert.equal((await tick()).status, 200)
    const history = await read(), interrupted = history.find(row => row.id === running.id)
    assert.equal(interrupted.status, 'interrupted')
    assert.equal(interrupted.error_code, 'execution_lease_expired')
    assert.equal(interrupted.jobs.find(job => job.job === 'automatic-collections').status, 'interrupted')
    assert.ok(interrupted.jobs.slice(4).every(job => job.status === 'not_started'))
    assert.equal(writes(), count + 1, 'restart never replaces an existing collection claim')
    const paid = await api(`invoices/${invoice}`)
    assert.equal(paid.paidCents, 10000); assert.equal(paid.balanceCents, 0)
    assert.equal(paid.allocations.length, 1)
    settled.push(invoice)
    await api('mfa.verify', { code: totp(factor.secret, instant) })
    await h.api('mfa.verify', finance, { code: totp(financeFactor.secret, instant) })
  }

  // A lost provider response is handled by the shipped collection job: its
  // execution can return normally while the source records an uncertain item.
  const uncertain = await prepare('provider-failure')
  edge.losePayment()
  await api('invoice.finalise', { invoice: uncertain.invoice, issue_date: uncertain.day })
  assert.equal((await api('automatic-collections')).find(row => row.id === uncertain.request.id).status, 'uncertain')
  const count = writes()
  refuseReads = true
  try {
    assert.equal((await tick()).status, 200)
    assert.equal((await api('automatic-collections')).find(row => row.id === uncertain.request.id).status, 'uncertain')
    const [reported] = await read()
    assert.equal(reported.status, 'failed', 'handled collection outages remain visible to the owner')
    assert.equal(reported.jobs.find(job => job.job === 'automatic-collections').error_code, 'job_reported_failure')
    assert.equal(reported.jobs.at(-1).status, 'completed', 'a handled outage preserves downstream dispatch')
    assert.equal((await api(`invoices/${uncertain.invoice}`)).paidCents, 0)
    assert.equal(writes(), count, 'processor outage cannot authorize a replacement payment')
  } finally { refuseReads = false }
  // Both ticks read the same uncertain revision. The first pauses while
  // validating captured cash; the second loses the intent-binding guard.
  gate = { mode: 'reconcile', searches: 0, bothSearching: deferred(), allowSecond: deferred(), entered: deferred(), release: deferred() }
  const reconciling = gate, pending = [tick(), tick()]
  try {
    await Promise.race([reconciling.entered.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('reconciliation edge did not pause')), 15000))])
    reconciling.allowSecond.resolve()
    await Promise.race(pending)
  } finally {
    gate = null
    reconciling.allowSecond.resolve()
    reconciling.release.resolve()
  }
  const concurrent = await Promise.all(pending)
  for (const response of concurrent) assert.equal(response.status, 200)
  assert.equal(writes(), count, 'concurrent reconciliation sends only provider reads')
  settled.push(uncertain.invoice)
  const history = await read()
  assert.notEqual(history[0].id, history[1].id, 'concurrent ticks retain distinct identities')
  assert.ok(history.slice(0, 2).every(row => row.status === 'completed'))
  const payments = await api('payments'), audit = await api('audit')
  assert.equal(edge.intents.size, 3); assert.equal(edge.charges.size, 3)
  assert.equal(payments.length, 3, JSON.stringify((await api('automatic-collections')).map(row => ({status: row.status, errorCode: row.errorCode}))))
  assert.equal(payments.reduce((sum, payment) => sum + payment.amount_cents, 0), 30000)
  for (const invoice of settled) {
    const paid = await api(`invoices/${invoice}`), collection = (await api('automatic-collections')).find(row => row.invoice === invoice)
    assert.equal(paid.total_cents, 10000); assert.equal(paid.paidCents, 10000); assert.equal(paid.allocations.length, 1)
    assert.equal(audit.filter(event => event.action === 'automatic.collection.claim' && event.subject === collection.id).length, 1)
    assert.equal(audit.filter(event => event.action === 'automatic.collection.collected' && event.subject === collection.id).length, 1)
    assert.equal(payments.filter(payment => payment.id === collection.payment).length, 1)
  }
  const operational = JSON.stringify(await api('job-runs'))
  for (const value of [email, customer, 'Synthetic private', 'synthetic-nectar-1', factor.secret, h.vars.SESSION_SECRET, 'synthetic-nectar-native-intent'])
    assert.ok(!operational.includes(value), 'operational metadata excludes private payloads and credentials')
  await h.api('job-runs', agent, undefined, 401)
  const erasure = await api('erasure.request', { customer })
  await api('erasure.verify', { request: erasure.id, reason: 'Synthetic independent identity verification', evidence: file('identity.txt', 'Synthetic verification evidence', 'text/plain') })
  await api('erasure.approve', { request: erasure.id, confirm: true })
  assert.equal(JSON.stringify(await api('job-runs')), operational, 'erasure has no customer payload to resurrect from observations')
  assert.equal((await tick()).status, 200)
  assert.equal(writes(), count, 'a future tick cannot collect an erased source')
  assert.equal((await api('payments')).reduce((sum, payment) => sum + payment.amount_cents, 0), 30000)
  await api('job-runs', {}, 404)
  await invoiceJobResumption(h, owner, { finance, factor, financeFactor, agent })
  console.log('jobRunsFlow: durable dispatch, real restart before and after collection claim, sanitized failures, concurrent once-only recovery and owner-only metadata passed')
}


// The same operational journey continues the actual saved invoice day. No
// fixture inserts a checkpoint, invoice, payment or execution record.
async function invoiceJobResumption(h, owner, { finance, factor, financeFactor, agent }) {
  const api=(path,body,status)=>h.api(path,owner,body,status)
  let instant=Date.parse('2026-11-01T10:00:00Z')
  const tick=()=>h.raw(`/cdn-cgi/local/scheduled?time=${instant}&cron=${encodeURIComponent('* * * * *')}`)
  const refresh=async()=>{
    await api('mfa.verify',{code:totp(factor.secret,instant)})
    await h.api('mfa.verify',finance,{code:totp(financeFactor.secret,instant)})
  }
  await h.advanceClock(new Date(instant).toISOString());await refresh()
  const history=async()=>(await api('invoice-automation')).runs
  const paymentsBefore=(await api('payments')).length,writesBefore=edge.intents.size
  const product=(await api('product.create',{code:'synthetic-nectar-operations',name:'Synthetic scheduled service'})).id
  const price=(await publishPrice(h,owner,{product,kind:'flat',unit_amount:'100',taxable:false})).id
  const customers=[],domain=(await api('me')).email.split('@')[1]
  for(let index=0;index<4;index++){
    const customer=(await api('customer.create',{external_id:`synthetic-nectar-operations-resume-${index}`,name:`Synthetic scheduled customer ${index}`,
      billing_email:`synthetic-nectar-operations-${index}@${domain}`,...(index===3?{invoice_settings:{poRequired:true}}:{})})).id
    await api('subscription.create',{customer,start_date:'2026-10-01',price:[price]})
    if(index<2)await api('collection.customer.bind',{customer,account_ref:'synthetic-nectar-native-account-1',stripe_customer_ref:`synthetic-nectar-native-customer-${index+3}`,confirm:true})
    customers.push(customer)
  }
  const prepared=await api('invoice.automation.prepare',{enabled:true,hour:0})
  await h.api('invoice.automation.decide',finance,{request:prepared.request,decision:'approved'})
  await api('notification.preferences',{billrun_exceptions:true})
  const mailCalls=[]
  const mailGate={entered:deferred(),release:deferred()}
  await h.configureMail({provider:'sendgrid',apiKey:'synthetic-nectar-3',from:(await api('me')).email},async request=>{
    mailCalls.push(await request.text());mailGate.entered.resolve();await mailGate.release.promise
    return new Response(null,{status:202,headers:{'x-message-id':'synthetic-nectar-3'}})
  })
  const scheduled=tick().catch(()=>null)
  const wait=promise=>Promise.race([promise,new Promise((_,reject)=>setTimeout(()=>reject(new Error('scheduled invoice edge did not pause')),15000))])
  await wait(mailGate.entered.promise)
  let [execution]=await history()
  assert.equal(execution.status,'running');assert.equal(execution.resumable,false)
  assert.equal(execution.periods.length,1,'the prepared month and its checkpoint commit together before an alert')
  const originalRun=execution.periods[0].bill_run_id
  const drafts=(await api(`runs/${originalRun}`)).invoices
  assert.equal(drafts.length,4)
  assert.ok(drafts.every(invoice=>invoice.status==='draft'))
  await api('invoice.automation.resume',{run:execution.id,revision:execution.execution_revision,confirm:true},409)
  // Stop the real Worker while its existing exception alert is in flight.
  await h.restart(new Date(instant).toISOString());mailGate.release.resolve();await scheduled
  assert.equal(edge.intents.size,writesBefore)
  assert.equal((await api('invoices')).data.filter(row=>customers.includes(row.customer_id)).length,0)
  instant+=31*60_000;await h.advanceClock(new Date(instant).toISOString())
  assert.equal((await tick()).status,200,'ordinary ticks retain the reserved day and never recover it automatically')
  ;[execution]=await history()
  assert.equal(execution.resumable,true)
  const resumePayload={run:execution.id,revision:execution.execution_revision,confirm:true}
  await api('invoice.automation.resume',resumePayload,403)
  await refresh()
  await h.api('invoice-automation',finance,undefined,403)
  await h.api('invoice.automation.resume',finance,resumePayload,403)
  await h.api('invoice.automation.resume',agent,resumePayload,401)
  assert.equal((await h.raw('/api/nectar/invoice-automation')).status,401)
  await api('invoice.automation.resume',{...resumePayload,confirm:false},400)
  await h.rejectAudit('invoice.automation.resume')
  try{await api('invoice.automation.resume',resumePayload,500)}finally{await h.rejectAudit()}
  assert.equal((await history())[0].execution_revision,execution.execution_revision,'failed audit cannot consume continuation authority')
  assert.equal(edge.intents.size,writesBefore)
  // Erasure between interruption and continuation must not issue that source.
  const erase=await api('erasure.request',{customer:customers[2]})
  await api('erasure.verify',{request:erase.id,reason:'Synthetic independent verification',evidence:file('identity.txt','Synthetic verification','text/plain')})
  await api('erasure.approve',{request:erase.id,confirm:true})
  for(const customer of customers.slice(0,2)){
    const invoice=drafts.find(row=>row.customer_id===customer).id
    const request=await api('automatic.collection.prepare',{invoice,issue_date:'2026-11-01'})
    const session=await api('portal.session.issue',{customer,origin:h.origin,audience:'hosted'})
    assert.equal((await h.raw(`/portal/automatic-collections/${request.id}?session=${encodeURIComponent(session.token)}`,{body:{request:request.id,basis_hash:request.basis,accept:true}})).status,200)
    await h.api('automatic.collection.decide',finance,{request:request.id,basis_hash:request.basis,decision:'approved',confirm:true})
  }

  edge.capturedAt(new Date(instant).toISOString())
  gate={mode:'invoice-after',entered:deferred(),release:deferred()}
  const captureGate=gate,resuming=api('invoice.automation.resume',resumePayload).catch(()=>null)
  await wait(captureGate.entered.promise)
  await api('invoice.automation.resume',resumePayload,409)
  const [afterClaim]=await history()
  assert.notEqual(afterClaim.execution_revision,execution.execution_revision)
  assert.equal(afterClaim.periods[0].bill_run_id,originalRun)
  assert.equal(edge.intents.size,writesBefore+1)
  await h.restart(new Date(instant).toISOString());gate=null;captureGate.release.resolve();await resuming
  assert.equal((await tick()).status,200,'ordinary collection tick reconciles a captured original claim')
  assert.equal((await api('payments')).length,paymentsBefore+1)
  instant+=31*60_000;await h.advanceClock(new Date(instant).toISOString());await refresh()
  ;[execution]=await history()
  assert.equal(execution.resumable,true)
  // Refuse invoice storage after approval: one approved source survives and
  // the next exact continuation issues it without reapproval or a new bill run.
  await h.rejectAudit('invoice.issue')
  try{await api('invoice.automation.resume',{run:execution.id,revision:execution.execution_revision,confirm:true},500)}finally{await h.rejectAudit()}
  ;[execution]=await history()
  assert.equal(execution.status,'failed')
  assert.ok((await api(`runs/${originalRun}`)).invoices.some(invoice=>invoice.status==='approved'))
  edge.capturedAt(new Date(instant).toISOString())
  const result=await api('invoice.automation.resume',{run:execution.id,revision:execution.execution_revision,confirm:true})
  assert.equal(result.status,'completed')
  ;[execution]=await history()
  assert.equal(execution.status,'completed');assert.equal(execution.resumable,false)
  assert.equal(execution.periods.length,2)
  assert.equal(execution.periods[0].bill_run_id,originalRun)
  assert.equal(new Set(result.issued).size,2)
  assert.equal(result.review.length,2,'exception and erased sources remain outside automatic issue')
  assert.equal(mailCalls.filter(body=>body.includes(originalRun)).length,1,'an interrupted claimed alert is never resent')
  const paid=(await api('invoices')).data.filter(invoice=>customers.slice(0,2).includes(invoice.customer_id))
  assert.equal(paid.length,2)
  assert.equal(edge.intents.size,writesBefore+2)
  const payments=(await api('payments')).filter(payment=>customers.slice(0,2).includes(payment.customer_id))
  assert.equal(payments.length,2);assert.equal(payments.reduce((sum,row)=>sum+row.amount_cents,0),20000)
  const audit=await api('audit')
  for(const row of paid){
    const invoice=await api(`invoices/${row.id}`)
    assert.deepEqual([invoice.total_cents,invoice.paidCents,invoice.balanceCents,invoice.allocations.length],[10000,10000,0,1])
    assert.equal(audit.filter(event=>event.action==='invoice.approve'&&event.subject===row.id).length,1)
    assert.equal(audit.filter(event=>event.action==='invoice.issue'&&event.subject===row.id).length,1)
    const collection=(await api('automatic-collections')).find(item=>item.invoice===row.id)
    assert.equal(audit.filter(event=>event.action==='automatic.collection.claim'&&event.subject===collection.id).length,1)
    assert.equal(audit.filter(event=>event.action==='automatic.collection.collected'&&event.subject===collection.id).length,1)
    const revenue=await api(`revenue/${row.id}`)
    assert.equal(revenue.schedules.length,1,'a restarted invoice retains one revenue schedule')
    assert.deepEqual(revenue.schedules[0].entries.map(entry=>[entry.period,entry.amountCents]),[['2026-10',10000]])
  }
  assert.equal(audit.filter(event=>event.action==='billrun.prepare'&&execution.periods.some(period=>period.bill_run_id===event.subject)).length,2)
  const financialSnapshot=async()=>JSON.stringify([await api('payments'),await api('invoices'),await Promise.all(paid.map(row=>api(`revenue/${row.id}`)))])
  const snapshot=await financialSnapshot()
  await api('invoice.automation.resume',{run:execution.id,revision:execution.execution_revision,confirm:true},409)
  assert.equal((await tick()).status,200)
  assert.equal(await financialSnapshot(),snapshot)
  // A known initial capture binds its provider identity with cash atomically.
  // A refused financial audit leaves a read-only recoverable claim, no cash
  // and no allocation; overlapping ordinary ticks apply that same capture once.
  const priorPayments=await api('payments'),priorPosts=edge.calls.filter(call=>call.method==='POST'&&call.path==='/payment_intents').length
  const charge=await api('charge.add',{customer:customers[0],amount:'100',description:'Synthetic captured audit refusal',effective_date:'2026-11-01',taxable:false})
  const draft=await api('invoice.manual',{customer:customers[0],charges:[charge.charge],service_date:'2026-11-01'})
  const request=await api('automatic.collection.prepare',{invoice:draft.id,issue_date:'2026-11-01'})
  const consent=await api('portal.session.issue',{customer:customers[0],origin:h.origin,audience:'hosted'})
  assert.equal((await h.raw(`/portal/automatic-collections/${request.id}?session=${encodeURIComponent(consent.token)}`,{body:{request:request.id,basis_hash:request.basis,accept:true}})).status,200)
  await h.api('automatic.collection.decide',finance,{request:request.id,basis_hash:request.basis,decision:'approved',confirm:true})
  await api('invoice.approve',{invoice:draft.id,acknowledge:true})
  await h.rejectAudit('automatic.collection.collected')
  try{await api('invoice.finalise',{invoice:draft.id,issue_date:'2026-11-01'})}finally{await h.rejectAudit()}
  const failedCapture=(await api('automatic-collections')).find(row=>row.id===request.id)
  const captured=[...edge.intents.values()].filter(row=>row.value.metadata.nectar_native_invoice===draft.id)
  assert.equal(captured.length,1);assert.equal(captured[0].value.status,'succeeded')
  assert.equal(failedCapture.status,'uncertain');assert.equal(failedCapture.paymentIntentRef,captured[0].value.id)
  assert.deepEqual(await api('payments'),priorPayments,'Refused financial audit records neither cash nor allocation')
  assert.deepEqual((await api(`invoices/${draft.id}`)).allocations,[])
  for(const response of await Promise.all([tick(),tick()]))assert.equal(response.status,200)
  const recovered=await api(`invoices/${draft.id}`),afterPayments=await api('payments')
  assert.deepEqual([recovered.paidCents,recovered.balanceCents,recovered.allocations.length],[10000,0,1])
  assert.equal(afterPayments.length,priorPayments.length+1)
  assert.equal(afterPayments.reduce((sum,row)=>sum+row.amount_cents,0)-priorPayments.reduce((sum,row)=>sum+row.amount_cents,0),10000)
  assert.equal((await api('automatic.collection.reconcile',{request:request.id})).paymentIntentRef,captured[0].value.id)
  assert.equal(edge.calls.filter(call=>call.method==='POST'&&call.path==='/payment_intents').length,priorPosts+1)
  const captureAudit=await api('audit')
  for(const action of ['automatic.collection.claim','automatic.collection.collected'])assert.equal(captureAudit.filter(event=>event.action===action&&event.subject===request.id).length,1)
  // Interrupt after the initial provider acknowledgement, while its captured
  // charge proof is still being read. Only the original durable claim survives.
  const beforeProofPayments=(await api('payments')).length,beforeProofPosts=edge.calls.filter(call=>call.method==='POST'&&call.path==='/payment_intents').length
  const proofCharge=await api('charge.add',{customer:customers[0],amount:'100',description:'Synthetic acknowledged capture interruption',effective_date:'2026-11-01',taxable:false})
  const proofDraft=await api('invoice.manual',{customer:customers[0],charges:[proofCharge.charge],service_date:'2026-11-01'})
  const proofRequest=await api('automatic.collection.prepare',{invoice:proofDraft.id,issue_date:'2026-11-01'})
  const proofConsent=await api('portal.session.issue',{customer:customers[0],origin:h.origin,audience:'hosted'})
  assert.equal((await h.raw(`/portal/automatic-collections/${proofRequest.id}?session=${encodeURIComponent(proofConsent.token)}`,{body:{request:proofRequest.id,basis_hash:proofRequest.basis,accept:true}})).status,200)
  await h.api('automatic.collection.decide',finance,{request:proofRequest.id,basis_hash:proofRequest.basis,decision:'approved',confirm:true})
  await api('invoice.approve',{invoice:proofDraft.id,acknowledge:true})
  const proofPause=gate={mode:'capture-proof',entered:deferred(),release:deferred()}
  const proving=api('invoice.finalise',{invoice:proofDraft.id,issue_date:'2026-11-01'}).catch(()=>null)
  try{
    await wait(proofPause.entered.promise)
    assert.equal(edge.calls.filter(call=>call.method==='POST'&&call.path==='/payment_intents').length,beforeProofPosts+1)
    assert.deepEqual((await api(`invoices/${proofDraft.id}`)).allocations,[])
    instant+=31*60_000
    await h.restart(new Date(instant).toISOString())
  }finally{gate=null;proofPause.release.resolve();await proving}
  edge.capturedAt(new Date(instant).toISOString());await refresh()
  for(const response of await Promise.all([tick(),tick()]))assert.equal(response.status,200)
  const proofPaid=await api(`invoices/${proofDraft.id}`),proofCollection=(await api('automatic-collections')).find(row=>row.id===proofRequest.id)
  assert.deepEqual([proofPaid.paidCents,proofPaid.balanceCents,proofPaid.allocations.length],[10000,0,1])
  assert.equal((await api('payments')).length,beforeProofPayments+1)
  assert.equal(proofCollection.status,'collected')
  assert.equal(proofCollection.paymentIntentRef,[...edge.intents.values()].find(row=>row.value.metadata.nectar_native_invoice===proofDraft.id).value.id)
  assert.equal(edge.calls.filter(call=>call.method==='POST'&&call.path==='/payment_intents').length,beforeProofPosts+1)
  // A failed future run cannot borrow approval from a changed policy or day.
  instant=Date.parse('2026-12-01T10:00:00Z');await h.advanceClock(new Date(instant).toISOString());await refresh()
  await h.rejectAudit('invoice.approve')
  try{assert.equal((await tick()).status,500)}finally{await h.rejectAudit()}
  ;[execution]=await history()
  assert.equal(execution.status,'failed')
  const nextPolicy=await api('invoice.automation.prepare',{enabled:true,hour:1})
  await h.api('invoice.automation.decide',finance,{request:nextPolicy.request,decision:'approved'})
  const beforePolicyRefusal=JSON.stringify([await api('invoices'),await api('payments')])
  await api('invoice.automation.resume',{run:execution.id,revision:execution.execution_revision,confirm:true},409)
  assert.equal(JSON.stringify([await api('invoices'),await api('payments')]),beforePolicyRefusal)
  instant=Date.parse('2026-12-02T10:00:00Z');await h.advanceClock(new Date(instant).toISOString());await refresh()
  await api('invoice.automation.resume',{run:execution.id,revision:execution.execution_revision,confirm:true},409)
  console.log('invoiceJobResumption: real interrupted preparation and captured collection, saved draft and approved continuation, independent audit and cash parity, stale authority and policy and day refusal passed')
}
