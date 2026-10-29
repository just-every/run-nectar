// Actual export, reset and import commands over public-door financial fixtures.
import assert from 'node:assert/strict'
import {access,mkdir,mkdtemp,readFile,rm} from 'node:fs/promises'
import {join,relative} from 'node:path'
import {readArchive} from '@runeditrun/rer/modules/portability'
import {command} from './cli.mjs'
import {harness,file} from './harness.mjs'
import {applyPolicy} from './policy-helper.mjs'
import {totp} from './mfa.mjs'
import {invoicePartialEdge,seedPartialInvoice} from './invoice-partial-payments.mjs'

assert.equal(process.env.NECTAR_TEST_CHECKOUT,'1','Use a disposable unconfigured checkout')
const root=process.cwd()
for(const path of ['.dev.vars','.wrangler/state'])await access(join(root,path)).then(()=>{throw new Error('A fresh unconfigured checkout is required')},error=>{if(error.code!=='ENOENT')throw error})
await mkdir('exports',{recursive:true})
const scratch=await mkdtemp(join(root,'exports','partial-archive-'))
const path=name=>join(scratch,`${name}.rer`)
const items=async name=>{
  const bytes=await readFile(path(name)),rows=[]
  for await(const record of readArchive(new ReadableStream({start(c){c.enqueue(bytes);c.close()}})))if(record.kind==='part')rows.push(...record.items.map(({index,...item})=>item))
  return rows
}
const edge=invoicePartialEdge(),at=Date.parse('2026-10-29T12:00:00Z')
let h
try {
  await command(root,['export','--output',path('empty')])
  const config=JSON.parse(await readFile('wrangler.jsonc','utf8')),databaseId=config.d1_databases.find(r=>r.binding==='DB').database_id,persistence=join(root,'.wrangler/state/v3')
  const options={persistence,databaseId,applyMigrations:false,localTime:new Date(at).toISOString(),stripeSecret:'synthetic-nectar-partial-key',stripeFetch:edge.fetch}
  h=await harness(options)
  await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})
  let owner=await h.signIn(h.vars.OWNER_EMAIL)
  await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
  let api=(route,body,status)=>h.api(route,owner,body,status)
  await api('business.configure',{legal_name:'Synthetic archive merchant',timezone:'UTC',invoice_prefix:'SYNTH',payment_terms_days:30})
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Synthetic archive tax review'})
  await api('tax.review',{revision:(await api('business')).revision})
  const enrollment=await api('mfa.totp.start',{});await api('mfa.totp.confirm',{factor:enrollment.factor,code:totp(enrollment.secret,at)})
  await api('portal.configure',{hosts:[h.origin],parents:[]})
  const customers=[],invoices=[],preparations=[],sessions=[]
  for(let n=1;n<=3;n++){
    const customer=(await api('customer.create',{external_id:`synthetic-nectar-partial-archive-${n}`,name:`Synthetic archive customer ${n}`,billing_email:(await api('me')).email})).id
    customers.push(customer);invoices.push(await seedPartialInvoice(h,owner,customer))
    await api('collection.customer.bind',{customer,account_ref:'synthetic-nectar-partial-account',stripe_customer_ref:`synthetic-nectar-archive-customer-${n}`,confirm:true})
    const prepared=await api('invoice.partial.prepare',{invoice:invoices[n-1].id,amount_cents:40000});preparations.push(prepared)
    await api('invoice.partial.confirm',prepared.confirm)
    sessions.push(await api('portal.session.issue',{customer,origin:h.origin,audience:'hosted'}))
  }
  const customerPost=async(n,operation)=>{
    const prepared=preparations[n],body=operation==='start'?{request:prepared.id,basis_hash:prepared.basisHash,accept:true}:{request:prepared.id}
    const response=await h.raw(`/portal/invoice-payment/${operation}?session=${sessions[n].token}`,{body});assert.equal(response.status,200);return response.json()
  }
  await customerPost(0,'start');edge.complete([...edge.sessions.keys()].at(-1));const captured=await customerPost(0,'check')
  edge.lose();assert.equal((await customerPost(1,'start')).status,'uncertain')
  const pendingSession=[...edge.sessions.keys()].at(-1)
  const settings={...h.vars},writes=edge.calls.filter(c=>c.method==='POST').length
  const originalInvoice=await api(`invoices/${invoices[0].id}`),originalReceipt=await api(`payments/${captured.payment}/receipt`)
  await h.close();h=null
  await command(root,['export','--output',path('populated')])
  const archive=await items('populated'),serialized=JSON.stringify(archive)
  for(const table of ['nc_invoice_partial_authority','nc_invoice_partial_returns','nc_portal_sessions','nc_mfa_sessions'])assert.ok(!archive.some(r=>r.table===table),'Archive contains no executable local customer or owner authority')
  for(const secret of ['synthetic-nectar-partial-key',...sessions.map(s=>s.token)])assert.ok(!serialized.includes(secret),'Archive excludes secrets and customer capabilities')
  assert.equal(archive.filter(r=>r.table==='nc_invoice_partial_payments').length,3)
  assert.equal(archive.filter(r=>r.table==='nc_invoice_partial_reservations').length,2,'Uncertain and not-yet-accepted reservations survive as fences')
  await command(root,['reset','--yes'])
  await command(root,['import','--input',path('populated'),'--yes'])
  h=await harness({...options,settings,localTime:'2026-10-29T12:00:30Z'})
  assert.equal((await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Restored owner'}})).status,303)
  owner=await h.signIn(h.vars.OWNER_EMAIL)
  api=(route,body,status)=>h.api(route,owner,body,status)
  await api('mfa.verify',{code:totp(enrollment.secret,at+30000)})
  // The listening origin changes after restart; re-approval of that origin is
  // explicit owner configuration, and does not recreate old payment authority.
  await api('portal.configure',{hosts:[h.origin],parents:[]})
  assert.equal((await h.raw(`/portal/invoice-payment/start?session=${sessions[2].token}`,{body:{request:preparations[2].id,basis_hash:preparations[2].basisHash,accept:true}})).status,401)
  const fresh=await api('portal.session.issue',{customer:customers[2],origin:h.origin,audience:'hosted'})
  const oldAcceptance=await h.raw(`/portal/invoice-payment/start?session=${fresh.token}`,{body:{request:preparations[2].id,basis_hash:preparations[2].basisHash,accept:true}})
  assert.equal(oldAcceptance.status,409,'Restored approved history cannot authorize a new Checkout');await oldAcceptance.text()
  await api('invoice.partial.confirm',preparations[2].confirm,409)
  await api('collection.prepare',{invoice:invoices[2].id},409)
  assert.equal((await api('invoice.partial.reconcile',{request:preparations[0].id})).payment,captured.payment)
  assert.deepEqual(await api(`payments/${captured.payment}/receipt`),originalReceipt,'Restoration preserves receipt identity, allocations and recorded cash')
  for(const key of ['total_cents','source_fingerprint','number','paidCents','balanceCents'])assert.equal((await api(`invoices/${invoices[0].id}`))[key],originalInvoice[key])
  edge.complete(pendingSession)
  const recovered=await api('invoice.partial.reconcile',{request:preparations[1].id})
  assert.equal(recovered.status,'collected');await api('invoice.partial.reconcile',{request:preparations[1].id})
  assert.equal((await api(`invoices/${invoices[1].id}`)).balanceCents,60000)
  assert.equal((await api('reports/collections?period=2026-10')).totalCents,80000)
  assert.equal(edge.calls.filter(c=>c.method==='POST').length,writes,'Restoration and read-only capture reconciliation create no provider write')
  const erasure=await api('erasure.request',{customer:customers[2]})
  await api('erasure.verify',{request:erasure.id,reason:'Independent synthetic archive owner verification',evidence:file('synthetic-owner.txt','Synthetic verified ownership','text/plain')})
  const erased=await api('erasure.approve',{request:erasure.id,confirm:true})
  assert.ok(erased.receipt.changed.some(r=>r.kind==='nc_invoice_partial_payments'))
  await api('invoice.partial.reconcile',{request:preparations[2].id},404)
  const finalSettings={...h.vars}
  await h.close();h=null
  await command(root,['export','--output',path('erased')])
  const after=await items('erased')
  assert.ok(!after.some(r=>['nc_invoice_partial_authority','nc_invoice_partial_returns'].includes(r.table)))
  const retained=after.find(r=>r.table==='nc_invoice_partial_payments'&&r.row.id===preparations[2].id)
  assert.equal(retained.row.status,'withdrawn');assert.equal(retained.row.basis_json,'{}')
  await command(root,['reset','--yes'])
  const refused=await command(root,['import','--input',path('populated'),'--journal',relative(root,path('erased')),'--yes'],{refuse:true})
  assert.match(refused,/later_journal|erased_row|erasure_epoch/)
  await command(root,['import','--input',path('erased'),'--yes'])
  h=await harness({...options,settings:finalSettings,localTime:'2026-10-29T12:01:00Z'})
  assert.equal((await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Restored owner'}})).status,303)
  owner=await h.signIn(h.vars.OWNER_EMAIL)
  await h.api('invoice.partial.reconcile',owner,{request:preparations[2].id},404)
  assert.equal((await h.api('payments',owner)).length,2,'Restored anonymous custody does not invent cash')
  assert.equal(edge.calls.filter(c=>c.method==='POST').length,writes)
  console.log('Partial invoice archive: exact cash and receipt restoration, inert approvals, retained uncertain reservations, read-only original capture, erasure and older-archive refusal passed')
} finally {await h?.close();await rm(scratch,{recursive:true,force:true})}
