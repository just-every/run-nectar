// Historical invoice checkpoints survive actual portability commands; execution
// authority never does, even when the owner still holds the original MFA key.
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { readArchive } from '@runeditrun/rer/modules/portability'
import { harness } from './harness.mjs'
import { harnessOptions, jobRunsFlow } from './job-runs.mjs'
import { applyPolicy } from './policy-helper.mjs'
import { command } from './cli.mjs'
import { totp } from './mfa.mjs'

async function records(path) {
  const bytes=await readFile(path),items=[]
  for await(const record of readArchive(new ReadableStream({start(controller){controller.enqueue(bytes);controller.close()}})))
    if(record.kind==='part')items.push(...record.items.map(({index,...item})=>item))
  return items
}
const history=items=>items.filter(item=>item.kind==='row'&&['nc_invoice_automation_runs','nc_invoice_automation_periods'].includes(item.table))
  .sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))

export async function invoiceJobArchiveJourney() {
  assert.equal(process.env.NECTAR_TEST_CHECKOUT,'1','Use a disposable checkout: this journey resets local state')
  const root=process.cwd()
  for(const path of ['.dev.vars','.wrangler/state'])await access(join(root,path)).then(()=>{throw new Error('A fresh unconfigured checkout is required')},error=>{if(error.code!=='ENOENT')throw error})
  await mkdir(join(root,'exports'),{recursive:true})
  const scratch=await mkdtemp(join(root,'exports','invoice-job-archive-'))
  let h
  try {
    const path=name=>join(scratch,`${name}.rer`)
    const config=JSON.parse(await readFile(join(root,'wrangler.jsonc'),'utf8'))
    const persistence=join(root,'.wrangler/state/v3'),databaseId=config.d1_databases.find(binding=>binding.binding==='DB').database_id
    await command(root,['export','--output',path('empty')])
    const options={...harnessOptions(),persistence,databaseId,applyMigrations:false}
    h=await harness(options)
    assert.equal((await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})).status,303)
    const owner=await h.signIn(h.vars.OWNER_EMAIL)
    await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
    await h.api('business.configure',owner,{legal_name:'Synthetic invoice operations',timezone:'UTC',invoice_prefix:'OPS',payment_terms_days:30})
    await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Synthetic scheduled archive journey'})
    await h.api('tax.review',owner,{revision:(await h.api('business',owner)).revision})
    let factor
    const api=h.api
    h.api=async(...args)=>{
      const result=await api(...args)
      if(args[0]==='mfa.totp.start'&&args[1]===owner)factor=result.secret
      return result
    }
    await jobRunsFlow(h,owner)
    // Leave a genuinely resumable same-day reservation, with no approved or
    // issued mutation allowed past this refused business audit.
    await h.rejectAudit('invoice.approve')
    try{await h.api('invoice.automation.run',owner,{},500)}finally{await h.rejectAudit()}
    const [pending]=(await h.api('invoice-automation',owner)).runs
    assert.equal(pending.status,'failed');assert.equal(pending.resumable,true)
    await h.api('report.schedule',owner,{enabled:true,day:1})
    await h.rejectAudit('report.snapshot')
    try{assert.equal((await h.raw(`/cdn-cgi/local/scheduled?time=${Date.parse(h.vars.NECTAR_LOCAL_TIME)}&cron=${encodeURIComponent('0 14 * * *')}`)).status,200)}finally{await h.rejectAudit()}
    const [reportPreparation]=(await h.api('report-schedule',owner)).deliveries
    assert.equal(reportPreparation.status,'failed')
    const financial=async who=>{const invoices=await h.api('invoices',who),payments=await h.api('payments',who);invoices.data.sort((a,b)=>a.id.localeCompare(b.id));payments.sort((a,b)=>a.id.localeCompare(b.id));return {invoices,payments}}
    const before=await financial(owner)
    await h.configureMail({provider:'resend',apiKey:'synthetic-nectar-archive-mail',from:h.vars.OWNER_EMAIL},null)
    const settings={...h.vars},instant=new Date(Date.parse(settings.NECTAR_LOCAL_TIME)+30_000).toISOString()
    await h.close();h=null
    await command(root,['export','--output',path('populated')])
    const captured=await records(path('populated'))
    assert.ok(history(captured).some(item=>item.table==='nc_invoice_automation_periods'&&item.row.automation_id===pending.id))
    assert.ok(history(captured).some(item=>item.table==='nc_invoice_automation_runs'&&item.row.status==='completed'))
    assert.ok(!captured.some(item=>['nc_invoice_automation_authority','nc_report_preparations','nc_report_schedules'].includes(item.table)),'No invoice continuation, report preparation or report send opt-in authority enters an archive')
    const serialized=JSON.stringify(captured)
    for(const value of [settings.SESSION_SECRET,settings.SETUP_TOKEN,settings.MFA_KEY,settings.STRIPE_BILLING_SECRET])
      assert.ok(value&&!serialized.includes(value),'Private installation keys do not enter historical records')
    await command(root,['reset','--yes'])
    await command(root,['import','--input',path('populated'),'--yes'])
    await command(root,['export','--output',path('restored')])
    assert.deepEqual(history(await records(path('restored'))),history(captured),'Exact checkpoint identities and outcomes survive actual restore')
    // Keep the network edge connected: a resurrected operational request would
    // be visible as a real provider call, rather than silently suppressed.
    let writes=0
    const stripeFetch=async request=>{if(request.method==='POST')writes++;return options.stripeFetch(request)}
    h=await harness({...options,settings,localTime:instant,stripeFetch})
    assert.equal((await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Restored Nectar Owner'}})).status,303)
    const restoredOwner=await h.signIn(h.vars.OWNER_EMAIL)
    await h.api('mfa.verify',restoredOwner,{code:totp(factor,Date.parse(instant))})
    assert.equal((await h.api('report-schedule',restoredOwner)).schedule.enabled,false,'Restoring evidence never restores a report send opt-in')
    const mailCount=h.mails.length
    const restored=(await h.api('invoice-automation',restoredOwner)).runs.find(row=>row.id===pending.id)
    assert.equal(restored.status,'failed');assert.equal(restored.resumable,false)
    await h.api('invoice.automation.resume',restoredOwner,{run:pending.id,revision:pending.execution_revision,confirm:true},409)
    assert.equal((await h.raw(`/cdn-cgi/local/scheduled?time=${Date.parse(instant)}&cron=${encodeURIComponent('0 14 * * *')}`)).status,200)
    assert.equal(writes,0,'Restore, old confirmation and ordinary ticks cannot reactivate a saved invoice day')
    assert.equal(h.mails.length,mailCount,'Historical report preparation never recreates a send')
    assert.equal((await h.api('report-schedule',restoredOwner)).deliveries.find(row=>row.id===reportPreparation.id).status,'failed')
    assert.deepEqual(await financial(restoredOwner),before)
    console.log('invoiceJobArchiveJourney: actual export, reset and import retain exact historical checkpoints and financial records, exclude keys and execution authority, and refuse replay with zero provider writes')
  } finally {await h?.close();await rm(scratch,{recursive:true,force:true})}
}
if(process.argv[1]===new URL(import.meta.url).pathname)await invoiceJobArchiveJourney()
