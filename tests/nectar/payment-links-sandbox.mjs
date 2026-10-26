// Real held-key Stripe test Checkout. Never substitutes provider completion.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { harness } from './harness.mjs'
import { applyPolicy } from './policy-helper.mjs'
import { totp } from './mfa.mjs'
import { stripeSandbox, safeError } from './stripe-sandbox-client.mjs'

const stripe=stripeSandbox(process.env.STRIPE_SECRET_KEY),directory=process.env.NECTAR_EVIDENCE_DIR??'.evidence/payment-links-sandbox'
await mkdir(directory,{recursive:true})
const ownedCustomers=new Set(),facts={head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),journey:'PAY-006 real Stripe hosted subscription and one-time checkout',results:[],cleanup:false}
let h,browser,page,phase='bootstrap'
try {
  h=await harness({assets:true,stripeSecret:process.env.STRIPE_SECRET_KEY,stripeFetch:async request=>{
    const response=await stripe.forward(request)
    if(request.method==='POST'&&new URL(request.url).pathname==='/v1/customers'&&response.ok){const row=await response.clone().json();if(row.object==='customer'&&row.livemode===false)ownedCustomers.add(row.id)}
    return response
  }})
  await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})
  const owner=await h.signIn(h.vars.OWNER_EMAIL)
  await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
  await h.api('business.configure',owner,{legal_name:'Nectar hosted signup test',timezone:'UTC',invoice_prefix:'LINK',payment_terms_days:30})
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Real processor test-mode signup journey'})
  await h.api('tax.review',owner,{revision:(await h.api('business',owner)).revision})
  const factor=await h.api('mfa.totp.start',owner,{})
  await h.api('mfa.totp.confirm',owner,{factor:factor.factor,code:totp(factor.secret,Date.now())})
  const product=(await h.api('product.create',owner,{code:'held-key-payment-link',name:'Hosted monthly workspace'})).id
  const price=(await h.api('price.create',owner,{product,kind:'flat',unit_amount:'25',taxable:false})).id
  const subscriptionLink=await h.api('payment_link.create',owner,{name:'Monthly workspace test',price:[price],quantity:['1'],trial_days:14,months:1,auto_renew:true,notice_days:7,uplift_percent:'0',max_uses:1,confirm:true,confirm_single:true})
  const paymentLink=await h.api('payment_link.create',owner,{kind:'one_time',name:'One-time workshop test',description:'One-time workshop',amount:'10',taxable:false,max_uses:1,confirm:true})
  browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']})
  const context=await browser.newContext();page=await context.newPage();page.setDefaultTimeout(20000)
  for(const [kind,link,language] of [['subscription',subscriptionLink,'es-US'],['one_time',paymentLink,'en']]) {
    phase=`${kind}-consent`
    await page.goto(`${h.origin}${link.path}?language=${language}`)
    const form=page.locator('form[action$="/start"]')
    await form.locator('[name=name]').fill('Hosted signup test customer')
    await form.locator('[name=billing_email]').fill(`payment-link-${kind}-${stripe.run}@example.test`)
    await form.locator('[name=address]').fill('10 Test Lane, San Francisco, CA 94105, US')
    await form.locator('[name=confirm]').check();if(kind==='subscription')await form.locator('[name=make_default]').check()
    for(const width of [1440,390]){await page.setViewportSize({width,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:`${directory}/${width}-${kind}-consent.png`,fullPage:true})}
    await form.getByRole('button').click();await page.waitForURL('https://checkout.stripe.com/**')
    phase=`${kind}-stripe`
    await page.locator('#cardNumber').fill('4242424242424242');await page.locator('#cardExpiry').fill('1235');await page.locator('#cardCvc').fill('123')
    const stripePass=page.locator('#enableStripePass');if(await stripePass.count())await stripePass.uncheck()
    const country=page.locator('#billingCountry');if(await country.count())await country.selectOption('US')
    const name=page.locator('#billingName');if(await name.count())await name.fill('Hosted signup test customer')
    const postal=page.locator('#billingPostalCode');if(await postal.count())await postal.fill('94105')
    await page.locator('button[type=submit]').click();await page.waitForURL(`${h.origin}/pay-links/attempts/**`,{timeout:60000})
    phase=`${kind}-finish`
    const attempt=new URL(page.url()).pathname.split('/').at(-1)
    const finish=page.locator(`form[action="/pay-links/attempts/${attempt}/finish"]`)
    await finish.getByRole('button').click();await page.waitForURL(`${h.origin}/pay-links/attempts/${attempt}`)
    const cookies=(await context.cookies()).filter(cookie=>cookie.name==='nectar_payment_link'&&cookie.path===`/pay-links/attempts/${attempt}`).map(cookie=>`${cookie.name}=${cookie.value}`).join('; ')
    const result=await (await h.raw(`/pay-links/attempts/${attempt}`,{cookie:cookies,headers:{accept:'application/json'}})).json()
    assert.equal(result.status,'complete')
    const customer=await h.api(`customers/${result.customer}`,owner)
    assert.equal(customer.language,language)
    if(kind==='subscription') {
      const subscription=await h.api(`subscriptions/${result.subscription}`,owner)
      assert.ok(subscription.trial_end);assert.equal(customer.ledger.paidCents,0)
      const attributed=customer.billingRecord.paymentLinks.find(row=>row.subscription===result.subscription)
      const source=await stripe.request('GET',`/v1/customers/${attributed.customerRef}`)
      assert.equal(source.invoice_settings.default_payment_method,attributed.method.methodRef)
    } else {
      assert.deepEqual([customer.ledger.invoicedCents,customer.ledger.paidCents,customer.ledger.balanceCents],[1000,1000,0])
      assert.ok(customer.billingRecord.receipts.some(receipt=>receipt.payment===result.payment&&receipt.amountCents===1000))
    }
    facts.results.push({kind,attempt,customer:result.customer,subscription:result.subscription,invoice:result.invoice,payment:result.payment})
    for(const width of [1440,390]){await page.setViewportSize({width,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:`${directory}/${width}-${kind}-complete.png`,fullPage:true})}
  }
  await h.api('payment_link.deactivate',owner,{link:subscriptionLink.id,revision:subscriptionLink.revision})
  assert.equal((await h.raw(subscriptionLink.path)).status,404)
  await h.assertStorageExcludes(['4242424242424242',process.env.STRIPE_SECRET_KEY])
  facts.outcome='passed'
} catch(error) {
  facts.outcome='failed';facts.phase=phase;facts.error=safeError(error);facts.errorType=/^[A-Za-z]{1,50}$/.test(error?.name??'')?error.name:'Error';process.exitCode=1
  if(page)await page.screenshot({path:`${directory}/failed-${phase}.png`,fullPage:true}).catch(()=>{})
} finally {
  await browser?.close();await h?.close()
  try {
    for(const customer of ownedCustomers) {
      const sessions=await stripe.list('/v1/checkout/sessions',{customer})
      for(const session of sessions.data)if(session.status==='open')await stripe.request('POST',`/v1/checkout/sessions/${session.id}/expire`,{})
      const deleted=await stripe.request('DELETE',`/v1/customers/${customer}`);assert.equal(deleted.deleted,true)
    }
    facts.cleanup=true
  } catch {facts.cleanup=false;facts.outcome='failed';process.exitCode=1}
  const evidence={...facts,requests:stripe.requests}
  console.log(JSON.stringify(evidence))
}
