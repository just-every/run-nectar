// One screen, asserted at 1440; the same populated history is recorded at 390.
import assert from 'node:assert/strict'
import {mkdir} from 'node:fs/promises'
import {chromium} from '@playwright/test'
import {harness} from './harness.mjs'
import {applyPolicy} from './policy-helper.mjs'
import {harnessOptions,subscriptionStatesFlow} from './subscription-states.mjs'
const directory=process.env.NECTAR_EVIDENCE_DIR??'.cache/subscription-states'
await mkdir(directory,{recursive:true})
const h=await harness(harnessOptions());let browser
try{
 await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Synthetic owner'}})
 const owner=await h.signIn(h.vars.OWNER_EMAIL)
 await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
 await h.api('business.configure',owner,{legal_name:'Synthetic merchant',timezone:'UTC',invoice_prefix:'STATE',payment_terms_days:30})
 await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Synthetic reviewed state proof'})
 await h.api('tax.review',owner,{revision:(await h.api('business',owner)).revision})
 browser=await chromium.launch({headless:true,...(process.env.NECTAR_CHROMIUM_PATH?{executablePath:process.env.NECTAR_CHROMIUM_PATH}:{}),args:['--no-sandbox','--use-mock-keychain','--password-store=basic']})
 const context=await browser.newContext({viewport:{width:1440,height:1000}})
 await context.addCookies(owner.split('; ').map(value=>{const index=value.indexOf('=');return {name:value.slice(0,index),value:value.slice(index+1),url:h.origin}}))
 const page=await context.newPage()
 await subscriptionStatesFlow(h,owner,{onState:async({state,subscription,history})=>{
  if(state!=='ended')return
  await page.goto(h.origin+`/app/subscriptions/${subscription}`)
  const table=page.getByRole('heading',{name:'State history',exact:true}).locator('..').getByRole('table').first()
  assert.equal(await table.locator('tbody tr').count(),history.length)
  const rows=await table.locator('tbody tr').allTextContents()
  for(const [index,event]of history.entries())assert.ok(rows[index].includes(event.state)&&rows[index].includes(new Intl.DateTimeFormat('en-US',{dateStyle:'medium',timeZone:'UTC'}).format(new Date(event.cause.day+'T00:00:00Z'))),'Displayed state history matches the recorded transition')
  for(const width of [1440,390]){
   await page.setViewportSize({width,height:1000})
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`State screen fits ${width}`)
   const icons=await page.locator('a,button,[role=button]').evaluateAll(nodes=>nodes.filter(node=>!node.textContent.trim()&&node.querySelector('svg,img')&&!node.getAttribute('aria-describedby')).map(node=>node.outerHTML))
   assert.deepEqual(icons,[],'Icon-only controls have tooltips')
   await page.screenshot({path:`${directory}/${width}-subscription-state-history.png`,fullPage:true})
   console.log('BROWSER',width,'subscription-state-history')
  }
 }})
}finally{await browser?.close();await h.close()}
