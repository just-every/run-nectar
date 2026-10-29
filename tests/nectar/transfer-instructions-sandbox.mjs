// Actual Stripe test account, ordinary owner confirmation and customer views.
// Provider facts and browser captures are retained outside the checkout only.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from '@playwright/test'
import { processorSetup } from './processor-events.mjs'
import { stripeSandbox, safeError } from './stripe-sandbox-client.mjs'
import { totp } from './mfa.mjs'

export async function proveTransferInstructions(stripe, secret) {
  let h, remote, browser, phase='account'
  const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()
  const directory=process.env.NECTAR_EVIDENCE_DIR
  assert.ok(directory,'Use an external evidence directory for provider qualification')
  const results={head,scenario:'native_transfer_instructions',screens:[],cash:[]}
  const writes=[]
  let returned
  try {
    const account=await stripe.request('GET','/v1/account')
    assert.equal(account.country,'US')
    remote=await stripe.request('POST','/v1/customers',{name:`Synthetic Nectar transfer ${stripe.run}`,
      'cash_balance[settings][reconciliation_mode]':'manual'})
    const setup=await processorSetup(undefined,{localTime:undefined,stripeSecret:secret,stripeFetch:async request=>{
      const response=await stripe.forward(request,observed=>{if(observed.method==='POST')writes.push(observed)})
      if(new URL(request.url).pathname.endsWith('/funding_instructions')&&response.ok)returned=await response.clone().json()
      return response
    }})
    h=setup.h
    const owner=setup.owner,api=(path,body,status)=>h.api(path,owner,body,status)
    const at=Date.now(),day=new Date(at).toISOString().slice(0,10)
    await h.advanceClock(new Date(at).toISOString())
    const factor=await api('mfa.totp.start',{})
    await api('mfa.totp.confirm',{factor:factor.factor,code:totp(factor.secret,at)})
    const customer=(await api('customer.create',{external_id:`synthetic-nectar-${stripe.run}`,name:'Synthetic transfer customer',billing_email:h.vars.OWNER_EMAIL})).id
    await api('collection.customer.bind',{customer,account_ref:account.id,stripe_customer_ref:remote.id,confirm:true})
    const issue=async(amount,label)=>{
      const charge=await api('charge.add',{customer,amount,description:label,taxable:false,effective_date:day})
      const invoice=(await api('invoice.manual',{customer,charges:[charge.charge],service_date:day})).id
      await api('invoice.approve',{invoice,acknowledge:true})
      await api('invoice.finalise',{invoice,issue_date:day})
      return api(`invoices/${invoice}`)
    }
    const old=await issue('10','Previously issued evidence')
    phase='owner-confirmation'
    const prepared=await api('transfer.instructions.prepare',{customer,account_ref:account.id})
    assert.equal(writes.length,0,'Preparation makes no provider write')
    const confirmations=await Promise.all([1,2].map(()=>h.raw('/api/nectar/transfer.instructions.confirm',{cookie:owner,body:prepared.confirm})))
    assert.deepEqual(confirmations.map(row=>row.status).sort(),[200,409])
    const available=await confirmations.find(row=>row.status===200).json()
    assert.equal(available.status,'available','Genuine provider instructions pass the product validator')
    await api('transfer.instructions.confirm',prepared.confirm,409)
    assert.equal(writes.length,1,'Concurrent confirmation and replay make one provider write')
    assert.equal(writes[0].path,`/v1/customers/${remote.id}/funding_instructions`)
    assert.equal(returned.livemode,false)
    const addresses=returned.bank_transfer.financial_addresses
    const aba=addresses.find(row=>row.type==='aba')
    assert.ok(aba)
    // Read the actual provider fields independently of the product projection.
    const expected={bankName:aba.aba.bank_name,accountHolderName:aba.aba.account_holder_name,
      accountNumber:aba.aba.account_number,routingNumber:aba.aba.routing_number,accountType:aba.aba.account_type,
      networks:[...aba.supported_networks].sort(),currency:'USD',country:'US',testMode:true}
    assert.deepEqual(available.instructions,expected)
    const invoices=[await issue('100','Native transfer service one'),await issue('125','Native transfer service two')]
    for(const invoice of invoices)assert.deepEqual(JSON.parse(invoice.transfer_instructions_json).fields,expected)
    assert.equal(invoices[0].transfer_instructions_json,invoices[1].transfer_instructions_json)
    assert.equal((await api(`invoices/${old.id}`)).transfer_instructions_json,null)
    // The provider returns the same stable virtual account for this customer.
    const direct=await stripe.request('POST',`/v1/customers/${remote.id}/funding_instructions`,{
      funding_type:'bank_transfer',currency:'usd','bank_transfer[type]':'us_bank_transfer'})
    assert.deepEqual(direct.bank_transfer,returned.bank_transfer)
    phase='customer-presentations'
    await api('portal.configure',{hosts:[h.origin],parents:[]})
    browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      args:['--no-sandbox','--use-mock-keychain','--password-store=basic']})
    const context=await browser.newContext(),page=await context.newPage()
    const path=(token,invoice='',pdf=false)=>`${invoice?`/portal/invoices/${invoice}`:'/portal'}?session=${encodeURIComponent(token)}${pdf?'&format=pdf':''}`
    const document=async(token,invoice)=>{
      const response=await h.raw(path(token,invoice,true));assert.equal(response.status,200)
      assert.equal(response.headers.get('content-type'),'application/pdf')
      return [...Buffer.from(await response.arrayBuffer()).toString('latin1').matchAll(/<([0-9a-f]+)> Tj/g)]
        .map(row=>Buffer.from(row[1],'hex').toString('latin1')).join('\n')
    }
    await mkdir(directory,{recursive:true})
    for(const language of ['en','es-US']) {
      const current=await api(`customers/${customer}`)
      await api('customer.update',{customer,revision:current.revision,name:current.name,billing_email:current.billing_email,language})
      const session=await api('portal.session.issue',{customer,origin:h.origin,audience:'hosted'})
      const data=await(await h.raw(`/portal/data?session=${encodeURIComponent(session.token)}`)).json()
      for(const invoice of invoices)assert.deepEqual(data.invoices.find(row=>row.id===invoice.id).transferInstructions,expected)
      const values=[expected.bankName,expected.accountHolderName,expected.accountNumber,expected.routingNumber,'USD',
        ...(language==='en'?['Checking','ACH credit','US domestic wire','United States','Test mode only']:
          ['Cuenta corriente','Crédito ACH','Transferencia nacional de EE. UU.','Estados Unidos','Solo modo de prueba'])]
      for(const invoice of invoices) {
        const pdf=await document(session.token,invoice.id)
        for(const value of values)assert.ok(pdf.includes(value),'PDF retains every provider remit-to field and its localized meaning')
      }
      for(const [label,route] of [['invoice',path(session.token,invoices[0].id)],['portal',path(session.token)]]) {
        for(const width of [1440,390]) {
          await page.setViewportSize({width,height:950});await page.goto(h.origin+route)
          if(width===1440)for(const value of values)assert.ok((await page.locator('main').innerText()).includes(value),'Customer page agrees with actual Stripe instructions')
          assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
          const file=`${width}-${language}-${label}.png`
          await page.screenshot({path:`${directory}/${file}`,fullPage:true})
          results.screens.push({language,width,label,file})
        }
      }
      await api('portal.session.revoke',{session:session.id})
    }
    // Reference and amount application against the very same instructed customer.
    phase='cash-application'
    for(const [index,invoice] of invoices.entries()) {
      const funded=await stripe.request('POST',`/v1/test_helpers/customers/${remote.id}/fund_cash_balance`,{
        amount:invoice.total_cents,currency:'usd',...(index===0?{reference:invoice.number}:{})})
      let event
      for(let attempt=0;attempt<12&&!event;attempt++) {
        event=(await stripe.list('/v1/events',{type:'cash_balance.funds_available','created[gte]':Math.floor(at/1000)-5})).data
          .find(row=>row.data?.object?.customer===remote.id&&row.data?.object?.available?.usd===invoice.total_cents)
        if(!event)await delay(1500)
      }
      assert.ok(event,'A genuine Stripe cash-balance event is required')
      await h.advanceClock(new Date(Date.now()+5000).toISOString())
      const body={account_ref:account.id,event_ref:event.id}
      await api('processor.event.consume',body)
      assert.equal((await api('processor.event.consume',body)).replayed,true)
      const observed=await api(`invoices/${invoice.id}`)
      assert.deepEqual([observed.paidCents,observed.balanceCents,observed.allocations.length],[invoice.total_cents,0,1])
      assert.equal(observed.transfer_instructions_json,invoice.transfer_instructions_json,'Payment cannot rewrite issued instructions')
      const cash=await stripe.request('GET',`/v1/customers/${remote.id}/cash_balance`)
      assert.equal(cash.available?.usd??0,0)
      const transactions=(await stripe.list(`/v1/customers/${remote.id}/cash_balance_transactions`)).data
      const ledger=await api(`processor-events?customer=${customer}`)
      assert.deepEqual(ledger.cashTransactions.map(row=>[row.transaction_ref,row.amount_cents,row.ending_balance_cents]).sort(),
        transactions.map(row=>[row.id,row.net_amount,row.ending_balance]).sort(),'Recorded cash history agrees independently with Stripe')
      assert.equal(transactions.filter(row=>row.type==='funded').length,index+1)
      assert.equal(transactions.filter(row=>row.type==='applied_to_payment').length,index+1)
      results.cash.push({invoice:invoice.id,matching:index===0?'reference':'exact_amount',event:event.id,transfer:funded.id,cents:invoice.total_cents,allocations:1,remainingCents:0})
    }
    const intents=(await stripe.list('/v1/payment_intents',{customer:remote.id})).data
    assert.equal(intents.length,2,'Repeated cash events create no replacement payment')
    assert.equal(writes.filter(row=>row.path==='/v1/payment_intents').length,2)
    assert.equal(writes.filter(row=>row.path.endsWith('/funding_instructions')).length,1)
    results.status='passed';results.customer=remote.id;results.invoices=invoices.map(row=>row.id)
    results.nativeInstructionWrites=1
    return results
  } catch(error) {
    throw Object.assign(new Error('transfer_instruction_sandbox_failed'),{code:'transfer_instruction_sandbox_failed',cause:error,phase})
  } finally {
    await browser?.close();await h?.close()
    if(remote) {
      await stripe.request('DELETE',`/v1/customers/${remote.id}`)
      results.cleanup='owned_test_customer_deleted'
    }
    await mkdir(directory,{recursive:true})
    await writeFile(`${directory}/result.json`,JSON.stringify({...results,phase,requests:stripe.requests},null,2)+'\n')
  }
}

if(process.argv[1]===new URL(import.meta.url).pathname) {
  const stripe=stripeSandbox(process.env.STRIPE_SECRET_KEY)
  try {const result=await proveTransferInstructions(stripe,process.env.STRIPE_SECRET_KEY);console.log(JSON.stringify(result))}
  catch(error) {
    console.error(JSON.stringify({status:'failed',phase:error.phase,error:safeError(error.cause??error),
      assertion:error.cause?.code==='ERR_ASSERTION'?String(error.cause.message).slice(0,300):undefined}))
    process.exitCode=1
  }
}
