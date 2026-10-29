import assert from 'node:assert/strict'
import {mkdir} from 'node:fs/promises'
import {chromium} from '@playwright/test'
import {harness} from './harness.mjs'
import {applyPolicy} from './policy-helper.mjs'
import {harnessOptions,invoicePartialPaymentsFlow} from './invoice-partial-payments.mjs'

const directory=process.env.NECTAR_EVIDENCE_DIR??'.evidence/invoice-partial-payments'
await mkdir(directory,{recursive:true})
const h=await harness({...harnessOptions(),assets:true})
let browser
try {
  await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})
  const owner=await h.signIn(h.vars.OWNER_EMAIL)
  await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
  await h.api('business.configure',owner,{legal_name:'Synthetic merchant',timezone:'UTC',invoice_prefix:'SYNTH',payment_terms_days:30})
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Synthetic partial payment journey'})
  await h.api('tax.review',owner,{revision:(await h.api('business',owner)).revision})
  browser=await chromium.launch({headless:true,...process.env.NECTAR_CHROMIUM_PATH?{executablePath:process.env.NECTAR_CHROMIUM_PATH}:{},args:['--no-sandbox','--use-mock-keychain','--password-store=basic']})
  const opContext=await browser.newContext(),customerContext=await browser.newContext()
  await opContext.addCookies(owner.split(';').map(pair=>{const [name,...value]=pair.trim().split('=');return {name,value:value.join('='),url:h.origin}}))
  const op=await opContext.newPage(),customer=await customerContext.newPage()
  await customer.route('https://checkout.stripe.com/**',route=>route.fulfill({status:200,body:'Synthetic processor edge'}))
  const capture=async(page,label)=>{
    await page.setViewportSize({width:1440,height:950})
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${label} fits the desktop viewport`)
    assert.equal(await page.locator('a,button,[role=button]').evaluateAll(nodes=>nodes.filter(n=>!n.textContent.trim()&&n.querySelector('svg,img')&&!n.getAttribute('aria-describedby')).length),0,'Icon-only controls have a tooltip')
    const region=page.locator('#partial-payment')
    if(await region.count())assert.ok(await region.locator('*').evaluateAll(nodes=>nodes.filter(n=>n.textContent.trim()).every(n=>parseFloat(getComputedStyle(n).fontSize)>=13)),'Changed operator text remains readable')
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:950})
      await page.screenshot({path:`${directory}/${label}-${width}.png`,fullPage:true})
    }
    await page.setViewportSize({width:1440,height:950})
  }
  const rows=()=>h.api('invoice-partial-payments',owner)
  const submit=async form=>{await Promise.all([op.waitForNavigation(),form.locator('button').click()]);assert.equal(new URL(op.url()).searchParams.get('error'),null)}
  await invoicePartialPaymentsFlow(h,owner,{
    interaction:{
      prepare:async({invoice})=>{
        await op.goto(h.origin+`/app/invoices/${invoice}`)
        const form=op.locator('form[action="/app/do/invoice.partial.prepare"]')
        await form.locator('..').locator('summary').click()
        await form.locator('[name=amount_cents]').fill('40000')
        await submit(form)
        const result=(await rows()).find(r=>r.invoice===invoice&&r.status==='prepared')
        assert.ok(result);await capture(op,'owner-exact-review');return result
      },
      confirm:async({prepared})=>{
        await op.goto(h.origin+`/app/invoices/${prepared.invoice}`)
        const form=op.locator('form[action="/app/do/invoice.partial.confirm"]').filter({has:op.locator(`input[name=request][value="${prepared.id}"]`)})
        await form.locator('[name=confirm]').check();await submit(form)
        return (await rows()).find(r=>r.id===prepared.id)
      },
      accept:async({invoice,session,payload})=>{
        await customer.goto(h.origin+`/portal/invoices/${invoice}?session=${session.token}`)
        const form=customer.locator(`[data-partial="${payload.request}"] form`).first()
        await form.locator('[name=accept]').check()
        assert.equal(await form.evaluate(node=>node.checkValidity()),true,'The native consent form is valid')
        const response=customer.waitForResponse(r=>new URL(r.url()).pathname==='/portal/invoice-payment/start'&&r.request().method()==='POST')
        await form.locator('button').click()
        const result=await response;assert.equal(result.status(),303)
        const headers=await result.allHeaders()
        assert.match(headers.location,/^https:\/\/checkout\.stripe\.com\//)
        return {started:{status:'open'},cookie:headers['set-cookie'].split(';')[0]}
      },
      check:async({invoice,session,request})=>{
        await customer.goto(h.origin+`/portal/invoices/${invoice}?session=${session.token}`)
        const form=customer.locator(`[data-partial="${request}"] form`)
        await Promise.all([customer.waitForNavigation(),form.locator('button').click()])
        assert.match(await customer.locator('main').innerText(),/Payment received/)
        return {...(await rows()).find(r=>r.id===request),payment:(await rows()).find(r=>r.id===request).payment}
      }
    },
    onState:async state=>{
      const response=await customer.goto(h.origin+`/portal/invoices/${state.invoice}?session=${state.session.token}`)
      assert.equal(response.status(),200)
      const text=await customer.locator('main').innerText()
      if(state.label==='captured-en'){assert.match(text,/USD 600\.00/);assert.match(text,/USD 400\.00/)}
      if(state.label==='captured-es'){assert.match(text,/600,00 USD|USD 600\.00/);assert.match(text,/400,00 USD|USD 400\.00/)}
      await capture(customer,state.label)
    }
  })
  console.log('Partial invoice payment: native owner and customer forms, exact figures and English and Spanish browser screens at 1440 and 390 passed')
} finally {await browser?.close();await h.close()}
