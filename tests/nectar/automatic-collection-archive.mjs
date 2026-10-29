// Actual rer archives over public Worker and D1 collection doors. Only Stripe
// transport and an unavailable audit write are substituted at their edges.
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { readArchive } from '@runeditrun/rer/modules/portability'
import { harness, file } from './harness.mjs'
import { command } from './cli.mjs'
import { processorSetup } from './processor-events.mjs'
import { automaticEdge } from './automatic-collection.mjs'
import { retryEdge } from './retry-edge.mjs'
import { totp } from './mfa.mjs'

let day='2026-10-22'
const instant=day+'T10:00:00Z'
const email=n=>[`synthetic-nectar-${n}`,'example.test'].join('@')
async function archiveItems(path){
 const bytes=await readFile(path),items=[]
 for await(const record of readArchive(new ReadableStream({start(c){c.enqueue(bytes);c.close()}})))
  if(record.kind==='part')items.push(...record.items.map(({index,...item})=>item))
 return items
}
const custody=items=>items.filter(item=>['nc_automatic_collections','nc_payments','nc_allocations'].includes(item.table))
const attempts=items=>items.filter(item=>item.table==='nc_automatic_collections').map(item=>item.row)

export async function automaticCollectionArchiveJourney(){
 assert.equal(process.env.NECTAR_TEST_CHECKOUT,'1','Use only a disposable checkout: this journey resets local state')
 const root=process.cwd()
 for(const path of ['.dev.vars','.wrangler/state'])await access(join(root,path)).then(()=>{throw new Error('A fresh unconfigured checkout is required')},error=>{if(error.code!=='ENOENT')throw error})
 await mkdir(join(root,'exports'),{recursive:true})
 const scratch=await mkdtemp(join(root,'exports','automatic-archive-'))
 const archive=name=>join(scratch,name+'.rer'),edge=automaticEdge()
 const stripeSecret='synthetic-nectar-archive-secret-1',stripeSecondarySecret='synthetic-nectar-archive-secret-2'
 const stripeFetch=request=>{const headers=new Headers(request.headers);headers.set('authorization',headers.get('authorization').replace(stripeSecondarySecret,'synthetic-nectar-2').replace(stripeSecret,'synthetic-nectar-1'));return edge.fetch({url:request.url,method:request.method,headers,text:()=>request.text()})}
 const config=JSON.parse(await readFile('wrangler.jsonc','utf8'))
 const persistence=join(root,'.wrangler/state/v3'),databaseId=config.d1_databases.find(row=>row.binding==='DB').database_id
 let h,owner,settings,secret
 const open=async(time=day+'T10:01:00Z')=>{
  h=await harness({assets:true,persistence,databaseId,applyMigrations:false,settings,localTime:time,stripeFetch,stripeSecret,stripeSecondarySecret})
  await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Restored owner'}})
  owner=await h.signIn(h.vars.OWNER_EMAIL)
  await h.api('mfa.verify',owner,{code:totp(secret,Date.parse(time))})
 }
 const close=async()=>{settings={...h.vars};await h.close();h=null}
 const api=(path,body,status)=>h.api(path,owner,body,status)
 const list=()=>api('automatic-collections')
 const tick=async()=>{const r=await h.raw(`/cdn-cgi/local/scheduled?time=${Date.parse(h.vars.NECTAR_LOCAL_TIME)}&cron=${encodeURIComponent('* * * * *')}`);assert.equal(r.status,200,await r.text())}
 const writes=()=>edge.calls.filter(call=>call.method!=='GET').length
 try{
  console.log('automatic archive: prepare real installation')
  await command(root,['export','--output',archive('empty')])
  const setup=await processorSetup(edge,{persistence,databaseId,applyMigrations:false,localTime:instant,stripeFetch,stripeSecret,stripeSecondarySecret})
  h=setup.h;owner=setup.owner
  const factor=await api('mfa.totp.start',{});secret=factor.secret
  await api('mfa.totp.confirm',{factor:factor.factor,code:totp(secret,Date.parse(instant))})
  await api('portal.configure',{hosts:[h.origin],parents:[]})
  const customers=[]
  for(const n of [1,3,4]){
   const customer=(await api('customer.create',{external_id:`synthetic-nectar-archive-${n}`,name:`Synthetic customer ${n}`,billing_email:email(n)})).id
   customers.push(customer)
   await api('collection.customer.bind',{customer,account_ref:'synthetic-nectar-native-account-1',stripe_customer_ref:`synthetic-nectar-native-customer-${n}`,confirm:true})
  }
  const draft=async(customer=customers[0])=>{
   const charge=(await api('charge.add',{customer,amount:'100',description:'Synthetic archive service',effective_date:day,taxable:false})).charge
   return (await api('invoice.manual',{customer,charges:[charge],service_date:day})).id
  }
  const prepare=async(invoice,stage='active',bank=false)=>{
   const row=await api('automatic.collection.prepare',{invoice,issue_date:day,...bank?{mandate_ref:edge.mandate}:{}})
   const session=await api('portal.session.issue',{customer:row.customer,origin:h.origin,audience:'hosted'})
   const path=`/portal/automatic-collections/${row.id}?session=${session.token}`
   if(stage!=='awaiting_customer')assert.equal((await h.raw(path,{body:{request:row.id,basis_hash:row.basis,accept:true}})).status,200)
   if(stage==='active')await api('automatic.collection.decide',{request:row.id,basis_hash:row.basis,decision:'approved',confirm:true,confirm_single:true})
   return {...row,session}
  }
  const issue=async(invoice,status=200)=>{await api('invoice.approve',{invoice,acknowledge:true});return api('invoice.finalise',{invoice,issue_date:day},status)}
  const paid=await prepare(await draft());await issue(paid.invoice)
  const bank=await prepare(await draft(customers[1]),'active',true);await issue(bank.invoice)
  const uncertain=await prepare(await draft(customers[2]));edge.losePayment();await issue(uncertain.invoice)
  const missing=await prepare(await draft(customers[2]));edge.loseBeforePayment();await issue(missing.invoice)
  const waiting=await prepare(await draft(),'awaiting_customer')
  const approval=await prepare(await draft(),'pending_approval')
  const active=await prepare(await draft())
  // A committed claim followed by a failed audit remains claimed even though
  // Stripe accepted the payment. No business row is injected or edited.
  const claimed=await prepare(await draft())
  await h.rejectAudit('automatic.collection.uncertain')
  const failed=await h.raw('/api/nectar/invoice.approve',{cookie:owner,body:{invoice:claimed.invoice,acknowledge:true}});assert.equal(failed.status,200)
  const interrupted=await h.raw('/api/nectar/invoice.finalise',{cookie:owner,body:{invoice:claimed.invoice,issue_date:day}})
  assert.ok(!interrupted.ok,'The unavailable outcome audit refuses the issue response')
  await h.rejectAudit(null)
  const before=await list()
  assert.deepEqual([paid,bank,uncertain,missing,waiting,approval,active,claimed].map(target=>before.find(row=>row.id===target.id).status),
   ['collected','pending_settlement','uncertain','uncertain','awaiting_customer','pending_approval','active','claimed'])
  assert.equal(writes(),5)
  const originalPaid=await api('invoices/'+paid.invoice)
  const retiredOwner=owner
  const initialReport=await api('reports/collections?period=2026-10')
  assert.equal(initialReport.totalCents,10000)
  await close()
  console.log('automatic archive: export pending custody')
  await command(root,['export','--output',archive('pending')])
  const exported=await archiveItems(archive('pending')),original=attempts(exported)
  assert.equal(original.length,8)
  for(const table of ['nc_automatic_collection_authorizations','nc_automatic_collection_events','nc_portal_sessions','nc_mfa_sessions','nc_retry_method_recovery_authorizations'])
   assert.ok(!exported.some(row=>row.table===table),'No executable collection or session authority enters the archive')
  const serialized=JSON.stringify(exported)
  for(const value of [stripeSecret,stripeSecondarySecret,secret,settings.SESSION_SECRET,settings.PORTAL_KEY,settings.SETUP_TOKEN,...[paid,bank,uncertain,missing,waiting,approval,active,claimed].map(row=>row.session.token)])
   assert.ok(!serialized.includes(value),'Archive excludes private runtime keys and customer capabilities')
  assert.ok(original.find(row=>row.id===claimed.id).claimed_at)
  assert.equal(original.find(row=>row.id===claimed.id).payment_intent_ref,null)
  assert.ok(original.find(row=>row.id===bank.id).payment_intent_ref)
  assert.equal(original.find(row=>row.id===uncertain.id).payment_intent_ref,null)
  await command(root,['reset','--yes'])
  await command(root,['import','--input',archive('pending'),'--yes'])
  await command(root,['export','--output',archive('restored')])
  assert.deepEqual(custody(await archiveItems(archive('restored'))),custody(exported),'Real import preserves exact claims, processor identities, cents, outcomes, cash and allocation IDs')
  console.log('automatic archive: restored public doors')
  await open()
  assert.equal((await h.raw('/api/nectar/automatic.collection.reconcile',{cookie:retiredOwner,body:{request:claimed.id}})).status,401,
   'An installation-local owner session cannot return through an archive')
  assert.ok((await list()).every(row=>row.historical))
  assert.deepEqual(await api('invoices/'+paid.invoice),originalPaid)
  assert.equal((await api('reports/collections?period=2026-10')).totalCents,10000)
  const writeCount=writes()
  for(const target of [paid,bank,uncertain,missing,waiting,approval,active,claimed]){
   assert.equal((await h.raw(`/portal/automatic-collections/${target.id}?session=${target.session.token}`,{body:{request:target.id,basis_hash:target.basis,accept:true}})).status,401)
   await api('automatic.collection.decide',{request:target.id,basis_hash:target.basis,decision:'approved',confirm:true,confirm_single:true},409)
  }
  // Portal origins remain explicitly installation-local; obtain new owner
  // approval of this installation's host without restoring debit authority.
  await api('portal.configure',{hosts:[h.origin],parents:[]})
  const freshSession=await api('portal.session.issue',{customer:waiting.customer,origin:h.origin,audience:'hosted'})
  assert.equal((await h.raw(`/portal/automatic-collections/${waiting.id}?session=${freshSession.token}`,{body:{request:waiting.id,basis_hash:waiting.basis,accept:true}})).status,409)
  for(const target of [paid,bank,uncertain,missing,claimed]){
   const responses=await Promise.all([h.raw('/api/nectar/collection.prepare',{cookie:owner,body:{invoice:target.invoice}}),h.raw('/api/nectar/invoice.finalise',{cookie:owner,body:{invoice:target.invoice}})])
   assert.deepEqual(responses.map(r=>r.status),[409,409])
  }
  // Issue may still issue ordinary debt; imported active evidence must not
  // become a debit or be rewritten as a fresh failed operational attempt.
  await issue(active.invoice)
  assert.equal((await list()).find(row=>row.id===active.id).status,'active','Restored unclaimed terms remain inert historical evidence')
  assert.equal(writes(),writeCount)
  // A mismatched provider amount is never cash, even for a retained claim.
  const uncertainIntent=[...edge.intents.values()].find(item=>item.value.metadata.nectar_native_collection_request===uncertain.id).value
  uncertainIntent.amount=10001
  assert.equal((await api('automatic.collection.reconcile',{request:uncertain.id})).status,'uncertain')
  assert.equal((await api('invoices/'+uncertain.invoice)).paidCents,0)
  assert.equal((await api('reports/collections?period=2026-10')).totalCents,10000)
  uncertainIntent.amount=10000
  const competing=await Promise.all([
   h.raw('/api/nectar/automatic.collection.reconcile',{cookie:owner,body:{request:claimed.id}}),
   h.raw('/api/nectar/automatic.collection.reconcile',{cookie:owner,body:{request:claimed.id}}),
   h.raw('/api/nectar/collection.prepare',{cookie:owner,body:{invoice:claimed.invoice}}),
  ])
  assert.deepEqual(competing.map(response=>response.status),[200,200,409],'Concurrent original-outcome reads record cash once and refuse a competing native debit')
  await tick()
  const reconciled=await list()
  for(const target of [claimed,uncertain])assert.equal(reconciled.find(row=>row.id===target.id).status,'collected')
  assert.equal(reconciled.find(row=>row.id===bank.id).status,'pending_settlement')
  assert.equal(reconciled.find(row=>row.id===missing.id).status,'uncertain','A provider history miss never grants a replacement attempt')
  assert.equal((await api('reports/collections?period=2026-10')).totalCents,30000)
  edge.settle()
  await h.advanceClock('2026-10-28T10:00:00Z')
  await api('mfa.verify',{code:totp(secret,Date.parse(h.vars.NECTAR_LOCAL_TIME))})
  await tick()
  const bankIntent=[...edge.intents.values()].find(row=>row.value.customer==='synthetic-nectar-native-customer-3').value
  const event='synthetic-nectar-archive-event-1'
  edge.events.set(event,{object:'event',id:event,type:'payment_intent.succeeded',livemode:false,data:{object:bankIntent}})
  for(const target of [bank,claimed,uncertain])await api('automatic.collection.reconcile',{request:target.id})
  for(let n=0;n<2;n++)await api('automatic.collection.event',{request:bank.id,event_ref:event})
  await tick()
  assert.equal(writes(),writeCount,'All restored reconciliation, replay and scheduling is read-only at Stripe')
  const final=await list()
  for(const target of [paid,bank,claimed,uncertain]){
   const row=final.find(item=>item.id===target.id),invoice=await api('invoices/'+target.invoice)
   assert.equal(row.status,'collected');assert.equal(row.amountCents,10000)
   assert.equal(invoice.paidCents,10000);assert.equal(invoice.balanceCents,0);assert.equal(invoice.allocations.length,1)
   const originalIntent=[...edge.intents.values()].find(item=>item.value.metadata.nectar_native_collection_request===target.id).value
   assert.equal(row.paymentIntentRef,originalIntent.id)
   assert.equal((await api('payments')).filter(payment=>payment.id===row.payment).length,1)
  }
  // Expected debt and cash come from the six ordinary issued 100-dollar
  // invoices, independently of the collection statuses and report totals.
  for(const [customer,issuedCount,paidCount] of [[customers[0],3,2],[customers[1],1,1],[customers[2],2,1]]){
   const record=await api('customers/'+customer),ledger=record.ledger
   const issued=record.billingRecord.automaticCollections.filter(row=>['collected','uncertain','active'].includes(row.status))
   assert.equal(record.ledger.paidCents,paidCount*10000)
   assert.ok(issued.length)
   assert.deepEqual([ledger.invoices.length,ledger.invoicedCents,ledger.paidCents,ledger.balanceCents,ledger.creditedCents,ledger.writtenOffCents,ledger.unallocatedCents],
    [issuedCount,issuedCount*10000,paidCount*10000,(issuedCount-paidCount)*10000,0,0,0])
   assert.equal(ledger.payments.length,paidCount)
   assert.equal(ledger.payments.reduce((sum,row)=>sum+row.amount_cents,0),paidCount*10000)
  }
  assert.equal((await api('payments')).length,4)
  assert.equal((await api('reports/billings?period=2026-10')).totalCents,60000)
  assert.equal((await api('reports/collections?period=2026-10')).totalCents,40000)
  assert.equal((await api('reports/ar')).totalCents,20000)
  // Terminal evidence and a bank debit erased before settlement take the
  // same real portability path. Their business outcomes must survive too.
  day='2026-10-28'
  const refused=await prepare(await draft())
  edge.refuseNext('processing_error');await issue(refused.invoice)
  const returned=await prepare(await draft(customers[1]),'active',true)
  await issue(returned.invoice);edge.returnLastBank()
  assert.equal((await api('automatic.collection.reconcile',{request:returned.id})).status,'returned')
  const withdrawn=await prepare(await draft())
  assert.equal((await h.raw(`/portal/automatic-collections/${withdrawn.id}?session=${withdrawn.session.token}`,{body:{request:withdrawn.id,withdraw:true}})).status,200)
  await issue(withdrawn.invoice)
  const invalidated=await prepare(await draft())
  const method=edge.customers.get('synthetic-nectar-native-customer-1').method
  edge.customers.get('synthetic-nectar-native-customer-1').method='synthetic-nectar-archive-changed-method'
  await issue(invalidated.invoice)
  edge.customers.get('synthetic-nectar-native-customer-1').method=method
  const pending=await prepare(await draft(customers[1]),'active',true)
  await issue(pending.invoice)
  const entity=await api('entity.create',{revision:(await api('business')).revision,legal_name:'Synthetic second entity',address:'2 Synthetic Way',ein:'12-3456789',
   invoice_prefix:'SECOND',invoice_number_width:4,payment_terms_days:30,processor_account_ref:'synthetic-nectar-native-account-2',
   ledger_company_ref:'synthetic-nectar-ledger-2',tax_registration:'Synthetic second entity registration'})
  const secondCustomer=(await api('customer.create',{external_id:'synthetic-nectar-archive-2',name:'Synthetic second account',billing_email:email(2)})).id
  await api('customer.entity',{revision:(await api('business')).revision,customer:secondCustomer,entity:entity.id,confirm:true})
  await api('collection.customer.bind',{customer:secondCustomer,account_ref:'synthetic-nectar-native-account-2',stripe_customer_ref:'synthetic-nectar-native-customer-2',confirm:true})
  const secondary=await prepare(await draft(secondCustomer))
  edge.losePayment();await issue(secondary.invoice)
  const terminal=[refused,returned,withdrawn,invalidated,pending,secondary]
  const expectedStates=['refused','returned','revoked','invalidated','pending_settlement','uncertain']
  const terminalRows=await list()
  assert.deepEqual(terminal.map(target=>terminalRows.find(row=>row.id===target.id).status),expectedStates)
  const terminalWrites=writes()
  assert.equal(terminalWrites,writeCount+4)
  const terminalRecovery=await api('recovery')
  assert.deepEqual([terminalRecovery.totals.failedInvoices,terminalRecovery.totals.failedAmountCents,terminalRecovery.totals.recoveredAmountCents],[2,20000,0])
  await close()
  console.log('automatic archive: export terminal and second-account custody')
  await command(root,['export','--output',archive('terminal')])
  const terminalItems=await archiveItems(archive('terminal'))
  await command(root,['reset','--yes'])
  await command(root,['import','--input',archive('terminal'),'--yes'])
  await command(root,['export','--output',archive('terminal-restored')])
  const restoredItems=await archiveItems(archive('terminal-restored'))
  const financialTables=new Set(['nc_automatic_collections','nc_payments','nc_allocations','nc_retry_series','nc_retry_attempts'])
  assert.deepEqual(restoredItems.filter(item=>financialTables.has(item.table)),terminalItems.filter(item=>financialTables.has(item.table)),
   'Terminal and pending claims, original failure dates and outcomes restore exactly')
  console.log('automatic archive: restored terminal and second-account public doors')
  await open()
  const historical=await list()
  assert.deepEqual(terminal.map(target=>historical.find(row=>row.id===target.id).status),expectedStates)
  assert.ok(historical.every(row=>row.historical))
  const restoredRecovery=await api('recovery')
  assert.equal(restoredRecovery.asOf,Date.parse(h.vars.NECTAR_LOCAL_TIME))
  const historicalRecovery=({asOf,...facts})=>facts
  assert.deepEqual(historicalRecovery(restoredRecovery),historicalRecovery(terminalRecovery))
  for(const target of terminal){
   const invoice=await api('invoices/'+target.invoice)
   assert.deepEqual([invoice.paidCents,invoice.balanceCents,invoice.allocations.length],[0,10000,0])
   await api('automatic.collection.decide',{request:target.id,basis_hash:target.basis,decision:'approved',confirm:true,confirm_single:true},409)
   await api('invoice.finalise',{invoice:target.invoice},409)
   assert.equal((await h.raw(`/portal/automatic-collections/${target.id}?session=${target.session.token}`,{body:{request:target.id,basis_hash:target.basis,accept:true}})).status,401)
  }
  for(const target of [refused,returned,pending]){
   await api('collection.prepare',{invoice:target.invoice},409)
   assert.equal((await api('automatic.collection.reconcile',{request:target.id})).status,expectedStates[terminal.indexOf(target)])
  }
  edge.accounts.set(2,'synthetic-nectar-archive-wrong-account')
  await api('automatic.collection.reconcile',{request:secondary.id},409)
  assert.equal((await api('invoices/'+secondary.invoice)).paidCents,0,'An unavailable original account never falls back to a different processor account')
  edge.accounts.set(2,'synthetic-nectar-native-account-2')
  const secondaryCollected=await api('automatic.collection.reconcile',{request:secondary.id})
  assert.equal(secondaryCollected.status,'collected')
  assert.equal(secondaryCollected.quote.accountRef,'synthetic-nectar-native-account-2')
  const secondaryInvoice=await api('invoices/'+secondary.invoice)
  assert.deepEqual([secondaryInvoice.paidCents,secondaryInvoice.balanceCents,secondaryInvoice.allocations.length],[10000,0,1])
  assert.deepEqual((await api('payments')).filter(row=>row.customer_id===secondCustomer).map(row=>row.amount_cents),[10000])
  await tick()
  assert.equal(writes(),terminalWrites,'Restored refusal and return histories confer no retry authority')
  assert.equal((await api('reports/billings?period=2026-10')).totalCents,120000)
  assert.equal((await api('reports/collections?period=2026-10')).totalCents,50000)
  assert.equal((await api('reports/ar')).totalCents,70000)
  const erasure=await api('erasure.request',{customer:customers[1]})
  await api('erasure.verify',{request:erasure.id,reason:'Synthetic independent account verification',evidence:file('synthetic-nectar-933.txt','Synthetic signed identity verification')})
  await api('erasure.approve',{request:erasure.id,confirm:true})
  await api('automatic.collection.reconcile',{request:bank.id},404)
  await api('automatic.collection.event',{request:bank.id,event_ref:event},404)
  await api('automatic.collection.reconcile',{request:pending.id},404)
  const pendingInvoice=await api('invoices/'+pending.invoice)
  assert.deepEqual([pendingInvoice.paidCents,pendingInvoice.balanceCents,pendingInvoice.allocations.length],[0,10000,0])
  const erasedInvoice=await api('invoices/'+bank.invoice)
  assert.equal(erasedInvoice.paidCents,10000);assert.equal(erasedInvoice.balanceCents,0)
  await close()
  await command(root,['export','--output',archive('erased')])
  const erasedItems=await archiveItems(archive('erased'))
  assert.ok(!JSON.stringify(erasedItems).includes(email(3)))
  assert.equal(attempts(erasedItems).find(row=>row.id===bank.id).amount_cents,10000)
  await command(root,['reset','--yes'])
  for(const name of ['pending','terminal']){
   const refusedImport=await command(root,['import','--input',archive(name),'--journal',relative(root,archive('erased')),'--yes'],{refuse:true})
   assert.match(refusedImport,/later_journal|erased_row|erasure_epoch/)
  }
  await command(root,['import','--input',archive('erased'),'--yes'])
  await command(root,['export','--output',archive('erased-restored')])
  assert.deepEqual(custody(await archiveItems(archive('erased-restored'))),custody(erasedItems),'Anonymized financial custody restores exactly')
  await open('2026-10-28T10:02:00Z')
  await api('automatic.collection.reconcile',{request:bank.id},404)
  await api('automatic.collection.reconcile',{request:pending.id},404)
  edge.settle()
  assert.equal((await h.raw(`/portal/automatic-collections/${bank.id}?session=${bank.session.token}`)).status,401)
  await tick()
  assert.equal((await api('invoices/'+bank.invoice)).paidCents,10000)
  const restoredPending=await api('invoices/'+pending.invoice)
  assert.deepEqual([restoredPending.paidCents,restoredPending.balanceCents,restoredPending.allocations.length],[0,10000,0])
  assert.equal((await api('reports/billings?period=2026-10')).totalCents,120000)
  assert.equal((await api('reports/collections?period=2026-10')).totalCents,50000)
  assert.equal((await api('reports/ar')).totalCents,70000)
  assert.equal(writes(),terminalWrites,'Erasure before settlement and anonymized restoration revive no provider write or cash')
  console.log('automaticCollectionArchiveJourney: real export, reset and import preserve claimed, uncertain, pending ACH, collected, refused, returned, revoked and invalidated custody; restored authority is inert; reads reconcile original cash once; erasure checkpoints refuse older archives')
 }finally{await h?.close();await rm(scratch,{recursive:true,force:true})}
}

