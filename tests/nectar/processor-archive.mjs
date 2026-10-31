import { remittanceFile, remittanceFixtures } from './remittance-files.mjs'
import { file } from './harness.mjs'
// Public processor capture, statutory removal and actual rer archive restore.
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { readArchive } from '@runeditrun/rer/modules/portability'
import { harness } from './harness.mjs'
import { command } from './cli.mjs'
import { processorSetup, processorEventFlow } from './processor-events.mjs'
import { processorCashEdge, processorCashFlow } from './processor-cash.mjs'
import { processorCashReturnEdge, processorCashReturnFlow } from './processor-cash-return.mjs'
import { importedCashEdge, processorCashImportedFlow } from './processor-cash-imported.mjs'
import { totp } from './mfa.mjs'

const eventKinds=['nc_processor_events','nc_processor_transactions','nc_processor_objects','nc_processor_failures','nc_processor_reversals']
const cashKinds=['nc_processor_events','nc_processor_cash_applications','nc_processor_cash_balances','nc_processor_cash_transactions','nc_processor_cash_unmatched','nc_processor_cash_escalations']
const returnKinds=['nc_processor_cash_returns']
const importedKinds=['nc_processor_cash_imported_applications','nc_processor_cash_imported_takeovers']
const nativeKinds=[...new Set([...eventKinds,...cashKinds])]
const remittanceKinds=['nc_remittances','nc_remittance_allocations','nc_remittance_origins']
const sourceKinds=[...nativeKinds,...returnKinds,...importedKinds,...remittanceKinds,'nc_remittance_source_keys']
const priorDay=day=>new Date(Date.parse(`${day}T12:00:00Z`)-86400000).toISOString()

/** Reuse in the existing processor journey; targets already passed the real
 * verified erasure door. Receipts count custody which ordinary views conceal. */
export async function processorFinancialRemovalFlow(h,owner,{targets,finance,peer}) {
 const api=(path,body,status)=>h.api(path,owner,body,status)
 const requests=await api('erasures')
 const groups=targets.map(target=>({...target,request:requests.find(row=>row.customer_id===target.customer&&row.status==='complete')}))
 for(const group of groups)assert.ok(group.request?.retain_until,'Issued processor money has a retention deadline')
 groups.sort((a,b)=>a.request.retain_until.localeCompare(b.request.retain_until))
 const peerBefore=peer?await api(`processor-events?customer=${peer}`):null
 if(peerBefore)assert.ok(peerBefore.events.length&&peerBefore.cashApplications.length,'The unaffected peer has real processor custody')
 for(const deadline of [...new Set(groups.map(group=>group.request.retain_until))]) {
  const due=groups.filter(group=>group.request.retain_until===deadline)
  await h.advanceClock(priorDay(deadline))
  await h.api('erasure.purge',finance,{},403)
  assert.deepEqual((await api('erasure.purge',{})).removed,[],'Owner removal refuses premature destruction')
  for(const group of due)if(group.invoice)await api(`invoices/${group.invoice}`)
  await h.advanceClock(`${deadline}T12:00:00Z`)
  await h.api('erasure.purge',finance,{},403)
  const removed=(await api('erasure.purge',{})).removed
  for(const group of due){
   assert.ok(removed.includes(group.request.id),'The owner removes every due group at its deadline')
   if(group.invoice)await api(`invoices/${group.invoice}`,undefined,404)
   const completed=(await api('erasures')).find(row=>row.id===group.request.id)
   const removal=JSON.parse(completed.receipt_json).removal
   for(const kind of group.kinds)assert.ok(removal.records.some(row=>row.kind===kind&&row.records>0),`Due removal includes populated ${kind}`)
   assert.ok(removal.retainedLegalIdentityRemoved)
   assert.ok((await api('audit')).some(row=>row.action==='erasure.financial.remove'&&row.subject===group.request.id))
  }
  if(peerBefore)assert.deepEqual(await api(`processor-events?customer=${peer}`),peerBefore,'Peer processor sources remain exact after each removal')
 }
 assert.deepEqual((await api('erasure.purge',{})).removed,[],'Repeating removal creates no second destruction')
 return groups.map(group=>group.customer)
}

async function archiveItems(path) {
 const bytes=await readFile(path),items=[]
 for await(const record of readArchive(new ReadableStream({start(controller){controller.enqueue(bytes);controller.close()}}))) {
  if(record.kind==='part')items.push(...record.items.map(({index,...item})=>item))
 }
 return items
}
const sources=items=>items.filter(item=>item.kind==='row'&&sourceKinds.includes(item.table))

