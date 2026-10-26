import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { check } from './stripe-sandbox-client.mjs'

export async function bankEvidence(origin, owner) {
 const directory=process.env.NECTAR_EVIDENCE_DIR??'.evidence/retry-bank-sandbox'
 await mkdir(directory,{recursive:true})
 const browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']})
 try {
  const context=await browser.newContext()
  await context.addCookies(owner.split('; ').map(part=>{const i=part.indexOf('=');return {name:part.slice(0,i),value:part.slice(i+1),url:origin}}))
  const page=await context.newPage()
  return {close:()=>browser.close(),async capture(source,label){
   await page.goto(`${origin}/app/invoices/${source.invoiceRef}`)
   check(new URL(page.url()).pathname===`/app/invoices/${source.invoiceRef}`,'invoice_evidence_session_missing')
   for(const width of [1440,390]){
    await page.setViewportSize({width,height:1000})
    check(!await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),'invoice_evidence_overflow')
    const icons=await page.locator('a,button,[role=button]').evaluateAll(nodes=>nodes.filter(n=>!n.textContent.trim()&&n.querySelector('svg,img')&&!n.getAttribute('aria-describedby')).length)
    check(icons===0,'invoice_icon_tooltip_missing')
    const section=page.locator('#automatic-collection')
    check(await section.count()===1,'invoice_automatic_section_missing')
    await page.screenshot({path:`${directory}/${width}-${source.index}-${label}.png`,fullPage:true})
    await section.screenshot({path:`${directory}/${width}-${source.index}-${label}-detail.png`})
   }
  }}
 } catch(error){await browser.close();throw error}
}
