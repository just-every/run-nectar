import { seedPendingPortalChange } from './portal-change-requests.mjs'
import { createServer } from 'node:net'
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readArchive } from '@runeditrun/rer/modules/portability'
import { command } from './cli.mjs'
import { harness } from './harness.mjs'
import { applyPolicy } from './policy-helper.mjs'
import { totp } from './mfa.mjs'

assert.equal(process.env.NECTAR_TEST_CHECKOUT,'1','Recovery needs a disposable checkout')

const smoke=process.argv.includes('--smoke')
const root=process.cwd()
const socket=createServer()
await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve))
const port=socket.address().port
await new Promise(resolve=>socket.close(resolve))

let instant='2026-10-28T12:00:00Z'

await mkdir('exports',{recursive:true})

const setup=()=>command(root,['setup','--owner-email','owner@example.test','--non-interactive','--port',String(port)])

const rows=async path=>{
 const bytes=await readFile(path),items=[]
 for await(const record of readArchive(new ReadableStream({start(c){c.enqueue(bytes);c.close()}}))) {
  if(record.kind==='part')items.push(...record.items.map(({index,...item})=>item))
 }
 return items
}

const mfaKey=async()=>{const text=await readFile('.dev.vars','utf8');const value=text.match(/^MFA_KEY=(.+)$/m)?.[1];assert.ok(value,'Setup provides a factor sealing key');return value}

await setup()

const originalKey=await mfaKey()

const config=JSON.parse(await readFile('wrangler.jsonc','utf8'))

const databaseId=config.d1_databases.find(binding=>binding.binding==='DB').database_id

let h,owner,factor

async function start(key=originalKey){
 instant=new Date(Date.parse(instant)+60_000).toISOString()
 h=await harness({persistence:join(root,'.wrangler/state/v3'),databaseId,applyMigrations:false,localTime:instant,settings:{MFA_KEY:key}})
 owner=await h.signIn(h.vars.OWNER_EMAIL)
 await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
}

async function stop(){await h?.close();h=null}

const api=(path,body,status)=>h.api(path,owner,body,status)

const before='exports/before-erasure.rer',after='exports/erased.rer',restored='exports/restored.rer'

