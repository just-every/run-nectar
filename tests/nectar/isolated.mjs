// Give substantial clause journeys their own installation and ordinary auth
// traffic, rather than sharing one IP's sign-in quota across unrelated firms.
import assert from 'node:assert/strict'
import { harness } from './harness.mjs'
import { applyPolicy } from './policy-helper.mjs'

export async function runIsolated(file, name) {
  const h=await harness()
  try {
    assert.equal((await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})).status,303)
    const owner=await h.signIn(h.vars.OWNER_EMAIL)
    await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
    await h.api('business.configure',owner,{legal_name:'Cedar Software Inc',timezone:'America/Los_Angeles',invoice_prefix:'CD',payment_terms_days:30})
    await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Reviewed isolated contract journey'})
    await h.api('tax.review',owner,{revision:(await h.api('business',owner)).revision})
    const module=await import(`./${file}.mjs`)
    await module[name](h,owner)
  } finally {await h.close()}
}
