import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { harness } from './harness.mjs'
import { applyPolicy } from './policy-helper.mjs'
import { retryMethodsFlow,harnessOptions } from './retry-methods.mjs'
const directory=process.env.NECTAR_EVIDENCE_DIR??'.evidence/retry-methods'
await mkdir(directory,{recursive:true})
const h=await harness(harnessOptions());let browser,lastPath
try{
 await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})
 const owner=await h.signIn(h.vars.OWNER_EMAIL)
 await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
 await h.api('business.configure',owner,{legal_name:'Cedar Software Inc',timezone:'UTC',invoice_prefix:'CARD',payment_terms_days:30})
 await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Reviewed card recovery'})
 await h.api('tax.review',owner,{revision:(await h.api('business',owner)).revision})
 browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']})
 const sessionPage=async cookie=>{const c=await browser.newContext();await c.addCookies(cookie.split('; ').map(p=>{const i=p.indexOf('=');return {name:p.slice(0,i),value:p.slice(i+1),url:h.origin}}));return c.newPage()}
 const page=await sessionPage(owner),customer=await (await browser.newContext()).newPage()
 const shot=async(target,label)=>{
  for(const width of [1440,390]){
   await target.setViewportSize({width,height:1000})
   assert.equal(await target.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${label} fits ${width}`)
   assert.deepEqual(await target.locator('a,button,[role=button]').evaluateAll(nodes=>nodes.filter(n=>!n.textContent.trim()&&n.querySelector('svg,img')&&!n.getAttribute('aria-describedby')).map(n=>n.outerHTML)),[],'Every icon control has a tooltip')
   await target.screenshot({path:`${directory}/${width}-${label}.png`,fullPage:true})
   if(await target.locator('#automatic-collection').count())await target.locator('#automatic-collection').screenshot({path:`${directory}/${width}-${label}-detail.png`})
   console.log('BROWSER',width,label)
  }
 }
 await retryMethodsFlow(h,owner,{
  prepareRecovery:async({input,invoice,session})=>{
   await page.goto(h.origin+`/app/invoices/${invoice}`)
   const details=page.locator('#automatic-collection details');await details.locator('summary').click()
   const form=details.locator('form');await form.locator('[name=confirm]').check();await shot(page,'review-new-card')
   await Promise.all([page.waitForNavigation(),form.getByRole('button').click()]);assert.equal(new URL(page.url()).searchParams.has('error'),false)
   const row=(await h.api('automatic-collections',owner)).find(r=>r.id===input.request),id=row.recoveries.at(-1).id
   const response=await h.raw(`/portal/retry-method-recoveries/${id}?session=${encodeURIComponent(session.token)}`,{headers:{accept:'application/json'}})
   assert.equal(response.status,200);return response.json()
  },
  acceptRecovery:async({path})=>{
   await customer.goto(h.origin+path);await shot(customer,'new-card-spanish-consent')
   const form=customer.locator('form').filter({has:customer.locator('[name=accept]')});await form.locator('[name=accept]').check()
   await Promise.all([customer.waitForNavigation(),form.getByRole('button').click()]);await shot(customer,'new-card-spanish-accepted')
  },
  approveRecovery:async({finance,invoice})=>{
   const financePage=await sessionPage(finance);await financePage.goto(h.origin+`/app/invoices/${invoice}`)
   const form=financePage.locator('form[action="/app/do/retry.method.decide"]');await form.locator('[name=confirm]').check();await shot(financePage,'independent-finance-approval')
   await Promise.all([financePage.waitForNavigation(),form.getByRole('button').click()]);assert.equal(new URL(financePage.url()).searchParams.has('error'),false)
  },
  onState:async({state,invoice,path})=>{
   lastPath=path
   if(state==='new-card-consent')return
   await page.goto(h.origin+`/app/invoices/${invoice}`);await shot(page,state)
   await customer.goto(h.origin+path);await shot(customer,`${state}-customer`)
  }
 })
 await customer.goto(h.origin+lastPath);await shot(customer,'erased-refusal')
}finally{await browser?.close();await h.close()}
