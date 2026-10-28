import assert from 'node:assert/strict'
import {applyPolicy} from './policy-helper.mjs'
import {nativeCollectionEdge} from './native-collection.mjs'
const edge=nativeCollectionEdge()
export const harnessOptions=()=>({stripeFetch:edge.fetch,stripeSecret:'synthetic-nectar-1'})
const rounded=(n,d)=>Math.floor((n+Math.floor(d/2))/d)
const contact=local=>[local,'example.test'].join('@')
export async function planChangesFlow(h,owner,{onState=async()=>{},prepare,decide}={}) {
  const api=(path,body,status)=>h.api(path,owner,body,status)
  await h.advanceClock('2026-07-01T10:00:00Z');edge.capturedAt('2026-07-01T10:00:00Z')
  await api('business.configure',{...await api('business'),timezone:'UTC'})
  await api('access.give',{email:contact('changes-finance'),name:'Change Finance',role:'finance'})
  const finance=await h.signIn(contact('changes-finance'),{requested:true}),credential=await api('credential.issue',{name:'Change observer',scopes:['prepare']}),agent={bearer:credential.key}
  const product=(await api('product.create',{code:'synthetic-nectar-plan-1',name:'Annual plan'})).id
  const makePrice=async(n,amount)=>(await api('price.create',{product:(await api('product.create',{code:`synthetic-nectar-plan-${n}`,name:`Annual tier ${n}`})).id,kind:'flat',unit_amount:amount,interval_unit:'year',billing_timing:'advance',taxable:false})).id
  const low=await makePrice(2,'1200'),high=await makePrice(3,'2400')
  const fixtures=[]
  for(let n=1;n<=6;n++){
    const customer=(await api('customer.create',{external_id:`synthetic-nectar-plan-customer-${n}`,name:`Plan account ${n}`,billing_email:contact(`plan-${n}`)})).id
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
  await h.api('plan.change.prepare',agent,{subscription:fixtures[0].subscription,item:fixtures[0].item,price:high,mode:'immediate'},403)
  await api('credential.revoke',{key:credential.id})
  await h.api(`subscriptions/${fixtures[0].subscription}`,agent,undefined,401)
  await h.api('plan.change.decide',agent,{change:first.change,decision:'approved'},401)
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
  await api('collection.confirm',collection.instructions.confirm,409)
  assert.equal((await api(`invoices/${upgraded.invoice}`)).balanceCents,0)
  assert.equal(edge.calls.filter(c=>c.method==='POST'&&c.path==='/payment_intents').length,1)
  await api('plan.change.decide',{change:first.change,decision:'approved'},409)
  await onState({label:'upgrade-issued-paid',subscription:fixtures[0].subscription,invoice:upgraded.invoice})
  const repeated=await repeatedPlanChanges(h,owner,finance,fixtures[0],{low,high,makePrice,first,debit,preview,approve,policy,onState})
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
  // A waived upgrade never creates purchased consideration to credit later.
  await h.advanceClock('2026-08-01T10:00:00Z')
  const waivedItem=(await api(`subscriptions/${fixtures[2].subscription}`)).items.find(i=>i.price_id===high)
  const waivedBefore=await api(`subscriptions/${fixtures[2].subscription}`),waivedInvoice=await api(`invoices/${fixtures[2].invoice}`)
  await policy('invoice_now')
  const unsupported=await api('plan.change.prepare',{subscription:fixtures[2].subscription,item:waivedItem.id,price:low,mode:'immediate'},409)
  assert.equal(unsupported.error,'plan_change_waived_service_basis_pending')
  assert.deepEqual((await api(`subscriptions/${fixtures[2].subscription}`)).items,waivedBefore.items)
  assert.equal((await api(`subscriptions/${fixtures[2].subscription}`)).planChanges.length,waivedBefore.planChanges.length,'unbilled waived service creates no credit request')
  assert.deepEqual(await api(`invoices/${fixtures[2].invoice}`),waivedInvoice)
  await onState({label:'waived-paid-basis-refused',subscription:fixtures[2].subscription})
  await policy('none');await h.advanceClock('2026-07-01T10:00:00Z')
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
  const endInvoice=futureInvoices.find(i=>i.customer_id===fixtures[1].customer),noneInvoice=futureInvoices.find(i=>i.customer_id===fixtures[2].customer),nextInvoice=futureInvoices.find(i=>i.customer_id===fixtures[4].customer),carryInvoice=futureInvoices.find(i=>i.customer_id===fixtures[3].customer),repeatedInvoice=futureInvoices.find(i=>i.customer_id===fixtures[0].customer)
  assert.equal(endInvoice.total_cents,120000);assert.equal(noneInvoice.total_cents,240000);assert.equal(nextInvoice.total_cents,240000+delta)
  assert.equal(repeatedInvoice.total_cents,120000,'the next full service uses only the final approved plan')
  for(const draft of [nextInvoice,carryInvoice,repeatedInvoice]){await api('invoice.approve',{invoice:draft.id,acknowledge:true});await api('invoice.finalise',{invoice:draft.id,issue_date:'2027-01-01'})}
  assert.equal((await api(`invoices/${repeatedInvoice.id}`)).balanceCents,120000-repeated.creditAmount,'the numbered cumulative credit applies once')
  await onState({label:'repeated-next-service-credit-applied',subscription:fixtures[0].subscription,invoice:repeatedInvoice.id})
  assert.equal((await api(`invoices/${carryInvoice.id}`)).balanceCents,120000-creditAmount)
  assert.equal((await api(`invoices/${nextInvoice.id}`)).lines.filter(l=>l.kind==='plan_change').length,1)
  const remaining=await api('billrun.prepare',{period:'2027-01'})
  assert.equal(remaining.summary.invoices,3,'only the three still-unissued annual services are drafted')
  assert.ok((await api(`runs/${remaining.id}`)).invoices.every(i=>![fixtures[0].customer,fixtures[3].customer,fixtures[4].customer].includes(i.customer_id)),'issued service, carried credit and deferred delta never duplicate')
  // Historical source tax, not today's rate, controls the debit difference.
  await h.advanceClock('2028-07-01T10:00:00Z');await policy('invoice_now')
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'flat_rate',tax_rate:'10',tax_note:'Synthetic reviewed historical rate'})
  await api('tax.review',{revision:(await api('business')).revision})
  const taxProduct=(await api('product.create',{code:'synthetic-nectar-plan-tax',name:'Taxed annual service'})).id
  const taxLow=(await api('price.create',{product:taxProduct,kind:'flat',unit_amount:'1200',interval_unit:'year',billing_timing:'advance',taxable:true})).id
  const otherTaxProduct=(await api('product.create',{code:'synthetic-nectar-plan-tax-target',name:'Taxed annual upgrade'})).id
  const taxHigh=(await api('price.create',{product:otherTaxProduct,kind:'flat',unit_amount:'2400',interval_unit:'year',billing_timing:'advance',taxable:true})).id
  const taxCustomer=(await api('customer.create',{external_id:'synthetic-nectar-plan-tax-customer',name:'Taxed plan account',billing_email:contact('tax-plan')})).id
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
  await mixedPlanChanges(h,owner,finance,{preview,approve,onState})
  console.log('planChangesFlow: annual upgrade exact preview/debit/PAY-008, period-end downgrade, no proration, paid carried credit, next-invoice delta and stale/duplicate refusal passed')
  return {fixtures,upgraded,changed}
}

