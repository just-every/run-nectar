// Native owner and signed-out customer forms over the same public journey.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { harness } from './harness.mjs'
import { applyPolicy } from './policy-helper.mjs'
import { harnessOptions, paymentLinksFlow } from './payment-links.mjs'

const directory=process.env.NECTAR_EVIDENCE_DIR??'.evidence/payment-links'
await mkdir(directory,{recursive:true})
const h=await harness({...harnessOptions(),assets:true})
let browser
const captures=[]
try {
  await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})
  const owner=await h.signIn(h.vars.OWNER_EMAIL)
  await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
  await h.api('business.configure',owner,{legal_name:'Cedar Software Inc',timezone:'America/Los_Angeles',invoice_prefix:'CD',payment_terms_days:30})
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Synthetic browser journey'})
  await h.api('tax.review',owner,{revision:(await h.api('business',owner)).revision})
  browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']})
  const operatorContext=await browser.newContext(),customerContext=await browser.newContext()
  await operatorContext.addCookies(owner.split(';').map(value=>{const [name,...rest]=value.trim().split('=');return {name,value:rest.join('='),url:h.origin}}))
  const operator=await operatorContext.newPage(),customer=await customerContext.newPage()
  await customer.route('https://checkout.stripe.com/**',route=>route.abort())
  const capture=async(page,name)=>{
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:844})
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Customer and management page fits the viewport')
      const file=`${width}-${name}.png`;await page.screenshot({path:`${directory}/${file}`,fullPage:true});captures.push(file)
      const attribution=page.getByRole('heading',{name:'Signup attribution',exact:true});if(await attribution.count())await attribution.first().locator('..').screenshot({path:`${directory}/${width}-${name}-attribution.png`})
      for(const [action,label] of [['payment_link.create','create-policy'],['payment_link.approve','approve-policy'],['payment_link.activate','activate-policy']]){
        const forms=page.locator(`form[action="/app/do/${action}"]`)
        for(let index=0;index<await forms.count();index++)await forms.nth(index).locator('..').screenshot({path:`${directory}/${width}-${name}-${label}-${index}.png`})
      }
      const iconOnly=await page.locator('a,button,[role=button]').evaluateAll(nodes=>nodes.filter(n=>!n.textContent.trim()&&n.querySelector('svg,img')&&!n.getAttribute('aria-describedby')).length);assert.equal(iconOnly,0)
    }
  }
  let created=0,started=0
  await paymentLinksFlow(h,owner,{interaction:{
    cancelRenewal:async({cancelPath})=>{
      await customer.goto(h.origin+cancelPath);await capture(customer,'cancellation-confirmation')
      const response=customer.waitForResponse(value=>new URL(value.url()).pathname===cancelPath&&value.request().method()==='POST')
      await customer.locator('button[name=confirm][value=cancel]').click();assert.equal((await response).status(),200)
      await capture(customer,'cancellation-complete')
    },
    approvePolicy:async({finance,pending})=>{
      const financeContext=await browser.newContext();await financeContext.addCookies(finance.split(';').map(value=>{const [name,...rest]=value.trim().split('=');return {name,value:rest.join('='),url:h.origin}}))
      const financePage=await financeContext.newPage();await financePage.goto(h.origin+'/app/payment-links');await capture(financePage,'independent-policy-approval')
      const form=financePage.locator('form[action="/app/do/payment_link.approve"]').filter({has:financePage.locator(`input[name=link][value="${pending.id}"]`)})
      await form.locator('[name=confirm]').check();await Promise.all([financePage.waitForNavigation(),form.getByRole('button').click()]);assert.equal(new URL(financePage.url()).searchParams.has('error'),false)
      await capture(financePage,'independent-policy-approved');await financeContext.close()
    },
    activatePolicy:async({pending})=>{
      await operator.goto(h.origin+'/app/payment-links')
      const form=operator.locator('form[action="/app/do/payment_link.activate"]').filter({has:operator.locator(`input[name=link][value="${pending.id}"]`)})
      await form.locator('[name=confirm]').check();await capture(operator,'approved-policy-activation')
      await Promise.all([operator.waitForNavigation(),form.getByRole('button').click()]);assert.equal(new URL(operator.url()).searchParams.has('error'),false)
      await capture(operator,'approved-policy-active')
    },
    action:async({action,payload})=>{
      const before=await h.api('payment-links',owner)
      await operator.goto(`${h.origin}/app/payment-links`)
      if(action==='payment_link.deactivate') {
        const form=operator.locator('form').filter({has:operator.locator(`input[name=link][value="${payload.link}"]`)})
        const response=operator.waitForResponse(value=>value.url().endsWith('/app/do/payment_link.deactivate')&&value.request().method()==='POST')
        await form.getByRole('button').click();assert.equal((await response).status(),303)
        await operator.waitForURL('**/app/payment-links**');return {id:payload.link}
      }
      const forms=operator.locator('form[action="/app/do/payment_link.create"]'),form=payload.kind==='one_time'?forms.nth(1):forms.nth(0)
      await form.locator('[name=name]').fill(payload.name)
      if(payload.kind==='one_time') {
        await form.locator('[name=amount]').fill(payload.amount);await form.locator('[name=description]').fill(payload.description)
        if(payload.taxable)await form.locator('[name=taxable]').check()
      } else {
        for(let index=0;index<payload.price.length;index++){await form.locator('[name=price]').nth(index).selectOption(payload.price[index]);await form.locator('[name=quantity]').nth(index).fill(payload.quantity[index]??'1')}
        await form.locator('[name=trial_days]').fill(String(payload.trial_days??0));await form.locator('[name=months]').fill(String(payload.months));await form.locator('[name=auto_renew]').selectOption(String(payload.auto_renew));await form.locator('[name=notice_days]').fill(String(payload.notice_days));await form.locator('[name=uplift_percent]').fill(payload.uplift_percent);if(payload.confirm_single)await form.locator('[name=confirm_single]').check()
        if(payload.promotion_code)await form.locator('[name=promotion_code]').fill(payload.promotion_code)
      }
      if(payload.max_uses)await form.locator('[name=max_uses]').fill(String(payload.max_uses))
      await form.locator('[name=confirm]').check()
      if(created++===0)await capture(operator,'owner-create')
      if(payload.kind==='one_time')await capture(operator,'owner-create-one-time')
      const response=operator.waitForResponse(value=>value.url().endsWith('/app/do/payment_link.create')&&value.request().method()==='POST')
      await form.getByRole('button').click();assert.equal((await response).status(),303)
      await operator.waitForURL('**/app/payment-links**')
      const link=(await h.api('payment-links',owner)).find(row=>!before.some(old=>old.id===row.id));assert.ok(link)
      return {id:link.id,path:link.path,revision:link.revision}
    },
    start:async({id,language,payload})=>{
      await customer.goto(`${h.origin}/pay-links/${id}?language=${language}`)
      const form=customer.locator('form[action$="/start"]')
      await form.locator('[name=name]').fill(payload.name);await form.locator('[name=billing_email]').fill(payload.billing_email);await form.locator('[name=address]').fill(payload.address)
      await form.locator('[name=confirm]').check();if(payload.make_default)await form.locator('[name=make_default]').check()
      const accepted=await form.evaluate(element=>Object.fromEntries(new FormData(element)))
      started++;await capture(customer,`${language}-consent-${started}`)
      const response=customer.waitForResponse(value=>value.url().endsWith(`/pay-links/${id}/start`)&&value.request().method()==='POST')
      await form.getByRole('button').click();const posted=await response;assert.equal(posted.status(),303)
      const cookies=await customerContext.cookies(),headers=await posted.allHeaders()
      const idMatch=headers['set-cookie']?.match(/Path=\/pay-links\/attempts\/([\w-]+)/)
      const attempt=idMatch?.[1];assert.ok(attempt,'The new signup returns its scoped cookie path')
      const saved=cookies.find(value=>value.name==='nectar_payment_link'&&value.path===`/pay-links/attempts/${attempt}`);assert.ok(saved)
      const cookieHeader=`${saved.name}=${saved.value}`
      const state=await (await h.raw(`/pay-links/attempts/${attempt}`,{cookie:cookieHeader,headers:{accept:'application/json'}})).json()
      await customer.goto(`${h.origin}/pay-links/attempts/${attempt}`);await capture(customer,`return-${state.status}-${started}`)
      return {body:{...state,url:headers.location,returnPath:`/pay-links/attempts/${attempt}`},cookie:cookieHeader,payload:accepted}
    },
    post:async({attempt,operation})=>{
      const path=`/pay-links/attempts/${attempt.body.id}`
      await customer.goto(h.origin+path)
      let form=customer.locator(`form[action="${path}/${operation}"]`)
      if(operation==='reconcile'&&!await form.count())form=customer.locator(`form[action="${path}/finish"]`)
      if(operation==='cancellation'){
        const response=customer.waitForResponse(value=>new URL(value.url()).pathname===`${path}/cancellation`&&value.request().method()==='POST')
        await form.getByRole('button').click();const posted=await response;assert.equal(posted.status(),303)
        return {cancelUrl:new URL((await posted.allHeaders()).location,h.origin).href}
      }
      if(await form.count()) {
        const formAction=await form.getAttribute('action')
        const response=customer.waitForResponse(value=>new URL(value.url()).pathname===formAction&&value.request().method()==='POST')
        await form.getByRole('button').click();assert.equal((await response).status(),303)
      }else{const replay=await h.raw(`${path}/${operation}`,{cookie:attempt.cookie,body:{confirm:true}});assert.equal(replay.status,200)}
      const response=await h.raw(path,{cookie:attempt.cookie,headers:{accept:'application/json'}});assert.equal(response.status,200);return response.json()
    },
  },onState:async({completed,state,cancelPath})=>{
    if(cancelPath){await customer.goto(h.origin+cancelPath);await capture(customer,'cancelled-scope');return}
    await customer.goto(`${h.origin}/pay-links/attempts/${completed.id}`);await capture(customer,state)
    await operator.goto(`${h.origin}/app/customers/${completed.customer}`);await capture(operator,`${state}-customer`)
    if(completed.payment){await operator.goto(`${h.origin}/app/payments/${completed.payment}/receipt`);await capture(operator,`${state}-receipt`)}
  }})
  await customer.goto(`${h.origin}/pay-links/unknown`);await capture(customer,'refused')
  console.log('payment-links browser screens:',captures.length)
} finally {await browser?.close();await h.close()}
