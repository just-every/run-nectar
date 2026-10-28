// Give substantial clause journeys their own installation and ordinary auth
// traffic, rather than sharing one IP's sign-in quota across unrelated firms.
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { harness } from './harness.mjs'
import { applyPolicy } from './policy-helper.mjs'

export async function runIsolated(file, name, load) {
  console.log('JOURNEY',file,name)
  const module=await load()
  const h=await harness(typeof module.harnessOptions==='function'?module.harnessOptions():{})
  try {
    console.log('JOURNEY READY',file)
    assert.equal((await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})).status,303)
    const owner=await h.signIn(h.vars.OWNER_EMAIL)
    await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
    await h.api('business.configure',owner,{legal_name:'Cedar Software Inc',timezone:'America/Los_Angeles',invoice_prefix:'CD',payment_terms_days:30})
    await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Reviewed isolated contract journey'})
    await h.api('tax.review',owner,{revision:(await h.api('business',owner)).revision})
    await module[name](h,owner)
  } finally {await h.close()}
}

// A file entry keeps Node CLI flags out of Miniflare's internal worker thread.
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const {isolatedJourneys}=await import('./isolated-cases.mjs')
  const names=new Set(process.argv.slice(2)),selected=isolatedJourneys.filter(journey=>names.has(journey.name))
  if(!names.size||selected.length!==names.size)throw new Error('Name the existing isolated journeys to run')
  for(const {file,name,load} of selected)await runIsolated(file,name,load)
}
