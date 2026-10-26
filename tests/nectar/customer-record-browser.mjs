// CUS-001 current customer composition, native customer lookup and exact scoped sources.
import assert from 'node:assert/strict'
import {mkdir,writeFile} from 'node:fs/promises'
import {chromium} from '@playwright/test'
import {harness} from './harness.mjs'
import {applyPolicy} from './policy-helper.mjs'
import {customerSearchFlow,harnessOptions} from './customer-search.mjs'
const directory=process.env.NECTAR_EVIDENCE_DIR??'.evidence/customer-record'
const hostedFocus=process.env.NECTAR_BROWSER_FOCUS==='hosted'
await mkdir(directory,{recursive:true})
const h=await harness({assets:true,hostname:'localhost',...harnessOptions()}),captures=[]
let browser
try{
  await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})
  const owner=await h.signIn(h.vars.OWNER_EMAIL)
  await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
  await h.api('business.configure',owner,{legal_name:'Alder Research Software',timezone:'UTC',invoice_prefix:'ALDER',payment_terms_days:30})
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Reviewed customer record journey'})
  await h.api('tax.review',owner,{revision:(await h.api('business',owner)).revision})
  browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']})
  const context=await browser.newContext(),page=await context.newPage()
  const customerContext=await browser.newContext(),customerPage=await customerContext.newPage()
  await customerPage.route('https://checkout.stripe.com/**',route=>route.abort())
  await context.addCookies(owner.split('; ').map(value=>{const i=value.indexOf('=');return {name:value.slice(0,i),value:value.slice(i+1),url:h.origin}}))
  const shot=async(label,width)=>{
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${label} fits ${width}`)
    const iconOnly=await page.locator('a,button,[role=button]').evaluateAll(nodes=>nodes.filter(n=>!n.textContent.trim()&&n.querySelector('svg,img')).map(n=>n.outerHTML));assert.deepEqual(iconOnly,[])
    if(hostedFocus&&!label.startsWith('hosted-'))return
    if(hostedFocus){const target=label.endsWith('-operator')?page.getByRole('heading',{name:'Hosted payment setup',exact:true}):page.locator('#saved-payment-methods');await target.scrollIntoViewIfNeeded()}
    const focusNames=label==='ach-before-verification'?['Verify an external ACH payment']:label.endsWith('customer')?['Payment receipts','Verified external ACH payments','Refund lifecycle','Saved payment methods']:[]
    for(const name of focusNames){const heading=page.getByRole('heading',{name,exact:true});if(await heading.count()===1)await heading.locator('..').screenshot({path:`${directory}/${width}-${label}-${name.toLowerCase().replaceAll(' ','-')}.png`})}
    const file=`${width}-${label}.png`;await page.screenshot({path:`${directory}/${file}`,fullPage:!hostedFocus});captures.push({width,label,file});console.log('BROWSER',width,label)
  }
  await customerSearchFlow(h,owner,async({customer,query,kind})=>{
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:950})
      assert.equal((await page.goto(h.origin+'/app/customers')).status(),200)
      const form=page.getByRole('search',{name:'Customer lookup'})
      await form.locator('[name=search]').fill(query??'billing@marigold.example')
      await Promise.all([page.waitForNavigation({waitUntil:'load'}),form.getByRole('button',{name:'Search',exact:true}).click()])
      const link=page.locator(`a[href="/app/customers/${customer}"]`);assert.equal(await link.count(),1)
      await shot(`${kind??'billing'}-search`,width)
      await Promise.all([page.waitForNavigation({waitUntil:'load'}),link.click()])
      assert.equal(new URL(page.url()).pathname,`/app/customers/${customer}`)
      await shot(`${kind??'billing'}-customer`,width)
      if(kind==='full-cycle'){
        const receipt=page.locator('main a[href^="/app/payments/"][href$="/receipt"]').first()
        await Promise.all([page.waitForNavigation({waitUntil:'load'}),receipt.click()])
        assert.equal(new URL(page.url()).pathname.endsWith('/receipt'),true)
        await shot('payment-receipt-source',width)
      }
    }
  },{prepareHosted:async({customer,binding,method})=>{
    await page.goto(h.origin+`/app/customers/${customer}`)
    const detail=page.locator('#saved-payment-methods details');await detail.locator('summary').click()
    const form=detail.locator('form');await form.locator('[name=binding]').selectOption(binding);await form.locator('[name=method]').selectOption(method);await form.locator('[name=confirm]').check()
    for(const width of [1440,390]){await page.setViewportSize({width,height:950});await shot(`hosted-${method}-prepare`,width)}
    await Promise.all([page.waitForNavigation({waitUntil:'load'}),form.getByRole('button').first().click()])
    assert.equal(new URL(page.url()).searchParams.get('error'),null)
    return (await h.api(`customers/${customer}`,owner)).billingRecord.hostedSetups.find(row=>row.status==='prepared'&&row.method===method)
  },hostedState:async({session,customer,setup,state,method})=>{
    for(const width of [1440,390]){
      await customerPage.setViewportSize({width,height:950});assert.equal((await customerPage.goto(h.origin+`/portal/payment-methods?session=${encodeURIComponent(session.token)}`)).status(),state==='refused'?401:200)
      assert.equal(await customerPage.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
      assert.equal(await customerPage.locator('a,button').evaluateAll(nodes=>nodes.filter(node=>!node.textContent.trim()).length),0,'All controls have visible labels')
      const card=customerPage.locator('section').filter({has:customerPage.locator(`input[value="${setup}"]`)});if(['prepared','open'].includes(state))assert.equal(await card.count(),1)
      await customerPage.screenshot({path:`${directory}/${width}-hosted-${method}-${state}.png`,fullPage:true})
      console.log('BROWSER',width,'hosted',method,state)
      await page.setViewportSize({width,height:950});await page.goto(h.origin+`/app/customers/${customer}`);await shot(`hosted-${method}-${state}-operator`,width)
    }
  },startHosted:async({session,setup})=>{
    await customerPage.goto(h.origin+`/portal/payment-methods?session=${encodeURIComponent(session.token)}`)
    const form=customerPage.locator('form').filter({has:customerPage.locator(`input[value="${setup}"]`)});await form.locator('[name=confirm]').check();await form.locator('[name=make_default]').check()
    const response=customerPage.waitForResponse(r=>new URL(r.url()).pathname==='/portal/payment-methods.start');await form.getByRole('button').first().click({noWaitAfter:true});const result=await response
    assert.equal(result.status(),303);const url=result.headers().location;assert.equal(new URL(url).hostname,'checkout.stripe.com')
    const cookies=await customerContext.cookies();assert.ok(cookies.some(cookie=>cookie.name==='nectar_setup_return'&&cookie.httpOnly&&cookie.sameSite==='Lax'))
    assert.equal((await customerPage.goto(h.origin+'/portal/payment-methods')).status(),200);return {status:'open',url,cookie:cookies.filter(cookie=>cookie.name==='nectar_setup_return').map(cookie=>`${cookie.name}=${cookie.value}`).join('; ')}
  },finishHosted:async({session,setup})=>{
    assert.equal((await customerPage.goto(h.origin+'/portal/payment-methods')).status(),200)
    const form=customerPage.locator('form').filter({has:customerPage.locator(`input[value="${setup}"]`)});await form.locator('[name=confirm]').check()
    const [completed]=await Promise.all([customerPage.waitForNavigation({waitUntil:'load'}),form.getByRole('button').first().click()]);assert.equal(completed.status(),200);assert.equal(new URL(customerPage.url()).pathname,'/portal/payment-methods.finish');for(const width of [1440,390]){await customerPage.setViewportSize({width,height:950});await customerPage.screenshot({path:`${directory}/${width}-hosted-return-complete.png`,fullPage:true})};return {status:'complete'}
  },recordAch:async({customer,input})=>{
    await page.goto(h.origin+`/app/customers/${customer}`)
    for(const width of [1440,390]){await page.setViewportSize({width,height:950});await shot('ach-before-verification',width)}
    const form=page.locator('form[action="/app/do/payment.ach_evidence.record"]')
    await form.locator('[name=invoice]').selectOption(input.invoice)
    await form.locator('[name=account_ref]').selectOption(input.account_ref)
    await form.locator('[name=payment_intent_ref]').fill(input.payment_intent_ref)
    await form.locator('[name=confirm]').check()
    await Promise.all([page.waitForNavigation({waitUntil:'load'}),form.getByRole('button').first().click()])
    assert.equal(new URL(page.url()).searchParams.get('error'),null)
    return (await h.api(`customers/${customer}`,owner)).billingRecord.achPaymentEvidence.at(-1)
  },refreshMethods:async({customer})=>{
    await page.goto(h.origin+`/app/customers/${customer}`)
    for(const width of [1440,390]){await page.setViewportSize({width,height:950});await shot('saved-methods-before-refresh',width)}
    const form=page.locator('form[action="/app/do/customer.payment_methods.refresh"]')
    await Promise.all([page.waitForNavigation({waitUntil:'load'}),form.getByRole('button').first().click()])
    assert.equal(new URL(page.url()).searchParams.get('error'),null)
    return (await h.api(`customers/${customer}`,owner)).billingRecord.savedPaymentMethods
  }})
  await writeFile(`${directory}/screens.json`,JSON.stringify({journey:'CUS-001 current customer record',captures},null,2))
}finally{await browser?.close();await h.close()}