// The same archive journey also follows an explicitly accepted replacement card.
// A retained claim identifies a past write; it must never restore permission.
export async function automaticCollectionRetryArchiveJourney(){
 assert.equal(process.env.NECTAR_TEST_CHECKOUT,'1','Use only a disposable checkout: this journey resets local state')
 const root=process.cwd(),edge=retryEdge(),at=Date.parse('2026-10-22T10:00:00Z')
 await command(root,['reset','--yes'])
 await mkdir(join(root,'exports'),{recursive:true})
 const scratch=await mkdtemp(join(root,'exports','automatic-retry-archive-')),archive=name=>join(scratch,name+'.rer')
 const config=JSON.parse(await readFile('wrangler.jsonc','utf8'))
 const persistence=join(root,'.wrangler/state/v3'),databaseId=config.d1_databases.find(row=>row.binding==='DB').database_id
 let h,owner,settings,secret,now=at
 const api=(path,body,status)=>h.api(path,owner,body,status)
 const rows=()=>api('automatic-collections')
 const report=kind=>api(['reports',kind].join('/')+(kind==='ar'?'':'?period=2026-10'))
 const tick=async(status=200)=>{const response=await h.raw(`/cdn-cgi/local/scheduled?time=${now}&cron=${encodeURIComponent('* * * * *')}`);assert.equal(response.status,status,await response.text())}
 const close=async()=>{settings={...h.vars};await h.close();h=null}
 const open=async()=>{
  now+=60000;edge.setTime(now)
  h=await harness({assets:true,persistence,databaseId,applyMigrations:false,settings,localTime:new Date(now).toISOString(),stripeFetch:edge.fetch,stripeSecret:'synthetic-nectar-1'})
  await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Restored owner'}})
  owner=await h.signIn(h.vars.OWNER_EMAIL)
  await api('mfa.verify',{code:totp(secret,now)})
 }
 try{
  await command(root,['export','--output',archive('empty')])
  const setup=await processorSetup(edge,{persistence,databaseId,applyMigrations:false,localTime:new Date(at).toISOString()})
  h=setup.h;owner=setup.owner
  const factor=await api('mfa.totp.start',{});secret=factor.secret
  await api('mfa.totp.confirm',{factor:factor.factor,code:totp(secret,at)})
  await api('portal.configure',{hosts:[h.origin],parents:[]})
  const targets=[]
  console.log('automatic archive: prepare replacement outcomes')
  const prepare=async(stage='active')=>{
   const n=targets.length+1,ref=`synthetic-nectar-archive-retry-customer-${n}`,method=`synthetic-nectar-archive-retry-original-${n}`,replacement=`synthetic-nectar-archive-retry-replacement-${n}`
   edge.customers.set(ref,{account:1,method});edge.rules.set(method,{code:'stolen_card',recoverAt:Infinity,advice:'do_not_try_again'})
   const customer=(await api('customer.create',{external_id:`synthetic-nectar-archive-retry-${n}`,name:`Synthetic replacement ${n}`,billing_email:email(950+n)})).id
   await api('collection.customer.bind',{customer,account_ref:'synthetic-nectar-native-account-1',stripe_customer_ref:ref,confirm:true})
   const charge=(await api('charge.add',{customer,amount:'100',description:'Synthetic replacement archive service',effective_date:day,taxable:false})).charge
   const invoice=(await api('invoice.manual',{customer,charges:[charge],service_date:day})).id
   const original=await api('automatic.collection.prepare',{invoice,issue_date:day,enable_retries:true})
   const session=await api('portal.session.issue',{customer,origin:h.origin,audience:'hosted'})
   assert.equal((await h.raw(`/portal/automatic-collections/${original.id}?session=${session.token}`,{body:{request:original.id,basis_hash:original.basis,accept:true}})).status,200)
   await api('automatic.collection.decide',{request:original.id,basis_hash:original.basis,decision:'approved',confirm:true,confirm_single:true})
   await api('invoice.approve',{invoice,acknowledge:true});await api('invoice.finalise',{invoice,issue_date:day})
   assert.equal((await rows()).find(row=>row.id===original.id).status,'refused')
   edge.customers.get(ref).method=replacement
   const recovery=await api('retry.method.prepare',{request:original.id,confirm:true})
   const path=`/portal/retry-method-recoveries/${recovery.id}?session=${session.token}`
   const acceptance={recovery:recovery.id,quote_hash:recovery.quoteHash,accept:true}
   const decision={recovery:recovery.id,quote_hash:recovery.quoteHash,decision:'approved',confirm:true,confirm_single:true}
   if(stage!=='awaiting_customer')assert.equal((await h.raw(path,{body:acceptance})).status,200)
   if(stage==='active')await api('retry.method.decide',decision)
   if(stage==='rejected')await api('retry.method.decide',{...decision,decision:'rejected'})
   if(stage==='withdrawn')assert.equal((await h.raw(path,{body:{recovery:recovery.id,quote_hash:recovery.quoteHash,withdraw:true}})).status,200)
   const target={...original,customer,invoice,replacement,recovery,path,session,acceptance,decision}
   targets.push(target);return target
  }
  day='2026-10-22'
  const paid=await prepare();await tick()
  const refused=await prepare();edge.rules.set(refused.replacement,{code:'processing_error',recoverAt:Infinity});await tick()
  const uncertain=await prepare();edge.lose();await tick()
  const uncertainIntent=edge.intents.get(uncertain.recovery.paymentIntentRef).value
  uncertainIntent.amount=10001
  assert.equal((await api('automatic.collection.reconcile',{request:uncertain.id})).status,'uncertain')
  const claimed=await prepare();edge.lose();await tick()
  const awaiting=await prepare('awaiting_customer'),approval=await prepare('pending_approval'),active=await prepare(),rejected=await prepare('rejected'),withdrawn=await prepare('withdrawn')
  const expected=['collected','refused','uncertain','claimed','refused','refused','refused','refused','refused']
  assert.deepEqual(targets.map(target=>(edge.intents.get(target.recovery.paymentIntentRef).value.metadata.nectar_native_collection_request)),targets.map(target=>target.id))
  assert.deepEqual(targets.map(target=>target.recovery.paymentIntentRef),edge.writes.filter(row=>!row.form).map(row=>row.id))
  assert.equal(edge.writes.length,13,'Nine original invoices and four replacement confirmations use nine original intents')
  const beforeRows=await rows()
  assert.deepEqual(targets.map(target=>beforeRows.find(row=>row.id===target.id).status),expected)
  const beforeRecovery=await api('recovery')
  assert.deepEqual([beforeRecovery.totals.failedInvoices,beforeRecovery.totals.failedAmountCents,beforeRecovery.totals.recoveredAmountCents],[9,90000,10000])
  await close()
  console.log('automatic archive: export replacement claims and unclaimed preparations')
  await command(root,['export','--output',archive('replacement')])
  const exported=await archiveItems(archive('replacement'))
  const tables=new Set(['nc_automatic_collections','nc_retry_method_recoveries','nc_retry_method_recovery_events','nc_retry_series','nc_retry_attempts','nc_payments','nc_allocations'])
  const facts=items=>items.filter(item=>tables.has(item.table))
  for(const table of ['nc_automatic_collection_authorizations','nc_retry_method_recovery_authorizations','nc_portal_sessions','nc_mfa_sessions'])assert.ok(!exported.some(item=>item.table===table))
  const serialized=JSON.stringify(exported)
  for(const value of [secret,settings.SESSION_SECRET,settings.PORTAL_KEY,settings.SETUP_TOKEN,settings.MFA_KEY,settings.STRIPE_BILLING_SECRET,...targets.map(target=>target.session.token)])assert.ok(!serialized.includes(value),'Historical replacement evidence excludes executable capabilities')
  assert.equal(exported.filter(item=>item.table==='nc_retry_method_recovery_events'&&item.row.kind==='claimed').length,4)
  await command(root,['reset','--yes'])
  await command(root,['import','--input',archive('replacement'),'--yes'])
  await command(root,['export','--output',archive('replacement-restored')])
  assert.deepEqual(facts(await archiveItems(archive('replacement-restored'))),facts(exported),'Replacement quotes, claim events, attempt outcomes, payments and allocations restore exactly')
  await open()
  assert.ok((await rows()).every(row=>row.historical&&row.recoveries.every(recovery=>recovery.status==='historical')))
  const writes=edge.writes.length
  for(const target of targets){
   await api('retry.method.decide',target.decision,409)
   await api('retry.method.prepare',{request:target.id,confirm:true},409)
   assert.equal((await h.raw(target.path,{body:target.acceptance})).status,401)
   await api('collection.prepare',{invoice:target.invoice},409)
   await api('invoice.finalise',{invoice:target.invoice},409)
  }
  await api('portal.configure',{hosts:[h.origin],parents:[]})
  for(const target of [awaiting,approval,active,rejected,withdrawn]){
   const session=await api('portal.session.issue',{customer:target.customer,origin:h.origin,audience:'hosted'})
   assert.equal((await h.raw(`/portal/retry-method-recoveries/${target.recovery.id}?session=${session.token}`,{body:target.acceptance})).status,409)
  }
  assert.equal((await api('automatic.collection.reconcile',{request:uncertain.id})).status,'uncertain','A mismatched replacement amount records no cash')
  assert.equal((await api('invoices/'+uncertain.invoice)).paidCents,0)
  uncertainIntent.amount=10000
  const claimedIntent=edge.intents.get(claimed.recovery.paymentIntentRef).value
  const actualMethod=claimedIntent.payment_method
  claimedIntent.payment_method=claimed.quote.method.paymentMethodRef
  assert.equal((await api('automatic.collection.reconcile',{request:claimed.id})).status,'uncertain','An original card cannot stand in for the actually claimed replacement')
  assert.equal((await api('invoices/'+claimed.invoice)).paidCents,0)
  claimedIntent.payment_method=actualMethod
  assert.equal((await api('automatic.collection.reconcile',{request:claimed.id})).status,'collected','Restored replacement claim reconciles its original captured outcome')
  const concurrent=await Promise.all([api('automatic.collection.reconcile',{request:uncertain.id}),api('automatic.collection.reconcile',{request:uncertain.id})])
  assert.ok(concurrent.every(row=>row.status==='collected'))
  const event='synthetic-nectar-archive-retry-event-1'
  edge.events.set(event,{object:'event',id:event,type:'payment_intent.succeeded',livemode:false,data:{object:claimedIntent}})
  for(let n=0;n<2;n++)await api('automatic.collection.event',{request:claimed.id,event_ref:event})
  await tick();await tick()
  assert.equal(edge.writes.length,writes,'Restoration and replay never repeat a create or replacement confirmation')
  for(const target of targets){
   const invoice=await api('invoices/'+target.invoice),record=await api('customers/'+target.customer)
   const paidCents=[paid,claimed,uncertain].includes(target)?10000:0
   assert.deepEqual([invoice.paidCents,invoice.balanceCents,invoice.allocations.length],[paidCents,10000-paidCents,paidCents?1:0])
   assert.deepEqual([record.ledger.invoicedCents,record.ledger.paidCents,record.ledger.balanceCents,record.ledger.unallocatedCents],[10000,paidCents,10000-paidCents,0])
   assert.equal(record.ledger.payments.length,paidCents?1:0)
   assert.equal(invoice.attempt_count,[paid,claimed,uncertain,refused].includes(target)?2:1)
   assert.equal(invoice.next_payment_attempt,null)
  }
  assert.equal((await api('payments')).length,3)
  assert.equal((await report('billings')).totalCents,90000)
  assert.equal((await report('collections')).totalCents,30000)
  assert.equal((await report('ar')).totalCents,60000)
  const recovered=await api('recovery')
  assert.deepEqual([recovered.totals.failedInvoices,recovered.totals.failedAmountCents,recovered.totals.recoveredAmountCents],[9,90000,30000])
  const erasure=await api('erasure.request',{customer:claimed.customer})
  await api('erasure.verify',{request:erasure.id,reason:'Synthetic independent verification',evidence:file('synthetic-nectar-retry-identity.txt','Synthetic verified identity')})
  await api('erasure.approve',{request:erasure.id,confirm:true})
  await api('automatic.collection.reconcile',{request:claimed.id},404)
  await api('automatic.collection.event',{request:claimed.id,event_ref:event},404)
  await api('retry.method.decide',claimed.decision,404)
  await close()
  await command(root,['export','--output',archive('erased')])
  const erased=await archiveItems(archive('erased'))
  assert.ok(!JSON.stringify(erased).includes(email(954)))
  await command(root,['reset','--yes'])
  assert.match(await command(root,['import','--input',archive('replacement'),'--journal',relative(root,archive('erased')),'--yes'],{refuse:true}),/later_journal|erased_row|erasure_epoch/)
  await command(root,['import','--input',archive('erased'),'--yes'])
  await command(root,['export','--output',archive('erased-restored')])
  assert.deepEqual(facts(await archiveItems(archive('erased-restored'))),facts(erased))
  await open();await tick()
  await api('automatic.collection.reconcile',{request:claimed.id},404)
  assert.equal((await api('invoices/'+claimed.invoice)).paidCents,10000)
  assert.equal((await report('collections')).totalCents,30000)
  assert.equal(edge.writes.length,writes)
  console.log('automaticCollectionRetryArchiveJourney: restored replacement claim identity reconciles once without debit authority; pending consent and approval stay inert; exact money and erasure custody survive real commands')
 }finally{await h?.close();await rm(scratch,{recursive:true,force:true})}
}
if(process.argv[1]===new URL(import.meta.url).pathname){
 const journey=process.argv[2]
 assert.ok(journey===undefined||['automatic','recovery'].includes(journey),'Choose automatic or recovery archive custody')
 if(journey===undefined||journey==='automatic')await automaticCollectionArchiveJourney()
 if(journey===undefined||journey==='recovery')await automaticCollectionRetryArchiveJourney()
}
