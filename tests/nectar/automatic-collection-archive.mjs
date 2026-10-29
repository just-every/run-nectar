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
import { totp } from './mfa.mjs'

const day='2026-10-22',instant=day+'T10:00:00Z'
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
  for(const customer of customers){
   const record=await api('customers/'+customer)
   const issued=record.billingRecord.automaticCollections.filter(row=>['collected','uncertain','active'].includes(row.status))
   const paidCount=final.filter(row=>row.customer===customer&&row.status==='collected').length
   assert.equal(record.ledger.paidCents,paidCount*10000)
   assert.ok(issued.length)
  }
  assert.equal((await api('payments')).length,4)
  assert.equal((await api('reports/collections?period=2026-10')).totalCents,40000)
  const erasure=await api('erasure.request',{customer:customers[1]})
  await api('erasure.verify',{request:erasure.id,reason:'Synthetic independent account verification',evidence:file('synthetic-nectar-933.txt','Synthetic signed identity verification')})
  await api('erasure.approve',{request:erasure.id,confirm:true})
  await api('automatic.collection.reconcile',{request:bank.id},404)
  await api('automatic.collection.event',{request:bank.id,event_ref:event},404)
  const erasedInvoice=await api('invoices/'+bank.invoice)
  assert.equal(erasedInvoice.paidCents,10000);assert.equal(erasedInvoice.balanceCents,0)
  await close()
  await command(root,['export','--output',archive('erased')])
  const erasedItems=await archiveItems(archive('erased'))
  assert.ok(!JSON.stringify(erasedItems).includes(email(3)))
  assert.equal(attempts(erasedItems).find(row=>row.id===bank.id).amount_cents,10000)
  await command(root,['reset','--yes'])
  const refused=await command(root,['import','--input',archive('pending'),'--journal',relative(root,archive('erased')),'--yes'],{refuse:true})
  assert.match(refused,/later_journal|erased_row|erasure_epoch/)
  await command(root,['import','--input',archive('erased'),'--yes'])
  await command(root,['export','--output',archive('erased-restored')])
  assert.deepEqual(custody(await archiveItems(archive('erased-restored'))),custody(erasedItems),'Anonymized financial custody restores exactly')
  await open('2026-10-28T10:01:00Z')
  await api('automatic.collection.reconcile',{request:bank.id},404)
  assert.equal((await h.raw(`/portal/automatic-collections/${bank.id}?session=${bank.session.token}`)).status,401)
  await tick()
  assert.equal((await api('invoices/'+bank.invoice)).paidCents,10000)
  assert.equal(writes(),writeCount,'Erasure and anonymized restoration revive no provider write')
  console.log('automaticCollectionArchiveJourney: real export, reset and import preserve claimed, uncertain, pending ACH and collected custody; restored authority is inert; reads reconcile original cash once; erasure checkpoints refuse older archives')
 }finally{await h?.close();await rm(scratch,{recursive:true,force:true})}
}
if(process.argv[1]===new URL(import.meta.url).pathname)await automaticCollectionArchiveJourney()
