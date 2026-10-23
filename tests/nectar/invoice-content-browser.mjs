// Browser and independent PDF proof on the same invoice journey.
import assert from 'node:assert/strict'
import { mkdir,writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { chromium } from '@playwright/test'
import { harness } from './harness.mjs'
import { applyPolicy } from './policy-helper.mjs'
import { invoiceContentFlow,invoiceAutomationFlow } from './invoice-content.mjs'

const directory=process.env.NECTAR_EVIDENCE_DIR
assert.ok(directory,'Evidence directory must be outside the checkout')
await mkdir(directory,{recursive:true})
const h=await harness({assets:true})
let browser
try {
  assert.equal((await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})).status,303)
  const owner=await h.signIn(h.vars.OWNER_EMAIL)
  await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
  await h.api('business.configure',owner,{legal_name:'Cedar Software Inc',timezone:'America/Los_Angeles',invoice_prefix:'CD',payment_terms_days:30})
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Reviewed invoice journey'})
  await h.api('tax.review',owner,{revision:(await h.api('business',owner)).revision})
  browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']})
  const flow=process.argv.includes('--automation')?invoiceAutomationFlow:invoiceContentFlow
  await flow(h,owner,{onState:async({label,path,owner:cookie,pdfPath})=>{
    const context=await browser.newContext()
    try {
      if(cookie)await context.addCookies(cookie.split('; ').map(value=>{const i=value.indexOf('=');return {name:value.slice(0,i),value:value.slice(i+1),url:h.origin}}))
      const page=await context.newPage()
      for(const width of [1440,390]){
        await page.setViewportSize({width,height:950})
        const response=await page.goto(h.origin+path)
        assert.equal(response.status(),200,label)
        assert.equal(await page.locator('main h1').count(),1)
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${label} fits ${width}`)
        if(label==='detailed-customer-invoice')await page.locator('details').evaluateAll(nodes=>nodes.forEach(node=>node.open=true))
        const iconOnly=await page.locator('a,button').evaluateAll(nodes=>nodes.filter(n=>!n.textContent.trim()&&n.querySelector('svg')).map(n=>n.outerHTML))
        assert.deepEqual(iconOnly,[],`${label}: all controls have visible words`)
        const logo=page.locator('main img')
        if(label==='branded-customer-invoice')assert.equal(await logo.evaluate(img=>img.complete&&img.naturalWidth>0),true)
        await page.screenshot({path:`${directory}/${width}-${label}.png`,fullPage:true})
        console.log(`BROWSER ${width} ${label}; no icon-only controls`)
      }
      if(pdfPath){
        const response=await h.raw(pdfPath),bytes=Buffer.from(await response.arrayBuffer())
        const filename=`${directory}/${label}.pdf`;await writeFile(filename,bytes)
        const text=execFileSync('pdftotext',[filename,'-'],{encoding:'utf8'})
        assert.match(text,/USD/)
        if(label==='branded-customer-invoice')for(const value of ['BUYER-42','Research West','Cedar Treasury','Thank you, Cedar'])assert.ok(text.includes(value),value)
        if(label==='detailed-customer-invoice')for(const value of ['Tier 1:','Tier 2:','USD 250.00'])assert.ok(text.includes(value),value)
        if(label==='paid-customer-invoice')assert.match(text,/Balance owed:[\s\n]*USD 0.00/)
        if(label.startsWith('hidden-usage')){assert.match(text,/USD 250.00/);assert.equal((text.match(/API usage/g)??[]).length,1);assert.doesNotMatch(text,/synthetic-nectar-invoice-|150|tier|breakdown/)}
        console.log(`PDF parsed ${label}`)
      }
    } finally {await context.close()}
  }})
} finally {await browser?.close();await h.close()}
