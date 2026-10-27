// Give substantial clause journeys their own installation and ordinary auth
// traffic, rather than sharing one IP's sign-in quota across unrelated firms.
import assert from 'node:assert/strict'
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

// A real script entry keeps focused local runs in the same module context as Verify.
if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL((await import('node:path')).resolve(process.argv[1])).href) {
  const names=process.argv.slice(2),{isolatedJourneys}=await import('./isolated-cases.mjs')
  assert.ok(names.length,'Name at least one registered journey')
  for(const name of names){
    const journey=isolatedJourneys.find(j=>j.name===name)
    assert.ok(journey,`Unknown registered journey: ${name}`)
    await runIsolated(journey.file,journey.name,journey.load)
  }
}