async function mixedPlanChanges(h,owner,finance,{preview,approve,onState}){
  const api=(path,body,status)=>h.api(path,owner,body,status)
  await h.advanceClock('2030-01-01T10:00:00Z')
  await applyPolicy(h,owner,'lifecycle.policy',{credit_unused:true,reactivation_days:30,proration_policy:'invoice_now'})
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'flat_rate',tax_rate:'10',tax_note:'Mixed issued-service replay'})
  await api('tax.review',{revision:(await api('business')).revision})
  const external='synthetic-nectar-mixed-plan',meterCode='synthetic-nectar-mixed-plan-units'
  const customer=(await api('customer.create',{external_id:external,name:'Mixed service account',billing_email:contact('mixed-plan')})).id
  const meter=(await api('meter.create',{code:meterCode,name:'Mixed service units',unit_label:'units'})).id
  const price=async(n,fields)=>(await api('price.create',{product:(await api('product.create',{code:`synthetic-nectar-mixed-plan-${n}`,name:`Mixed service tier ${n}`})).id,taxable:true,...fields})).id
  const low=await price(1,{kind:'flat',unit_amount:'1200.03',interval_unit:'year',billing_timing:'advance'})
  const high=await price(2,{kind:'flat',unit_amount:'2400.07',interval_unit:'year',billing_timing:'advance'})
  const seat=await price(3,{kind:'seat',unit_amount:'120.07',interval_unit:'year',billing_timing:'advance'})
  const units=await price(4,{kind:'unit',unit_amount:'0.07',meter})
  const subscription=(await api('subscription.create',{customer,start_date:'2030-01-01',price:[low,seat,units],quantity:['1','2','']})).id
  const issue=async(period)=>{
    const run=await api('billrun.prepare',{period}),rows=(await api(`runs/${run.id}`)).invoices.filter(i=>i.customer_id===customer)
    assert.equal(rows.length,1,'each due date has one mixed-service invoice')
    const invoice=rows[0]
    await api('invoice.approve',{invoice:invoice.id,acknowledge:true})
    await api('invoice.finalise',{invoice:invoice.id,issue_date:`${period}-01`})
    return api(`invoices/${invoice.id}`)
  }
  await issue('2030-01')
  const usage=async(id,quantity,date)=>api('usage.submit',{events:[{event_id:`synthetic-nectar-mixed-plan-${id}`,customer:external,meter:meterCode,quantity,occurred_at:`${date}T12:00:00Z`}]})
  await usage('original','3','2030-12-15')
  await h.advanceClock('2031-01-01T10:00:00Z')
  const source=await issue('2031-01'),originalSubtotal=120003+2*12007+21,total=n=>n+rounded(n,10)
  assert.equal(source.calculation.inputs.billing.serviceWindows.length,2)
  assert.equal(source.subtotal_cents,originalSubtotal);assert.equal(source.total_cents,total(originalSubtotal))
  const immutable=i=>({number:i.number,subtotal:i.subtotal_cents,tax:i.tax_cents,total:i.total_cents,lines:i.lines,calculation:i.calculation})
  const original=immutable(source)
  const paid=(await api('payment.record',{customer,amount:String(source.total_cents/100),received_on:'2031-01-02',method:'bank_transfer',reference:'synthetic-nectar-mixed-plan-paid'})).payment
  await api('payment.allocate',{payment:paid,invoice:source.id,amount:String(source.total_cents/100)})
  const item=async priceId=>(await api(`subscriptions/${subscription}`)).items.find(i=>i.price_id===priceId&&!i.effective_to)
  const quote=async(priceId,target,quantity=1,mode='immediate')=>preview({subscription,item:(await item(priceId)).id,price:target,quantity,mode})
  await h.advanceClock('2031-07-01T10:00:00Z')
  const upgrade=await quote(low,high),competing=await quote(seat,seat,4)
  const flatAfter=rounded(120003*181,365)+rounded(240007*184,365),firstSubtotal=flatAfter+2*12007+21
  assert.equal(upgrade.quote.before.totalCents,total(originalSubtotal));assert.equal(upgrade.quote.after.totalCents,total(firstSubtotal))
  const debit=await approve({change:upgrade.change,decision:'approved'},finance)
  assert.equal((await api(`invoices/${debit.invoice}`)).total_cents,total(firstSubtotal)-source.total_cents)
  const unchanged=await api(`subscriptions/${subscription}`),money=await api(`invoices/${source.id}`)
  await h.api('plan.change.decide',finance,{change:competing.change,decision:'approved'},409)
  assert.deepEqual((await api(`subscriptions/${subscription}`)).items,unchanged.items)
  assert.deepEqual(await api(`invoices/${source.id}`),money,'a stale sibling-component approval changes no money')
  await onState({label:'mixed-annual-upgrade',subscription,invoice:debit.invoice})
  await h.advanceClock('2031-08-01T10:00:00Z')
  const seats=await quote(seat,seat,4),seatAfter=rounded(2*12007*212,365)+rounded(4*12007*153,365),secondSubtotal=flatAfter+seatAfter+21
  assert.equal(seats.quote.before.totalCents,total(firstSubtotal));assert.equal(seats.quote.after.totalCents,total(secondSubtotal))
  const seatDebit=await approve({change:seats.change,decision:'approved'},finance)
  assert.equal((await api(`invoices/${seatDebit.invoice}`)).total_cents,total(secondSubtotal)-total(firstSubtotal))
  await onState({label:'mixed-independent-seat-upgrade',subscription,invoice:seatDebit.invoice})
  await h.advanceClock('2031-09-01T10:00:00Z')
  const down=await quote(high,low),finalFlat=rounded(120003*181,365)+rounded(240007*62,365)+rounded(120003*122,365),finalSubtotal=finalFlat+seatAfter+21
  assert.equal(down.quote.before.totalCents,total(secondSubtotal));assert.equal(down.quote.after.totalCents,total(finalSubtotal))
  const reduced=await approve({change:down.change,decision:'approved'},finance),credited=await api(`invoices/${source.id}`),credit=credited.credits.find(c=>c.id===reduced.credit)
  assert.ok(credit.number);assert.equal(credit.amount_cents,total(secondSubtotal)-total(finalSubtotal));assert.equal(credit.applied_cents,0)
  assert.equal(credit.subtotal_cents,secondSubtotal-finalSubtotal)
  assert.equal(credit.tax_cents,rounded(secondSubtotal,10)-rounded(finalSubtotal,10),'tax is the whole-invoice difference, including unchanged metered service')
  assert.deepEqual(immutable(credited),original,'all original service calendars, usage and issued amounts remain immutable')
  const revenue=(await api(`revenue/${debit.invoice}`)).schedules.flatMap(s=>s.entries)
  assert.equal(revenue.reduce((sum,e)=>sum+e.amountCents,0),firstSubtotal-originalSubtotal,'the revenue schedule reconciles the exact tax-exclusive debit')
  const share=(amount,index,count)=>rounded(amount*(index+1),count)-rounded(amount*index,count)
  const expectedRevenue=Array.from({length:12},(_,index)=>[
    `2031-${String(index+1).padStart(2,'0')}`,
    (index<6?share(rounded(120003*181,365),index,6):share(rounded(240007*184,365),index-6,6))-share(120003,index,12),
  ]).filter(([,amount])=>amount!==0)
  assert.deepEqual(revenue.map(e=>[e.period,e.amountCents]),expectedRevenue,'equal service-month recognition reconciles each changed fee segment; unchanged usage and seats cancel')
  const beforeReplay=await api(`subscriptions/${subscription}`)
  await h.api('plan.change.decide',finance,{change:down.change,decision:'approved'},409)
  await api('plan.change.prepare',{subscription,item:(await item(units)).id,price:units,mode:'immediate'},409)
  assert.deepEqual((await api(`subscriptions/${subscription}`)).items,beforeReplay.items)
  await onState({label:'mixed-numbered-credit',subscription,invoice:source.id})
  // Replacement claims cover only the changed advance item. The independently
  // metered component remains billable exactly once at its ordinary due date.
  await usage('later','10','2031-08-15')
  const monthly=await issue('2031-09')
  assert.equal(monthly.total_cents,77);assert.equal(monthly.lines.filter(l=>l.kind==='usage').length,1)
  assert.equal(monthly.lines.filter(l=>l.kind==='flat'||l.kind==='seat').length,0,'neither replacement advance component is billed again')
  assert.equal(monthly.balanceCents,0)
  const repeat=await api('billrun.prepare',{period:'2031-09'})
  assert.equal((await api(`runs/${repeat.id}`)).invoices.filter(i=>i.customer_id===customer).length,0)
  const scheduled=await quote(seat,seat,1,'period_end')
  assert.equal(scheduled.quote.effectiveDate,'2032-01-01');assert.equal(scheduled.quote.delta.totalCents,0)
  await approve({change:scheduled.change,decision:'approved'},finance)
  await h.advanceClock('2032-01-01T10:00:00Z')
  await usage('renewal','5','2031-12-15')
  const renewal=await issue('2032-01'),renewalSubtotal=120003+12007+35
  assert.equal(renewal.total_cents,total(renewalSubtotal),'the next mixed invoice uses only final approved plans and exact new usage')
  assert.equal(renewal.balanceCents,Math.max(0,renewal.total_cents-(credit.amount_cents-77)),'the numbered credit is conserved across ordinary invoices')
  assert.deepEqual(immutable(await api(`invoices/${source.id}`)),original)
  await onState({label:'mixed-next-service',subscription,invoice:renewal.id})
}

