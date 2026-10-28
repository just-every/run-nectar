import assert from 'node:assert/strict'
import {mkdir} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import {chromium} from '@playwright/test'
import {harness} from './harness.mjs'
import {applyPolicy} from './policy-helper.mjs'
import {harnessOptions,usageThresholdFlow} from './entitlement-quotas.mjs'
const directory=process.env.NECTAR_EVIDENCE_DIR??'.evidence/usage-thresholds'
await mkdir(directory,{recursive:true})
console.log('THRESHOLD BROWSER HEAD',execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim())
const h=await harness({...harnessOptions(),assets:true});let browser
try{
  await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})
  const owner=await h.signIn(h.vars.OWNER_EMAIL)
  await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
  await h.api('business.configure',owner,{legal_name:'Acacia Billing',timezone:'UTC',invoice_prefix:'ACACIA',payment_terms_days:30})
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Synthetic threshold journey'})
  await h.api('tax.review',owner,{revision:(await h.api('business',owner)).revision})
  browser=await chromium.launch({headless:true,args:['--no-sandbox','--use-mock-keychain','--password-store=basic']})
  const context=await browser.newContext()
  await context.addCookies(owner.split('; ').map(part=>{const at=part.indexOf('=');return{name:part.slice(0,at),value:part.slice(at+1),url:h.origin}}))
  const page=await context.newPage(),customerContext=await browser.newContext(),customerPage=await customerContext.newPage()
  const capture=async(page,label)=>{
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:1000})
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${label} fits ${width}`)
      assert.deepEqual(await page.locator('a,button,[role=button]').evaluateAll(nodes=>nodes.filter(n=>!n.textContent.trim()&&n.querySelector('svg,img')&&!n.getAttribute('aria-describedby')).map(n=>n.outerHTML)),[],'Icon controls have tooltips')
      await page.screenshot({path:`${directory}/${width}-${label}.png`,fullPage:true})
    }
    console.log('SCREEN 1440 and 390',label)
  }
  await usageThresholdFlow(h,owner,{onState:async state=>{
    await page.setViewportSize({width:1440,height:1000})
    if(state.label==='crossed'){
      await page.goto(h.origin+'/app/usage?period=2026-09');await capture(page,'usage-navigation')
      await page.goto(h.origin+'/app/more');assert.equal(await page.getByRole('heading',{name:'Usage threshold alerts'}).count(),1);assert.equal(await page.getByRole('link',{name:'One million calls',exact:true}).count(),1);await capture(page,'notification-navigation')
      await customerPage.goto(h.origin+`/portal?session=${encodeURIComponent(state.session.token)}`);await capture(customerPage,'portal-navigation')
      assert.equal((await page.goto(h.origin+'/app/usage/alerts')).status(),200)
      assert.equal(await page.getByRole('heading',{name:'Recent crossings'}).count(),1)
      assert.equal(await page.getByRole('button',{name:'Prepare threshold invoice'}).count(),1)
      await capture(page,'operator-alerts')
      await page.getByText('Create an alert',{exact:true}).click()
      const operatorForm=page.locator('details').filter({has:page.locator('summary',{hasText:'Create an alert'})}).locator('form')
      assert.equal(await operatorForm.getByLabel('Contract (commitment alerts)',{exact:true}).getByRole('option',{name:/Signed monthly minimum/}).count(),1,'Contract choices name the actual saved terms')
      await operatorForm.getByLabel('Alert name',{exact:true}).fill('Budget watch')
      await operatorForm.getByLabel('Subscription',{exact:true}).selectOption(state.subscription)
      await operatorForm.getByLabel('Alert type',{exact:true}).selectOption('spend')
      await operatorForm.getByLabel('Threshold (usage units, spend in billing currency, or commitment percent)',{exact:true}).fill('7000')
      await operatorForm.getByLabel('Recipient billing contact email',{exact:true}).fill('priya@acacia.example')
      await operatorForm.getByLabel('I confirm this billing contact may receive threshold emails.').check()
      await capture(page,'operator-alert-form')
      await Promise.all([page.waitForNavigation(),operatorForm.getByRole('button',{name:'Create alert',exact:true}).click()])
      assert.equal(await page.getByRole('heading',{name:'Budget watch',exact:true}).count(),1)
      assert.equal((await customerPage.goto(h.origin+`/portal/alerts?session=${encodeURIComponent(state.session.token)}`)).status(),200)
      assert.equal(await customerPage.getByRole('heading',{name:'One million calls',exact:true}).count(),2)
      await customerPage.getByText('Change alert settings',{exact:true}).click()
      const form=customerPage.locator('form').first()
      await form.getByLabel('Threshold (usage units or spend in billing currency)',{exact:true}).fill('1500000')
      await form.getByLabel('I agree to receive threshold emails at my bound billing contact address.').check()
      await capture(customerPage,'portal-alert-form')
      await Promise.all([customerPage.waitForNavigation(),form.getByRole('button',{name:'Update alert'}).click()])
      assert.equal(await customerPage.locator('input[name=threshold]').first().inputValue(),'1500000.00','Portal form changes the owned alert')
      await capture(customerPage,'portal-alerts')
      const wrong=await customerPage.goto(h.origin+`/portal/alerts?session=${encodeURIComponent(state.foreign.token)}`)
      assert.equal(wrong.status(),200);assert.equal(await customerPage.getByText('One million calls',{exact:true}).count(),0);assert.equal(await customerPage.locator('form').count(),0,'An account without a subscription has no unfulfillable alert form')
      await capture(customerPage,'other-customer-alerts')
    }else{
      assert.equal((await page.goto(h.origin+`/app/invoices/${state.invoice}`)).status(),200)
      if(state.label==='threshold-invoice')assert.equal(await page.getByText('$5,050.00',{exact:true}).count()>0,true)
      else if(state.label==='remainder-invoice')assert.equal(await page.getByText('$950.00',{exact:true}).count()>0,true)
      else if(state.label==='credited-threshold')assert.equal(await page.getByText('$499.50',{exact:true}).count()>0,true)
      else assert.equal(await page.getByText('$0.00',{exact:true}).count()>0,true)
      await capture(page,state.label)
    }
  }})
}finally{await browser?.close();await h.close()}
