import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { harness } from './harness.mjs'
import { applyPolicy } from './policy-helper.mjs'
import { harnessOptions,planChangesFlow } from './plan-changes.mjs'

const directory=process.env.NECTAR_EVIDENCE_DIR??'.evidence/plan-changes'
await mkdir(directory,{recursive:true})
console.log('PLAN CHANGES BROWSER HEAD',execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim())
const h=await harness({assets:true,...harnessOptions()});let browser
try{
  await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})
  const owner=await h.signIn(h.vars.OWNER_EMAIL)
  await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
  await h.api('business.configure',owner,{legal_name:'Cedar Software Inc',timezone:'UTC',invoice_prefix:'CD',payment_terms_days:30})
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Reviewed plan-change journey'})
  await h.api('tax.review',owner,{revision:(await h.api('business',owner)).revision})
  browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']})
  const context=await browser.newContext(),page=await context.newPage()
  const as=async cookie=>{
    await context.clearCookies()
    await context.addCookies(cookie.split('; ').map(part=>{const at=part.indexOf('=');return{name:part.slice(0,at),value:part.slice(at+1),url:h.origin}}))
  }
  const submit=async fields=>{
    await Promise.all([page.waitForNavigation(),fields.getByRole('button').first().click()])
    assert.equal(new URL(page.url()).searchParams.get('error'),null,'the native form succeeds')
  }
  await planChangesFlow(h,owner,{
    prepare:async payload=>{
      const before=(await h.api(`subscriptions/${payload.subscription}`,owner)).planChanges
      await as(owner);await page.goto(h.origin+`/app/subscriptions/${payload.subscription}`)
      const fields=page.locator('form[action="/app/do/plan.change.prepare"]')
      for(const name of ['item','price','mode'])await fields.locator(`[name="${name}"]`).selectOption(payload[name])
      if(payload.quantity)await fields.locator('[name="quantity"]').fill(String(payload.quantity))
      await submit(fields)
      const change=(await h.api(`subscriptions/${payload.subscription}`,owner)).planChanges.find(c=>!before.some(old=>old.id===c.id))
      assert.ok(change,'native preparation creates the reviewed quote')
      return {change:change.id,quote:change.quote}
    },
    decide:async(payload,cookie)=>{
      const change=(await h.api('audit',owner)).find(r=>r.action==='plan-change.prepare'&&r.subject===payload.change)
      const subscription=JSON.parse(change.detail).subscription
      await as(cookie);await page.goto(h.origin+`/app/subscriptions/${subscription}`)
      const fields=page.locator('form[action="/app/do/plan.change.decide"]').filter({has:page.locator(`input[name="change"][value="${payload.change}"]`)}).filter({has:page.locator('input[name="decision"][value="approved"]')})
      await submit(fields)
      const result=(await h.api(`subscriptions/${subscription}`,owner)).planChanges.find(c=>c.id===payload.change)
      return {invoice:result.invoice_id??null,credit:result.credit_id??null}
    },
    onState:async({label,subscription,invoice})=>{
      if(!subscription)return
      await as(owner)
      for(const width of [1440,390]){
        await page.setViewportSize({width,height:1000})
        await page.goto(h.origin+`/app/subscriptions/${subscription}#advance-plan-changes`)
        const section=page.locator('#advance-plan-changes')
        assert.ok(await section.getByRole('heading').count())
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${label} fits ${width}`)
        const tooSmall=await section.locator('p,a,button,label,td,th,select,input').evaluateAll(nodes=>nodes.filter(n=>n.getClientRects().length&&parseFloat(getComputedStyle(n).fontSize)<13).map(n=>n.tagName))
        assert.deepEqual(tooSmall,[],'plan-change text is readable')
        const icons=await page.locator('button,a,[role="button"]').evaluateAll(nodes=>nodes.filter(n=>n.getClientRects().length&&!n.textContent.trim()&&n.querySelector('svg,img')&&!n.getAttribute('aria-describedby')).map(n=>n.outerHTML))
        assert.deepEqual(icons,[],'icon controls have descriptive tooltips')
        await page.screenshot({path:`${directory}/${width}-${label}.png`,fullPage:true})
        await section.screenshot({path:`${directory}/${width}-${label}-detail.png`})
        if(invoice){
          await page.goto(h.origin+`/app/invoices/${invoice}`)
          assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
          await page.screenshot({path:`${directory}/${width}-${label}-invoice.png`,fullPage:true})
        }
        console.log('BROWSER',width,label)
      }
    },
  })
}finally{await browser?.close();await h.close()}
