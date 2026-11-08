if (process.argv[2] === '--sandbox') {
 const journeys={
  "hosted-setup-sandbox": hostedSetupSandboxJourney,
  "stripe-history-sandbox": stripeHistorySandboxJourney,
  "payment-links-sandbox": paymentLinksSandboxJourney,
 }
 const run=journeys[process.argv[3]]
 if(!run)throw new Error('Unknown sandbox journey')
 await run(process.argv[4])
 process.exit(0)
}
import { processorSetup, processorEventFlow } from './processor-events.mjs'

const {h,owner,edge}=await processorSetup()

try {await processorEventFlow(h,owner,edge);console.log('JOURNEY PASS processor reconciliation')}
finally {await h.close()}

// hosted-setup-sandbox: retained public-door assertions with one shared entry point.
async function hostedSetupSandboxJourney(mode) {
// Held-key live test only, outside push Verify. The Worker owns every setup and
// default write; Playwright enters published Stripe test inputs on Stripe only.
const { default: assert } = await import('node:assert/strict')
const {execFileSync} = await import('node:child_process')
const {mkdir} = await import('node:fs/promises')
const {chromium,expect} = await import('@playwright/test')
const {harness} = await import('./harness.mjs')
const {totp} = await import('./mfa.mjs')
const {applyPolicy} = await import('./policy-helper.mjs')
const {stripeSandbox,safeError} = await import('./processor-edge.mjs')

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
  const publicApi=h.api
  h.api=async(...args)=>{try{return await publicApi(...args)}catch(error){
    facts.failureRoute=args[0]
    const code=error.message?.match(/\"error\":\"([a-z_]+)\"/)
    if(code)facts.applicationError=code[1]
    if(typeof error.actual==='number')facts.actualStatus=error.actual
    throw error
  }}
  await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Nectar Owner'}})
  const owner=await h.signIn(h.vars.OWNER_EMAIL)
  await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
  await h.api('business.configure',owner,{legal_name:'Alder Analytics',timezone:'UTC',invoice_prefix:'ALDER',payment_terms_days:30})
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Reviewed portal replacement journey'})
  await h.api('tax.review',owner,{revision:(await h.api('business',owner)).revision})
  await h.api('access.give',owner,{email:'synthetic-nectar-872@example.test',name:'Finance approver',role:'finance'})
  const finance=await h.signIn('synthetic-nectar-872@example.test',{requested:true})
  const financeFactor=await h.api('mfa.totp.start',finance,{})
  await h.api('mfa.totp.confirm',finance,{factor:financeFactor.factor,code:totp(financeFactor.secret,Date.now())})
  const factor=await h.api('mfa.totp.start',owner,{})
  await h.api('mfa.totp.confirm',owner,{factor:factor.factor,code:totp(factor.secret,Date.now())})
  const native=await h.api('customer.create',owner,{external_id:'synthetic-nectar-819',name:'Alder Analytics test customer',billing_email:`nectar-${stripe.run}@example.test`})
  const beforeForeign=stripe.requests.filter(row=>row.method==='POST').length
  await h.api('collection.customer.bind',owner,{customer:native.id,account_ref:'synthetic-nectar-foreign-account',stripe_customer_ref:customer.id,confirm:true},409)
  assert.equal(stripe.requests.filter(row=>row.method==='POST').length,beforeForeign,'Foreign account association is refused without a Stripe write')
  const binding=await h.api('collection.customer.bind',owner,{customer:native.id,account_ref:account.id,stripe_customer_ref:customer.id,confirm:true})
  await h.api('portal.configure',owner,{hosts:[h.origin],parents:[]})
  browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox'],headless:true,args:['--no-sandbox','--use-mock-keychain','--password-store=basic']})
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
    await h.api('invoice.approve',owner,{invoice:invoice.id,acknowledge:true})
    const authority=await h.api('automatic.collection.prepare',owner,{invoice:invoice.id,issue_date:day,...(method==='us_bank_account'?{mandate_ref:record.paymentMethod.mandateRef}:{})})
    assert.equal(authority.quote.method.paymentMethodRef,record.paymentMethod.methodRef)
    const acceptance=await h.raw(`/portal/automatic-collections/${authority.id}?session=${encodeURIComponent(session.token)}`,{body:{request:authority.id,basis_hash:authority.basis,accept:true}})
    assert.equal(acceptance.status,200)
    await h.api('automatic.collection.decide',finance,{request:authority.id,basis_hash:authority.basis,decision:'approved',confirm:true})
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

}

// stripe-history-sandbox: retained public-door assertions with one shared entry point.
async function stripeHistorySandboxJourney(mode) {
// Outside push Verify. Parent builds/commits, then runs through heavy-slot and
// briefs/_od08-env.py STRIPE_SECRET_KEY=STRIPE_US_TEST_SECRET_KEY -- node THIS_FILE.
// No Stripe response bodies, credentials, customer URLs or auth cookies are logged.
const { createHash } = await import('node:crypto')
const { execFileSync } = await import('node:child_process')
const { mkdir, writeFile } = await import('node:fs/promises')
const { join } = await import('node:path')
const { isDeepStrictEqual } = await import('node:util')
const { stripeSandbox, check, safeError, reference, monthTime, monthName } = await import('./processor-edge.mjs')

const evidence = process.env.NECTAR_EVIDENCE_DIR ?? join(process.cwd(), '.evidence')
const receipt = { version: 1, journey: 'MOVE-007 Stripe 18-month history', status: 'running', startedAt: new Date().toISOString(), head: null,
  clockId: null, sourceIds: {}, assertions: {}, captureHashes: {}, cleanup: { clockDeleted: false } }
let stripe, phase = 'test-key', ownedClock, h
const workerStripeRequests = []
const step = name => { phase = name; console.log(`Stripe history: ${name}`) }
const sum = rows => rows.reduce((total, row) => total + row, 0)
const dateMonth = seconds => new Date(seconds * 1000).toISOString().slice(0, 7)
const subscriptionOf = invoice => reference(invoice.subscription ?? invoice.parent?.subscription_details?.subscription)
const invoicePayments = invoice => invoice.payments?.data ?? []
const belongs = (payment, charge) => payment.payment?.type === 'payment_intent'
  ? reference(payment.payment.payment_intent) === reference(charge.payment_intent)
  : payment.payment?.type === 'charge' && reference(payment.payment.charge) === charge.id

async function capturedInvoice(id) {
  const invoice = await stripe.request('GET', `/v1/invoices/${id}`, { 'expand[]': 'payments' })
  // Pagination combines real provider list entries without inventing documents.
  if (invoice.lines.has_more) invoice.lines = await stripe.list(`/v1/invoices/${id}/lines`)
  if (invoice.payments?.has_more) invoice.payments = await stripe.list('/v1/invoice_payments', { invoice: id })
  check(invoice.lines?.has_more === false && Array.isArray(invoice.lines.data), 'stripe_invoice_lines_incomplete')
  check(invoice.payments?.has_more === false, 'stripe_invoice_payments_incomplete')
  return invoice
}

async function generate() {
  step('create-owned-clock')
  const clock = await stripe.request('POST', '/v1/test_helpers/test_clocks', { frozen_time: monthTime(0), name: `Nectar history ${stripe.run}` })
  ownedClock = clock.id; receipt.clockId = ownedClock; receipt.clockDeletesAfter = clock.deletes_after
  check(clock.status === 'ready' && clock.frozen_time === monthTime(0), 'stripe_initial_clock_not_ready')
  step('create-owned-catalog-and-customer')
  const product = await stripe.request('POST', '/v1/products', { name: `Nectar history ${stripe.run}`, 'metadata[nectar_run]': stripe.run })
  receipt.sourceIds.product = product.id; receipt.sourceIds.prices = []
  const prices = []
  for (const [interval, amount] of [['month', 10000], ['year', 1200000]]) {
    const price = await stripe.request('POST', '/v1/prices', { product: product.id, currency: 'usd', unit_amount: amount,
      'recurring[interval]': interval, tax_behavior: 'exclusive', 'metadata[nectar_run]': stripe.run })
    prices.push(price); receipt.sourceIds.prices.push(price.id)
  }
  const method = await stripe.request('POST', '/v1/payment_methods', { type: 'card', 'card[token]': 'tok_visa' })
  receipt.sourceIds.paymentMethod = method.id
  const customer = await stripe.request('POST', '/v1/customers', { name: `Nectar sandbox ${stripe.run}`, email: `nectar-${stripe.run}@example.test`, test_clock: ownedClock,
    payment_method: method.id, 'invoice_settings[default_payment_method]': method.id, 'metadata[nectar_run]': stripe.run })
  receipt.sourceIds.customer = customer.id
  const events = new Map()
  async function captureEvents() {
    const listed = await stripe.list('/v1/events', { type: 'customer.subscription.*' })
    for (const event of listed.data) if (reference(event.data?.object?.customer) === customer.id) events.set(event.id, event)
  }
  const createSubscription = price => stripe.request('POST', '/v1/subscriptions', { customer: customer.id, 'items[0][price]': price,
    collection_method: 'charge_automatically', payment_behavior: 'error_if_incomplete', 'metadata[nectar_run]': stripe.run })
  step('create-monthly-subscription')
  const monthly = await createSubscription(prices[0].id)
  receipt.sourceIds.subscriptions = [monthly.id]
  await captureEvents()
  const first = await capturedInvoice(reference(monthly.latest_invoice))
  check(first.status === 'paid' && first.amount_paid === 10000, 'stripe_initial_invoice_not_paid')
  const firstCharges = await stripe.list('/v1/charges', { customer: customer.id })
  const firstCharge = firstCharges.data.find(charge => invoicePayments(first).some(payment => belongs(payment, charge)))
  check(firstCharge?.status === 'succeeded' && firstCharge.amount === 10000, 'stripe_first_payment_mapping_missing')
  step('create-twenty-dollar-refund-and-linked-credit')
  const refund = await stripe.request('POST', '/v1/refunds', { charge: firstCharge.id, amount: 2000, 'metadata[nectar_run]': stripe.run })
  receipt.sourceIds.refund = refund.id
  check(refund.status === 'succeeded' && refund.amount === 2000, 'stripe_refund_not_succeeded')
  const credit = await stripe.request('POST', '/v1/credit_notes', { invoice: first.id, amount: 2000, 'refunds[0][refund]': refund.id,
    'refunds[0][amount_refunded]': 2000, memo: `Nectar history ${stripe.run}` })
  check(credit.status === 'issued' && credit.total === 2000, 'stripe_credit_not_issued')
  check(credit.refunds?.some(row => reference(row.refund) === refund.id && row.amount_refunded === 2000), 'stripe_credit_refund_link_missing')
  receipt.sourceIds.creditNote = credit.id
  let annual
  for (let index = 1; index < 18; index++) {
    step(`generate-${monthName(index)}`)
    await stripe.advance(ownedClock, monthTime(index), `${monthName(index)} boundary`)
    if (index === 14) {
      step('create-march-annual-subscription')
      annual = await createSubscription(prices[1].id)
      receipt.sourceIds.subscriptions.push(annual.id)
      await captureEvents()
    }
    phase = `settle-${monthName(index)}`
    await stripe.advance(ownedClock, monthTime(index) + 7200, `${monthName(index)} finalize`)
    await captureEvents()
  }
  phase = 'finish-before-cutover'
  await stripe.advance(ownedClock, monthTime(18) - 1, 'before July cutover')
  await captureEvents()
  step('create-owned-open-cutover-receivable')
  const draft = await stripe.request('POST', '/v1/invoices', { customer: customer.id, collection_method: 'send_invoice', days_until_due: 30,
    auto_advance: false, pending_invoice_items_behavior: 'exclude', 'automatic_tax[enabled]': false, 'metadata[nectar_run]': stripe.run })
  step('create-owned-open-line')
  await stripe.request('POST', '/v1/invoiceitems', { customer: customer.id, invoice: draft.id, amount: 2500, currency: 'usd',
    description: 'Owned sandbox cutover service', 'period[start]': monthTime(17), 'period[end]': monthTime(18), 'metadata[nectar_run]': stripe.run })
  step('finalize-owned-open-receivable')
  const opened = await stripe.request('POST', `/v1/invoices/${draft.id}/finalize`, { auto_advance: false })
  check(opened.status === 'open' && opened.auto_advance === false && opened.total === 2500 && opened.amount_remaining === 2500 && opened.amount_paid === 0, 'stripe_cutover_invoice_not_open')
  receipt.sourceIds.openInvoice = opened.id
  step('capture-complete-provider-history')
  const customers = await stripe.list('/v1/customers', { test_clock: ownedClock })
  const subscriptions = await stripe.list('/v1/subscriptions', { customer: customer.id, status: 'all' })
  const listedInvoices = await stripe.list('/v1/invoices', { customer: customer.id })
  const invoices = { ...listedInvoices, data: [] }
  for (const row of listedInvoices.data) invoices.data.push(await capturedInvoice(row.id))
  const payments = await stripe.list('/v1/charges', { customer: customer.id })
  const refunds = { object: 'list', url: '/v1/refunds', has_more: false, data: [] }
  const disputes = { object: 'list', url: '/v1/disputes', has_more: false, data: [] }
  for (const charge of payments.data) {
    refunds.data.push(...(await stripe.list('/v1/refunds', { charge: charge.id })).data)
    if (charge.disputed) disputes.data.push(...(await stripe.list('/v1/disputes', { charge: charge.id })).data)
  }
  const creditNotes = await stripe.list('/v1/credit_notes', { customer: customer.id })
  const capture = { customers, products: { object: 'list', has_more: false, data: [product] }, prices: { object: 'list', has_more: false, data: prices },
    subscriptions, invoices, payments, refunds, disputes, credit_notes: creditNotes,
    subscription_events: { object: 'list', url: '/v1/events', has_more: false, data: [...events.values()] } }
  capture.manifest = { source: 'stripe', captured_at: new Date().toISOString(), api_version: stripe.apiVersion,
    captured_by: 'Nectar sandbox journey using held Stripe test credentials', clock: ownedClock,
    coverage: 'Only this journey clock/customer and owned catalog; subscription events captured during generation; all resource pages combined.',
    files: Object.fromEntries(Object.entries(capture).map(([name, value]) => [name, { endpoint: value.url ?? `/v1/${name}`, count: value.data.length, has_more: false }])) }
  check(customers.data.length === 1 && customers.data[0].id === customer.id, 'stripe_clock_customer_scope_changed')
  check(invoices.data.every(row => (row.status === 'paid' || row.id === opened.id && row.status === 'open') && row.status_transitions.finalized_at && row.number), 'stripe_history_contains_unissued_invoice')
  check(invoices.data.filter(row => subscriptionOf(row) === monthly.id).length === 18, 'stripe_monthly_invoice_count')
  check(invoices.data.filter(row => subscriptionOf(row) === annual?.id).length === 1, 'stripe_annual_invoice_count')
  check(capture.subscription_events.data.length > 0, 'stripe_subscription_events_unavailable')
  check(refunds.data.some(row => row.id === refund.id && row.amount === 2000), 'stripe_refund_capture_missing')
  check(payments.data.every(charge => invoices.data.some(invoice => invoicePayments(invoice).some(payment => belongs(payment, charge)))), 'stripe_payment_invoice_mapping_incomplete')
  receipt.sourceIds.invoices = invoices.data.map(row => row.id)
  receipt.sourceIds.lines = invoices.data.flatMap(row => row.lines.data.map(line => line.id))
  receipt.sourceIds.payments = payments.data.map(row => row.id)
  receipt.sourceIds.events = capture.subscription_events.data.map(row => row.id)
  receipt.sourceIds.disputes = disputes.data.map(row => row.id)
  receipt.providerCounts = Object.fromEntries(Object.entries(capture).filter(([name]) => name !== 'manifest').map(([name, value]) => [name, value.data.length]))
  for (const [name, value] of Object.entries(capture)) receipt.captureHashes[name] = createHash('sha256').update(JSON.stringify(value)).digest('hex')
  if (process.env.STRIPE_SANDBOX_CAPTURE === '1') {
    const filename = `stripe-history-sandbox-capture-${stripe.run}.json`
    await writeFile(join(evidence, filename), JSON.stringify(capture), { mode: 0o600, flag: 'wx' }); receipt.privateCapture = filename
  }
  return { capture, customer, monthly, annual, first, refund, credit, open: invoices.data.find(row => row.id === opened.id) }
}

async function prove({ capture, customer, monthly, annual, first, refund, credit, open }) {
  step('ordinary-owner-setup')
  const { harness, file } = await import('./harness.mjs')
  const { applyPolicy } = await import('./policy-helper.mjs')
  h = await harness({ localTime: '2026-07-01T00:00:00Z', stripeSecret: process.env.STRIPE_SECRET_KEY,
    stripeFetch: request => stripe.forward(request, entry => workerStripeRequests.push(entry)) })
  check((await h.raw('/auth/bootstrap', { body: { token: h.vars.SETUP_TOKEN, displayName: 'Sandbox Owner' } })).status === 303, 'owner_bootstrap_failed')
  const owner = await h.signIn(h.vars.OWNER_EMAIL)
  check((await h.raw('/setup', { cookie: owner, form: new URLSearchParams({ confirm: 'yes' }) })).status === 303, 'owner_setup_failed')
  const api = (path, body, status) => h.api(path, owner, body, status)
  await api('business.configure', { legal_name: 'Nectar sandbox history', timezone: 'UTC', invoice_prefix: 'SANDBOX', payment_terms_days: 30 })
  await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: 'CA', tax_mode: 'no_tax', tax_note: 'Zero-tax provider sandbox history; no tax service requested' })
  await api('tax.review', { revision: (await api('business')).revision })
  const files = Object.fromEntries(Object.entries(capture).map(([name, value]) => [name, file(`${name}.json`, JSON.stringify(value), 'application/json')]))
  step('public-import-preview-and-apply')
  const preview = await api('import.preview', files)
  check(preview.rejected.some(row => row.location.includes(annual.id)), 'annual_active_subscription_not_explicitly_rejected')
  check(preview.rejected.some(row => row.location.includes(capture.prices.data[1].id)), 'annual_active_price_not_explicitly_rejected')
  check(preview.rejected.length === 2, 'unexpected_history_mapping_rejection')
  check(preview.create.invoice === capture.invoices.data.length && preview.create.credit_note === 1, 'import_document_count_mismatch')
  check((await api('customers')).length === 0, 'import_preview_mutated_customers')
  const job = await api('import.apply', { ...files, fingerprint: preview.fingerprint })
  check((await api('import.apply', { ...files, fingerprint: preview.fingerprint })).job === job.job, 'import_replay_changed_job')
  const originalFiles=(await api('imports')).find(row=>row.id===job.job).originalFiles
  check(originalFiles.length===Object.keys(capture).length,'retained_source_files_missing')
  for(const original of originalFiles){
    const name=original.name.replace(/\.json$/,'')
    check(Object.hasOwn(capture,name),'unknown_original_capture')
    const response=await h.raw(`/app/import/${job.job}/originals/${original.id}`,{cookie:owner})
    check(response.status===200&&response.headers.get('content-type')==='application/octet-stream'&&response.headers.get('content-disposition')?.startsWith('attachment;'),'original_not_opaque_attachment')
    const bytes=Buffer.from(await response.arrayBuffer()),expected=Buffer.from(JSON.stringify(capture[name]))
    check(bytes.equals(expected)&&createHash('sha256').update(bytes).digest('hex')===original.sha256,'provider_original_bytes_changed')
  }
  const imported = (await api('customers')).find(row => row.external_id === customer.id)
  check(imported, 'imported_customer_missing')
  const detail = await api(`customers/${imported.id}`), history = detail.incumbentHistory
  check(history.documents.length === capture.invoices.data.length + capture.credit_notes.data.length, 'customer_history_document_count')
  const importedPayments = history.records.filter(row => row.kind === 'payment')
  check(importedPayments.length === capture.payments.data.length, 'customer_history_payment_count')
  for (const charge of capture.payments.data) {
    const retained = importedPayments.find(row => row.provider_ref === charge.id)
    const linked = capture.invoices.data.find(invoice => invoicePayments(invoice).some(payment => belongs(payment, charge)))
    check(retained?.amount_cents === charge.amount && retained.invoice_ref === linked?.id, 'imported_basil_payment_link_mismatch')
    check(!Object.hasOwn(retained,'original'),'raw_payment_original_rendered')
  }
  check(history.records.some(row => row.kind === 'refund' && row.provider_ref === refund.id && row.amount_cents === 2000), 'customer_history_refund_missing')
  check(history.documents.some(row => row.provider_ref === credit.id && row.document_kind === 'credit-note' && row.total_cents === 2000), 'customer_history_credit_missing')
  check(history.records.filter(row => row.kind === 'subscription-event').length === capture.subscription_events.data.length, 'customer_history_subscription_events_missing')
  for (const event of capture.subscription_events.data) check(history.records.some(row=>row.provider_ref===event.id&&!Object.hasOwn(row,'original')),'typed_subscription_timeline_missing')
  for (const invoice of capture.invoices.data)check(history.documents.some(row=>row.provider_ref===invoice.id&&row.total_cents===invoice.total&&!Object.hasOwn(row,'original')),'typed_invoice_history_changed')
  check(!detail.subscriptions.some(row => row.provider_ref === annual.id), 'unsupported_annual_subscription_installed')
  const annualInvoice = capture.invoices.data.find(row => subscriptionOf(row) === annual.id)
  const annualDocument = history.documents.find(row => row.provider_ref === annualInvoice.id)
  check(annualDocument && annualDocument.provider_ref === annualInvoice.id, 'annual_original_history_missing')
  receipt.assertions.history = { importedDocuments: history.documents.length, importedPayments: importedPayments.length,
    importedRefundCents: 2000, importedCreditCents: 2000, importedSubscriptionEvents: capture.subscription_events.data.length, annualActiveMappingRejected: true }
  step('public-eighteen-month-source-reports')
  const monthlyReports = []
  for (let index = 0; index < 18; index++) {
    const period = monthName(index); phase = `reports-${period}`
    const sourceInvoices = capture.invoices.data.filter(row => dateMonth(row.status_transitions.finalized_at) === period)
    const sourceCharges = capture.payments.data.filter(row => row.status === 'succeeded' && dateMonth(row.created) === period)
    const amounts = { billings: sum(sourceInvoices.map(row => row.total)), collections: sum(sourceCharges.map(row => row.amount)), tax: 0,
      credits: sum(capture.credit_notes.data.filter(row => row.status === 'issued' && dateMonth(row.created) === period).map(row => row.total)), mrr: 10000 + (index >= 14 ? 100000 : 0) }
    check(sourceInvoices.some(row => subscriptionOf(row) === monthly.id), 'monthly_source_invoice_missing')
    for (const [metric, expected] of Object.entries(amounts)) {
      const report = await api(`reports/${metric}?period=${period}&customer=${imported.id}`)
      check(report.totalCents === expected, `historical_${metric}_total_mismatch`)
      check(report.entries.every(row => row.sourceProvider === 'stripe'), 'report_source_provider_mismatch')
      for (const entry of report.entries) {
        const source = await api(`reports/${metric}/${entry.invoiceId}?period=${period}&customer=${imported.id}`)
        check(source.totalCents === entry.amountCents && sum(source.components.map(row => row.amountCents)) === entry.amountCents, 'historical_source_reconciliation_mismatch')
        check(source.historical.reference === entry.sourceReference, 'historical_source_reference_mismatch')
      }
    }
    monthlyReports.push({ period, ...amounts })
  }
  receipt.assertions.monthlyReports = monthlyReports
  step('public-annual-deferred-revenue')
  const revenue = await api(`revenue?from=2026-07&to=2027-02&customer=${imported.id}`)
  check(revenue.openingCents === 800000 && revenue.recognizedCents === 800000 && revenue.closingCents === 0, 'annual_deferred_rollforward_mismatch')
  check(revenue.months.length === 8 && revenue.months.every(row => row.recognizedCents === 100000), 'annual_monthly_recognition_mismatch')
  const source = await api(`revenue/${annualDocument.id}?from=2026-07&to=2027-02&customer=${imported.id}`)
  check(source.source.providerRef === annualInvoice.id, 'annual_revenue_source_mismatch')
  check(source.schedules.length === 1 && source.schedules[0].entries.length === 12 && source.schedules[0].entries.every(row => row.amountCents === 100000), 'annual_source_schedule_mismatch')
  receipt.assertions.revenue = { annualInvoice: annualInvoice.id, julyOpeningDeferredCents: 800000, remainingMonths: 8, monthlyRecognitionCents: 100000, closingCents: 0 }
  const csv = await h.raw(`/app/exports/revenue.csv?from=2026-07&to=2027-02&customer=${imported.id}`, { cookie: owner })
  check(csv.status === 200 && (await csv.text()).includes('1000.00'), 'annual_revenue_csv_missing')
  await proveOpenCollection({ api, owner, imported, capture, history, open })
  receipt.assertions.importJob = job.job
  receipt.assertions.firstStripeInvoice = first.id
}

