import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { harness } from './harness.mjs'
import { applyPolicy } from './policy-helper.mjs'
import { portalBillingFlow, harnessOptions } from './portal-billing.mjs'

const directory=process.env.NECTAR_EVIDENCE_DIR??'.evidence/portal-billing'
await mkdir(directory,{recursive:true})
const browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']})
const h=await harness({assets:true,...harnessOptions()})
try {
  await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})
  const owner=await h.signIn(h.vars.OWNER_EMAIL)
  await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
  await h.api('business.configure',owner,{legal_name:'Cedar Software Inc',timezone:'America/Los_Angeles',invoice_prefix:'CD',payment_terms_days:30})
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Reviewed portal billing journey'})
  await h.api('tax.review',owner,{revision:(await h.api('business',owner)).revision})
  const context=await browser.newContext(),page=await context.newPage(),operatorContext=await browser.newContext(),operator=await operatorContext.newPage()
  await operatorContext.addCookies(owner.split('; ').map(value=>{const i=value.indexOf('=');return {name:value.slice(0,i),value:value.slice(i+1),url:h.origin}}))
  let session
  page.on('console',message=>{if(message.type()==='error')console.error('Browser error',message.text().replace(/session=[^\s"'<>;]*/g,'session=[redacted]'))})
  page.on('requestfailed',request=>console.error('Browser request failed',new URL(request.url()).pathname,request.failure()?.errorText))
  const shot=async(target,name)=>{
    for(const width of [1440,390]) {
      await target.setViewportSize({width,height:950})
      assert.equal(await target.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${name} fits ${width}`)
      const small=await target.locator('main *').evaluateAll(nodes=>nodes.filter(node=>node.getClientRects().length&&[...node.childNodes].some(child=>child.nodeType===Node.TEXT_NODE&&child.textContent.trim())&&parseFloat(getComputedStyle(node).fontSize)<13).map(node=>node.tagName))
      assert.deepEqual(small,[],`${name} keeps readable text at ${width}`)
      const icons=await target.locator('main a,main button').evaluateAll(nodes=>nodes.filter(node=>node.getClientRects().length&&!node.textContent.trim()&&!node.querySelector('[role=tooltip]')&&!node.getAttribute('data-tooltip')).map(node=>node.outerHTML))
      assert.deepEqual(icons,[],`${name} labels its controls`)
      await target.screenshot({path:`${directory}/${width}-${name}.png`,fullPage:true})
    }
    await target.setViewportSize({width:1440,height:950})
  }
  const profilePath=()=>`${h.origin}/portal/profile?session=${encodeURIComponent(session.token)}`
  await portalBillingFlow(h,owner,{
    signIn:async(record)=>{
      await page.goto(`${h.origin}/portal/signin`)
      await page.locator('[name=customer]').fill(record.external_id)
      await page.locator('[name=email]').fill(record.billing_email)
      await shot(page,'signin-filled')
      const count=h.mails.length
      await Promise.all([page.waitForNavigation(),page.locator('form button').click()])
      await shot(page,'signin-sent')
      const message=h.mails.slice(count).find(mail=>String(mail.text).includes('/portal/signin/'))
      assert.ok(message)
      const url=message.text.match(/https?:\/\/[^\s]+\/portal\/signin\/[\w-]+/)[0]
      await page.goto(url);await shot(page,'signin-confirm')
      await Promise.all([page.waitForNavigation(),page.locator('form button').click()])
      const token=new URL(page.url()).searchParams.get('session'),claims=JSON.parse(Buffer.from(token.split('.')[0],'base64url'))
      session={id:claims.jti,token,url:page.url(),expiresAt:claims.exp,signinPath:new URL(url).pathname}
      return session
    },
    profile:async(fields)=>{
      await page.goto(profilePath())
      const form=page.locator('form').filter({has:page.locator(`input[name=operation][value="${fields.operation}"]`)})
      for(const [key,value] of Object.entries(fields)) {
        if(['operation','revision'].includes(key))continue
        const control=form.locator(`[name="${key}"]`)
        if(key==='file')await control.setInputFiles({name:value.filename,mimeType:value.type,buffer:Buffer.from(value.base64,'base64')})
        else if(await control.evaluate(node=>node.tagName)==='SELECT')await control.selectOption(value)
        else await control.fill(value)
      }
      await shot(page,`profile-${fields.operation.replace('.','-')}-prepared`)
      const [response]=await Promise.all([page.waitForNavigation(),form.locator('button').click()])
      assert.equal(response.status(),200,'Customer profile form returns to its saved state')
    },
    pay:async()=>{
      const form=page.locator('form[action^="/portal/pay?"]')
      await form.locator('[name=confirm]').check()
      const invoice=await form.locator('[name=invoice]').inputValue()
      const responsePromise=page.waitForResponse(response=>new URL(response.url()).pathname==='/portal/pay')
      await form.locator('button').click({noWaitAfter:true})
      const response=await responsePromise
      assert.equal(response.status(),303)
      assert.match(response.headers().location,/^https:\/\/checkout\.stripe\.com\//)
      const result=await h.raw(`/portal/payment?invoice=${invoice}&session=${encodeURIComponent(session.token)}`).catch(()=>null)
      // The hosted redirect carries no Nectar capability. State is read through
      // the signed portal after the external bank authorization boundary.
      if(result){const data=await result.json();return {id:data.attempt.id,status:data.attempt.status}}
      throw new Error('Portal payment state unavailable')
    },
    state:async({name,path,operator:asOperator})=>{
      const target=asOperator?operator:page
      const response=await target.goto(`${h.origin}${path}`)
      assert.equal(response.status(),name==='revoked'?401:200)
      await shot(target,name)
    },
  })
  await page.goto(`${h.origin}/portal/signin?language=es-US`);await shot(page,'signin-spanish')
  console.log(`Portal browser journey passed at 1440 and 390; screens ${directory}`)
} finally {await h.close();await browser.close()}