try {
 await start()
 await api('business.configure',{legal_name:'Cedar Software Inc',timezone:'UTC',invoice_prefix:'CD',payment_terms_days:30})
 await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'flat_rate',tax_rate:'10',tax_note:'Reviewed recovery billing'})
 await api('tax.review',{revision:(await api('business')).revision})
 const customer=(await api('customer.create',{external_id:'RECOVERY-PRIVATE',name:'Marigold Private LLC',billing_email:'private@recovery.example',address:'Private home address'})).id
 const product=(await api('product.create',{code:'recovery-service',name:'Recovery service'})).id
 const price=(await api('price.create',{product,kind:'flat',unit_amount:'100',taxable:true})).id
 await api('subscription.create',{customer,start_date:'2026-09-01',price:[price]})
 const run=(await api('billrun.prepare',{period:'2026-09'})).id
 const invoice=(await api(`runs/${run}`)).invoices.find(row=>row.customer_id===customer).id
 await api('invoice.approve',{invoice,acknowledge:true})
 await api('invoice.finalise',{invoice,issue_date:'2026-10-28'})
 await api('credit.issue',{invoice,amount:'10',reason:'Service adjustment'})
 const payment=(await api('payment.record',{customer,amount:'100',received_on:'2026-10-28',method:'bank_transfer',reference:'RECOVERY-WIRE'})).payment
 await api('payment.allocate',{payment,invoice,amount:'100'})
 const issued=await api(`invoices/${invoice}`)
 assert.deepEqual([issued.total_cents,issued.tax_cents,issued.balanceCents],[11000,1000,0])
 await api('note.add',{kind:'customer',record:customer,body:'Private recovery note'})
 await api('metadata.write',{kind:'customer',record:customer,revision:0,metadata:{private:'Private recovery metadata'}})
 const portalChange=await seedPendingPortalChange(h,owner,customer)
 await api('mfa.policy',{scope:'all'})
 factor=await api('mfa.totp.start',{})
 await api('mfa.totp.confirm',{factor:factor.factor,code:totp(factor.secret,Date.parse(instant))})
 await stop()
 if(smoke) {
  await command(root,['export','--output',after])
  const archived=await rows(after)
  assert.ok(!archived.some(row=>row.table==='nc_portal_sessions'),'Customer runtime sessions stay out of portable archives')
  assert.ok(archived.some(row=>row.table==='nc_invoices'&&row.row.id===invoice))
  assert.ok(!JSON.stringify(archived).includes(factor.secret),'The exported factor stays sealed')
  await command(root,['reset','--yes'])
  await command(root,['import','--input',after,'--yes'])
  await command(root,['export','--output',restored])
  assert.deepEqual(await rows(restored),archived,'Every portable row survives real CLI export/reset/import')
  await setup()
  await start()
  await api('mfa.verify',{code:totp(factor.secret,Date.parse(instant))})
  assert.equal((await h.raw(`/portal/data?session=${portalChange.session.token}`)).status,401,'Restore never revives an old customer capability')
  const restoredInvoice=await api(`invoices/${invoice}`)
  assert.deepEqual([restoredInvoice.total_cents,restoredInvoice.tax_cents,restoredInvoice.balanceCents],[11000,1000,0])
  assert.equal(restoredInvoice.calculation.fingerprint,issued.calculation.fingerprint)
  console.log('JOURNEY PASS public CLI billing export/reset/import and restored identity')
 } else {
 await command(root,['export','--output','public/exposed.rer'],{refuse:true})
 console.log('RECOVERY archive')
 await command(root,['export','--output',before])
 const original=await rows(before)
 assert.ok(original.some(item=>item.table==='nc_portal_change_requests'&&item.row.id===portalChange.request.id),'Actual archive retains pending request evidence')
 assert.ok(JSON.stringify(original).includes('Private recovery note'))
 assert.ok(original.some(row=>row.table==='nc_mfa_factors'&&row.row.sealed_secret))
 assert.ok(!JSON.stringify(original).includes(factor.secret),'Factor plaintext stays out of the real archive')
 assert.ok(!JSON.stringify(original).includes(originalKey),'The sealing key stays in the installation')
 await start()
 await api('mfa.verify',{code:totp(factor.secret,Date.parse(instant))})
 const request=await api('erasure.request',{customer})
 const mail=h.mails.findLast(mail=>String(mail.text).includes('/erase/'))
 assert.deepEqual(mail.to,['private@recovery.example'])
 const path=new URL(mail.text.match(/https?:\/\/[^\s]+\/erase\/[a-f0-9]+/)[0]).pathname
 assert.equal((await h.raw(path,{form:new URLSearchParams({confirm:'yes'})})).status,200)
 assert.equal((await h.raw(path,{form:new URLSearchParams({confirm:'yes'})})).status,404)
 const verified=await api(`invoices/${invoice}`)
 assert.deepEqual(verified,issued,'Verification alone changes no financial evidence')
 const erasedReceipt=await api('erasure.approve',{request:request.id,confirm:true})
 assert.equal(erasedReceipt.receipt.changed.find(row=>row.kind==='nc_portal_change_requests').records,1)
 assert.equal((await h.raw(`/portal/change.request?session=${portalChange.session.token}`,{body:portalChange.body})).status,401,'Erasure withdraws the request capability')
 const retained=await api(`invoices/${invoice}`)
 assert.deepEqual([retained.total_cents,retained.tax_cents,retained.balanceCents],[11000,1000,0])
 assert.ok(!JSON.stringify(await api(`customers/${customer}`)).includes('Private recovery note'))
 await stop()
 console.log('RECOVERY archive')
 await command(root,['export','--output',after])
 const erased=await rows(after),serialized=JSON.stringify(erased)
 assert.ok(!erased.some(row=>row.table==='nc_portal_sessions'),'Customer runtime sessions stay out of privacy archives')
 assert.ok(!erased.some(row=>row.table==='nc_portal_change_requests'),'Erased requests never enter the anonymized restore')
 for(const value of ['private@recovery.example','RECOVERY-PRIVATE','Private home address','Private recovery note','Private recovery metadata'])assert.ok(!serialized.includes(value),'Erased personal data stays out of the real archive')
 assert.ok(erased.some(row=>row.table==='ik_d1_erasure_journal'))
 console.log('RECOVERY restore')
 await command(root,['reset','--yes'])
 await command(root,['import','--input',before,'--journal',after,'--yes'],{refuse:true})
 await command(root,['import','--input',after,'--yes'])
 await command(root,['import','--input',after,'--yes'],{refuse:true})
 await command(root,['export','--output',restored])
 assert.deepEqual(await rows(restored),erased,'Every portable row survives restore without resurrecting personal data')
 // Reapplying the declared setup upgrades the restored installation and keeps
 // its domain and applied migrations; a new factor key cannot open the factor.
 console.log('RECOVERY upgrade')
 await setup()
 const newKey=await mfaKey()
 await start(newKey)
 const held=await api('customers',undefined,403)
 assert.deepEqual([held.error,held.detail.reason],['mfa_enrollment_required','mfa_key_changed'])
 await stop()
 await start(originalKey)
 await api('mfa.verify',{code:totp(factor.secret,Date.parse(instant))})
 assert.equal((await h.raw(`/portal/data?session=${portalChange.session.token}`)).status,401,'Anonymized restore never revives an erased customer capability')
 await api('portal.session.issue',{customer,origin:h.origin,audience:'hosted'},404)
 const restoredInvoice=await api(`invoices/${invoice}`)
 assert.deepEqual([restoredInvoice.total_cents,restoredInvoice.tax_cents,restoredInvoice.balanceCents],[11000,1000,0])
 assert.deepEqual(restoredInvoice.calculation,retained.calculation,'Restore preserves the exact anonymized financial evidence')
 await stop()
 console.log('JOURNEY PASS public CLI billing, erasure, restore, MFA custody and setup upgrade')
 }
} finally {await stop()}
