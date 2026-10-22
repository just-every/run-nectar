import assert from 'node:assert/strict'
import {applyPolicy} from './policy-helper.mjs'
import {nativeCollectionEdge} from './native-collection.mjs'
const edge=nativeCollectionEdge()
export const harnessOptions=()=>({stripeFetch:edge.fetch,stripeSecret:'synthetic-nectar-1'})
const rounded=(n,d)=>Math.floor((n+Math.floor(d/2))/d)
export async function planChangesFlow(h,owner,{onState=async()=>{},prepare,decide}={}) {
  const api=(path,body,status)=>h.api(path,owner,body,status)
  await h.advanceClock('2026-07-01T10:00:00Z');edge.capturedAt('2026-07-01T10:00:00Z')
  await api('business.configure',{...await api('business'),timezone:'UTC'})
  await api('access.give',{email:'changes-finance@example.test',name:'Change Finance',role:'finance'})
  const finance=await h.signIn('changes-finance@example.test',{requested:true}),agent={bearer:(await api('credential.issue',{name:'Change observer',scopes:['prepare']})).key}
  const product=(await api('product.create',{code:'synthetic-nectar-plan-1',name:'Annual plan'})).id
  const makePrice=async(n,amount)=>(await api('price.create',{product:(await api('product.create',{code:`synthetic-nectar-plan-${n}`,name:`Annual tier ${n}`})).id,kind:'flat',unit_amount:amount,interval_unit:'year',billing_timing:'advance',taxable:false})).id
  const low=await makePrice(2,'1200'),high=await makePrice(3,'2400')
  const fixtures=[]
  for(let n=1;n<=6;n++){
    const customer=(await api('customer.create',{external_id:`synthetic-nectar-plan-customer-${n}`,name:`Plan account ${n}`,billing_email:`plan-${n}@example.test`})).id
    const subscription=(await api('subscription.create',{customer,start_date:'2026-01-01',price:[n===2||n===4?high:low]})).id
    fixtures.push({customer,subscription})
  }
  const run=await api('billrun.prepare',{period:'2026-01'})
  for(const row of (await api(`runs/${run.id}`)).invoices){await api('invoice.approve',{invoice:row.id,acknowledge:true});await api('invoice.finalise',{invoice:row.id,issue_date:'2026-01-01'});const f=fixtures.find(f=>f.customer===row.customer_id);f.invoice=row.id;f.original=await api(`invoices/${row.id}`);f.item=(await api(`subscriptions/${f.subscription}`)).items[0].id}
  await api('plan.change.prepare',{subscription:fixtures[0].subscription,item:fixtures[0].item,price:high,mode:'immediate'},409)
  for(const who of [agent,undefined])await h.api('plan.change.decide',who,{},who?403:401)
  const policy=async mode=>{const request=await api('lifecycle.policy',{credit_unused:true,reactivation_days:30,proration_policy:mode});assert.ok((await h.page('/app/settings',finance)).includes(({invoice_now:'prorate and invoice now',next_invoice:'prorate on next invoice',none:'no proration'})[mode]),'the different approver sees the exact proration policy before applying it');await onState({label:`proration-policy-${mode}`,policy:true,finance});await h.api('policy.decide',finance,{request:request.request,decision:'approved'})}
  const preview=prepare??(payload=>api('plan.change.prepare',payload)),approve=decide??((payload,who)=>h.api('plan.change.decide',who,payload))
  await policy('invoice_now')
  const first=await preview({subscription:fixtures[0].subscription,item:fixtures[0].item,price:high,mode:'immediate'})
  // July 1 through Jan 1 has 184 days; the existing engine rounds each
  // immutable old/new service piece independently, half away from zero.
  const after=rounded(120000*181,365)+rounded(240000*184,365),delta=after-120000
  assert.equal(first.quote.before.totalCents,120000);assert.equal(first.quote.after.totalCents,after);assert.equal(first.quote.delta.totalCents,delta)
  await api('plan.change.decide',{change:first.change,decision:'approved'},409)
  await onState({label:'upgrade-preview',subscription:fixtures[0].subscription})
  const upgraded=await approve({change:first.change,decision:'approved'},finance)
  const debit=await api(`invoices/${upgraded.invoice}`)
  assert.equal(debit.status,'issued');assert.equal(debit.total_cents,delta)
  assert.deepEqual((await api(`invoices/${fixtures[0].invoice}`)).lines,fixtures[0].original.lines,'original issued invoice never changes')
  assert.equal((await api('billrun.prepare',{period:'2026-07'})).summary.invoices,0,'the changed current advance stub is covered once')
  await api('collection.customer.bind',{customer:fixtures[0].customer,account_ref:'synthetic-nectar-native-account-1',stripe_customer_ref:'synthetic-nectar-native-customer-1',confirm:true})
  const collection=await api('collection.prepare',{invoice:upgraded.invoice});await api('collection.confirm',collection.instructions.confirm)
  assert.equal((await api(`invoices/${upgraded.invoice}`)).balanceCents,0)
  assert.equal(edge.calls.filter(c=>c.method==='POST'&&c.path==='/payment_intents').length,1)
  await api('plan.change.decide',{change:first.change,decision:'approved'},409)
  await onState({label:'upgrade-issued-paid',subscription:fixtures[0].subscription,invoice:upgraded.invoice})
  const scheduled=await preview({subscription:fixtures[1].subscription,item:fixtures[1].item,price:low,mode:'period_end'})
  assert.equal(scheduled.quote.effectiveDate,'2027-01-01');assert.equal(scheduled.quote.delta.totalCents,0)
  await approve({change:scheduled.change,decision:'approved'},finance)
  const history=(await api(`subscriptions/${fixtures[1].subscription}`)).items
  assert.deepEqual(history.map(i=>[i.price_id,i.effective_from,i.effective_to]),[[high,'2026-01-01','2027-01-01'],[low,'2027-01-01',null]])
  await onState({label:'downgrade-period-end',subscription:fixtures[1].subscription})
  await policy('none')
  const none=await preview({subscription:fixtures[2].subscription,item:fixtures[2].item,price:high,mode:'immediate'})
  assert.equal(none.quote.delta.totalCents,0);assert.equal(none.quote.waivedDelta.totalCents,delta)
  const waived=await approve({change:none.change,decision:'approved'},finance);assert.equal(waived.invoice,null);assert.equal(waived.credit,null)
  await onState({label:'without-proration',subscription:fixtures[2].subscription})
  // A paid downgrade issues a numbered carried credit, not a processor refund.
  await policy('invoice_now')
  const paid=(await api('payment.record',{customer:fixtures[3].customer,amount:'2400',received_on:'2026-01-02',method:'bank_transfer',reference:'synthetic-nectar-plan-paid'})).payment
  await api('payment.allocate',{payment:paid,invoice:fixtures[3].invoice,amount:'2400'})
  const down=await preview({subscription:fixtures[3].subscription,item:fixtures[3].item,price:low,mode:'immediate'})
  const creditAmount=240000-rounded(240000*181,365)-rounded(120000*184,365)
  assert.equal(down.quote.delta.totalCents,-creditAmount)
  const changed=await approve({change:down.change,decision:'approved'},finance)
  const invoice=await api(`invoices/${fixtures[3].invoice}`),credit=invoice.credits.find(c=>c.id===changed.credit)
  assert.ok(credit.number);assert.equal(credit.amount_cents,creditAmount);assert.equal(credit.applied_cents,0);assert.equal(invoice.balanceCents,0)
  await onState({label:'paid-downgrade-credit',subscription:fixtures[3].subscription,invoice:fixtures[3].invoice})
  await policy('next_invoice')
  const next=await preview({subscription:fixtures[4].subscription,item:fixtures[4].item,price:high,mode:'immediate'})
  const deferred=await approve({change:next.change,decision:'approved'},finance);assert.equal(deferred.invoice,null)
  // Policy revisions invalidate pending quotes without touching items or money.
  const stale=await preview({subscription:fixtures[5].subscription,item:fixtures[5].item,price:high,mode:'immediate'})
  await policy('none');await h.api('plan.change.decide',finance,{change:stale.change,decision:'approved'},409)
  assert.equal((await api(`subscriptions/${fixtures[5].subscription}`)).items.length,1)
  await h.advanceClock('2027-01-02T10:00:00Z')
  const future=await api('billrun.prepare',{period:'2027-01'}),futureInvoices=(await api(`runs/${future.id}`)).invoices
  const endInvoice=futureInvoices.find(i=>i.customer_id===fixtures[1].customer),noneInvoice=futureInvoices.find(i=>i.customer_id===fixtures[2].customer),nextInvoice=futureInvoices.find(i=>i.customer_id===fixtures[4].customer),carryInvoice=futureInvoices.find(i=>i.customer_id===fixtures[3].customer)
  assert.equal(endInvoice.total_cents,120000);assert.equal(noneInvoice.total_cents,240000);assert.equal(nextInvoice.total_cents,240000+delta)
  for(const draft of [nextInvoice,carryInvoice]){await api('invoice.approve',{invoice:draft.id,acknowledge:true});await api('invoice.finalise',{invoice:draft.id,issue_date:'2027-01-01'})}
  assert.equal((await api(`invoices/${carryInvoice.id}`)).balanceCents,120000-creditAmount)
  assert.equal((await api(`invoices/${nextInvoice.id}`)).lines.filter(l=>l.kind==='plan_change').length,1)
  const remaining=await api('billrun.prepare',{period:'2027-01'})
  assert.equal(remaining.summary.invoices,4,'only the four still-unissued annual services are drafted')
  assert.ok((await api(`runs/${remaining.id}`)).invoices.every(i=>i.customer_id!==fixtures[3].customer&&i.customer_id!==fixtures[4].customer),'issued service and deferred delta never duplicate')
  // Historical source tax, not today's rate, controls the debit difference.
  await h.advanceClock('2028-07-01T10:00:00Z');await policy('invoice_now')
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'flat_rate',tax_rate:'10',tax_note:'Synthetic reviewed historical rate'})
  await api('tax.review',{revision:(await api('business')).revision})
  const taxProduct=(await api('product.create',{code:'synthetic-nectar-plan-tax',name:'Taxed annual service'})).id
  const taxLow=(await api('price.create',{product:taxProduct,kind:'flat',unit_amount:'1200',interval_unit:'year',billing_timing:'advance',taxable:true})).id
  const otherTaxProduct=(await api('product.create',{code:'synthetic-nectar-plan-tax-target',name:'Taxed annual upgrade'})).id
  const taxHigh=(await api('price.create',{product:otherTaxProduct,kind:'flat',unit_amount:'2400',interval_unit:'year',billing_timing:'advance',taxable:true})).id
  const taxCustomer=(await api('customer.create',{external_id:'synthetic-nectar-plan-tax-customer',name:'Taxed plan account',billing_email:'tax-plan@example.test'})).id
  const taxSub=(await api('subscription.create',{customer:taxCustomer,start_date:'2028-01-01',price:[taxLow]})).id
  const taxRun=await api('billrun.prepare',{period:'2028-01'}),taxSource=(await api(`runs/${taxRun.id}`)).invoices.find(i=>i.customer_id===taxCustomer)
  await api('invoice.approve',{invoice:taxSource.id,acknowledge:true});await api('invoice.finalise',{invoice:taxSource.id,issue_date:'2028-01-01'})
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'flat_rate',tax_rate:'20',tax_note:'Synthetic new rate does not rewrite issued history'})
  await api('tax.review',{revision:(await api('business')).revision})
  const taxItem=(await api(`subscriptions/${taxSub}`)).items[0].id
  const taxQuote=await api('plan.change.prepare',{subscription:taxSub,item:taxItem,price:taxHigh,mode:'immediate'})
  // Leap-year denominator and independently rounded source tax delta.
  const taxAfter=rounded(120000*182,366)+rounded(240000*184,366)
  assert.equal(taxQuote.quote.delta.subtotalCents,taxAfter-120000)
  assert.equal(taxQuote.quote.delta.taxCents,rounded(taxAfter,10)-12000)
  const approvals=await Promise.all([1,2].map(()=>h.raw('/api/nectar/plan.change.decide',{cookie:finance,body:{change:taxQuote.change,decision:'approved'}})))
  assert.deepEqual(approvals.map(r=>r.status).sort(),[200,409],'concurrent approvals execute the exact saved change once')
  const taxChange=await approvals.find(r=>r.status===200).json()
  const taxDebit=await api(`invoices/${taxChange.invoice}`)
  assert.equal(taxDebit.tax_cents,taxQuote.quote.delta.taxCents);assert.equal(taxDebit.total_cents,taxQuote.quote.delta.totalCents)
  // Erasure withdraws quote/source narrative while exact credits and revenue remain.
  await api('erasure.request',{customer:fixtures[3].customer})
  const mail=h.mails.at(-1),erasureLink=`${mail.text??''} ${mail.html??''}`.match(/https?:\/\/[^\s"<]+\/erase\/[a-f0-9]{64}/)[0]
  await h.raw(new URL(erasureLink).pathname,{form:new URLSearchParams({confirm:'yes'})})
  await api('erasure.approve',{request:(await api('erasures')).find(r=>r.customer_id===fixtures[3].customer).id,confirm:true})
  assert.equal((await api(`invoices/${fixtures[3].invoice}`)).total_cents,240000)
  assert.equal((await api(`revenue/${fixtures[3].invoice}`)).credits.find(c=>c.id===changed.credit).amountCents,-creditAmount)
  console.log('planChangesFlow: annual upgrade exact preview/debit/PAY-008, period-end downgrade, no proration, paid carried credit, next-invoice delta and stale/duplicate refusal passed')
  return {fixtures,upgraded,changed}
}