async function proveOpenCollection({ api, owner, imported, capture, history, open }) {
  step('public-open-invoice-collection-preparation')
  const document = history.documents.find(row => row.provider_ref === open.id)
  check(document?.status === 'open' && document.remaining_cents === open.amount_remaining, 'imported_open_invoice_missing')
  const nativeInvoices = await api('invoices'), billingsPeriod = dateMonth(open.status_transitions.finalized_at)
  const billingsBefore = await api(`reports/billings?period=${billingsPeriod}&customer=${imported.id}`)
  const arBefore = await api(`reports/ar?customer=${imported.id}`)
  check(arBefore.totalCents === open.amount_remaining && arBefore.entries.some(row => row.invoiceId === document.id), 'imported_open_invoice_not_in_ar')
  const prepared = await api('imported.collection.prepare', { invoice: document.id })
  check(prepared.status === 'pending' && prepared.invoice_ref === open.id && prepared.amount_cents === open.amount_remaining, 'imported_collection_preparation_mismatch')
  check(workerStripeRequests.every(row => row.method === 'GET'), 'collection_preparation_wrote_provider')
  const stillOpen = await capturedInvoice(open.id)
  check(stillOpen.status === 'open' && stillOpen.amount_remaining === open.amount_remaining, 'collection_preparation_changed_invoice')
  const missingConfirmation = await h.raw('/api/nectar/imported.collection.execute', { cookie: owner, body: { request: prepared.id, basis_hash: prepared.basis_hash } })
  check(missingConfirmation.status === 400, 'collection_without_confirmation_accepted')
  step('public-explicit-processor-collection-and-out-of-band-mirror')
  const pending = await api('imported.collection.execute', { request: prepared.id, basis_hash: prepared.basis_hash, confirm: true, disable_auto_advance: true })
  receipt.assertions.collectionAttempt={status:pending.status,errorCode:pending.error_code,intentRecorded:!!pending.payment_intent_ref,chargeRecorded:!!pending.charge_ref}
  check(pending.status === 'uncertain' && pending.charge_ref,'collection_charge_not_confirmed')
  check(!workerStripeRequests.some(row=>row.path.endsWith('/pay')&&row.method==='POST'),'collection_automatically_mirrored')
  check((await capturedInvoice(open.id)).status==='open','original_mirrored_before_confirmation')
  const collected=await api('imported.collection.finalize',{request:pending.id,confirm:true})
  check(collected.status === 'collected' && collected.amount_cents === open.amount_remaining && collected.charge_ref && collected.payment_intent_ref, 'imported_collection_not_proven')
  const intent = await stripe.request('GET', `/v1/payment_intents/${collected.payment_intent_ref}`)
  const charge = await stripe.request('GET', `/v1/charges/${collected.charge_ref}`)
  check(intent.status === 'succeeded' && intent.amount_received === open.amount_remaining && reference(intent.customer) === receipt.sourceIds.customer
    && intent.metadata?.nectar_original_invoice === open.id && intent.metadata?.nectar_collection_request === prepared.id, 'collection_payment_intent_witness_mismatch')
  check(charge.status === 'succeeded' && charge.paid === true && charge.captured === true && charge.amount === open.amount_remaining
    && charge.amount_captured === open.amount_remaining && charge.currency === open.currency && reference(charge.payment_intent) === intent.id
    && reference(charge.customer) === receipt.sourceIds.customer && !reference(charge.invoice), 'collection_charge_witness_mismatch')
  check(!capture.payments.data.some(row => row.id === charge.id), 'collection_reused_historical_charge')
  const paid = await capturedInvoice(open.id)
  check(paid.status === 'paid' && paid.amount_remaining === 0 && paid.auto_advance === false && paid.number === open.number
    && paid.total === open.total && paid.currency === open.currency && reference(paid.customer) === reference(open.customer), 'original_out_of_band_mirror_mismatch')
  check(!invoicePayments(paid).some(payment => belongs(payment, charge)), 'native_collection_charged_through_original_invoice')
  const posts = workerStripeRequests.filter(row => row.method === 'POST')
  const paymentPosts = posts.filter(row => row.path === '/v1/payment_intents'), mirrorPosts = posts.filter(row => row.path === `/v1/invoices/${open.id}/pay`)
  check(paymentPosts.length === 1 && paymentPosts[0].fields.get('off_session') === 'true' && paymentPosts[0].fields.get('confirm') === 'true'
    && paymentPosts[0].fields.get('payment_method') === receipt.sourceIds.paymentMethod && !paymentPosts[0].fields.has('receipt_email')
    && paymentPosts[0].fields.get('metadata[nectar_original_invoice]') === open.id && paymentPosts[0].idempotencyKey.includes(prepared.review.intentKey), 'native_collection_protocol_mismatch')
  check(mirrorPosts.length === 1 && mirrorPosts[0].fields.get('paid_out_of_band') === 'true', 'invoice_mark_not_out_of_band')
  const disableAt = posts.findIndex(row => row.path === `/v1/invoices/${open.id}` && row.fields.get('auto_advance') === 'false')
  check(disableAt >= 0 && disableAt < posts.indexOf(paymentPosts[0]) && posts.indexOf(paymentPosts[0]) < posts.indexOf(mirrorPosts[0]), 'collection_order_mismatch')
  // PaymentIntent/charge timestamps are the provider's actual financial dates;
  // an application clock never substitutes for those saved facts.
  const collectedOn = new Date(charge.created * 1000).toISOString().slice(0, 10), period = collectedOn.slice(0, 7)
  check(collected.collected_on === collectedOn, 'collection_financial_date_mismatch')
  if (charge.created >= monthTime(18)) await h.advanceClock(new Date(charge.created * 1000 + 1000).toISOString())
  const collections = await api(`reports/collections?period=${period}&customer=${imported.id}`)
  const priorCollections = sum(capture.payments.data.filter(row => row.status === 'succeeded' && dateMonth(row.created) === period).map(row => row.amount))
  check(collections.totalCents === priorCollections + charge.amount, 'collection_report_not_exactly_once')
  const contribution = collections.entries.filter(row => row.sourceReference === charge.id)
  check(contribution.length === 1 && contribution[0].amountCents === charge.amount, 'collection_charge_report_source_missing')
  const drill = await api(`reports/collections/${contribution[0].invoiceId}?period=${period}&customer=${imported.id}`)
  check(drill.totalCents === charge.amount && sum(drill.components.map(row => row.amountCents)) === charge.amount, 'collection_report_drillthrough_mismatch')
  check((await api(`reports/ar?customer=${imported.id}`)).totalCents === 0, 'paid_imported_invoice_still_in_ar')
  check(isDeepStrictEqual(await api(`reports/billings?period=${billingsPeriod}&customer=${imported.id}`), billingsBefore), 'collection_changed_original_billings')
  const after = await api(`customers/${imported.id}`)
  check(isDeepStrictEqual(after.incumbentHistory.documents, history.documents) && isDeepStrictEqual(after.incumbentHistory.records, history.records), 'collection_mutated_imported_originals')
  check(after.incumbentHistory.totals.remainingCents === 0 && isDeepStrictEqual(await api('invoices'), nativeInvoices), 'collection_created_or_reissued_native_invoice')
  const repeat = await h.raw('/api/nectar/imported.collection.execute', { cookie: owner, body: { request: prepared.id, basis_hash: prepared.basis_hash, confirm: true, disable_auto_advance: true } })
  check(repeat.status === 409, 'collection_payment_repeat_accepted')
  const reconciled = await api('imported.collection.reconcile', { request: prepared.id })
  check(reconciled.status === 'collected' && reconciled.charge_ref === charge.id, 'collection_reconciliation_changed_witness')
  check(workerStripeRequests.filter(row => row.method === 'POST').length === posts.length, 'collection_replay_or_reconcile_wrote_provider')
  const charges = await stripe.list('/v1/charges', { customer: receipt.sourceIds.customer })
  check(charges.data.filter(row => row.status === 'succeeded' && !capture.payments.data.some(old => old.id === row.id)).length === 1, 'collection_created_second_charge')
  receipt.assertions.openCollection = { invoice: open.id, number: open.number, amountCents: open.amount_remaining, currency: open.currency,
    request: prepared.id, paymentIntent: intent.id, charge: charge.id, collectedOn, originalStatus: 'paid', outOfBandMirror: true,
    processorPaymentAttempts: paymentPosts.length, providerMirrorAttempts: mirrorPosts.length, remainingArCents: 0, sourceOriginalsUnchanged: true, repeatRefused: true }
}

