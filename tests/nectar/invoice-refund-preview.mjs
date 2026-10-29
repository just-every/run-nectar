import assert from 'node:assert/strict'
import { prepaidRefundEdge } from './prepaid-refunds.mjs'
import { applyPolicy } from './policy-helper.mjs'

let edge

export const harnessOptions = () => {
  edge = prepaidRefundEdge(); edge.at('2026-10-22T18:00:00Z')
  return { stripeFetch: edge.fetch, stripeSecret: 'synthetic-nectar-1' }
}

export async function invoiceRefundPreviewFlow(h, owner) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  await h.advanceClock('2026-10-22T18:00:00Z')
  await api('business.configure', { ...await api('business'), timezone: 'UTC' })
  await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: 'CA', tax_mode: 'flat_rate', tax_rate: '10', tax_note: 'Synthetic reviewed service tax' })
  await api('tax.review', { revision: (await api('business')).revision })
  await applyPolicy(h, owner, 'credit.policy', { two_person_above: '1000' })
  const customer = (await api('customer.create', { external_id: 'synthetic-nectar-preview-1', name: 'Synthetic refund preview customer', billing_email: 'synthetic-nectar-preview-1@example.test' })).id
  const charge = (await api('charge.add', { customer, amount: '2000', description: 'Synthetic taxable card-paid service', taxable: true, effective_date: '2026-10-20' })).charge
  const { id } = await api('invoice.manual', { customer, charges: [charge], service_date: '2026-10-20' })
  const preview = (amount, destination, status) => api('invoice.refund.preview', { invoice: id, amount, destination }, status)
  await api('invoice.approve', { invoice: id, acknowledge: true })
  await api('invoice.finalise', { invoice: id, issue_date: '2026-10-22' })
  assert.equal((await preview('1100', 'original', 409)).error, 'paid_invoice_required')
  await api('collection.customer.bind', { customer, account_ref: 'synthetic-nectar-native-account-1', stripe_customer_ref: 'synthetic-nectar-native-customer-1', confirm: true })
  assert.equal((await api('invoice.void', { invoice: id, basis: 'synthetic-nectar-stale', reason: 'Synthetic stale taxed void refusal', confirm: true }, 409)).error, 'source_changed')
  const collection = await api('collection.prepare', { invoice: id })
  await api('collection.confirm', collection.instructions.confirm)
  const original = await api(`invoices/${id}`), audit = await api('audit'), writes = [...edge.calls,...edge.native.calls].filter(call => call.method === 'POST').length, mails = h.mails.length
  assert.deepEqual([original.subtotal_cents, original.tax_cents, original.total_cents, original.balanceCents], [200000, 20000, 220000, 0])
  const cash = await preview('1100', 'original'), balance = await preview('1100', 'balance')
  assert.deepEqual(cash.reversing, { subtotalCents: 100000, taxCents: 10000, totalCents: 110000 })
  assert.deepEqual(balance.reversing, cash.reversing)
  assert.deepEqual(cash.effects, { owedBeforeCents: 0, owedAfterCents: 0, cashCents: -110000, customerBalanceCents: 0, revenueCents: -100000 })
  assert.deepEqual(balance.effects, { owedBeforeCents: 0, owedAfterCents: 0, cashCents: 0, customerBalanceCents: 110000, revenueCents: -100000 })
  assert.equal(cash.needsSecondApprover, true); assert.equal(balance.needsSecondApprover, true)
  assert.notEqual(cash.basis, balance.basis)
  assert.equal((await api('invoice.refund.prepare',{invoice:id,amount:'1100',destination:'original',basis:cash.basis,reason:'Synthetic taxed refund refusal'},409)).error,'invoice_refund_provider_tax_required')
  assert.deepEqual(cash.original, { totalCents: 220000, subtotalCents: 200000, taxCents: 20000, payment: original.allocations[0].payment_id, capture: edge.native.charges.values().next().value.value.id })
  const low = await preview('900', 'original')
  assert.equal(low.needsSecondApprover, false)
  assert.deepEqual(low.reversing, { subtotalCents: 81818, taxCents: 8182, totalCents: 90000 })
  for (const value of [cash, balance, low]) { assert.equal(value.executionAvailable, false); assert.equal(value.providerOutcome, 'not-attempted') }
  for (const [amount, destination, status, error] of [['2200.01','original',409,'exceeds_refundable_amount'],['0','balance',409,'exceeds_refundable_amount'],['1','another',400,'invalid_refund_destination']]) assert.equal((await preview(amount, destination, status)).error, error)
  const agent = { bearer: (await api('credential.issue', { name: 'Synthetic refund proposer', scopes: ['prepare'] })).key }
  const beforeAgent = await api('audit')
  assert.deepEqual(await h.api('invoice.refund.preview', agent, { invoice: id, amount: '1100', destination: 'original' }), cash)
  await h.api('invoice.refund.preview', undefined, { invoice: id, amount: '1', destination: 'original' }, 401)
  assert.deepEqual(await api('audit'), beforeAgent)
  assert.equal([...edge.calls,...edge.native.calls].filter(call => call.method === 'POST').length, writes)
  // The credential issue sends no mail; quoting never reserves a message.
  assert.equal(h.mails.length, mails)
  assert.deepEqual(await api(`invoices/${id}`), original)
  assert.deepEqual((await api(`customers/${customer}/balance`)).totalCents, 0)
  assert.equal(audit.some(row => row.action.startsWith('invoice.refund')), false)
  await applyPolicy(h, owner, 'credit.policy', { two_person_above: '1200' })
  const changed = await preview('1100', 'original')
  assert.equal(changed.needsSecondApprover, false); assert.notEqual(changed.basis, cash.basis)
  await invoiceRefundExecutionFlow(h,owner,{account:'synthetic-nectar-native-account-1',customerRef:'synthetic-nectar-native-customer-3',edge})
  console.log('INV-005 refund preview: exact independent tax and pretax effects, original-method and balance destinations, thresholds, source basis, refused inputs and no provider, ledger or mail writes passed')
}

