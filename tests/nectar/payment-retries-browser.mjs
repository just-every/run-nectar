import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { harness } from './harness.mjs'
import { applyPolicy } from './policy-helper.mjs'
import { paymentRetriesFlow,harnessOptions } from './payment-retries.mjs'
const directory=process.env.NECTAR_EVIDENCE_DIR??'.evidence/payment-retries'
await mkdir(directory,{recursive:true})
const h=await harness(harnessOptions());let browser
try{
 await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})
 const owner=await h.signIn(h.vars.OWNER_EMAIL)
 await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
 await h.api('business.configure',owner,{legal_name:'Cedar Software Inc',timezone:'UTC',invoice_prefix:'RETRY',payment_terms_days:30})
 await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Reviewed retry journey'})
 await h.api('tax.review',owner,{revision:(await h.api('business',owner)).revision})
 browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']})
 const context=await browser.newContext();await context.addCookies(owner.split('; ').map(part=>{const at=part.indexOf('=');return {name:part.slice(0,at),value:part.slice(at+1),url:h.origin}}))
 const page=await context.newPage(),customer=await (await browser.newContext()).newPage(),seen=new Set()
 const shot=async(target,label)=>{
  if(seen.has(label))return;seen.add(label)
  for(const width of [1440,390]){
   await target.setViewportSize({width,height:1000})
   assert.equal(await target.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${label} fits ${width}`)
   const icons=await target.locator('a,button,[role=button]').evaluateAll(nodes=>nodes.filter(n=>!n.textContent.trim()&&n.querySelector('svg,img')&&!n.getAttribute('aria-describedby')).map(n=>n.outerHTML))
   assert.deepEqual(icons,[],'Icon controls have descriptive tooltips')
   await target.screenshot({path:`${directory}/${width}-${label}.png`,fullPage:true})
   if(await target.locator('#automatic-collection').count())await target.locator('#automatic-collection').screenshot({path:`${directory}/${width}-${label}-detail.png`})
   console.log('BROWSER',width,label)
  }
 }
 await paymentRetriesFlow(h,owner,{
  prepareCollection:async input=>{
   await page.goto(h.origin+`/app/invoices/${input.invoice}`)
   const details=page.locator('#automatic-collection details');await details.locator('summary').click()
   const form=details.locator('form');await form.locator('[name=issue_date]').fill(input.issue_date)
   if(input.mandate_ref)await form.locator('[name=mandate_ref]').fill(input.mandate_ref)
   if(input.enable_retries)await form.locator('[name=enable_retries]').check()
   await shot(page,input.mandate_ref?'prepare-bank':'prepare-card')
   await Promise.all([page.waitForNavigation(),form.getByRole('button').click()])
   assert.equal(new URL(page.url()).searchParams.has('error'),false)
   return (await h.api('automatic-collections',owner)).find(r=>r.invoice===input.invoice)
  },
  acceptCollection:async({path,request})=>{
   await customer.goto(h.origin+path)
   await shot(customer,request.method==='us_bank_account'?'consent-spanish':'consent-english')
   const form=customer.locator('form').filter({has:customer.locator('[name=accept]')});await form.locator('[name=accept]').check()
   await Promise.all([customer.waitForNavigation(),form.getByRole('button').click()])
   assert.equal(new URL(customer.url()).searchParams.has('error'),false)
   await shot(customer,request.method==='us_bank_account'?'accepted-spanish':'accepted-english')
  },
  onState:async state=>{
   if(state.state==='consent')return
   if(state.state==='report'){
    await page.goto(h.origin+'/app/reports/recovery');await shot(page,'recovery-report')
    await page.goto(h.origin+'/app/settings#payment-retries');await page.locator('#payment-retries summary').click();await shot(page,'retry-settings')
   }else{await page.goto(h.origin+`/app/invoices/${state.id}`);await shot(page,state.state)}
  }
 })
}finally{await browser?.close();await h.close()}
