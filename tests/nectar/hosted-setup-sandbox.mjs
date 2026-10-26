// Held-key live test only, outside push Verify. The Worker owns every setup and
// default write; Playwright enters published Stripe test inputs on Stripe only.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdir} from 'node:fs/promises'
import {chromium} from '@playwright/test'
import {harness} from './harness.mjs'
import {totp} from './mfa.mjs'
import {stripeSandbox,safeError} from './stripe-sandbox-client.mjs'

const stripe=stripeSandbox(process.env.STRIPE_SECRET_KEY),directory=process.env.NECTAR_EVIDENCE_DIR??'.evidence/hosted-sandbox'
await mkdir(directory,{recursive:true})
let h,browser,page,phase='account',customer
const facts={head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),setups:[],cleanup:false}
try {
  const account=await stripe.request('GET','/v1/account')
  facts.account=account.id
  customer=await stripe.request('POST','/v1/customers',{name:'Alder Analytics test customer',email:`nectar-${stripe.run}@example.test`,'metadata[nectar_run]':stripe.run})
  h=await harness({assets:true,stripeSecret:process.env.STRIPE_SECRET_KEY,stripeFetch:request=>stripe.forward(request)})
  await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})
  const owner=await h.signIn(h.vars.OWNER_EMAIL)
  await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
  await h.api('business.configure',owner,{legal_name:'Alder Analytics',timezone:'UTC',invoice_prefix:'ALDER',payment_terms_days:30})
  const factor=await h.api('mfa.totp.start',owner,{})
  await h.api('mfa.totp.confirm',owner,{factor:factor.factor,code:totp(factor.secret,Date.now())})
  const native=await h.api('customer.create',owner,{external_id:'synthetic-nectar-819',name:'Alder Analytics test customer',billing_email:`nectar-${stripe.run}@example.test`})
  const beforeForeign=stripe.requests.filter(row=>row.method==='POST').length
  await h.api('collection.customer.bind',owner,{customer:native.id,account_ref:'synthetic-nectar-foreign-account',stripe_customer_ref:customer.id,confirm:true},409)
  assert.equal(stripe.requests.filter(row=>row.method==='POST').length,beforeForeign,'Foreign account association is refused without a Stripe write')
  const binding=await h.api('collection.customer.bind',owner,{customer:native.id,account_ref:account.id,stripe_customer_ref:customer.id,confirm:true})
  await h.api('portal.configure',owner,{hosts:[h.origin],parents:[]})
  browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']})
  const context=await browser.newContext();page=await context.newPage()
  page.setDefaultTimeout(20000)
  for(const method of ['card','us_bank_account']) {
    phase=`prepare-${method}`
    const setup=await h.api('checkout.setup.prepare',owner,{customer:native.id,binding:binding.id,method,confirm:true})
    const session=await h.api('portal.session.issue',owner,{customer:native.id,origin:h.origin,audience:'hosted'})
    await page.goto(`${h.origin}/portal/payment-methods?session=${encodeURIComponent(session.token)}`)
    const form=page.locator('form').filter({has:page.locator(`input[value="${setup.id}"]`)})
    await form.locator('[name=confirm]').check();await form.locator('[name=make_default]').check()
    for(const width of [1440,390]) {await page.setViewportSize({width,height:950});await page.screenshot({path:`${directory}/${width}-${method}-acceptance.png`,fullPage:true})}
    phase=`stripe-${method}`
    await form.getByRole('button').first().click()
    await page.waitForURL('https://checkout.stripe.com/**')
    await page.locator('body').waitFor()
    await page.screenshot({path:`${directory}/${method}-stripe-arrival.png`,fullPage:true})
    if(method==='card') {
      await page.locator('#enableStripePass').uncheck()
      await page.locator('#billingCountry').selectOption('US')
      await page.locator('#cardNumber').fill('4242424242424242')
      await page.locator('#cardExpiry').fill('1235')
      await page.locator('#cardCvc').fill('123')
      const name=page.locator('#billingName');if(await name.count())await name.fill('Alder Analytics')
      const postal=page.locator('#billingPostalCode');if(await postal.count())await postal.fill('94105')
      await page.locator('button[type=submit]').click()
    } else {
      // The hosted bank selector owns verification. No financial input is sent
      // to Nectar or to the test driver's HTTP transport.
      const manual=page.getByText(/enter bank details manually|enter bank details|manually verify/i).first()
      await manual.click()
    }
    phase=`return-${method}`
    await page.waitForURL(`${h.origin}/portal/payment-methods`,{timeout:60000})
    const complete=page.locator('form').filter({has:page.locator(`input[value="${setup.id}"]`)})
    await complete.locator('[name=confirm]').check()
    await complete.getByRole('button').first().click()
    assert.equal(new URL(page.url()).pathname,'/portal/payment-methods/finish')
    const record=(await h.api(`customers/${native.id}`,owner)).billingRecord.hostedSetups.find(row=>row.id===setup.id)
    assert.equal(record.status,'complete');assert.equal(record.debitAuthority,false)
    const source=await stripe.request('GET',`/v1/customers/${customer.id}`)
    assert.equal(source.invoice_settings.default_payment_method,record.paymentMethod.methodRef)
    if(method==='us_bank_account')assert.ok(record.paymentMethod.mandateRef)
    facts.setups.push({id:setup.id,method,paymentMethod:record.paymentMethod.methodRef,mandate:record.paymentMethod.mandateRef,defaultChoice:record.defaultChoice})
    for(const width of [1440,390]){await page.setViewportSize({width,height:950});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:`${directory}/${width}-${method}-complete.png`,fullPage:true})}
    await h.assertStorageExcludes(['4242424242424242','000123456789',process.env.STRIPE_SECRET_KEY])
  }
  facts.outcome='passed'
} catch(error) {
  facts.outcome='failed';facts.phase=phase;facts.error=safeError(error)
  if(page){await page.screenshot({path:`${directory}/failed-${phase}.png`,fullPage:true}).catch(()=>{});facts.controls=await page.locator('input,button').evaluateAll(nodes=>nodes.map(node=>({tag:node.tagName,type:node.type,id:node.id,name:node.name,label:node.getAttribute('aria-label')}))).catch(()=>[])}
  // Deliberately avoid browser exception messages, URLs and provider bodies.
  process.exitCode=1
} finally {
  await browser?.close();await h?.close()
  if(customer?.id){try{
    const sessions=await stripe.list('/v1/checkout/sessions',{customer:customer.id})
    for(const session of sessions.data)if(session.status==='open')await stripe.request('POST',`/v1/checkout/sessions/${session.id}/expire`,{})
    await stripe.request('DELETE',`/v1/customers/${customer.id}`);facts.cleanup=true
  }catch{facts.cleanup=false}}
  console.log(JSON.stringify({...facts,requests:stripe.requests}))
}
