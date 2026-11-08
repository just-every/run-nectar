import assert from 'node:assert/strict'
import {harness} from './tests/nectar/harness.mjs'
import {applyPolicy} from './tests/nectar/policy-helper.mjs'
import {invoicePartialEdge,seedPartialInvoice} from './tests/nectar/invoice-partial-payments.mjs'
import {totp} from './tests/nectar/mfa.mjs'
import {writeFile} from 'node:fs/promises'
const at='2026-10-29T12:00:00Z',results=[]
for(const kind of ['card','scheduled_ach']){
 const edge=invoicePartialEdge();edge.bankTime(at)
 const h=await harness({localTime:at,stripeFetch:edge.fetch,stripeSecret:'synthetic-nectar-partial-key'})
 try {
  await h.raw('/auth/bootstrap',{body:{token:h.vars.SETUP_TOKEN,displayName:'Synthetic owner'}})
  const owner=await h.signIn(h.vars.OWNER_EMAIL),api=(path,body,status)=>h.api(path,owner,body,status)
  await h.raw('/setup',{cookie:owner,form:new URLSearchParams({confirm:'yes'})})
  await api('business.configure',{legal_name:'Synthetic INV-007',timezone:'America/Los_Angeles',invoice_prefix:'SY',payment_terms_days:30})
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Synthetic regression probe'})
  await api('tax.review',{revision:(await api('business')).revision})
  const factor=await api('mfa.totp.start',{});await api('mfa.totp.confirm',{factor:factor.factor,code:totp(factor.secret,Date.parse(at))})
  const customer=(await api('customer.create',{external_id:`synthetic-inv007-${kind}`,name:'Synthetic customer',billing_email:(await api('me')).email})).id
  const invoice=await seedPartialInvoice(h,owner,customer,{issueDate:'2026-10-29'})
  const ref=`synthetic-inv007-${kind}`
  await api('collection.customer.bind',{customer,account_ref:'synthetic-nectar-partial-account',stripe_customer_ref:ref,confirm:true})
  await api('portal.configure',{hosts:[h.origin],parents:[]})
  const session=await api('portal.session.issue',{customer,origin:h.origin,audience:'hosted'})
  const bank=kind==='scheduled_ach'?edge.bank(ref):null
  const prepared=bank?await api('invoice.partial.schedule.prepare',{invoice:invoice.id,scheduled_on:'2026-10-29',mandate_ref:bank.mandateRef}):await api('invoice.partial.prepare',{invoice:invoice.id,amount_cents:40000})
  await api('invoice.partial.confirm',prepared.confirm)
  const accept=await h.raw(`/portal/invoice-payment/${bank?'schedule':'start'}?session=${session.token}`,{body:{request:prepared.id,basis_hash:prepared.basisHash,accept:true}})
  assert.equal(accept.status,200);await accept.text()
  if(bank){await api('invoice.partial.schedule.execute',{request:prepared.id,basis_hash:prepared.basisHash,scheduled_on:'2026-10-29',amount_cents:100000,payment_method_ref:bank.paymentMethodRef,confirm:true});edge.settleBank([...edge.intents.keys()].at(-1))}
  else edge.complete([...edge.sessions.keys()].at(-1))
  const c=await api(`customers/${customer}`)
  await api('customer.update',{customer,revision:c.revision,name:c.name,billing_email:c.billing_email,address:'Synthetic new billing address'})
  const beforeWrites=edge.calls.filter(c=>c.method==='POST').length
  const response=await h.raw('/api/nectar/invoice.partial.reconcile',{cookie:owner,body:{request:prepared.id}}),result=await response.json()
  const after=await api(`invoices/${invoice.id}`),row=(await api('invoice-partial-payments')).find(r=>r.id===prepared.id)
  const payment=await api('payment.record',{customer,amount:'1',received_on:'2026-10-29',method:'bank_transfer',reference:`synthetic-recovery-${kind}`})
  const recovery=await h.raw('/api/nectar/payment.allocate',{cookie:owner,body:{invoice:invoice.id,payment:payment.payment,amount:'1'}}),recoveryBody=await recovery.json()
  const list=await h.raw('/api/nectar/invoice-partial-payments?limit=1',{cookie:owner}),listBody=await list.json()
  if(response.ok)await api('invoice.partial.reconcile',{request:prepared.id})
  results.push({kind,reconcileStatus:response.status,result:result.error??result.status,paidCents:after.paidCents,balanceCents:after.balanceCents,allocations:after.allocations.length,requestStatus:row.status,allocationRecoveryStatus:recovery.status,allocationRecoveryResult:recoveryBody.error??'allocated',pagedListStatus:list.status,pagedListError:listBody.error??null,pagedListRows:listBody.data?.length??null,providerWritesDuringReconciliation:edge.calls.filter(c=>c.method==='POST').length-beforeWrites})
 } finally{await h.close()}
}
console.log(JSON.stringify(results,null,2))
if(process.env.PROBE_RECEIPT)await writeFile(process.env.PROBE_RECEIPT,JSON.stringify({probe:'INV-007 address edit after provider submission',results},null,2)+'\n')
