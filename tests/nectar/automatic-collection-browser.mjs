import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { harness } from './harness.mjs'
import { applyPolicy } from './policy-helper.mjs'
import { automaticCollectionFlow,harnessOptions } from './automatic-collection.mjs'
const directory=process.env.NECTAR_EVIDENCE_DIR??'.evidence/automatic-collection'
await mkdir(directory,{recursive:true})
const h=await harness({assets:true,...harnessOptions()})
let browser
try{
 await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})
 const owner=await h.signIn(h.vars.OWNER_EMAIL)
 await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
 await h.api('business.configure',owner,{legal_name:'Cedar Software Inc',timezone:'UTC',invoice_prefix:'AUTO',payment_terms_days:30})
 await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Reviewed test billing'})
 await h.api('tax.review',owner,{revision:(await h.api('business',owner)).revision})
 browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']})
 const context=await browser.newContext();await context.addCookies(owner.split('; ').map(part=>{const at=part.indexOf('=');return {name:part.slice(0,at),value:part.slice(at+1),url:h.origin}}))
 const page=await context.newPage(),customerPage=await (await browser.newContext()).newPage()
 const shot=async(target,label)=>{
  for(const width of [1440,390]){
   await target.setViewportSize({width,height:950})
   assert.equal(await target.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${label} fits ${width}`)
   const unlabeled=await target.locator('a,button,[role=button]').evaluateAll(nodes=>nodes.filter(n=>!n.textContent.trim()&&n.querySelector('svg,img')&&!n.getAttribute('aria-describedby')).length)
   assert.equal(unlabeled,0,'Icon controls have tooltips')
   await target.screenshot({path:`${directory}/${width}-${label}.png`,fullPage:true})
   const invoiceSection=target.locator('#automatic-collection');if(await invoiceSection.count())await invoiceSection.screenshot({path:`${directory}/${width}-${label}-detail.png`})
   const paymentSection=target.getByRole('heading',{name:'Automatic invoice payments',exact:true}).first();if(await paymentSection.count())await paymentSection.locator('..').screenshot({path:`${directory}/${width}-${label}-payment-detail.png`})
   console.log('BROWSER',width,label)
  }
 }
 await automaticCollectionFlow(h,owner,{
  prepareCollection:async input=>{
   await page.goto(h.origin+`/app/invoices/${input.invoice}`)
   const detail=page.locator('#automatic-collection details');await detail.locator('summary').click()
   const form=detail.locator('form');await form.locator('[name=issue_date]').fill(input.issue_date)
   if(input.mandate_ref)await form.locator('[name=mandate_ref]').fill(input.mandate_ref)
   await shot(page,`prepare-${input.mandate_ref?'bank':'card'}-${input.invoice.slice(0,8)}`)
   await Promise.all([page.waitForNavigation(),form.getByRole('button').click()]);assert.equal(new URL(page.url()).searchParams.has('error'),false)
   return (await h.api('automatic-collections',owner)).find(r=>r.invoice===input.invoice)
  },
  acceptCollection:async({target,prepared})=>{
   await customerPage.goto(h.origin+target);await shot(customerPage,`consent-${prepared.method}-${prepared.id.slice(0,8)}`)
   const form=customerPage.locator('form').filter({has:customerPage.locator('[name=accept]')});await form.locator('[name=accept]').check()
   await Promise.all([customerPage.waitForNavigation(),form.getByRole('button').click()]);assert.equal(new URL(customerPage.url()).searchParams.has('error'),false)
   await shot(customerPage,`accepted-${prepared.method}-${prepared.id.slice(0,8)}`)
  },
  decideCollection:async input=>{
   const row=(await h.api('automatic-collections',owner)).find(r=>r.id===input.request)
   await page.goto(h.origin+`/app/invoices/${row.invoice}`)
   const form=page.locator('form[action="/app/do/automatic.collection.decide"]')
   await form.locator('[name=confirm]').check();await form.locator('[name=confirm_single]').check();await shot(page,`approval-${row.method}-${row.id.slice(0,8)}`)
   await Promise.all([page.waitForNavigation(),form.getByRole('button').click()]);assert.equal(new URL(page.url()).searchParams.has('error'),false)
   return (await h.api('automatic-collections',owner)).find(r=>r.id===input.request)
  },
  onState:async({state,invoice,customer,session,request})=>{
   if(state==='collected'&&request.payment){await page.goto(h.origin+`/app/payments/${request.payment}/receipt`);await shot(page,`${request.method}-receipt-${request.id.slice(0,8)}`)}
   for(const [target,path,kind] of [[page,`/app/invoices/${invoice}`,'invoice'],[page,`/app/customers/${customer}`,'customer'],[customerPage,`/portal/automatic-collections/${request.id}?session=${encodeURIComponent(session.token)}`,'portal']]){
    assert.equal((await target.goto(h.origin+path)).status(),200)
    await shot(target,`${request.method}-${state}-${kind}-${request.id.slice(0,8)}`)
   }
  },
 })
}finally{await browser?.close();await h.close()}
