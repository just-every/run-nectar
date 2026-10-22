// Outside push Verify: real rer export/reset/import/export of a populated
// disposable installation. Endpoint secrets and operational outbox never ship.
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {readArchive} from '@runeditrun/rer/modules/portability'
import {harness} from './harness.mjs'
import {webhooksFlow,harnessOptions} from './webhooks.mjs'
import {command} from './cli.mjs'
import {applyPolicy} from './policy-helper.mjs'
assert.equal(process.env.NECTAR_TEST_CHECKOUT,'1','Only an owned disposable checkout may be reset')
const root=process.cwd(),scratch=await mkdtemp(join(tmpdir(),'nectar-webhook-restore-'))
const persistence=resolve('.wrangler/state/v3/d1'),databaseId='local-nectar-only'
const operational=new Set(['nc_webhook_endpoints','nc_webhook_events','nc_webhook_deliveries','nc_webhook_attempts','nc_webhook_entitlement_state','nc_webhook_observation_cursor','nc_webhook_subscription_revisions','nc_webhook_invoice_settlements'])
const items=async path=>{const records=[];const bytes=await readFile(path);for await(const r of readArchive(new ReadableStream({start(c){c.enqueue(bytes);c.close()}})))if(r.kind==='part')records.push(...r.items.map(({index,...item})=>item));return records}
let h
try{
 // Wrangler owns migration history in the same canonical state RER exports.
 await promisify(execFile)(process.execPath,['node_modules/wrangler/bin/wrangler.js','d1','migrations','apply','nectar','--local','--persist-to','.wrangler/state','--config','wrangler.jsonc'],{maxBuffer:16*1024**2,env:{...process.env,CI:'1',WRANGLER_SEND_METRICS:'false'}})
 h=await harness({...harnessOptions(),persistence,databaseId,applyMigrations:false})
 await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})
 const owner=await h.signIn(h.vars.OWNER_EMAIL)
 await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
 await h.api('business.configure',owner,{legal_name:'Synthetic restored webhook business',timezone:'UTC',invoice_prefix:'RESTORE',payment_terms_days:30})
 await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Synthetic archive journey'})
 await h.api('tax.review',owner,{revision:(await h.api('business',owner)).revision})
 await webhooksFlow(h,owner)
 const populated=await h.api('webhooks',owner)
 assert.ok(populated.endpoints.some(e=>e.enabled));assert.ok(populated.deliveries.length>0)
 await h.close();h=null
 const beforeFile=join(scratch,'before.rer'),afterFile=join(scratch,'after.rer')
 await command(root,['export','--output',beforeFile])
 const before=await items(beforeFile)
 assert.ok(!before.some(r=>r.kind==='row'&&operational.has(r.table)),'no endpoint, key, outbox or attempt row is portable')
 const metadata=before.filter(r=>r.kind==='row'&&r.table==='nc_metadata_revisions')
 assert.deepEqual([...new Set(metadata.map(r=>r.row.kind))].sort(),['credit-note','customer','invoice','payment','price','subscription'])
 assert.ok(metadata.some(r=>r.row.revision>1),'the populated financial maps include history')
 assert.ok(before.some(r=>r.kind==='row'&&r.table==='nc_audit'&&r.row.action==='webhook.register'),'the consent audit remains portable without carrying an active endpoint')
 await command(root,['reset','--yes'])
 await command(root,['import','--input',beforeFile,'--yes'])
 await command(root,['export','--output',afterFile])
 assert.deepEqual(await items(afterFile),before,'all portable financial and metadata originals survive unchanged')
 h=await harness({persistence,databaseId,applyMigrations:false,webhookFetch:async()=>{throw new Error('restored installation must never call the old destination')}})
 const restoredOwner=await h.signIn(h.vars.OWNER_EMAIL)
 assert.deepEqual(await h.api('webhooks',restoredOwner),{endpoints:[],deliveries:[]})
 assert.equal((await h.api('webhook.dispatch',restoredOwner,{})).processed,0)
 console.log('webhookRestore: actual export/reset/import/export preserves six-kind metadata and financial originals; no endpoint, secret or operational outbox is restored')
}finally{await h?.close();await rm(scratch,{recursive:true,force:true})}
