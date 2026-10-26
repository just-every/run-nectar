import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { harness } from './harness.mjs'
import { applyPolicy } from './policy-helper.mjs'
import { retryAuthenticationFlow,harnessOptions } from './retry-methods.mjs'
const directory=process.env.NECTAR_EVIDENCE_DIR??'.evidence/retry-authentication'
await mkdir(directory,{recursive:true})
const h=await harness(harnessOptions());let browser
try{
 await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})
 const owner=await h.signIn(h.vars.OWNER_EMAIL)
 await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
 await h.api('business.configure',owner,{legal_name:'Cedar Software Inc',timezone:'UTC',invoice_prefix:'AUTH',payment_terms_days:30})
 await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Reviewed authentication recovery'})
 await h.api('tax.review',owner,{revision:(await h.api('business',owner)).revision})
 browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']})
 const sessionPage=async cookie=>{const context=await browser.newContext();await context.addCookies(cookie.split('; ').map(part=>{const i=part.indexOf('=');return {name:part.slice(0,i),value:part.slice(i+1),url:h.origin}}));return context.newPage()}
 const ownerPage=await sessionPage(owner),customer=await (await browser.newContext()).newPage()
 // Only the processor's hosted authentication network edge is replaced.
 await customer.route('https://hooks.stripe.com/**',route=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Processor authentication</title><p>Processor authentication challenge</p>'}))
 const shot=async(page,label)=>{
  for(const width of [1440,390]){
   await page.setViewportSize({width,height:1000})
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${label} fits ${width}`)
   assert.deepEqual(await page.locator('a,button,[role=button]').evaluateAll(nodes=>nodes.filter(n=>!n.textContent.trim()&&n.querySelector('svg,img')&&!n.getAttribute('aria-describedby')).map(n=>n.outerHTML)),[],'Icon controls have tooltips')
   await page.screenshot({path:`${directory}/${width}-${label}.png`,fullPage:true})
   if(await page.locator('#automatic-collection').count())await page.locator('#automatic-collection').screenshot({path:`${directory}/${width}-${label}-detail.png`})
   console.log('BROWSER',width,label)
  }
 }
 await retryAuthenticationFlow(h,owner,{
  prepareRecovery:async({input,invoice,session})=>{
   await ownerPage.goto(h.origin+`/app/invoices/${invoice}`)
   const details=ownerPage.locator('#automatic-collection details').filter({has:ownerPage.locator('[name=authenticate]')})
   await details.locator('summary').click();await details.locator('[name=confirm]').check();await shot(ownerPage,'authentication-review')
   await Promise.all([ownerPage.waitForNavigation(),details.getByRole('button').click()]);assert.equal(new URL(ownerPage.url()).searchParams.has('error'),false)
   const id=(await h.api('automatic-collections',owner)).find(r=>r.id===input.request).recoveries.at(-1).id
   const response=await h.raw(`/portal/retry-method-recoveries/${id}?session=${encodeURIComponent(session.token)}`,{headers:{accept:'application/json'}})
   assert.equal(response.status,200);return response.json()
  },
  acceptRecovery:async({path})=>{
   await customer.goto(h.origin+path);await shot(customer,'authentication-spanish-consent')
   const form=customer.locator('form').filter({has:customer.locator('[name=accept]')});await form.locator('[name=accept]').check()
   await Promise.all([customer.waitForNavigation(),form.getByRole('button').click()]);await shot(customer,'authentication-spanish-accepted');const state=await h.raw(path,{headers:{accept:'application/json'}});assert.equal(state.status,200);assert.equal((await state.json()).status,'pending_approval')
  },
  approveRecovery:async({finance,invoice})=>{
   const page=await sessionPage(finance);await page.goto(h.origin+`/app/invoices/${invoice}`)
   const form=page.locator('form[action="/app/do/retry.method.decide"]');await form.locator('[name=confirm]').check();await shot(page,'authentication-finance-approval')
   await Promise.all([page.waitForNavigation(),form.getByRole('button').click()]);assert.equal(new URL(page.url()).searchParams.has('error'),false)
  },
  confirmAuthentication:async({path,body})=>{
   await customer.goto(h.origin+path)
   const form=customer.locator('form').filter({has:customer.locator('[name=authenticate]')})
   await Promise.all([customer.waitForURL('https://hooks.stripe.com/**'),form.getByRole('button').click()])
   return h.raw(path,{body})
  },
  checkAuthentication:async({prepared,edge,intent})=>{
   edge.authenticate(intent)
   await customer.goto(h.origin+`/portal/retry-method-recoveries/${prepared.id}/return?payment_intent=${intent}&payment_intent_client_secret=synthetic-nectar-redirect-secret`)
   assert.equal(new URL(customer.url()).search,'','The provider secret is discarded before rendering')
   const form=customer.locator('form').filter({has:customer.locator('[name=check]')})
   await Promise.all([customer.waitForNavigation(),form.getByRole('button').click()])
   assert.equal(new URL(customer.url()).search,'')
  },
  onState:async({state,invoice,path})=>{
   if(state==='authentication-pending'){await ownerPage.goto(h.origin+`/app/invoices/${invoice}`);await shot(ownerPage,state);return}
   if(state!=='authentication-erased'){await ownerPage.goto(h.origin+`/app/invoices/${invoice}`);await shot(ownerPage,state)}
   await customer.goto(h.origin+path);await shot(customer,state+'-customer')
  }
 })
}finally{await browser?.close();await h.close()}
