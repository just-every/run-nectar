import { seedCloseSources } from './close-tieout.mjs'
// GOV-005: public rer commands over a real populated installation. Use a
// disposable checkout only; the journey deliberately resets and restores it.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { access,appendFile,mkdir,mkdtemp,readFile,rm,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readArchive } from '@runeditrun/rer/modules/portability'
import { command,devKey,signIn } from './cli.mjs'
import { file } from './harness.mjs'
import { applyPolicy } from './policy-helper.mjs'
import { seedPendingPortalChange } from './portal-change-requests.mjs'
import { stripeHistoryCapture } from '../fixtures/stripe-history.mjs'
assert.equal(process.env.NECTAR_TEST_CHECKOUT,'1','Use only a disposable checkout')
const root=process.cwd(),scratch=await mkdtemp(join(tmpdir(),'nectar-erasure-archive-'))
await access(join(root,'.dev.vars')).then(()=>{throw new Error('A fresh unconfigured checkout is required')},e=>{if(e.code!=='ENOENT')throw e})
const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r))
const origin=`http://127.0.0.1:${port}`,entry=import.meta.resolve('@runeditrun/rer/internal/global/rer.mjs').replace('file://','')
let server,cookie,serverOutput=()=>''
async function start(){
 const child=spawn(process.execPath,[entry,'dev','--foreground','--port',String(port)],{cwd:root,stdio:['ignore','pipe','pipe'],env:{...process.env,WRANGLER_SEND_METRICS:'false'}})
 let output='';serverOutput=()=>output;for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{output+=b})
 server=child
 for(let attempt=0;attempt<600;attempt++){assert.equal(child.exitCode,null,'GOV-005 dev remains alive: '+output.replace(/RER_OPEN [^\n]+/g,'RER_OPEN [redacted]').replace(/(token=|rer-dev=|RER_DEV_KEY=)[^&\s"']+/g,'$1[redacted]').slice(-3000));if(output.includes('RER_READY'))break;await new Promise(r=>setTimeout(r,250));assert.ok(attempt<599,'GOV-005 dev becomes ready')}
 console.log('GOV-005 real rer dev ready')
 cookie=await signIn(origin,await devKey(root))
}
async function stop(){if(!server)return;const child=server;server=null;if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Owned dev process did not stop')),30000).unref())])}}
async function api(path,who,body,status=200){const response=await fetch(`${origin}/api/nectar/${path}`,{method:body===undefined?'GET':'POST',headers:{cookie:who??cookie,...(body===undefined?{}:{origin,'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});if(response.status!==status)console.error(serverOutput().replace(/RER_OPEN [^\n]+/g,'RER_OPEN [redacted]').replace(/(token=|rer-dev=|RER_DEV_KEY=)[^&\s"']+/g,'$1[redacted]').slice(-4000));assert.equal(response.status,status,`GOV-005 ${path} status`);return response.json()}
const rows=async path=>{const bytes=await readFile(path),records=[];for await(const record of readArchive(new ReadableStream({start(c){c.enqueue(bytes);c.close()}})))records.push(record);return records}
const items=records=>records.filter(r=>r.kind==='part').flatMap(r=>r.items).map(({index,...item})=>item)
try{
 await mkdir('exports',{recursive:true});await writeFile('exports/erasure-answers.json',JSON.stringify({OWNER_EMAIL:'owner@example.test'}),{mode:0o600})
 await command(root,['setup','--answers','exports/erasure-answers.json','--non-interactive','--port',String(port)])
 await appendFile(join(root,'.dev.vars'),'\nNECTAR_LOCAL_TIME=2026-10-28T09:00:00Z\n')
 await start()
 await fetch(origin+'/setup',{method:'POST',redirect:'manual',headers:{cookie,origin,'content-type':'application/x-www-form-urlencoded'},body:'confirm=yes'})
 await api('business.configure',cookie,{legal_name:'Cedar Software Inc',timezone:'America/Los_Angeles',invoice_prefix:'CD',payment_terms_days:30})
 const h={api,origin,raw:(path,{body,headers={}}={})=>fetch(origin+path,{method:body===undefined?'GET':'POST',redirect:'manual',headers:{...(body===undefined?{}:{origin,'content-type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)})};await applyPolicy(h,cookie,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Reviewed GOV-005 archive journey'})
 await api('tax.review',cookie,{revision:(await api('business',cookie)).revision})
 const closeSources=await seedCloseSources(h,cookie)
 const closeBasis=(await api('close-tieout?period=2026-09',cookie)).basis
 await api('close.scan',cookie,{period:'2026-09',basis:closeBasis,owner:(await api('me',cookie)).id})
 const closeCases=(await api('assurance-cases',cookie)).filter(row=>row.customer_id===closeSources.customer)
 assert.equal(closeCases.length,2,'Close preparation keeps two distinct operational cases before export')
 const capture=Object.fromEntries(await Promise.all(['manifest','customers','products','prices','subscriptions','invoices','meters'].map(async name=>[name,file(`${name}.json`,await readFile(new URL(`../fixtures/stripe/${name}.json`,import.meta.url)),'application/json')])))
 const preview=await api('import.preview',cookie,capture);await api('import.apply',cookie,{...capture,fingerprint:preview.fingerprint})
 const customer=(await api('customers',cookie)).find(c=>c.external_id==='cus_NcAtlasFreight01')
 await api('contact.add',cookie,{customer:customer.id,name:'Amelia Privatecontact',email:'amelia.private@gov005.example'})
 const keyed=await fetch(`${origin}/api/nectar/note.add`,{method:'POST',headers:{cookie,origin,'content-type':'application/json','idempotency-key':'gov005-archive-note'},body:JSON.stringify({kind:'customer',record:customer.id,body:'private imported customer note GOV005'})});assert.equal(keyed.status,200)
 await api('metadata.write',cookie,{kind:'customer',record:customer.id,revision:0,metadata:{private:'private metadata GOV005'}})
 const historyCapture=stripeHistoryCapture()
 const historyFiles=Object.fromEntries(Object.entries(historyCapture).map(([name,value])=>[name,file(`${name}.json`,JSON.stringify(value),'application/json')]))
 const historyPreview=await api('import.preview',cookie,historyFiles);await api('import.apply',cookie,{...historyFiles,fingerprint:historyPreview.fingerprint})
 const historicalCustomer=(await api('customers',cookie)).find(c=>c.external_id==='synthetic-nectar-1')
 const historicRevenue=await api(`revenue?from=2026-07&to=2027-02&customer=${historicalCustomer.id}`,cookie)
 assert.equal(historicRevenue.openingCents,800000)
 const portalChange=await seedPendingPortalChange(h,cookie,customer.id)
 const currentPolicy=(await api('retention',cookie)).policy
 const policy=await api('retention.policy.prepare',cookie,{...currentPolicy,revision:currentPolicy.revision,enabled:true,save_kind:'discount',save_percent:50,save_months:2,winback_enabled:false})
 await api('retention.policy.decide',cookie,{request:policy.request,decision:'approved',confirm_single:true})
 const peer=(await api('customer.create',cookie,{external_id:'synthetic-nectar-archive-peer',name:'Retained peer',billing_email:(await api('me',cookie)).email})).id
 const peerSub=(await api('subscription.create',cookie,{customer:peer,start_date:'2026-01-01',price:[portalChange.prices[0]],quantity:['10']})).id
 const term=await api('term.prepare',cookie,{subscription:peerSub,revision:(await api(`subscriptions/${peerSub}`,cookie)).revision,term_start:'2026-01-01',months:24,auto_renew:true,notice_days:30,uplift_percent:'0'})
 await api('term.decide',cookie,{term:term.term,decision:'approved',confirm_single:true})
 const portalSession=()=>api('portal.session.issue',cookie,{customer:peer,origin,audience:'hosted'})
 const liveSession=await portalSession()
 const renewalPath=session=>`/portal/renewal/${peerSub}?session=${session.token}`
 const view=async session=>{const r=await h.raw(renewalPath(session),{headers:{accept:'application/json'}});assert.equal(r.status,200);return r.json()}
 const liveOffer=await view(liveSession)
 assert.equal(liveOffer.save.percent,50,'A real approved policy permits the live portal save before export')
 await stop()
 const before=join(scratch,'before.rer'),after=join(scratch,'after.rer'),restored=join(scratch,'restored.rer')
 await command(root,['export','--output',before]);assert.ok(JSON.stringify(items(await rows(before))).includes('Amelia Privatecontact'))
 assert.ok(items(await rows(before)).some(item=>item.table==='nc_portal_change_requests'&&item.row.id===portalChange.request.id),'The actual archive includes non-executable pending request evidence')
 assert.ok(!items(await rows(before)).some(i=>i.table==='nc_portal_retention_authority'),'Policy evidence exports without executable portal retention authority')
 assert.ok(items(await rows(before)).some(i=>i.table==='nc_assurance_cases'&&closeCases.some(row=>row.id===i.row.id)),'Close cases export as evidence without financial execution authority')
 assert.ok(!items(await rows(before)).some(i=>i.table==='nc_idempotency'),'DEV-002 the idempotency replay store never enters an archive')
 await start()
 const request=await api('erasure.request',cookie,{customer:customer.id})
 await api('erasure.verify',cookie,{request:request.id,reason:'Billing mailbox unreachable; independently compared signed company records',evidence:file('independent-check.txt','Independent verification of the owner request','text/plain')})
 const erased=await api('erasure.approve',cookie,{request:request.id,confirm:true})
 assert.ok(erased.receipt.changed.some(r=>r.kind==='nc_incumbent_invoices'))
 assert.equal(erased.receipt.changed.find(r=>r.kind==='nc_portal_change_requests').records,1)
 assert.equal((await h.raw(`/portal/change.request?session=${portalChange.session.token}`,{body:portalChange.body})).status,401,'Erasure withdraws the real request capability')
 const day=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(erased.receipt.approvedAt))
 assert.equal(erased.receipt.retained.legacyAnchor,day,'GOV-005 missing legacy issue/payment dates use the approval business-local date')
 assert.match(erased.receipt.retained.legacyDateRule,/unavailable/,'GOV-005 the receipt identifies missing legacy date evidence')
 assert.equal(erased.receipt.retained.until,`${Number(day.slice(0,4))+7}${day.slice(4)}`,'GOV-005 legacy financial custody expires seven calendar years after approval')
 const closeErasure=await api('erasure.request',cookie,{customer:closeSources.customer})
 await api('erasure.verify',cookie,{request:closeErasure.id,reason:'Independent verification of close-source erasure',evidence:file('close-owner.txt','Synthetic independent verification','text/plain')})
 await api('erasure.approve',cookie,{request:closeErasure.id,confirm:true})
 assert.ok(!(await api('assurance-cases',cookie)).some(row=>closeCases.some(old=>old.id===row.id)))
 const historicalRequest=await api('erasure.request',cookie,{customer:historicalCustomer.id})
 await api('erasure.verify',cookie,{request:historicalRequest.id,reason:'Independently checked historical account owner',evidence:file('historical-owner.txt','Signed owner history request','text/plain')})
 const historicalErasure=await api('erasure.approve',cookie,{request:historicalRequest.id,confirm:true})
 assert.equal(historicalErasure.receipt.retained.legacyAnchor,null)
 assert.ok(historicalErasure.receipt.changed.some(row=>row.kind==='nc_incumbent_history'))
 assert.deepEqual((await api(`revenue?from=2026-07&to=2027-02&customer=${historicalCustomer.id}`,cookie)).months,historicRevenue.months)
 await stop();await command(root,['export','--output',after])
 const archived=items(await rows(after)),privateValues=[customer.billing_email,customer.address,customer.external_id,'Amelia Privatecontact','amelia.private@gov005.example','private imported customer note GOV005','private metadata GOV005',historicalCustomer.billing_email,historicalCustomer.external_id,'synthetic-nectar-private-7'].filter(Boolean)
 for(const item of archived){const serialized=JSON.stringify(item);for(const value of privateValues)assert.ok(!serialized.includes(value),`GOV-005 archive ${item.table} removes personal text`)
  if(item.kind==='row')for(const [column,value] of Object.entries(item.row)){if(typeof value==='object'&&value?.blob){const decoded=Buffer.from(value.blob,'base64').toString();for(const personal of privateValues)assert.ok(!decoded.includes(personal),`GOV-005 retained blob ${item.table}.${column} has no erased personal data`)}}
 }
 assert.ok(!archived.some(r=>['nc_assurance_cases','nc_assurance_observations'].includes(r.table)&&r.row?.customer_id===closeSources.customer),'Erased close investigations never restore')
 assert.ok(archived.some(r=>r.table==='nc_ledger_postings'&&r.row?.id===closeSources.posting),'Minimal financial posting custody remains in the archive')
 assert.ok(!archived.some(r=>r.table==='nc_portal_change_requests'),'Erased requests never enter the anonymized restore')
 assert.ok(archived.some(r=>r.kind==='row'&&r.table==='nc_incumbent_revenue'),'MOVE-007 anonymous revenue schedules are in the actual archive')
 assert.ok(archived.some(r=>r.kind==='row'&&r.table==='ik_d1_erasure_journal'),'GOV-005 import custody retirement is journalled')
 await command(root,['reset','--yes'])
 await command(root,['import','--input',before,'--journal',after,'--yes'],{refuse:true})
 await command(root,['import','--input',after,'--yes'])
 await command(root,['export','--output',restored])
 assert.deepEqual(items(await rows(restored)),archived,'GOV-005 the post-erasure archive restores only anonymized records and exact retained financial custody')
 await start()
 assert.equal((await h.raw(renewalPath(liveSession),{headers:{accept:'application/json'}})).status,401,'An archived installation never restores its old customer session')
 const restoredPacket=await api('close-tieout?period=2026-09',cookie)
 assert.ok(!restoredPacket.proofs.some(row=>row.customer===closeSources.customer),'Restoration cannot resurrect an erased close source')
 assert.equal((await api('close.scan',cookie,{period:'2026-09',basis:closeBasis,owner:(await api('me',cookie)).id},409)).error,'close_source_changed')
 const restoredSession=await portalSession(),restoredView=await view(restoredSession)
 assert.equal(restoredView.save,null,'Retained policy evidence cannot restore portal save execution authority')
 assert.equal((await h.raw(renewalPath(restoredSession),{body:{basis:restoredView.basis,confirm:'save',offer:liveOffer.save.id}})).status,409)
 assert.equal((await h.raw(renewalPath(restoredSession),{body:{basis:restoredView.basis,confirm:'cancel'}})).status,200,'Retention reapproval is never required to cancel renewal')
 assert.equal((await api(`subscriptions/${peerSub}`,cookie)).renewal.terms[0].auto_renew,0)
 console.log('GOV-005 real rer export, reset and import, old-archive refusal, anonymous restore and inactive portal retention authority passed')
}finally{await stop();await rm(scratch,{recursive:true,force:true})}
