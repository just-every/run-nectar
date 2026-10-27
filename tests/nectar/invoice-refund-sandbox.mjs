// Real held-key proof for the non-taxable current refund door. Provider tax
// transactions and cancellation authority remain separate, unproved work.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir,writeFile } from 'node:fs/promises'
import { stripeSandbox,safeError } from './stripe-sandbox-client.mjs'
import { harness } from './harness.mjs'
import { invoiceRefundExecutionFlow } from './invoice-refund-preview.mjs'
const directory=process.env.NECTAR_EVIDENCE_DIR
assert.ok(directory,'An external evidence directory is required')
await mkdir(directory,{recursive:true})
const receipt={head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),journey:'Non-taxable invoice card refund and balance credit',status:'running',checks:{},cleanup:[]}
let stripe,h,customer
try {
  stripe=stripeSandbox(process.env.STRIPE_SECRET_KEY)
  const account=await stripe.request('GET','/v1/account')
  assert.equal(account.country,'US')
  customer=await stripe.request('POST','/v1/customers',{name:`Synthetic Nectar refund ${stripe.run}`})
  const method=await stripe.request('POST','/v1/payment_methods',{type:'card','card[token]':'tok_visa'})
  await stripe.request('POST',`/v1/payment_methods/${method.id}/attach`,{customer:customer.id})
  await stripe.request('POST',`/v1/customers/${customer.id}`,{'invoice_settings[default_payment_method]':method.id})
  const forward=request=>stripe.forward(request,entry=>{
    if(entry.method==='POST') {
      assert.ok(['/v1/payment_intents','/v1/refunds'].includes(entry.path))
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
  receipt.status='passed';receipt.account=account.id;receipt.invoice=result.invoice
  receipt.refund=refund.id;receipt.balanceTransaction=balanceTransaction.id
  receipt.checks={halfRefundCents:150000,balanceCreditCents:150000,originalTotalCents:300000,originalTaxCents:0,providerOutflowCents:-150000,independentApproval:true,lowSingleApprover:true,duplicateRefused:true,staleRefused:true,agentRefused:true,originalsUnchanged:true}
} catch(error) {receipt.status='failed';receipt.error=safeError(error);process.exitCode=1}
finally {
  await h?.close()
  if(stripe&&customer) {
    try {
      for(const charge of await stripe.list('/v1/charges',{customer:customer.id}))if(charge.paid&&charge.amount_refunded<charge.amount) {
        await stripe.request('POST','/v1/refunds',{charge:charge.id,amount:charge.amount-charge.amount_refunded})
        receipt.cleanup.push({charge:charge.id,remainingTestCashRefunded:true})
      }
      await stripe.request('DELETE',`/v1/customers/${customer.id}`)
      receipt.cleanup.push({customer:customer.id,deleted:true})
    } catch(error) {receipt.cleanup.push({error:safeError(error)});process.exitCode=1}
  }
  if(stripe)receipt.requests=stripe.requests
  await writeFile(`${directory}/invoice-refund-sandbox.json`,JSON.stringify(receipt,null,2)+'\n')
  console.log('INVOICE REFUND SANDBOX',JSON.stringify({head:receipt.head,status:receipt.status,error:receipt.error??null}))
}
