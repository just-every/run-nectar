// Held-key live test only, outside push Verify. The Worker owns every setup and
// default write; Playwright enters published Stripe test inputs on Stripe only.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdir} from 'node:fs/promises'
import {chromium,expect} from '@playwright/test'
import {harness} from './harness.mjs'
import {totp} from './mfa.mjs'
import {applyPolicy} from './policy-helper.mjs'
import {stripeSandbox,safeError} from './stripe-sandbox-client.mjs'

const stripe=stripeSandbox(process.env.STRIPE_SECRET_KEY),directory=process.env.NECTAR_EVIDENCE_DIR??'.evidence/hosted-sandbox'
await mkdir(directory,{recursive:true})
let h,browser,page,phase='account',customer
const facts={journey:'PORT-004 replacement, verified ACH and next invoice',head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),setups:[],cleanup:false}
try {
  const account=await stripe.request('GET','/v1/account')
  facts.account=account.id
  customer=await stripe.request('POST','/v1/customers',{name:'Alder Analytics test customer',email:`nectar-${stripe.run}@example.test`,'metadata[nectar_run]':stripe.run})
  const old=await stripe.request('POST','/v1/payment_methods',{type:'card','card[token]':'tok_visa'})
  await stripe.request('POST',`/v1/payment_methods/${old.id}/attach`,{customer:customer.id})
  await stripe.request('POST',`/v1/payment_methods/${old.id}`,{'card[exp_month]':new Date().getUTCMonth()+1,'card[exp_year]':new Date().getUTCFullYear()})
  await stripe.request('POST',`/v1/customers/${customer.id}`,{'invoice_settings[default_payment_method]':old.id})
  facts.previousExpiringCard=old.id
  let loseDefaultResponse=false
  h=await harness({assets:true,stripeSecret:process.env.STRIPE_SECRET_KEY,stripeFetch:async request=>{
    const response=await stripe.forward(request)
    if(loseDefaultResponse&&request.method==='POST'&&new URL(request.url).pathname===`/v1/customers/${customer.id}`){
      loseDefaultResponse=false;await response.arrayBuffer();return new Response(null,{status:503})
    }
    return response
  }})
  await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})
  const owner=await h.signIn(h.vars.OWNER_EMAIL)
  await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
  await h.api('business.configure',owner,{legal_name:'Alder Analytics',timezone:'UTC',invoice_prefix:'ALDER',payment_terms_days:30})
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Reviewed portal replacement journey'})
  await h.api('tax.review',owner,{revision:(await h.api('business',owner)).revision})
  await h.api('access.give',owner,{email:'synthetic-nectar-872@example.test',name:'Finance approver',role:'finance'})
  const finance=await h.signIn('synthetic-nectar-872@example.test',{requested:true})
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
      await page.locator('#billingName').fill('Alder Analytics')
      const manual=page.getByText(/enter bank details manually|enter bank details|manually verify/i).first()
      await manual.click()
      phase='bank-details'
      let bankFrame
      await expect.poll(async()=>{
        for(const frame of page.frames())if(frame.url().startsWith('https:')&&new URL(frame.url()).hostname.endsWith('.stripe.com')&&await frame.getByRole('textbox',{name:'Routing number',exact:true}).count()===1){bankFrame=frame;return true}
        return false
      },{timeout:20000}).toBe(true)
      await bankFrame.getByRole('textbox',{name:'Routing number',exact:true}).fill('110000000')
      await bankFrame.getByRole('textbox',{name:'Account number',exact:true}).fill('000123456789')
      await bankFrame.getByRole('textbox',{name:'Confirm account number',exact:true}).fill('000123456789')
      await bankFrame.getByRole('button',{name:'Submit',exact:true}).click()
      await bankFrame.getByRole('button',{name:'Finish without saving',exact:true}).click()
      await bankFrame.getByRole('button',{name:/^Continue to /}).click()
      if(new URL(page.url()).hostname==='checkout.stripe.com')await page.locator('button[type=submit]').click()
      await page.screenshot({path:`${directory}/bank-submitted.png`,fullPage:true})
    }
    phase=`return-${method}`
    await page.waitForURL(`${h.origin}/portal/payment-methods`,{timeout:60000})
    if(method==='us_bank_account') {
      const sessions=await stripe.list('/v1/checkout/sessions',{customer:customer.id})
      const checkout=sessions.data.find(row=>row.metadata?.nectar_setup_id===setup.id)
      const intent=await stripe.request('GET',`/v1/setup_intents/${checkout.setup_intent}`)
      if(intent.status==='requires_action'&&intent.next_action?.type==='verify_with_microdeposits') {
        const verification=intent.next_action.verify_with_microdeposits
        await stripe.request('POST',`/v1/setup_intents/${intent.id}/verify_microdeposits`,verification.microdeposit_type==='descriptor_code'?{descriptor_code:'SM11AA'}:{'amounts[]':[32,45]})
      }
    }
    const complete=page.locator('form').filter({has:page.locator(`input[value="${setup.id}"]`)})
    await complete.locator('[name=confirm]').check()
    const defaultWrites=()=>stripe.requests.filter(row=>row.method==='POST'&&row.path===`/v1/customers/${customer.id}`).length
    const writesBefore=defaultWrites()
    loseDefaultResponse=method==='us_bank_account'
    const [completed]=await Promise.all([page.waitForNavigation(),complete.getByRole('button').first().click()])
    if(method==='us_bank_account') {
      assert.equal(completed.status(),502,'The intentionally lost real response stays uncertain')
      assert.equal(defaultWrites(),writesBefore+1)
      for(const width of [1440,390]){await page.setViewportSize({width,height:950});await page.screenshot({path:`${directory}/${width}-ach-uncertain.png`,fullPage:true})}
      assert.equal((await page.goto(`${h.origin}/portal/payment-methods`)).status(),200)
      const reconcile=page.locator('form').filter({has:page.locator(`input[value="${setup.id}"]`)})
      await reconcile.locator('[name=confirm]').check()
      const [recovered]=await Promise.all([page.waitForNavigation(),reconcile.getByRole('button').click()])
      assert.equal(recovered.status(),200)
      assert.equal(defaultWrites(),writesBefore+1,'Real default reconciliation never repeats the provider write')
      facts.lostResponseReconciled=true
    }
    assert.equal(new URL(page.url()).pathname,method==='us_bank_account'?'/portal/payment-methods/reconcile':'/portal/payment-methods/finish')
    const record=(await h.api(`customers/${native.id}`,owner)).billingRecord.hostedSetups.find(row=>row.id===setup.id)
    assert.equal(record.status,'complete');assert.equal(record.debitAuthority,false)
    const source=await stripe.request('GET',`/v1/customers/${customer.id}`)
    assert.equal(source.invoice_settings.default_payment_method,record.paymentMethod.methodRef)
    if(method==='us_bank_account')assert.ok(record.paymentMethod.mandateRef)
    phase=`next-invoice-${method}`
    const day=new Date().toISOString().slice(0,10)
    const charge=await h.api('charge.add',owner,{customer:native.id,amount:'12',description:'Portal replacement renewal',effective_date:day,taxable:false})
    const invoice=await h.api('invoice.manual',owner,{customer:native.id,charges:[charge.charge],service_date:day})
    const authority=await h.api('automatic.collection.prepare',owner,{invoice:invoice.id,issue_date:day,...(method==='us_bank_account'?{mandate_ref:record.paymentMethod.mandateRef}:{})})
    assert.equal(authority.quote.method.paymentMethodRef,record.paymentMethod.methodRef)
    const acceptance=await h.raw(`/portal/automatic-collections/${authority.id}?session=${encodeURIComponent(session.token)}`,{body:{request:authority.id,basis_hash:authority.basis,accept:true}})
    assert.equal(acceptance.status,200)
    await h.api('automatic.collection.decide',finance,{request:authority.id,basis_hash:authority.basis,decision:'approved',confirm:true})
    await h.api('invoice.approve',owner,{invoice:invoice.id,acknowledge:true})
    await h.api('invoice.finalise',owner,{invoice:invoice.id,issue_date:day})
    const collected=(await h.api('automatic-collections',owner)).find(row=>row.id===authority.id)
    assert.equal(collected.status,method==='card'?'collected':'pending_settlement')
    const intent=await stripe.request('GET',`/v1/payment_intents/${collected.paymentIntentRef}`)
    assert.equal(intent.payment_method,record.paymentMethod.methodRef)
    assert.notEqual(intent.payment_method,old.id)
    facts.nextInvoices??=[];facts.nextInvoices.push({method,invoice:invoice.id,paymentIntent:intent.id,selectedMethod:intent.payment_method,status:intent.status,approvalMode:collected.approvalMode})
    facts.setups.push({id:setup.id,method,paymentMethod:record.paymentMethod.methodRef,mandate:record.paymentMethod.mandateRef,defaultChoice:record.defaultChoice})
    for(const width of [1440,390]){await page.setViewportSize({width,height:950});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:`${directory}/${width}-${method}-complete.png`,fullPage:true})}
    await h.assertStorageExcludes(['4242424242424242','000123456789',process.env.STRIPE_SECRET_KEY])
  }
  facts.outcome='passed'
} catch(error) {
  facts.outcome='failed';facts.phase=phase;facts.error=safeError(error)
  if(page)await page.screenshot({path:`${directory}/failed-${phase}.png`,fullPage:true}).catch(()=>{})
  // Deliberately avoid browser exception messages, URLs and provider bodies.
  process.exitCode=1
} finally {
  await browser?.close();await h?.close()
  if(customer?.id){try{
    const sessions=await stripe.list('/v1/checkout/sessions',{customer:customer.id})
    for(const session of sessions.data)if(session.status==='open')await stripe.request('POST',`/v1/checkout/sessions/${session.id}/expire`,{})
    const deleted=await stripe.request('DELETE',`/v1/customers/${customer.id}`);assert.equal(deleted.deleted,true);facts.cleanup=true
  }catch{facts.cleanup=false}}
  if(customer?.id&&!facts.cleanup){facts.outcome='failed';process.exitCode=1}
  console.log(JSON.stringify({...facts,requests:stripe.requests}))
}
