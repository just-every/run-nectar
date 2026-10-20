// GOV-005: public rer commands over a real populated installation. Use a
// disposable checkout only; the journey deliberately resets and restores it.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { access,mkdir,mkdtemp,readFile,rm,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readArchive } from '@runeditrun/rer/modules/portability'
import { command,devKey,signIn } from './cli.mjs'
import { file } from './harness.mjs'
import { applyPolicy } from './policy-helper.mjs'
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
 await start()
 await fetch(origin+'/setup',{method:'POST',redirect:'manual',headers:{cookie,origin,'content-type':'application/x-www-form-urlencoded'},body:'confirm=yes'})
 await api('business.configure',cookie,{legal_name:'Cedar Software Inc',timezone:'America/Los_Angeles',invoice_prefix:'CD',payment_terms_days:30})
 const h={api};await applyPolicy(h,cookie,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Reviewed GOV-005 archive journey'})
 await api('tax.review',cookie,{revision:(await api('business',cookie)).revision})
 const capture=Object.fromEntries(await Promise.all(['manifest','customers','products','prices','subscriptions','invoices','meters'].map(async name=>[name,file(`${name}.json`,await readFile(new URL(`../fixtures/stripe/${name}.json`,import.meta.url)),'application/json')])))
 const preview=await api('import.preview',cookie,capture);await api('import.apply',cookie,{...capture,fingerprint:preview.fingerprint})
 const customer=(await api('customers',cookie)).find(c=>c.external_id==='cus_NcAtlasFreight01')
 await api('contact.add',cookie,{customer:customer.id,name:'Amelia Privatecontact',email:'amelia.private@gov005.example'})
 await api('note.add',cookie,{kind:'customer',record:customer.id,body:'private imported customer note GOV005'})
 await api('metadata.write',cookie,{kind:'customer',record:customer.id,revision:0,metadata:{private:'private metadata GOV005'}})
 await stop()
 const before=join(scratch,'before.rer'),after=join(scratch,'after.rer'),restored=join(scratch,'restored.rer')
 await command(root,['export','--output',before]);assert.ok(JSON.stringify(items(await rows(before))).includes('Amelia Privatecontact'))
 await start()
 const request=await api('erasure.request',cookie,{customer:customer.id})
 await api('erasure.verify',cookie,{request:request.id,reason:'Billing mailbox unreachable; independently compared signed company records',evidence:file('independent-check.txt','Independent verification of the owner request','text/plain')})
 const erased=await api('erasure.approve',cookie,{request:request.id,confirm:true})
 assert.ok(erased.receipt.changed.some(r=>r.kind==='nc_incumbent_invoices'))
 const day=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(erased.receipt.approvedAt))
 assert.equal(erased.receipt.retained.legacyAnchor,day,'GOV-005 missing legacy issue/payment dates use the approval business-local date')
 assert.match(erased.receipt.retained.legacyDateRule,/unavailable/,'GOV-005 the receipt identifies missing legacy date evidence')
 assert.equal(erased.receipt.retained.until,`${Number(day.slice(0,4))+7}${day.slice(4)}`,'GOV-005 legacy financial custody expires seven calendar years after approval')
 await stop();await command(root,['export','--output',after])
 const archived=items(await rows(after)),privateValues=[customer.billing_email,customer.address,customer.external_id,'Amelia Privatecontact','amelia.private@gov005.example','private imported customer note GOV005','private metadata GOV005'].filter(Boolean)
 for(const item of archived){const serialized=JSON.stringify(item);for(const value of privateValues)assert.ok(!serialized.includes(value),`GOV-005 archive ${item.table} removes personal text`)
  if(item.kind==='row')for(const [column,value] of Object.entries(item.row)){if(typeof value==='object'&&value?.blob){const decoded=Buffer.from(value.blob,'base64').toString();for(const personal of privateValues)assert.ok(!decoded.includes(personal),`GOV-005 retained blob ${item.table}.${column} has no erased personal data`)}}
 }
 assert.ok(archived.some(r=>r.kind==='row'&&r.table==='ik_d1_erasure_journal'),'GOV-005 import custody retirement is journalled')
 await command(root,['reset','--yes'])
 await command(root,['import','--input',before,'--journal',after,'--yes'],{refuse:true})
 await command(root,['import','--input',after,'--yes'])
 await command(root,['export','--output',restored])
 assert.deepEqual(items(await rows(restored)),archived,'GOV-005 the post-erasure archive restores only anonymized records and exact retained financial custody')
 console.log('GOV-005 real rer export/reset/import, old-archive refusal with later journal, and anonymous restore passed')
}finally{await stop();await rm(scratch,{recursive:true,force:true})}
