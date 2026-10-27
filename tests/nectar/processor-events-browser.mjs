import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { chromium } from '@playwright/test'
import { processorSetup, processorEventFlow } from './processor-events.mjs'
const directory=process.env.NECTAR_EVIDENCE_DIR??'.evidence/processor-events'
await mkdir(directory,{recursive:true})
console.log('PROCESSOR BROWSER HEAD',execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim())
const cashMode=process.argv[2]==='cash'
const cashModule=cashMode?await import('./processor-cash.mjs'):null
const {h,owner,edge}=await processorSetup(undefined,cashModule?.harnessOptions());let browser
try {
 browser=await chromium.launch({headless:true,executablePath:process.env.NECTAR_CHROMIUM_PATH,args:['--no-sandbox','--use-mock-keychain','--password-store=basic']})
 const context=await browser.newContext()
 await context.addCookies(owner.split('; ').map(part=>{const at=part.indexOf('=');return {name:part.slice(0,at),value:part.slice(at+1),url:h.origin}}))
 const page=await context.newPage()
 const capture=async({label,customer,delivery,bankInvoice})=>{
  const paths=[`/app/processor-events?customer=${customer}`,...(label==='reconciled'?['/app/receivables','/app/reports/settlements?period=2026-10','/app/reports/refunds?period=2026-10','/app/reports/collections?period=2026-10','/app/report-schedule',`/app/report-deliveries/${delivery}`,`/app/invoices/${bankInvoice}`]:[])]
  if(label==='reconciled')for(const metric of ['settlements','refunds','collections']){const report=await h.api(`reports/${metric}?period=2026-10&customer=${customer}`,owner);assert.ok(report.entries.length);paths.push(report.entries[0].href)}
  for(const [index,path] of paths.entries()){
   for(const width of [1440,390]){
    await page.setViewportSize({width,height:1000});await page.goto(h.origin+path)
    assert.equal(await page.locator('h1').count(),1)
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Processor views fit the screen')
    const icons=await page.locator('a,button,[role=button]').evaluateAll(nodes=>nodes.filter(node=>!node.textContent.trim()&&node.querySelector('svg,img')&&!node.getAttribute('aria-describedby')).map(node=>node.outerHTML))
    assert.deepEqual(icons,[],'Icon controls have tooltips')
    if(path==='/app/receivables'){
     const control=page.locator('.nc-tooltip-wrap>a').first(),hint=page.locator('.nc-tooltip').first()
     await control.focus();assert.equal(await hint.isVisible(),true,'Keyboard focus shows the tooltip immediately')
     await control.evaluate(node=>node.blur());await page.mouse.move(0,0)
     await control.hover();await hint.waitFor({state:'visible',timeout:2000})
    }
    await page.screenshot({path:`${directory}/${width}-${label}-${index}.png`,fullPage:true})
   }
  }
 }
 if(cashMode)await cashModule.processorCashFlow(h,owner,{onState:state=>capture({...state,label:'cash-applied'})})
 else await processorEventFlow(h,owner,edge,{onState:capture})
}finally{await browser?.close();await h.close()}
