import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { chromium } from '@playwright/test'
import { processorSetup, processorEventFlow } from './processor-events.mjs'
const directory=process.env.NECTAR_EVIDENCE_DIR??'.evidence/processor-events'
await mkdir(directory,{recursive:true})
console.log('PROCESSOR BROWSER HEAD',execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim())
const cashMode=process.argv[2]==='cash'
const importedMode=process.argv[2]==='imported'
const cashModule=cashMode?await import('./processor-cash.mjs'):null
const importedModule=importedMode?await import('./processor-cash-imported.mjs'):null
const {h,owner,edge}=await processorSetup(undefined,(cashModule??importedModule)?.harnessOptions());let browser
try {
 browser=await chromium.launch({headless:true,executablePath:process.env.NECTAR_CHROMIUM_PATH,args:['--no-sandbox','--use-mock-keychain','--password-store=basic']})
 const context=await browser.newContext()
 await context.addCookies(owner.split('; ').map(part=>{const at=part.indexOf('=');return {name:part.slice(0,at),value:part.slice(at+1),url:h.origin}}))
 const page=await context.newPage()
 const capture=async({label,customer,delivery,bankInvoice})=>{
  const paths=[`/app/processor-events?customer=${customer}`,...(label==='failure-resolved'?['/app/processor-events']:[]),...(label==='cash-applied'||label==='cash-returned'||label==='cash-awaiting-allocation'?['/app/receivables']:[]),...(label==='cash-returned'||label==='imported-cash-refunded'?[`/app/reports/refunds?period=2026-10&customer=${customer}`]:[]),...(label==='reconciled'?['/app/receivables','/app/reports/settlements?period=2026-10','/app/reports/refunds?period=2026-10','/app/reports/collections?period=2026-10','/app/report-schedule',`/app/report-deliveries/${delivery}`,`/app/invoices/${bankInvoice}`]:[])]
  if(label==='reconciled')for(const metric of ['settlements','refunds','collections']){const report=await h.api(`reports/${metric}?period=2026-10&customer=${customer}`,owner);assert.ok(report.entries.length);paths.push(report.entries[0].href)}
  for(const [index,path] of paths.entries()){
   for(const width of [1440,390]){
    await page.setViewportSize({width,height:1000})
    if(path==='/app/processor-events'){await page.goto(h.origin+'/app/receivables');await page.getByRole('link',{name:'Processor reconciliation',exact:true}).click()}
    else await page.goto(h.origin+path)
    assert.equal(await page.locator('h1').count(),1)
    if(width===1440&&label==='cash-awaiting-allocation'&&path==='/app/receivables'){
     const queue=await page.locator('#cash-application-queue').innerText()
     assert.match(queue,/Remittance file/);assert.match(queue,/Processor cash balance/);assert.match(queue,/75 days until return deadline/)
     assert.ok(await page.locator('#cash-application-queue a').filter({hasText:'Review transfer'}).count())
    }
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${path} fits ${width} pixels`)
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
  if(label==='reconciled'){
   await page.setViewportSize({width:1440,height:1000});await page.goto(h.origin+'/app/processor-events')
   await page.getByRole('link',{name:'Bank deposit matched',exact:true}).click()
   const review=page.locator('#remittance-review')
   assert.match(await review.innerText(),/\$26\.70/);assert.match(await review.innerText(),/synthetic-nectar-payout-bank-deposit/)
   assert.equal(await review.locator('form').count(),0,'A matched payout is evidence without another customer payment action')
   for(const width of [1440,390]){await page.setViewportSize({width,height:1000});await review.screenshot({path:`${directory}/${width}-matched-payout-source.png`})}
   await review.getByRole('link',{name:'Open processor payout'}).click()
   assert.match(new URL(page.url()).pathname,/processor-events$/)
  }
 }
 if(cashMode){
  await cashModule.processorCashFlow(h,owner,{onState:state=>capture({...state,label:state.label??'cash-applied'}),allocate:async payload=>{
   await page.goto(h.origin+`/app/processor-events?customer=${payload.customer}`)
   const form=page.locator('form').filter({has:page.locator(`input[name="transfer_ref"][value="${payload.transfer_ref}"]`)})
   const details=form.locator('..');await details.locator('summary').click()
   await form.locator('[name="invoice"]').selectOption(payload.invoice);await form.locator('[name="amount"]').fill(payload.amount);await form.locator('[name="confirm"]').check()
   for(const width of [1440,390]){await page.setViewportSize({width,height:1000});await page.screenshot({path:`${directory}/${width}-cash-allocation-form.png`,fullPage:true})}
   await Promise.all([page.waitForNavigation(),form.getByRole('button',{name:'Apply cash',exact:true}).click()])
   assert.equal(new URL(page.url()).searchParams.has('error'),false)
   const result=(await h.api(`processor-events?customer=${payload.customer}`,owner)).cashApplications.find(row=>row.transfer_ref===payload.transfer_ref&&row.invoice_id===payload.invoice)
   assert.ok(result);return {status:result.status}
  }})
  const returns=await import('./processor-cash-return.mjs')
  await returns.processorCashReturnFlow(h,owner,{cashReturnEdge:cashModule.cashTestEdge(),onState:state=>capture({...state,label:'cash-returned'}),prepareReturn:async payload=>{
   await page.goto(h.origin+`/app/processor-events?customer=${payload.customer}`)
   const review=page.locator('form').filter({has:page.locator(`input[name="return_customer"][value="${payload.customer}"]`)})
   await review.locator('[name="return_amount"]').fill(payload.amount)
   await Promise.all([page.waitForNavigation(),review.getByRole('button',{name:'Review return',exact:true}).click()])
   const save=page.locator('form[action="/app/do/processor.cash.return.prepare"]')
   assert.equal(await save.locator('[name="basis"]').inputValue(),payload.basis)
   await save.locator('[name="confirm"]').check()
   for(const width of [1440,390]){await page.setViewportSize({width,height:1000});await page.screenshot({path:`${directory}/${width}-cash-return-review.png`,fullPage:true})}
   await Promise.all([page.waitForNavigation(),save.getByRole('button',{name:'Save reviewed return',exact:true}).click()])
   assert.equal(new URL(page.url()).searchParams.has('error'),false)
   const request=(await h.api(`processor-events?customer=${payload.customer}`,owner)).cashReturns.find(row=>row.basis===payload.basis&&row.status==='prepared')
   assert.ok(request);return request
  }})
 }
 else if(importedMode)await importedModule.processorCashImportedFlow(h,owner,{onState:capture})
 else await processorEventFlow(h,owner,edge,{onState:capture})
}finally{await browser?.close();await h.close()}
