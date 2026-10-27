// Public processor capture, statutory removal and actual rer archive restore.
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { readArchive } from '@runeditrun/rer/modules/portability'
import { harness } from './harness.mjs'
import { command } from './cli.mjs'
import { processorSetup, processorEventFlow } from './processor-events.mjs'
import { processorCashEdge, processorCashFlow } from './processor-cash.mjs'

const eventKinds=['nc_processor_events','nc_processor_transactions','nc_processor_objects','nc_processor_failures','nc_processor_reversals']
const cashKinds=['nc_processor_events','nc_processor_cash_applications','nc_processor_cash_balances','nc_processor_cash_transactions']
const sourceKinds=[...new Set([...eventKinds,...cashKinds])]
const priorDay=day=>new Date(Date.parse(`${day}T12:00:00Z`)-86400000).toISOString()

/** Reuse in the existing processor journey; targets already passed the real
 * verified erasure door. Receipts count custody which ordinary views conceal. */
export async function processorFinancialRemovalFlow(h,owner,{targets,finance,peer}) {
 const api=(path,body,status)=>h.api(path,owner,body,status)
 const requests=await api('erasures')
 const groups=targets.map(target=>({...target,request:requests.find(row=>row.customer_id===target.customer&&row.status==='complete')}))
 for(const group of groups)assert.ok(group.request?.retain_until,'Issued processor money has a retention deadline')
 groups.sort((a,b)=>a.request.retain_until.localeCompare(b.request.retain_until))
 const peerBefore=await api(`processor-events?customer=${peer}`)
 assert.ok(peerBefore.events.length&&peerBefore.cashApplications.length,'The unaffected peer has real processor custody')
 await h.advanceClock(priorDay(groups[0].request.retain_until))
 await h.api('erasure.purge',finance,{},403)
 assert.deepEqual((await api('erasure.purge',{})).removed,[],'Owner removal refuses premature destruction')
 for(const target of groups)await api(`invoices/${target.invoice}`)
 for(const group of groups) {
  await h.advanceClock(`${group.request.retain_until}T12:00:00Z`)
  await h.api('erasure.purge',finance,{},403)
  assert.ok((await api('erasure.purge',{})).removed.includes(group.request.id),'The owner removes the due group at its deadline')
  await api(`invoices/${group.invoice}`,undefined,404)
  const completed=(await api('erasures')).find(row=>row.id===group.request.id)
  const removal=JSON.parse(completed.receipt_json).removal
  for(const kind of group.kinds)assert.ok(removal.records.some(row=>row.kind===kind&&row.records>0),`Due removal includes populated ${kind}`)
  assert.ok(removal.retainedLegalIdentityRemoved)
  assert.deepEqual(await api(`processor-events?customer=${peer}`),peerBefore,'Peer processor sources remain exact after each removal')
  assert.ok((await api('audit')).some(row=>row.action==='erasure.financial.remove'&&row.subject===group.request.id))
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
  await command(root,['export','--output',empty])
  const config=JSON.parse(await readFile(join(root,'wrangler.jsonc'),'utf8'))
  const persistence=join(root,'.wrangler/state/v3'),databaseId=config.d1_databases.find(binding=>binding.binding==='DB').database_id
  const setup=await processorSetup(undefined,{persistence,databaseId,applyMigrations:false})
  h=setup.h
  const {owner,edge}=setup
  const events=await processorEventFlow(h,owner,edge)
  const cashEdge=processorCashEdge()
  // A second runtime swaps only the paid network edge, sharing the same real
  // installation. No SQL copies, injected business rows or alternate API exist.
  await h.close();h=null
  h=await harness({assets:true,persistence,databaseId,applyMigrations:false,localTime:'2026-10-28T10:00:00Z',stripeFetch:cashEdge.fetch,stripeSecret:'synthetic-nectar-1',stripeSecondarySecret:'synthetic-nectar-2'})
  const cashOwner=await h.signIn(h.vars.OWNER_EMAIL)
  const cash=await processorCashFlow(h,cashOwner,{cashEdge})
  const peer=await cashPeer(h,cashOwner,cashEdge)
  await erase(h,cashOwner,cash.customer)
  await h.close();h=null
  await command(root,['export','--output',populated])
  const before=await archiveItems(populated),captured=sources(before)
  for(const kind of sourceKinds)assert.ok(captured.some(item=>item.table===kind),`Actual archive includes populated ${kind}`)
  for(const customer of [events.customer,cash.customer])assert.ok(captured.some(item=>item.row.customer_id===customer),'Erased financial custody remains in the archive until due')
  h=await harness({assets:true,persistence,databaseId,applyMigrations:false,localTime:'2026-10-29T12:00:00Z'})
  const removalOwner=await h.signIn(h.vars.OWNER_EMAIL)
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
  console.log('Processor archive: public capture, exact rer restore, owner-only due removal, unchanged peers and older-archive refusal passed')
 } finally {await h?.close();await rm(scratch,{recursive:true,force:true})}
}

if(process.argv[1]===new URL(import.meta.url).pathname)await processorArchiveJourney()