// Observe the ordinary enrollment response, then present that factor through
// the real verification route after restarting. Secrets never enter archives.
function observeOwnerEnrollment(h,owner,state) {
 const api=h.api
 h.api=async(...args)=>{
  const result=await api(...args)
  if(args[0]==='mfa.totp.start'&&args[1]===owner)state.secret=result.secret
  return result
 }
}
async function restoredOwner(h,state,instant) {
 const owner=await h.signIn(h.vars.OWNER_EMAIL)
 if(state.secret)await h.api('mfa.verify',owner,{code:totp(state.secret,Date.parse(instant))})
 observeOwnerEnrollment(h,owner,state)
 return owner
}

async function erase(h,owner,customer) {
 const email=(await h.api(`customers/${customer}`,owner)).billing_email,start=h.mails.length
 const request=await h.api('erasure.request',owner,{customer})
 const message=h.mails.slice(start).find(mail=>[mail.to].flat().includes(email))
 assert.ok(message,'Erasure verifies the original billing mailbox')
 const path=new URL(`${message.text??''} ${message.html??''}`.match(/https?:\/\/[^\s"<]+\/erase\/[a-f0-9]{64}/)[0]).pathname
 assert.equal((await h.raw(path,{form:new URLSearchParams({confirm:'yes'})})).status,200)
 await h.api('erasure.approve',owner,{request:request.id,confirm:true})
}

// A separate live customer proves the sweep does not consume another customer's
// applications, observed balance or transfer history in the same account.
async function cashPeer(h,owner,edge) {
 const api=(path,body)=>h.api(path,owner,body)
 const customer=(await api('customer.create',{external_id:'synthetic-nectar-91',name:'Synthetic peer',billing_email:'synthetic-nectar-91@example.test'})).id
 const charge=(await api('charge.add',{customer,amount:'90',description:'Peer service',effective_date:'2026-10-28',taxable:false})).charge
 const invoice=(await api('invoice.manual',{customer,charges:[charge],service_date:'2026-10-28'})).id
 await api('invoice.approve',{invoice,acknowledge:true})
 await api('invoice.finalise',{invoice,issue_date:'2026-10-28'})
 const remote='synthetic-nectar-native-customer-3',account_ref='synthetic-nectar-native-account-1'
 await api('collection.customer.bind',{customer,account_ref,stripe_customer_ref:remote,confirm:true})
 const issued=await api(`invoices/${invoice}`)
 await api('processor.event.consume',{account_ref,event_ref:edge.fund(remote,9500,issued.number)})
 assert.equal((await api(`invoices/${invoice}`)).paidCents,9000)
 return customer
}

export async function processorArchiveJourney() {
 assert.equal(process.env.NECTAR_TEST_CHECKOUT,'1','Use only a disposable checkout: this journey resets local state')
 const root=process.cwd()
 // Never reset an existing local installation, even when the opt-in is present.
 for(const path of ['.dev.vars','.wrangler/state'])await access(join(root,path)).then(()=>{throw new Error('A fresh unconfigured checkout is required')},error=>{if(error.code!=='ENOENT')throw error})
 await mkdir(join(root,'exports'),{recursive:true})
 const scratch=await mkdtemp(join(root,'exports','processor-archive-'))
 const empty=join(scratch,'empty.rer'),populated=join(scratch,'populated.rer'),purged=join(scratch,'purged.rer')
 const restored=join(scratch,'restored.rer'),restoredPurged=join(scratch,'restored-purged.rer')
 let h
 try {
  // Let the real CLI create and ledger every migration before the Worker opens
  // exactly that binding. Product rows are created exclusively through HTTP.
  const only=process.argv[2]
  const config=JSON.parse(await readFile(join(root,'wrangler.jsonc'),'utf8'))
  const persistence=join(root,'.wrangler/state/v3'),databaseId=config.d1_databases.find(binding=>binding.binding==='DB').database_id
  if(!only){
  await command(root,['export','--output',empty])
  const setup=await processorSetup(undefined,{persistence,databaseId,applyMigrations:false})
  h=setup.h
  const {owner,edge}=setup
  const enrollment={}
  observeOwnerEnrollment(h,owner,enrollment)
  const events=await processorEventFlow(h,owner,edge)
  const cashEdge=processorCashEdge()
  // A second runtime swaps only the paid network edge, sharing the same real
  // installation. No SQL copies, injected business rows or alternate API exist.
  let settings={...h.vars}
  await h.close();h=null
  h=await harness({assets:true,persistence,databaseId,applyMigrations:false,settings,localTime:'2026-10-28T10:00:00Z',stripeFetch:cashEdge.fetch,stripeSecret:'synthetic-nectar-1',stripeSecondarySecret:'synthetic-nectar-2'})
  const cashOwner=await restoredOwner(h,enrollment,'2026-10-28T10:00:00Z')
  const cash=await processorCashFlow(h,cashOwner,{cashEdge})
  const peer=await cashPeer(h,cashOwner,cashEdge)
  await erase(h,cashOwner,cash.customer)
  settings={...h.vars};await h.close();h=null
  await command(root,['export','--output',populated])
  const before=await archiveItems(populated),captured=sources(before)
  for(const kind of nativeKinds)assert.ok(captured.some(item=>item.table===kind),`Actual archive includes populated ${kind}`)
  for(const customer of [events.customer,cash.customer])assert.ok(captured.some(item=>item.row.customer_id===customer),'Erased financial custody remains in the archive until due')
  h=await harness({assets:true,persistence,databaseId,applyMigrations:false,settings,localTime:'2027-01-13T12:00:00Z'})
  const removalOwner=await restoredOwner(h,enrollment,'2027-01-13T12:00:00Z')
  const finance=await h.signIn(events.people.finance.email)
  const removed=await processorFinancialRemovalFlow(h,removalOwner,{finance,peer,targets:[{customer:events.customer,invoice:events.invoice,kinds:eventKinds},{customer:cash.customer,invoice:cash.invoices[0],kinds:cashKinds}]})
  await h.close();h=null
  await command(root,['export','--output',purged])
  const after=await archiveItems(purged)
  assert.ok(!sources(after).some(item=>removed.includes(item.row.customer_id)),'A real export proves no due processor custody survives hidden in storage')
  assert.deepEqual(sources(after),captured.filter(item=>!removed.includes(item.row.customer_id)),'Every peer and account-level processor source remains exact')
  await command(root,['reset','--yes'])
  await command(root,['import','--input',populated,'--yes'])
  await command(root,['export','--output',restored])
  assert.deepEqual(sources(await archiveItems(restored)),captured,'Actual rer restore preserves every populated processor source exactly')
  await command(root,['reset','--yes'])
  const refused=await command(root,['import','--input',populated,'--journal',relative(root,purged),'--yes'],{refuse:true})
  assert.match(refused,/later_journal|erased_row|erasure_epoch/,'The trusted later journal refuses older financial custody for a privacy reason')
  await command(root,['import','--input',purged,'--yes'])
  await command(root,['export','--output',restoredPurged])
  assert.deepEqual(sources(await archiveItems(restoredPurged)),sources(after),'Restoring the post-removal archive cannot resurrect purged processor custody')
  }
  if(!only||only==='returns')await additionalArchivePhase(root,scratch,{label:'returns',persistence,databaseId,edge:processorCashReturnEdge(),requiredKinds:returnKinds,
   async populate(worker,who,provider){
    const result=await processorCashReturnFlow(worker,who,{cashReturnEdge:provider})
    const peer=await cashPeer(worker,who,provider)
    await erase(worker,who,result.customer)
    return {customer:result.customer,peer,financeEmail:'synthetic-nectar-return-finance@example.test'}
   }})
  if(!only||only==='imported')await additionalArchivePhase(root,scratch,{label:'imported',persistence,databaseId,edge:importedCashEdge(),requiredKinds:importedKinds,localTime:'2026-10-28T10:00:00Z',
   async populate(worker,who,provider){
    const result=await processorCashImportedFlow(worker,who,{cashEdge:provider,keepFinancial:true})
    await worker.api('access.give',who,{email:'synthetic-nectar-archive-finance@example.test',name:'Archive finance',role:'finance'})
    await worker.signIn('synthetic-nectar-archive-finance@example.test',{requested:true})
    return {...result,financeEmail:'synthetic-nectar-archive-finance@example.test'}
   }})
  if(only==='remittances')await additionalArchivePhase(root,scratch,{label:'remittances',persistence,databaseId,edge:processorCashEdge(),requiredKinds:remittanceKinds,localTime:'2026-10-28T10:00:00Z',
   async populate(worker,who){
    const api=(path,body,status)=>worker.api(path,who,body,status)
    const {customer,issue}=await remittanceFixtures(worker,who),invoice=await issue('10.00')
    const source=remittanceFile([['synthetic-nectar-930','2026-10-15','USD','25.00','synthetic-nectar-901','','']])
    const receipt=(await api('remittance.upload',{file:source})).id
    const prepared=await api('remittance.preview',{receipt})
    const confirmed=await api('remittance.confirm',{receipt,fingerprint:prepared.fingerprint,confirm:true})
    const bank=await api('bank.deposit.upload',{bank_source_id:'synthetic-nectar-937',file:source})
    const bankPreview=await api('remittance.preview',{receipt:bank.id,source:bank.source})
    assert.equal((await api('remittance.confirm',{receipt:bank.id,source:bank.source,fingerprint:bankPreview.fingerprint,confirm:true})).payment,confirmed.payment)
    assert.equal((await api(`payments/${confirmed.payment}/receipt`)).recordedSources.length,2)
    const allocation=await api('remittance.allocate.preview',{receipt,invoice:invoice.id,amount:'10.00'})
    await api('remittance.allocate',{receipt,invoice:invoice.id,amount:'10.00',fingerprint:allocation.fingerprint,confirm:true})
    const financeEmail=['synthetic-nectar-931','example.test'].join('@')
    await api('access.give',{email:financeEmail,name:'Synthetic finance',role:'finance'})
    await worker.signIn(financeEmail,{requested:true})
    const request=await api('erasure.request',{customer})
    await api('erasure.verify',{request:request.id,reason:'Independent archive customer verification',evidence:file('synthetic-nectar-932.txt','Synthetic signed verification')})
    await api('erasure.approve',{request:request.id,confirm:true})
    await worker.assertStorageExcludes(['synthetic-nectar-901','synthetic-nectar-930'])
    return {customer,financeEmail,async restoreCheck(restored,owner,removed=false){
     await restored.api('remittance.upload',owner,{file:source},409)
     await restored.api('bank.deposit.upload',owner,{bank_source_id:'synthetic-nectar-937',file:source},409)
     await restored.api('remittance.confirm',owner,{receipt,fingerprint:prepared.fingerprint,confirm:true},removed?404:409)
     const payments=await restored.api('payments',owner)
     assert.equal(payments.filter(p=>p.customer_id===customer).length,removed?0:1)
     if(!removed)assert.equal(payments.find(p=>p.id===confirmed.payment).amount_cents,2500)
    }}
   }})
  console.log(`Processor archive${only?` ${only} phase`:''}: public capture, exact rer restore, owner-only due removal, unchanged peers and older-archive refusal passed`)
 } finally {await h?.close();await rm(scratch,{recursive:true,force:true})}
}

// Return-only and imported originals need separate installations: their real
// frozen report journeys each reserve the owner's one October snapshot.
async function additionalArchivePhase(root,scratch,{label,persistence,databaseId,edge,requiredKinds,populate,localTime}) {
 const path=name=>join(scratch,`${label}-${name}.rer`)
 let h
 try {
  await command(root,['reset','--yes'])
  await command(root,['export','--output',path('empty')])
  const setup=await processorSetup(edge,{persistence,databaseId,applyMigrations:false,...localTime?{localTime}:{}})
  h=setup.h
  const enrollment={};observeOwnerEnrollment(h,setup.owner,enrollment)
  const target=await populate(h,setup.owner,edge)
  const settings={...h.vars}
  await h.close();h=null
  await command(root,['export','--output',path('populated')])
  const captured=sources(await archiveItems(path('populated')))
  for(const kind of requiredKinds)assert.ok(captured.some(item=>item.table===kind&&item.row.customer_id===target.customer),`Actual ${label} archive includes populated ${kind}`)
  h=await harness({assets:true,persistence,databaseId,applyMigrations:false,settings,localTime:'2026-11-02T12:00:00Z'})
  const owner=await restoredOwner(h,enrollment,'2026-11-02T12:00:00Z'),finance=await h.signIn(target.financeEmail)
  await processorFinancialRemovalFlow(h,owner,{finance,peer:target.peer,targets:[{customer:target.customer,kinds:requiredKinds}]})
  if(target.restoreCheck)await target.restoreCheck(h,owner,true)
  await h.close();h=null
  await command(root,['export','--output',path('purged')])
  const removed=sources(await archiveItems(path('purged')))
  assert.ok(!removed.some(item=>item.row.customer_id===target.customer),`Actual ${label} export contains no expired processor custody`)
  assert.deepEqual(removed,captured.filter(item=>item.row.customer_id!==target.customer),`${label} removal preserves all peer processor sources`)
  await command(root,['reset','--yes'])
  await command(root,['import','--input',path('populated'),'--yes'])
  await command(root,['export','--output',path('restored')])
  assert.deepEqual(sources(await archiveItems(path('restored'))),captured,`Actual rer restore preserves every populated ${label} processor source`)
  if(target.restoreCheck){
   h=await harness({assets:true,persistence,databaseId,applyMigrations:false,settings,localTime:'2026-11-02T12:00:00Z'})
   assert.equal((await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Restored owner'}})).status,303)
   await target.restoreCheck(h,await restoredOwner(h,enrollment,'2026-11-02T12:00:00Z'))
  }
 } finally {await h?.close()}
}

if(process.argv[1]===new URL(import.meta.url).pathname){
 await processorArchiveJourney()
 if(!process.argv[2])await (await import('./automatic-collection-archive.mjs')).isolatedAutomaticCollectionArchiveJourney()
}