export async function invoiceRefundExecutionFlow(h, owner, {account,customerRef,edge:processor,onState=async()=>{}}) {
  const api=(path,body,status)=>h.api(path,owner,body,status)
  const instant=processor?'2026-10-22T18:00:00Z':new Date().toISOString()
  await h.advanceClock(instant)
  const date=instant.slice(0,10), period=date.slice(0,7)
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Synthetic non-taxable refund proof'})
  await api('tax.review',{revision:(await api('business')).revision})
  await applyPolicy(h,owner,'credit.policy',{two_person_above:'1000'})
  await api('access.give',{email:'synthetic-nectar-refund-finance@example.test',name:'Synthetic refund approver',role:'finance'})
  const finance=await h.signIn('synthetic-nectar-refund-finance@example.test',{requested:true})
  await api('access.give',{email:'synthetic-nectar-refund-reader@example.test',name:'Synthetic refund accountant',role:'accountant'})
  const reader=await h.signIn('synthetic-nectar-refund-reader@example.test',{requested:true})
  const agent={bearer:(await api('credential.issue',{name:'Synthetic refund agent',scopes:['prepare']})).key}
  const customer=(await api('customer.create',{external_id:'synthetic-nectar-refund-1',name:'Synthetic card refund business',billing_email:'synthetic-nectar-refund-1@example.test'})).id
  await api('collection.customer.bind',{customer,account_ref:account,stripe_customer_ref:customerRef,confirm:true})
  const paid=async amount=>{
    const charge=(await api('charge.add',{customer,amount,description:'Synthetic refundable service',taxable:false,effective_date:date})).charge
    const {id}=await api('invoice.manual',{customer,charges:[charge],service_date:date})
    await api('invoice.approve',{invoice:id,acknowledge:true});await api('invoice.finalise',{invoice:id,issue_date:date})
    const request=await api('collection.prepare',{invoice:id});await api('collection.confirm',request.instructions.confirm)
    const invoice=await api(`invoices/${id}`);assert.equal(invoice.balanceCents,0);return invoice
  }
  const original=await paid('3000'),low=await paid('900'),uncertain=await paid('100')
  const quote=async(invoice,amount,destination)=>api('invoice.refund.preview',{invoice:invoice.id,amount,destination})
  const body=q=>({invoice:q.invoice,amount:String(q.amountCents/100),destination:q.destination,basis:q.basis,reason:'Synthetic customer correction',confirm:true})
  const q=await quote(original,'1500','original'), before=processor?.refunds.size
  await api('invoice.refund.execute',body(q),409)
  const saved=await api('invoice.refund.prepare',body(q))
  await api('invoice.refund.execute',{refund:saved.id,basis:saved.basis,confirm:true},409)
  for(const who of [agent,reader])for(const action of ['invoice.refund.prepare','invoice.refund.execute','invoice.refund.reconcile'])await h.api(action,who,body(q),403)
  assert.equal((await api(`invoices/${original.id}`)).balanceCents,0)
  if(processor)assert.equal(processor.refunds.size,before)
  await h.rejectAudit('invoice.refund.claim')
  await h.api('invoice.refund.execute',finance,{refund:saved.id,basis:saved.basis,confirm:true},500)
  await h.rejectAudit(null)
  if(processor)assert.equal(processor.refunds.size,before,'A failed claim audit cannot move cash')
  const cash=await h.api('invoice.refund.execute',finance,{refund:saved.id,basis:saved.basis,confirm:true})
  assert.equal(cash.status,'completed');assert.ok(cash.refundRef);assert.equal(cash.amountCents,150000)
  const afterCash=await api(`invoices/${original.id}`)
  const refunds=await api(`reports/refunds?period=${period}&customer=${customer}`)
  assert.equal(refunds.totalCents,-150000)
  const refundEntry=refunds.entries.find(row=>row.invoiceId===cash.id)
  assert.ok(refundEntry)
  const refundSource=await api(refundEntry.href.replace('/app/',''))
  assert.equal(refundSource.components.reduce((sum,row)=>sum+row.amountCents,0),-150000)
  const {csvRows}=await import('./financial-reports.mjs')
  const refundCsv=await h.raw(`/app/exports/reports/refunds.csv?period=${period}&customer=${customer}`,{cookie:owner})
  assert.equal(refundCsv.status,200)
  assert.deepEqual(csvRows(await refundCsv.text()).filter(row=>row.source!=='TOTAL').map(row=>Math.round(Number(row.amount.replace(/[^0-9.-]/g,''))*100)),[-150000])
  assert.deepEqual(afterCash.lines,original.lines);assert.deepEqual(afterCash.calculation,original.calculation)
  assert.deepEqual(afterCash.allocations,original.allocations);assert.equal(afterCash.balanceCents,0)
  assert.equal((await api(`customers/${customer}/balance`)).totalCents,0)
  const record=await api(`customers/${customer}`)
  const composed=record.billingRecord.refunds.find(row=>row.id===cash.id)
  assert.ok(composed);assert.equal(composed.refundRef,cash.refundRef);assert.equal(composed.cashAmountCents,-150000)
  assert.deepEqual((await api(`customers?search=${cash.refundRef}`)).map(row=>row.id),[customer])
  const credit=afterCash.credits.find(row=>row.id===cash.credit)
  assert.deepEqual([credit.amount_cents,credit.subtotal_cents,credit.tax_cents,credit.applied_cents],[150000,150000,0,0])
  await h.api('invoice.refund.execute',finance,{refund:saved.id,basis:saved.basis,confirm:true},409)
  assert.equal((await api('invoice.refund.reconcile',{refund:saved.id})).status,'completed')
  const bq=await quote(original,'1500','balance'), balanceRequest=await api('invoice.refund.prepare',body(bq))
  const balance=await h.api('invoice.refund.execute',finance,{refund:balanceRequest.id,basis:balanceRequest.basis,confirm:true})
  assert.equal(balance.status,'completed');assert.equal(balance.refundRef,null)
  assert.equal((await api(`customers/${customer}/balance`)).carriedCents,150000)
  assert.equal((await api(`reports/credit-balances?period=${period}&customer=${customer}`)).totalCents,150000)
  assert.equal((await api('invoice.refund.preview',{invoice:original.id,amount:'0.01',destination:'original'},409)).error,'exceeds_refundable_amount')
  const lowQuote=await quote(low,'900','original'), lowRefund=await api('invoice.refund.execute',body(lowQuote))
  assert.equal(lowRefund.status,'completed');assert.equal(lowRefund.preparedBy,lowRefund.approvedBy)
  const staleQuote=await quote(uncertain,'100','original'), stale=await api('invoice.refund.prepare',body(staleQuote))
  await applyPolicy(h,owner,'credit.policy',{two_person_above:'1001'})
  assert.equal((await api('invoice.refund.execute',{refund:stale.id,basis:stale.basis,confirm:true},409)).error,'invoice_refund_stale')
  const audit=(await api('audit')).filter(row=>row.action==='invoice.refund.complete'&&row.subject===cash.id)
  assert.equal(audit.length,1)
  assert.deepEqual([JSON.parse(audit[0].detail).preparedBy,JSON.parse(audit[0].detail).approvedBy],[h.vars.OWNER_EMAIL,'synthetic-nectar-refund-finance@example.test'])
  if(processor) {
    const uq=await quote(uncertain,'100','original'), request=await api('invoice.refund.prepare',body(uq))
    processor.loseNext()
    const lost=await api('invoice.refund.execute',{refund:request.id,basis:request.basis,confirm:true})
    assert.equal(lost.status,'uncertain')
    const writes=processor.refunds.size
    await api('invoice.refund.execute',{refund:request.id,basis:request.basis,confirm:true},409)
  await h.api('invoice.refund.execute',finance,{refund:request.id,basis:request.basis,confirm:true},409)
    const recovered=await api('invoice.refund.reconcile',{refund:request.id})
    assert.equal(recovered.status,'completed');assert.equal(processor.refunds.size,writes)
    assert.equal((await api('invoice.refund.reconcile',{refund:request.id})).credit,recovered.credit)
  }
  const final=await api(`invoices/${original.id}`)
  assert.deepEqual(final.credits.map(n=>n.amount_cents),[150000,150000])
  assert.equal(final.balanceCents,0);assert.equal(final.paidCents,300000)
  assert.equal((await api(`reports/tax?period=${period}&customer=${customer}`)).totalCents,0)
  await api('report.schedule',{enabled:true,day:5})
  const next=new Date(Date.UTC(Number(period.slice(0,4)),Number(period.slice(5,7)),5,18)).toISOString()
  await h.advanceClock(next)
  const tick=await h.raw(`/cdn-cgi/local/scheduled?time=${Date.parse(next)}&cron=${encodeURIComponent('0 14 * * *')}`)
  assert.equal(tick.status,200)
  const deliveries=(await api('report-schedule')).deliveries
  assert.equal(deliveries.length,1)
  const snapshot=await api(`report-deliveries/${deliveries[0].id}`)
  const cashSnapshot=snapshot.reports.find(row=>row.metric==='refunds')
  assert.equal(cashSnapshot.totalCents,processor?-250000:-240000)
  assert.equal(cashSnapshot.entries.filter(row=>row.sourceKind==='invoice_refund').length,processor?3:2)
  const source=snapshot.sourceEvidence.find(row=>row.metric==='refunds'&&row.detail.invoiceRefund?.id===cash.id)
  assert.ok(source);assert.equal(source.detail.totalCents,-150000)
    await onState({label:'refunded-and-balance-credited',id:original.id,owner})
  const later=next.slice(0,10)
  const futureCharge=(await api('charge.add',{customer,amount:'1800',description:'Synthetic later service',taxable:false,effective_date:later})).charge
  const future=await api('invoice.manual',{customer,charges:[futureCharge],service_date:later})
  await api('invoice.approve',{invoice:future.id,acknowledge:true});await api('invoice.finalise',{invoice:future.id,issue_date:later})
  const applied=await api(`invoices/${future.id}`)
  assert.equal(applied.balanceCents,30000)
  assert.deepEqual(applied.carriedApplications.map(row=>[row.credit_id,row.amount_cents]),[[balance.credit,150000]])
  assert.equal((await api(`customers/${customer}/balance`)).carriedCents,0)
  await api('invoice.finalise',{invoice:future.id,issue_date:later},409)
  assert.deepEqual((await api(`invoices/${future.id}`)).carriedApplications,applied.carriedApplications)
  await invoiceRefundCorrectionFlow(h,owner,{invoice:await paid('3000'),customer,finance,reader,agent,processor,onState})
  const erasure=await api('erasure.request',{customer})
  const link=h.mails.at(-1).text.match(/https?:\/\/[^\s"<]+\/erase\/[a-f0-9]{64}/)[0]
  assert.equal((await h.raw(new URL(link).pathname,{form:new URLSearchParams({confirm:'yes'})})).status,200)
  await api('erasure.approve',{request:erasure.id,confirm:true})
  await api('invoice.refund.reconcile',{refund:cash.id},404)
  await h.assertStorageExcludes(['Synthetic source-bound correction','Synthetic reviewed invoice refund'])
  assert.deepEqual((await api(`invoices/${original.id}`)).refunds.map(row=>[row.amountCents,row.cashAmountCents,row.destination]).sort((a,b)=>a[2].localeCompare(b[2])),[[150000,0,'balance'],[150000,-150000,'original']])
  console.log('INV-005 card refund and balance credit: exact half allocations, immutable originals, independent approval, low direct execution, refusal, stale, replay and cash custody passed')
  return {customer,invoice:original.id,cash,balance,low:lowRefund,original}
}

// The existing refund journey also drives the ordinary agent and human review doors.
async function invoiceRefundCorrectionFlow(h,owner,{invoice,customer,finance,reader,agent,processor,onState}) {
  const api=(path,body,status)=>h.api(path,owner,body,status), detail=id=>api(`proposals/${id}`)
  const closedPeriod=invoice.issue_date.slice(0,7), text=async path=>(await h.raw(path,{cookie:owner})).text()
  await api('revenue.close',{period:closedPeriod})
  const closedPacket=await api(`period-closes/${closedPeriod}`), closedRevenue=await text(`/app/exports/revenue.csv?period=${closedPeriod}`), closedJournal=await text(`/app/exports/revenue-journal.csv?period=${closedPeriod}`)
  const line=invoice.lines[0], recipient=(await api(`customers/${customer}`)).billing_email
  const payload={invoice_refund:true,invoice:invoice.id,amount:'1500',destination:'original',reason:'Synthetic source-bound correction',
    explanation:'The cited $3,000 service was reduced by $1,500; original tax is $0 and reversing tax is $0.',
    subject:'Synthetic reviewed invoice refund',body:'The cited $3,000 service was reduced by $1,500. A $1,500 original-method refund reduces revenue by $1,500. Tax remains $0. The issued invoice remains unchanged.',
    citations:[{line_id:line.id,source:`/app/invoices/${invoice.id}/lines/${line.id}`,quote:line.description}]}
  const propose=(value=payload,status=200)=>h.api('proposal.create',agent,{kind:'amendment',title:payload.reason,payload:value},status)
  const decide=(id,who=owner,status=200)=>h.api('proposal.decide',who,{proposal:id,decision:'approved'},status)
  const mails=()=>h.mails.filter(m=>m.subject===payload.subject)
  const beforePosts=processor?.calls.filter(c=>c.method==='POST').length??0
  const before=await api(`invoices/${invoice.id}`)
  await propose({...payload,recipient:'synthetic-nectar-foreign@example.test'},400)
  await propose({...payload,citations:[{...payload.citations[0],source:'/app/invoices/synthetic-nectar-foreign/lines/synthetic-nectar-foreign'}]},400)
  await propose({...payload,citations:[{...payload.citations[0],quote:'Synthetic absent source wording'}]},400)
  const rejected=await propose()
  await api('proposal.decide',{proposal:rejected.id,decision:'rejected'})
  await api('invoice.refund.prepare',{proposal:rejected.id},409)
  assert.equal((await detail(rejected.id)).correctionMail,null)
  const stale=await propose(), customerBefore=await api(`customers/${customer}`)
  await api('customer.update',{...customerBefore,customer,billing_email:'synthetic-nectar-new@example.test'})
  await api('invoice.refund.prepare',{proposal:stale.id},409)
  assert.equal((await detail(stale.id)).stale,true)
  await api('customer.update',{...await api(`customers/${customer}`),customer,billing_email:recipient})
  // Case-linked financial approval must still hold its proposer and assignee authority.
  await api('meter.create',{code:'synthetic-nectar-refund-events',name:'Synthetic refund events',unit_label:'events'})
  const product=(await api('product.create',{code:'synthetic-nectar-refund-source',name:'Synthetic refund source'})).id
  const price=(await api('price.create',{product,kind:'unit',meter:'synthetic-nectar-refund-events',unit_amount:'1'})).id
  const subscription=(await api('subscription.create',{customer,start_date:invoice.issue_date,price:[price],quantity:['']})).id
  await api('usage.control',{customer,meter:'synthetic-nectar-refund-events',day:invoice.issue_date,expected_count:1,expected_quantity:'1'})
  const ownerId=(await api('me')).id, financeId=(await h.api('me',finance)).id
  await api('assurance.scan',{period:closedPeriod,owner:ownerId})
  const sourceCase=(await api('assurance-cases')).find(row=>row.customer_id===customer&&row.kind==='usage_source_control')
  assert.ok(sourceCase,'A real source mismatch supplies the case link')
  const foreignCustomer=(await api('customer.create',{external_id:'synthetic-nectar-refund-case-foreign',name:'Synthetic separate case customer',billing_email:'synthetic-nectar-refund-case-foreign@example.test'})).id
  const foreignSubscription=(await api('subscription.create',{customer:foreignCustomer,start_date:invoice.issue_date,price:[price],quantity:['']})).id
  await api('usage.control',{customer:foreignCustomer,meter:'synthetic-nectar-refund-events',day:invoice.issue_date,expected_count:1,expected_quantity:'1'})
  await api('assurance.scan',{period:closedPeriod,owner:ownerId})
  const foreignCase=(await api('assurance-cases')).find(row=>row.customer_id===foreignCustomer&&row.kind==='usage_source_control')
  assert.ok(foreignCase)
  assert.equal((await h.api('proposal.create',agent,{assurance_case:foreignCase.id,kind:'amendment',title:payload.reason,payload:{...payload,subscription:foreignSubscription}},409)).error,'assurance_fix_customer_mismatch','A case cannot authorize another customer invoice refund')
  const refusalResults=[]
  for(const change of ['credential-revoked','case-reassigned']) {
    const name='Synthetic refund authority '+change
    const credential=await api('credential.issue',{name,scopes:['prepare']})
    const proposer={bearer:credential.key}
    const linked=await h.api('proposal.create',proposer,{assurance_case:sourceCase.id,kind:'amendment',title:payload.reason,payload:{...payload,subscription}})
    const request=await api('invoice.refund.prepare',{proposal:linked.id})
    const frozen={invoice:await api(`invoices/${invoice.id}`),balance:await api(`customers/${customer}/balance`),mails:h.mails.length,posts:processor?.calls.filter(c=>c.method==='POST').length??0}
    if(change==='credential-revoked') {
      const key=(await api('credentials')).find(row=>row.name===name)
      await api('credential.revoke',{key:key.id})
    } else await api('assurance.assign',{case:sourceCase.id,owner:financeId})
    const response=await h.raw('/api/nectar/proposal.decide',{cookie:finance,body:{proposal:linked.id,decision:'approved'}})
    const result=await response.json()
    refusalResults.push([change,response.status,result.error])
    if(response.status===409) {
      assert.equal((await detail(linked.id)).status,'pending')
      assert.equal((await detail(linked.id)).refundRequest.status,'pending')
      assert.equal((await detail(linked.id)).correctionMail,null)
      assert.deepEqual(await api(`invoices/${invoice.id}`),frozen.invoice)
      assert.deepEqual(await api(`customers/${customer}/balance`),frozen.balance)
      assert.equal(h.mails.length,frozen.mails)
      assert.equal(processor?.calls.filter(c=>c.method==='POST').length??0,frozen.posts)
      assert.equal((await api('audit')).some(row=>row.action==='invoice.refund.claim'&&row.subject===request.id),false)
      await api('proposal.decide',{proposal:linked.id,decision:'rejected'})
    }
    await api('assurance.assign',{case:sourceCase.id,owner:ownerId})
  }
  assert.deepEqual(refusalResults,[
    ['credential-revoked',409,'assurance_proposer_unavailable'],
    ['case-reassigned',409,'assurance_case_changed'],
  ],'Both changed-authority sequences refuse without claiming or adjusting the refund')
  console.log('INV-005 case-linked refund current-authority refusals passed')
  const beforeReview=await api(`invoices/${invoice.id}`)
  const proposed=await h.api('proposal.create',agent,{assurance_case:sourceCase.id,kind:'amendment',title:payload.reason,payload:{...payload,subscription}}), saved=await detail(proposed.id)
  assert.deepEqual(saved.impact.refund.original,{totalCents:300000,subtotalCents:300000,taxCents:0,payment:invoice.allocations[0].payment_id,capture:saved.impact.refund.original.capture})
  assert.deepEqual(saved.impact.refund.reversing,{totalCents:150000,subtotalCents:150000,taxCents:0})
  assert.deepEqual(saved.impact.refund.effects,{owedBeforeCents:0,owedAfterCents:0,cashCents:-150000,customerBalanceCents:0,revenueCents:-150000})
  assert.equal(saved.impact.mail.recipient,recipient)
  assert.equal(saved.impact.mail.body,payload.body)
  assert.deepEqual(saved.impact.mail.citations,payload.citations)
  assert.deepEqual(await api(`invoices/${invoice.id}`),beforeReview)
  assert.equal(mails().length,0)
  assert.equal(processor?.calls.filter(c=>c.method==='POST').length??0,beforePosts)
  await onState({label:'refund-correction-pending',id:proposed.id,kind:'proposal',owner})
  await decide(proposed.id,owner,409)
  for(const who of [agent,reader]) {
    await h.api('invoice.refund.prepare',who,{proposal:proposed.id},403)
    await decide(proposed.id,who,403)
  }
  const request=await api('invoice.refund.prepare',{proposal:proposed.id})
  await api('invoice.refund.prepare',{proposal:proposed.id},409)
  await api('invoice.refund.execute',{refund:request.id,basis:request.basis,confirm:true},409)
  await decide(proposed.id,owner,409)
  assert.equal((await detail(proposed.id)).correctionMail,null)
  await h.rejectAudit('invoice.refund.claim')
  await decide(proposed.id,finance,500)
  await h.rejectAudit(null)
  assert.equal((await detail(proposed.id)).status,'pending')
  assert.equal(mails().length,0)
  assert.equal(processor?.calls.filter(c=>c.method==='POST').length??0,beforePosts)
  // A crash after the cash write must not separate the local credit from its mail.
  if(processor) await h.rejectAudit('invoice.refund.complete')
  const approved=await decide(proposed.id,finance)
  if(processor) {
    assert.equal((await detail(proposed.id)).status,'approved')
    assert.equal((await detail(proposed.id)).correctionMail,null)
    assert.equal((await api(`invoices/${invoice.id}`)).credits.length,0)
    assert.equal(mails().length,0)
    await h.rejectAudit(null)
    const recovered=await api('invoice.refund.reconcile',{refund:approved.refund})
    assert.equal(recovered.status,'completed')
    assert.equal(processor.calls.filter(c=>c.method==='POST').length,beforePosts+1)
  }
  const completed=await detail(proposed.id), after=await api(`invoices/${invoice.id}`)
  assert.equal(completed.correctionMail.status,'accepted')
  assert.equal(completed.correctionMail.credit_id,after.credits[0].id)
  assert.equal(completed.correctionMail.body,payload.body)
  assert.equal(completed.correctionMail.recipient,recipient)
  assert.deepEqual(JSON.parse(completed.correctionMail.citations_json),payload.citations)
  assert.equal(mails().length,1)
  assert.equal(mails()[0].text,payload.body)
  assert.deepEqual(after.lines,before.lines)
  assert.deepEqual([after.subtotal_cents,after.tax_cents,after.total_cents,after.balanceCents],[300000,0,300000,0])
  assert.deepEqual(after.credits.map(c=>c.amount_cents),[150000])
  await decide(proposed.id,finance,409)
  await api('invoice.refund.reconcile',{refund:approved.refund})
  assert.equal(mails().length,1)
  assert.deepEqual(await api(`period-closes/${closedPeriod}`),closedPacket)
  assert.equal(await text(`/app/exports/revenue.csv?period=${closedPeriod}`),closedRevenue)
  assert.equal(await text(`/app/exports/revenue-journal.csv?period=${closedPeriod}`),closedJournal)
  const revenue=await api(`revenue/${invoice.id}`)
  assert.deepEqual(revenue.contributions.filter(c=>c.kind.startsWith('credit')).map(c=>[c.kind,c.period,c.amountCents]),[['credit-billing',closedPacket.open,-150000],['credit-recognition',closedPacket.open,-150000]])
  await onState({label:'refund-correction-completed',id:proposed.id,kind:'proposal',owner})
  const balanceBefore=(await api(`customers/${customer}/balance`)).carriedCents
  const low=await propose({...payload,amount:'900',destination:'balance',body:'A reviewed $900 balance credit; cash does not change.'})
  const lowRequest=await api('invoice.refund.prepare',{proposal:low.id})
  h.mailResponses.push({status:500,body:{name:'synthetic_provider_uncertain'}})
  const lowResult=await decide(low.id,owner)
  assert.equal(lowResult.refund,lowRequest.id)
  assert.equal((await detail(low.id)).refundRequest.status,'completed')
  assert.equal((await detail(low.id)).correctionMail.status,'uncertain')
  assert.equal((await api(`customers/${customer}/balance`)).carriedCents,balanceBefore+90000)
  await api('invoice.refund.reconcile',{refund:lowRequest.id})
  assert.equal(mails().length,2,'Reconciliation never retries an uncertain customer message')
  if(processor) {
    const late=await propose({...payload,amount:'100',subject:'Synthetic refund recipient race'})
    await api('invoice.refund.prepare',{proposal:late.id})
    const held=processor.pauseNext(), pending=decide(late.id)
    await held.arrived
    try { await api('customer.update',{...await api(`customers/${customer}`),customer,billing_email:'synthetic-nectar-changed@example.test'}) }
    finally { held.release() }
    const result=await pending
    assert.equal((await detail(late.id)).refundRequest.status,'completed')
    assert.equal((await detail(late.id)).correctionMail.status,'suppressed')
    assert.equal(h.mails.filter(m=>m.subject==='Synthetic refund recipient race').length,0)
    await api('invoice.refund.reconcile',{refund:result.refund})
    assert.equal(h.mails.filter(m=>m.subject==='Synthetic refund recipient race').length,0)
    assert.ok((await api('audit')).some(row=>row.subject===late.id&&JSON.parse(row.detail).reason==='refund_recipient_changed'))
    await onState({label:'refund-correction-suppressed',id:late.id,kind:'proposal',owner})
    await api('customer.update',{...await api(`customers/${customer}`),customer,billing_email:recipient})
  }
  console.log('INV-005 refund correction: cited exact preview, refusal and rejection, human preparation, independent approval, recipient staleness, audit rollback, atomic credit and frozen mail, and once-only reconciliation passed')
}