async function repeatedPlanChanges(h,owner,finance,f,{low,high,makePrice,first,debit,preview,approve,policy,onState}){
  const api=(path,body,status)=>h.api(path,owner,body,status)
  const higher=await makePrice(4,'4800')
  const visible=async()=>({items:(await api(`subscriptions/${f.subscription}`)).items,invoices:await Promise.all((await api(`invoices?customer=${f.customer}`)).data.map(i=>api(`invoices/${i.id}`)))})
  const immutable=i=>({number:i.number,subtotal:i.subtotal_cents,tax:i.tax_cents,total:i.total_cents,lines:i.lines,calculation:i.calculation})
  const original=immutable(await api(`invoices/${f.invoice}`)),firstDebit=immutable(debit)
  await h.advanceClock('2026-09-01T10:00:00Z')
  const current=(await api(`subscriptions/${f.subscription}`)).items.find(i=>i.price_id===high)
  const fields={subscription:f.subscription,item:current.id,price:higher,mode:'immediate'}
  const staleSource=await preview(fields)
  const payment=(await api('payment.record',{customer:f.customer,amount:'1200',received_on:'2026-09-01',method:'bank_transfer',reference:'synthetic-nectar-repeated-original'})).payment
  await api('payment.allocate',{payment,invoice:f.invoice,amount:'1200'})
  let before=await visible()
  await h.api('plan.change.decide',finance,{change:staleSource.change,decision:'approved'},409)
  assert.deepEqual(await visible(),before,'a changed source balance invalidates the old exact quote without changing money or service')
  const second=await preview(fields),competing=await preview({...fields,price:low})
  const secondTotal=rounded(120000*181,365)+rounded(240000*62,365)+rounded(480000*122,365)
  assert.equal(second.quote.before.totalCents,first.quote.after.totalCents)
  assert.equal(second.quote.after.totalCents,secondTotal)
  assert.equal(second.quote.delta.totalCents,secondTotal-first.quote.after.totalCents)
  before=await visible()
  await api('plan.change.decide',{change:second.change,decision:'approved'},409)
  assert.deepEqual(await visible(),before,'a preparer cannot approve their own second change')
  await onState({label:'repeated-second-upgrade-preview',subscription:f.subscription})
  const result=await approve({change:second.change,decision:'approved'},finance)
  const secondDebit=await api(`invoices/${result.invoice}`)
  assert.equal(secondDebit.total_cents,second.quote.delta.totalCents)
  before=await visible()
  for(const change of [second.change,competing.change])await h.api('plan.change.decide',finance,{change,decision:'approved'},409)
  await api('plan.change.prepare',fields,409)
  assert.deepEqual(await visible(),before,'duplicate and superseded source-item requests change no money or plan')
  const settlement=(await api('payment.record',{customer:f.customer,amount:String(secondDebit.total_cents/100),received_on:'2026-09-01',method:'bank_transfer',reference:'synthetic-nectar-repeated-second'})).payment
  await api('payment.allocate',{payment:settlement,invoice:result.invoice,amount:String(secondDebit.total_cents/100)})
  assert.equal((await api('billrun.prepare',{period:'2026-09'})).summary.invoices,0,'the second replacement stub is already claimed')
  await onState({label:'repeated-second-upgrade-issued',subscription:f.subscription,invoice:result.invoice})
  await h.advanceClock('2026-10-01T10:00:00Z')
  const latest=(await api(`subscriptions/${f.subscription}`)).items.find(i=>i.price_id===higher)
  const downgrade={subscription:f.subscription,item:latest.id,price:low,mode:'immediate'}
  const stalePolicy=await preview(downgrade)
  await policy('none');before=await visible()
  await h.api('plan.change.decide',finance,{change:stalePolicy.change,decision:'approved'},409)
  assert.deepEqual(await visible(),before,'a policy revision invalidates a repeated-change credit without mutation')
  await policy('invoice_now')
  await applyPolicy(h,owner,'credit.policy',{two_person_above:'500'})
  const down=await preview(downgrade)
  const finalTotal=rounded(120000*181,365)+rounded(240000*62,365)+rounded(480000*30,365)+rounded(120000*92,365)
  const creditAmount=secondTotal-finalTotal
  assert.equal(down.quote.before.totalCents,secondTotal);assert.equal(down.quote.after.totalCents,finalTotal);assert.equal(down.quote.delta.totalCents,-creditAmount)
  await onState({label:'repeated-downgrade-credit-preview',subscription:f.subscription})
  const races=await Promise.all([1,2].map(()=>h.raw('/api/nectar/plan.change.decide',{cookie:finance,body:{change:down.change,decision:'approved'}})))
  assert.deepEqual(races.map(r=>r.status).sort(),[200,409],'concurrent repeated-credit approvals execute once')
  const applied=await races.find(r=>r.status===200).json(),source=await api(`invoices/${f.invoice}`),credit=source.credits.find(c=>c.id===applied.credit)
  assert.ok(credit.number);assert.equal(credit.amount_cents,creditAmount);assert.equal(credit.applied_cents,0);assert.equal(source.balanceCents,0)
  assert.equal(120000+debit.total_cents+secondDebit.total_cents-creditAmount,finalTotal,'net debit and numbered credit equal independently rated chronological service')
  assert.deepEqual(immutable(source),original);assert.deepEqual(immutable(await api(`invoices/${debit.id}`)),firstDebit)
  assert.deepEqual(immutable(await api(`invoices/${result.invoice}`)),immutable(secondDebit),'all issued source documents retain their evidence')
  before=await visible();await h.api('plan.change.decide',finance,{change:down.change,decision:'approved'},409)
  assert.deepEqual(await visible(),before,'replayed credit approval cannot issue a second credit')
  assert.equal((await api('billrun.prepare',{period:'2026-10'})).summary.invoices,0,'the downgraded current service is claimed once')
  await onState({label:'repeated-downgrade-numbered-credit',subscription:f.subscription,invoice:f.invoice})
  await h.advanceClock('2026-07-01T10:00:00Z')
  return {creditAmount}
}

