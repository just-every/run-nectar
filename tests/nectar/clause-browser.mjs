// Focused real-browser use of a clause's own public pages and native forms.
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { harness } from './harness.mjs'
import { applyPolicy } from './policy-helper.mjs'
import { erasureFlow } from './erasure.mjs'
import { moveCollectionFlow,harnessOptions as collectionOptions } from './move-collection.mjs'
import { moveHistoryFlow } from './move-history.mjs'
const kind=process.argv[2],directory=process.env.NECTAR_EVIDENCE_DIR??`.evidence/${kind}`
assert.ok(['erasure','history','collection'].includes(kind))
await mkdir(directory,{recursive:true})
const h=await harness({assets:true,...(kind==='collection'?collectionOptions():{})});let browser
try {
  await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})
  const owner=await h.signIn(h.vars.OWNER_EMAIL)
  await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
  await h.api('business.configure',owner,{legal_name:'Alder Research Software',timezone:'UTC',invoice_prefix:'ALDER',payment_terms_days:30})
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Reviewed focused browser journey'})
  await h.api('tax.review',owner,{revision:(await h.api('business',owner)).revision})
  browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']})
  const context=await browser.newContext()
  await context.addCookies(owner.split('; ').map(value=>{const i=value.indexOf('=');return {name:value.slice(0,i),value:value.slice(i+1),url:h.origin}}))
  const page=await context.newPage()
  const shot=async(label,path)=>{
    if(path)await page.goto(h.origin+path)
    assert.ok(await page.locator('main h1').count(),label)
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${label} fits at ${page.viewportSize().width}`)
    await page.screenshot({path:`${directory}/${page.viewportSize().width}-${label}.png`,fullPage:true})
    console.log(`BROWSER ${page.viewportSize().width} ${label}`)
  }
  if(kind==='erasure')await erasureFlow(h,owner,async state=>{
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:950})
      await shot(state.label,state.path)
    }
  })
  else if(kind==='collection')await moveCollectionFlow(h,owner,{
    prepare:async(customer,invoice)=>{
      await page.goto(h.origin+`/app/customers/${customer}`)
      await page.locator('select[name="invoice"]').selectOption(invoice)
      await Promise.all([page.waitForURL('**/app/customers/**'),page.getByRole('button',{name:'Review original invoice',exact:true}).click()])
      return (await h.api(`customers/${customer}`,owner)).importedCollections.find(row=>row.invoice_id===invoice)
    },
    execute:async(customer,request)=>{
      await page.goto(h.origin+`/app/customers/${customer}`)
      const form=page.locator('form[action="/app/do/imported.collection.execute"]').filter({has:page.locator(`input[value="${request.id}"]`)})
      await form.locator('input[name="disable_auto_advance"]').check()
      await form.locator('input[name="confirm"]').check()
      await Promise.all([page.waitForURL('**/app/customers/**'),form.getByRole('button').click()])
      return (await h.api(`customers/${customer}`,owner)).importedCollections.find(row=>row.id===request.id)
    },
    onState:async state=>{for(const width of [1440,390]){await page.setViewportSize({width,height:950});await shot(`collection-${state.label}`,`/app/customers/${state.customer}`)}}
  })
  else await moveHistoryFlow(h,owner,{onState:async state=>{
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:950})
      if(state.label==='preview') {
        await shot('import-upload','/app/import')
        for(const [name,value]of Object.entries(state.capture))await page.locator(`input[name="${name}"]`).setInputFiles({name:`${name}.json`,mimeType:'application/json',buffer:Buffer.from(JSON.stringify(value))})
        await Promise.all([page.waitForURL('**/app/import/preview'),page.getByRole('button',{name:'Preview the move',exact:true}).click()])
        await shot('import-preview')
      } else {
        const paths=[['customer-history',`/app/customers/${state.customer}`],['import-applied','/app/import'],['mrr-history',`/app/reports/mrr?period=2026-06&customer=${state.customer}`],['billings',`/app/reports/billings?period=${state.period}&customer=${state.customer}`],['billings-source',`/app/reports/billings/${state.annual}?period=${state.period}&customer=${state.customer}`],['collections-source',`/app/reports/collections/${state.payment}?period=${state.period}&customer=${state.customer}`],['revenue',`/app/revenue?from=2026-07&to=2027-02&customer=${state.customer}`],['revenue-source',`/app/revenue/${state.annual}?from=2026-07&to=2027-02&customer=${state.customer}`],['frozen-report',`/app/report-deliveries/${state.delivery}`]]
        for(const [label,path]of paths)await shot(label,path)
      }
    }
  }})
} finally {await browser?.close();await h.close()}
