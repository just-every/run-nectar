import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { harness } from './harness.mjs'
import { applyPolicy } from './policy-helper.mjs'
import { paymentRetriesFlow,retryPlanChurnFlow,harnessOptions } from './payment-retries.mjs'
if(process.env.NECTAR_JOURNEY_RUN)console.log(`JOURNEY RUN ${process.env.NECTAR_JOURNEY_RUN} HEAD ${execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()}`)
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
   if(label==='recovery-report'||label.startsWith('churn-'))for(const title of ['Failed payments and recovered revenue','By decline reason','By retry attempt','By dunning step','Involuntary churn','Published retry comparison']){const section=target.getByRole('heading',{name:title,exact:true}).locator('..');await section.screenshot({path:`${directory}/${width}-${label}-${title.toLowerCase().replaceAll(' ','-')}.png`})}
   if(await target.locator('#payment-retries').count())await target.locator('#payment-retries').screenshot({path:`${directory}/${width}-${label}-detail.png`})
   if(await target.locator('#automatic-collection').count())await target.locator('#automatic-collection').screenshot({path:`${directory}/${width}-${label}-detail.png`})
   console.log('BROWSER',width,label)
  }
 }
 await (process.argv.includes('churn')?retryPlanChurnFlow:paymentRetriesFlow)(h,owner,{
  assignSegment:async input=>{
   await page.goto(h.origin+'/app/settings#payment-retries')
   const details=page.locator(`[data-retry-customer="${input.customer}"]`)
   await details.locator('summary').click()
   const form=details.locator('form')
   assert.equal(await form.locator('[name=customer_revision]').inputValue(),input.customer_revision)
   assert.equal(await form.locator('[name=revision]').inputValue(),input.revision??'')
   await form.locator('[name=segment]').fill(input.segment)
   await form.locator('[name=confirm]').check()
   await shot(page,input.segment?`segment-form-${input.segment}`:'segment-clear-form')
   await Promise.all([page.waitForNavigation(),form.getByRole('button').click()])
   assert.equal(new URL(page.url()).searchParams.has('error'),false)
   const saved=page.locator(`[data-retry-customer="${input.customer}"]`)
   const revision=await saved.locator('[name=revision]').inputValue()
   assert.equal(await saved.locator('[name=segment]').inputValue(),input.segment)
   await saved.locator('summary').click();await shot(page,input.segment?`segment-saved-${input.segment}`:'segment-cleared')
   return {customer:input.customer,segment:input.segment||null,revision}
  },
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
   await shot(customer,request.method==='us_bank_account'?'consent-spanish':request.quote.retryPolicy?'consent-english-retries':'consent-english')
   const form=customer.locator('form').filter({has:customer.locator('[name=accept]')});await form.locator('[name=accept]').check()
   await Promise.all([customer.waitForNavigation(),form.getByRole('button').click()])
   assert.equal(new URL(customer.url()).searchParams.has('error'),false)
   await shot(customer,request.method==='us_bank_account'?'accepted-spanish':request.quote.retryPolicy?'accepted-english-retries':'accepted-english')
  },
  onState:async state=>{
   if(state.state==='consent')return
   if(state.state==='report'||state.state.startsWith('churn-')){
    await page.goto(h.origin+'/app/reports/recovery');await page.getByText('Configured policy comparisons',{exact:true}).click();await shot(page,state.state==='report'?'recovery-report':state.state)
    await page.goto(h.origin+'/app/settings#payment-retries');await page.locator('#payment-retries > details > summary').first().click();await shot(page,'retry-settings')
   }else{await page.goto(h.origin+`/app/invoices/${state.id}`);await shot(page,state.state)}
  }
 })
}finally{await browser?.close();await h.close()}