// GOV-001 already permits sales quotes; invoice and credit custody stay gated.
export async function salesPlanChangesFlow(h,owner,{onState=async()=>{},prepare,creditPrepare,decide}={}){
 const api=(path,body,status)=>h.api(path,owner,body,status)
 await h.advanceClock('2026-07-01T12:00:00Z');await api('business.configure',{...await api('business'),timezone:'UTC'})
 const people={}
 for(const role of ['sales','finance']){await api('access.give',{email:contact(`plan-${role}`),name:`Plan ${role}`,role});people[role]=await h.signIn(contact(`plan-${role}`),{requested:true})}
 await applyPolicy(h,owner,'credit.policy',{two_person_above:'1000'})
 await applyPolicy(h,owner,'lifecycle.policy',{credit_unused:true,reactivation_days:30,proration_policy:'invoice_now'})
 const price=async(n,amount)=>{const product=(await api('product.create',{code:`synthetic-nectar-sales-price-${n}`,name:`Annual sales tier ${n}`})).id;return(await api('price.create',{product,kind:'seat',unit_amount:amount,interval_unit:'year',billing_timing:'advance',taxable:false})).id}
 const low=await price(1,'1200'),high=await price(2,'4800'),fixtures=[]
 for(let n=0;n<2;n++){const customer=(await api('customer.create',{external_id:`synthetic-nectar-sales-plan-${n}`,name:`Quoted annual account ${n+1}`,billing_email:contact(`sales-plan-${n}`)})).id;const subscription=(await api('subscription.create',{customer,start_date:'2026-01-01',price:[n?high:low],quantity:['1']})).id;fixtures.push({customer,subscription})}
 const run=await api('billrun.prepare',{period:'2026-01'})
 for(const row of (await api(`runs/${run.id}`)).invoices){await api('invoice.approve',{invoice:row.id,acknowledge:true});await api('invoice.finalise',{invoice:row.id,issue_date:'2026-01-01'});const f=fixtures.find(f=>f.customer===row.customer_id);f.invoice=row.id;f.item=(await api(`subscriptions/${f.subscription}`)).items[0].id}
 const payment=(await api('payment.record',{customer:fixtures[1].customer,amount:'4800',received_on:'2026-01-02',method:'bank_transfer',reference:'synthetic-nectar-sales-paid'})).payment
 await api('payment.allocate',{payment,invoice:fixtures[1].invoice,amount:'4800'})
 const preview=prepare??((fields,who)=>h.api('plan.change.prepare',who,fields)),execute=decide??((fields,who)=>h.api('plan.change.decide',who,fields))
 const minimal=['after','before','delta','effectiveDate','mode','period','policy','waivedDelta'].sort()
 const ownerOtherQuote=await api('plan.change.prepare',{subscription:fixtures[0].subscription,item:fixtures[0].item,price:high,quantity:1,mode:'immediate'})
 assert.ok((await h.page(`/app/subscriptions/${fixtures[0].subscription}`,people.sales)).includes(`value="${high}"`),'sales can select their permitted catalogue price in the real plan form')
 const upgrade=await preview({subscription:fixtures[0].subscription,item:fixtures[0].item,price:high,quantity:1,mode:'immediate'},people.sales)
 assert.deepEqual(Object.keys(upgrade.quote).sort(),minimal)
 assert.ok((await h.page(`/app/subscriptions/${fixtures[0].subscription}`,people.finance)).includes('Target plan: <strong>Annual sales tier 2 v1</strong>'),'the approver sees the saved target plan, not just a money delta')
 await h.api(`invoices/${fixtures[0].invoice}`,people.sales,undefined,403)
 const own=(await h.api(`subscriptions/${fixtures[0].subscription}`,people.sales)).planChanges
 assert.equal(own.length,1,'sales see their own quote, not another preparer\'s saved source')
 assert.equal(own[0].source_invoice_id,undefined);assert.equal(own[0].quote.sourceBalance,undefined);assert.equal(own[0].quote.originalTax,undefined)
 await h.api('plan.change.decide',people.sales,{change:upgrade.change,decision:'approved'},403)
 await onState({label:'sales-upgrade-preview',subscription:fixtures[0].subscription,sales:people.sales,finance:people.finance})
 const applied=await execute({change:upgrade.change,decision:'approved'},people.finance)
 assert.equal((await api(`invoices/${applied.invoice}`)).total_cents,upgrade.quote.delta.totalCents)
 const down=await preview({subscription:fixtures[1].subscription,item:fixtures[1].item,price:low,quantity:1,mode:'immediate'},people.sales)
 assert.deepEqual(Object.keys(down.quote).sort(),minimal);assert.ok(down.quote.delta.totalCents < -100000)
 await h.api('plan.change.credit.prepare',people.sales,{change:down.change},403)
 await h.api('plan.change.decide',people.finance,{change:down.change,decision:'approved'},409)
 await onState({label:'sales-credit-needs-finance',subscription:fixtures[1].subscription,sales:people.sales,finance:people.finance})
 const authorize=creditPrepare??((fields,who)=>h.api('plan.change.credit.prepare',who,fields))
 const binding=await authorize({change:down.change},people.finance)
 await h.api('plan.change.credit.prepare',people.finance,{change:down.change},409)
 await h.api('plan.change.decide',people.finance,{change:down.change,decision:'approved'},409)
 await h.api('credit.issue',people.finance,{invoice:fixtures[1].invoice,request:binding.request,amount:String(-down.quote.delta.totalCents/100),reason:'Unused advance service from approved plan change'},409)
 await onState({label:'sales-credit-independent-review',subscription:fixtures[1].subscription,sales:people.sales,finance:people.finance})
 const credited=await execute({change:down.change,decision:'approved'},owner)
 const original=await api(`invoices/${fixtures[1].invoice}`),note=original.credits.find(c=>c.id===credited.credit)
 assert.equal(note.amount_cents,-down.quote.delta.totalCents);assert.equal(note.applied_cents,0);assert.equal(original.balanceCents,0)
 const projected=(await h.api(`subscriptions/${fixtures[1].subscription}`,people.sales)).planChanges[0]
 assert.equal(projected.status,'approved');assert.equal(projected.credit_id,undefined);assert.equal(projected.source_invoice_id,undefined)
 await onState({label:'sales-credit-approved',subscription:fixtures[1].subscription,sales:people.sales,finance:people.finance})
 // The same immutable chain applies to seat quantities and scoped sales quotes.
 await h.advanceClock('2026-09-01T12:00:00Z')
 const seatItem=(await api(`subscriptions/${fixtures[0].subscription}`)).items.find(i=>i.price_id===high)
 const seats=await preview({subscription:fixtures[0].subscription,item:seatItem.id,price:high,quantity:2,mode:'immediate'},people.sales)
 const seatTotal=rounded(120000*181,365)+rounded(480000*62,365)+rounded(960000*122,365)
 assert.deepEqual(Object.keys(seats.quote).sort(),minimal)
 assert.equal(seats.quote.before.totalCents,upgrade.quote.after.totalCents);assert.equal(seats.quote.after.totalCents,seatTotal)
 const seatDebit=await execute({change:seats.change,decision:'approved'},people.finance)
 assert.equal((await api(`invoices/${seatDebit.invoice}`)).total_cents,seatTotal-upgrade.quote.after.totalCents)
 await h.advanceClock('2026-10-01T12:00:00Z')
 const twoSeats=(await api(`subscriptions/${fixtures[0].subscription}`)).items.find(i=>i.quantity===2)
 const fewer=await preview({subscription:fixtures[0].subscription,item:twoSeats.id,price:high,quantity:1,mode:'immediate'},people.sales)
 const reducedTotal=rounded(120000*181,365)+rounded(480000*62,365)+rounded(960000*30,365)+rounded(480000*92,365)
 assert.equal(fewer.quote.delta.totalCents,reducedTotal-seatTotal)
 await h.api('plan.change.decide',people.finance,{change:fewer.change,decision:'approved'},409)
 await authorize({change:fewer.change},people.finance)
 await h.api('plan.change.decide',people.finance,{change:fewer.change,decision:'approved'},409)
 const seatCredit=await execute({change:fewer.change,decision:'approved'},owner)
 assert.equal((await api(`invoices/${fixtures[0].invoice}`)).credits.find(c=>c.id===seatCredit.credit).amount_cents,seatTotal-reducedTotal)
 assert.equal((await api('billrun.prepare',{period:'2026-10'})).summary.invoices,0,'repeated seat changes cannot rebill current service')
 await onState({label:'sales-repeated-seat-credit',subscription:fixtures[0].subscription,sales:people.sales,finance:people.finance})
 const afterCredit=(await api(`subscriptions/${fixtures[0].subscription}`)).items.find(i=>i.effective_from==='2026-10-01')
 await h.api('plan.change.prepare',people.sales,{subscription:fixtures[0].subscription,item:afterCredit.id,price:high,quantity:3,mode:'immediate'},400)
 await h.advanceClock('2026-10-02T12:00:00Z')
 const more=await preview({subscription:fixtures[0].subscription,item:afterCredit.id,price:high,quantity:3,mode:'immediate'},people.sales)
 const moreTotal=rounded(120000*181,365)+rounded(480000*62,365)+rounded(960000*30,365)+rounded(480000,365)+rounded(1440000*91,365)
 assert.equal(more.quote.before.totalCents,reducedTotal);assert.equal(more.quote.after.totalCents,moreTotal)
 const afterCreditDebit=await execute({change:more.change,decision:'approved'},people.finance)
 assert.equal((await api(`invoices/${afterCreditDebit.invoice}`)).total_cents,moreTotal-reducedTotal,'a later change replays the earlier numbered credit and exact seat timeline')
 assert.equal((await api('billrun.prepare',{period:'2026-10'})).summary.invoices,0)
 await api('erasure.request',{customer:fixtures[0].customer})
 const erasure=h.mails.at(-1),href=`${erasure.text??''} ${erasure.html??''}`.match(/https?:\/\/[^\s"<]+\/erase\/[a-f0-9]{64}/)[0]
 await h.raw(new URL(href).pathname,{form:new URLSearchParams({confirm:'yes'})})
 await api('erasure.approve',{request:(await api('erasures')).find(r=>r.customer_id===fixtures[0].customer).id,confirm:true})
 await h.api(`subscriptions/${fixtures[0].subscription}`,people.sales,undefined,410)
 await h.api('plan.change.decide',people.finance,{change:ownerOtherQuote.change,decision:'approved'},410)
 await h.api('plan.change.credit.prepare',people.finance,{change:ownerOtherQuote.change},410)
 assert.equal((await api(`invoices/${applied.invoice}`)).total_cents,upgrade.quote.delta.totalCents)
 console.log('salesPlanChangesFlow: own minimal sales quotes, invoice denial, authorized bound credit preparation and independent above-limit execution passed')
}
