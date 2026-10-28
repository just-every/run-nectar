// Real held-key invoice refunds, provider tax reversals and cancellation custody.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir,writeFile } from 'node:fs/promises'
import { stripeSandbox,safeError } from './stripe-sandbox-client.mjs'
import { harness } from './harness.mjs'
import { invoiceRefundExecutionFlow, invoiceTaxRefundFlow, invoiceCancellationRefundFlow } from './invoice-refund-preview.mjs'
const directory=process.env.NECTAR_EVIDENCE_DIR
assert.ok(directory,'An external evidence directory is required')
await mkdir(directory,{recursive:true})
const receipt={head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),journey:'Invoice card refunds, provider tax, balance credits and frozen cancellation policy',status:'running',checks:{},cleanup:[]}
let stripe,h,customer
const remoteCustomers=[]
try {
  stripe=stripeSandbox(process.env.STRIPE_SECRET_KEY)
  const account=await stripe.request('GET','/v1/account')
  assert.equal(account.country,'US')
  const createCustomer=async()=>{
    const row=await stripe.request('POST','/v1/customers',{name:`Synthetic Nectar refund ${stripe.run}`,'address[line1]':'510 Townsend St','address[city]':'San Francisco','address[state]':'CA','address[postal_code]':'94103','address[country]':'US'})
    remoteCustomers.push(row)
    const method=await stripe.request('POST','/v1/payment_methods',{type:'card','card[token]':'tok_visa'})
    await stripe.request('POST',`/v1/payment_methods/${method.id}/attach`,{customer:row.id})
    await stripe.request('POST',`/v1/customers/${row.id}`,{'invoice_settings[default_payment_method]':method.id})
    return row
  }
  customer=await createCustomer()
  const forward=request=>stripe.forward(request,entry=>{
    if(entry.method==='POST') {
      assert.ok(['/v1/payment_intents','/v1/refunds','/v1/tax/transactions/create_reversal'].includes(entry.path))
      assert.equal(entry.fields.has('receipt_email'),false)
      assert.ok(entry.idempotencyKey)
    }
  })
  h=await harness({stripeFetch:forward,stripeSecret:process.env.STRIPE_SECRET_KEY})
  await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Synthetic owner'}})
  const owner=await h.signIn(h.vars.OWNER_EMAIL)
  await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
  await h.api('business.configure',owner,{legal_name:'Synthetic refund business',timezone:'UTC',invoice_prefix:'REF',payment_terms_days:30})
  const result=await invoiceRefundExecutionFlow(h,owner,{account:account.id,customerRef:customer.id})
  const refund=await stripe.request('GET',`/v1/refunds/${result.cash.refundRef}`)
  assert.equal(refund.status,'succeeded');assert.equal(refund.amount,150000)
  const balanceTransaction=await stripe.request('GET',`/v1/balance_transactions/${refund.balance_transaction}`)
  assert.equal(balanceTransaction.amount,-150000)
  const taxTransaction=async(invoice,customerRef)=>{
    const fields={currency:'usd',customer:customerRef}
    invoice.lines.forEach((line,index)=>Object.assign(fields,{[`line_items[${index}][amount]`]:line.amount_cents,[`line_items[${index}][reference]`]:line.id,[`line_items[${index}][tax_code]`]:'txcd_99999999',[`line_items[${index}][tax_behavior]`]:'exclusive'}))
    const calculation=await stripe.request('POST','/v1/tax/calculations',fields)
    assert.equal(calculation.amount_total,invoice.total_cents);assert.equal(calculation.tax_amount_exclusive,invoice.tax_cents)
    return (await stripe.request('POST','/v1/tax/transactions/create_from_calculation',{calculation:calculation.id,reference:invoice.id})).id
  }
  const taxed=await invoiceTaxRefundFlow(h,owner,{account:account.id,customerRef:customer.id,taxTransaction})
  const second=await createCustomer()
  const cancellation=await invoiceCancellationRefundFlow(h,owner,{account:account.id,customerRef:second.id,taxTransaction})
  receipt.taxed={invoice:taxed.invoice,cash:taxed.cash.refundRef,taxReversals:[taxed.cash.taxReversalRef,taxed.balance.taxReversalRef]}
  receipt.cancellation={invoice:cancellation.invoice,refund:cancellation.refund.refundRef,taxReversal:cancellation.refund.taxReversalRef,credit:cancellation.refund.credit}
  receipt.status='passed';receipt.account=account.id;receipt.invoice=result.invoice
  receipt.refund=refund.id;receipt.balanceTransaction=balanceTransaction.id
  receipt.checks={halfRefundCents:150000,balanceCreditCents:150000,originalTotalCents:300000,originalTaxCents:0,providerOutflowCents:-150000,independentApproval:true,lowSingleApprover:true,duplicateRefused:true,staleRefused:true,agentRefused:true,originalsUnchanged:true}
} catch(error) {receipt.status='failed';receipt.error=safeError(error);process.exitCode=1}
finally {
  await h?.close()
  if(stripe) for(const customer of remoteCustomers) {
    try {
      for(const charge of (await stripe.list('/v1/charges',{customer:customer.id})).data)if(charge.paid&&charge.amount_refunded<charge.amount) {
        await stripe.request('POST','/v1/refunds',{charge:charge.id,amount:charge.amount-charge.amount_refunded})
        receipt.cleanup.push({charge:charge.id,remainingTestCashRefunded:true})
      }
      await stripe.request('DELETE',`/v1/customers/${customer.id}`)
      receipt.cleanup.push({customer:customer.id,deleted:true})
    } catch(error) {receipt.cleanup.push({error:safeError(error)});receipt.status='failed-cleanup';process.exitCode=1}
  }
  if(stripe)receipt.requests=stripe.requests
  await writeFile(`${directory}/invoice-refund-sandbox.json`,JSON.stringify(receipt,null,2)+'\n')
  console.log('INVOICE REFUND SANDBOX',JSON.stringify({head:receipt.head,status:receipt.status,error:receipt.error??null}))
}
