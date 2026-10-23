// CUS-001 child ownership and write-off source end states, over public journeys.
import assert from 'node:assert/strict'
import {mkdir} from 'node:fs/promises'
import {chromium} from '@playwright/test'
import {harness} from './harness.mjs'
import {applyPolicy} from './policy-helper.mjs'
const directory=process.env.NECTAR_EVIDENCE_DIR??'.evidence/customer-children'
await mkdir(directory,{recursive:true})
const browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']})
async function journey(file,run){
  const module=await import(`./${file}.mjs`),h=await harness({assets:true,...(module.harnessOptions?.()??{})})
  try{
    await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})
    const owner=await h.signIn(h.vars.OWNER_EMAIL)
    await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
    await h.api('business.configure',owner,{legal_name:'Cedar Software Inc',timezone:'America/Los_Angeles',invoice_prefix:'CD',payment_terms_days:30})
    await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Reviewed customer source journey'})
    await h.api('tax.review',owner,{revision:(await h.api('business',owner)).revision})
    const context=await browser.newContext(),page=await context.newPage()
    await context.addCookies(owner.split('; ').map(value=>{const i=value.indexOf('=');return {name:value.slice(0,i),value:value.slice(i+1),url:h.origin}}))
    const both=async(label,customer)=>{
      for(const width of [1440,390]){
        await page.setViewportSize({width,height:950})
        assert.equal((await page.goto(h.origin+`/app/customers/${customer}`)).status(),200)
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${label} fits ${width}`)
        const iconOnly=await page.locator('a,button,[role=button]').evaluateAll(nodes=>nodes.filter(n=>!n.textContent.trim()&&n.querySelector('svg,img')).map(n=>n.outerHTML));assert.deepEqual(iconOnly,[])
        await page.screenshot({path:`${directory}/${width}-${label}.png`,fullPage:true});console.log('BROWSER',width,label)
      }
    }
    await run(module,h,owner,both)
    await context.close()
  }finally{await h.close()}
}
try{
 await journey('hierarchies',async(m,h,owner,both)=>{
   const result=await m.hierarchiesFlow(h,owner,{onState:async state=>{if(state.label==='parent-card-collected')await both('child-ledgers-parent-card',state.parent)}})
   await both('child-erasure-retained-ledgers',result.parent)
 })
 await journey('lifecycle',async(m,h,owner,both)=>{const result=await m.lifecycleFlow(h,owner);await both('customer-subscription-history',result.customer)})
 await journey('write-offs',async(m,h,owner,both)=>m.writeOffFlow(h,owner,{onRecord:async({customer})=>both('customer-writeoff-recovery',customer)}))
}finally{await browser.close()}