try {
  stripe = stripeSandbox(process.env.STRIPE_SECRET_KEY)
  receipt.head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  check(/^[a-f0-9]{40}$/.test(receipt.head), 'candidate_head_required')
  receipt.apiVersion = stripe.apiVersion
  await mkdir(evidence, { recursive: true, mode: 0o700 })
  step('verify-us-test-account')
  const account = await stripe.request('GET', '/v1/account')
  check(account.country === 'US', 'stripe_us_test_account_required')
  receipt.accountId = account.id
  await prove(await generate())
  receipt.status = 'passed'
} catch (error) {
  receipt.status = 'failed'; receipt.failure = { phase, ...safeError(error) }; process.exitCode = 1
  console.error(`Stripe history: failed phase=${phase} code=${receipt.failure.code} status=${receipt.failure.status ?? 'none'} param=${receipt.failure.param??'none'}`)
} finally {
  if (h) { try { await h.close() } catch (error) { receipt.status = 'failed'; receipt.runtimeCleanup = safeError(error); process.exitCode = 1 } }
  if (stripe && ownedClock) {
    try { const deleted = await stripe.request('DELETE', `/v1/test_helpers/test_clocks/${ownedClock}`); check(deleted.deleted === true && deleted.id === ownedClock, 'stripe_clock_cleanup_unconfirmed'); receipt.cleanup.clockDeleted = true }
    catch (error) { receipt.status = 'failed'; receipt.cleanup.error = safeError(error); process.exitCode = 1 }
  }
  receipt.completedAt = new Date().toISOString()
  if (stripe) receipt.requestCounts = stripe.counts
  try { await mkdir(evidence, { recursive: true, mode: 0o700 }); await writeFile(join(evidence, 'stripe-history-sandbox.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 }) }
  catch { console.error('Stripe history: safe receipt could not be written'); process.exitCode = 1 }
  console.log(`Stripe history: ${receipt.status}; owned clock deleted=${receipt.cleanup.clockDeleted}; receipt=.evidence/stripe-history-sandbox.json`)
}

}

// payment-links-sandbox: retained public-door assertions with one shared entry point.
async function paymentLinksSandboxJourney(mode) {
// Real held-key Stripe test Checkout. Never substitutes provider completion.
const { default: assert } = await import('node:assert/strict')
const { execFileSync } = await import('node:child_process')
const { mkdir } = await import('node:fs/promises')
const { chromium } = await import('@playwright/test')
const { harness } = await import('./harness.mjs')
const { applyPolicy } = await import('./policy-helper.mjs')
const { totp } = await import('./mfa.mjs')
const { stripeSandbox, safeError } = await import('./processor-edge.mjs')

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
  browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox'],headless:true,args:['--no-sandbox','--use-mock-keychain','--password-store=basic']})
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

}
