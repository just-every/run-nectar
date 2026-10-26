import {cardExpiryNoticesFlow,harnessOptions as expiryOptions} from './card-expiry-notices.mjs'
import assert from 'node:assert/strict'
import {mkdir} from 'node:fs/promises'
import {chromium} from '@playwright/test'
import {harness} from './harness.mjs'
import {applyPolicy} from './policy-helper.mjs'
import {customerSearchFlow,harnessOptions} from './customer-search.mjs'
import {lifecycleFlow,harnessOptions as lifecycleOptions} from './card-lifecycle.mjs'
const directory=process.env.NECTAR_EVIDENCE_DIR??'.evidence/portal-methods'
await mkdir(directory,{recursive:true})
const browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']})
async function installation(options) {
 const h=await harness({assets:true,...options})
 await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})
 const owner=await h.signIn(h.vars.OWNER_EMAIL)
 await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
 await h.api('business.configure',owner,{legal_name:'Alder Analytics',timezone:'UTC',invoice_prefix:'ALDER',payment_terms_days:30})
 await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Reviewed portal methods journey'})
 await h.api('tax.review',owner,{revision:(await h.api('business',owner)).revision})
 return {h,owner}
}
let h
try {
 const initial=await installation(harnessOptions());h=initial.h;const owner=initial.owner
 const operator=await browser.newContext(),customer=await browser.newContext(),op=await operator.newPage(),page=await customer.newPage()
 await operator.addCookies(owner.split('; ').map(value=>{const i=value.indexOf('=');return {name:value.slice(0,i),value:value.slice(i+1),url:h.origin}}))
 const shot=async(page,label)=>{
  for(const width of [1440,390]) {
   await page.setViewportSize({width,height:950})
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${label} fits ${width}`)
   assert.equal(await page.locator('a,button').evaluateAll(nodes=>nodes.filter(n=>!n.textContent.trim()).length),0)
   const changed=page.locator('#saved-payment-methods')
   if(await changed.count())await changed.screenshot({path:`${directory}/${width}-${label}.png`})
   else await page.screenshot({path:`${directory}/${width}-${label}.png`,fullPage:true})
  }
 }
 await customerSearchFlow(h,owner,async()=>{},{
  prepareMethodAction:async({customer,binding,setup,operation})=>{
   await op.goto(`${h.origin}/app/customers/${customer}`)
   const detail=op.locator('#saved-payment-methods details').filter({has:op.locator('form[action="/app/do/portal.method.prepare"]')})
   await detail.locator('summary').click()
   const form=detail.locator('form').filter({has:op.locator(`input[name=setup][value="${setup}"]`)})
   await form.locator('[name=operation]').selectOption(operation);await form.locator('[name=confirm]').check()
   await shot(op,`owner-${operation}-prepared`)
   await Promise.all([op.waitForNavigation(),form.getByRole('button').click()])
   assert.equal(new URL(op.url()).searchParams.get('error'),null)
   const session=await h.api('portal.session.issue',owner,{customer,origin:h.origin,audience:'hosted'})
   const response=await h.raw(`/portal/payment-methods/actions?session=${encodeURIComponent(session.token)}`)
   return (await response.json()).find(row=>row.status==='prepared'&&row.setup===setup&&row.operation===operation)
  },
  confirmMethodAction:async({session,action,operation})=>{
   await page.goto(`${h.origin}/portal/payment-methods?session=${encodeURIComponent(session.token)}`)
   const form=page.locator(`[data-method-action="${action}"] form`)
   await form.locator('[name=confirm]').check()
   await shot(page,`customer-${operation}-${action.slice(0,6)}`)
   const [response]=await Promise.all([page.waitForNavigation(),form.getByRole('button').click()])
   assert.equal(response.status(),200)
   const result=await h.raw(`/portal/payment-methods/actions?session=${encodeURIComponent(session.token)}`)
   return (await result.json()).find(row=>row.id===action)
  },
  methodState:async({customer,session,operation,state})=>{
   const response=await page.goto(`${h.origin}/portal/payment-methods?session=${encodeURIComponent(session.token)}`)
   assert.equal(response.status(),state==='refused'?401:200)
   await shot(page,`portal-${operation}-${state}`)
   await op.goto(`${h.origin}/app/customers/${customer}`);await shot(op,`owner-${operation}-${state}`)
  }
 })
 await h.close();h=null
 const lifecycle=await installation(lifecycleOptions());h=lifecycle.h
 const lifecycleContext=await browser.newContext(),record=await lifecycleContext.newPage()
 await lifecycleContext.addCookies(lifecycle.owner.split('; ').map(value=>{const i=value.indexOf('=');return {name:value.slice(0,i),value:value.slice(i+1),url:h.origin}}))
 await lifecycleFlow(h,lifecycle.owner,{onState:async({customer,state})=>{await record.goto(`${h.origin}/app/customers/${customer}`);await shot(record,`lifecycle-${state}`)}})
 await h.close();h=null
 const expiry=await installation(expiryOptions());h=expiry.h
 const expiryContext=await browser.newContext(),review=await expiryContext.newPage(),message=await expiryContext.newPage()
 await expiryContext.addCookies(expiry.owner.split('; ').map(value=>{const i=value.indexOf('=');return {name:value.slice(0,i),value:value.slice(i+1),url:h.origin}}))
 await cardExpiryNoticesFlow(h,expiry.owner,{onState:async({customer,state,notice,updateLink})=>{
  if(state==='expired'){
   assert.equal((await message.goto(updateLink)).status(),401)
   await shot(message,'expiry-link-expired');return
  }
  await review.goto(`${h.origin}/app/customers/${customer}`)
  await review.locator('#card-expiry-notices summary').click()
  await shot(review,`expiry-${state}`)
  if(notice.preview){
   await message.setContent(notice.preview.html)
   await shot(message,'expiry-email')
   const link=message.getByRole('link')
   assert.ok(await link.evaluate(node=>node.getBoundingClientRect().height>=44))
   const href=await link.getAttribute('href')
   await message.goto(href);await shot(message,'expiry-update-link')
  }
 }})
 console.log('PORT-004 and PAY-005 native forms and end states passed at 1440 and 390')
} finally {await h?.close();await browser.close()}
