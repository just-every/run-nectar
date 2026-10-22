import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { nativeCollectionEdge } from './native-collection.mjs'
import { applyPolicy } from './policy-helper.mjs'
import { csvRows } from './financial-reports.mjs'

// Original charge/payment proof is the existing native collector's real path.
// Only Stripe's refund network endpoints and response timing are synthetic.
export function prepaidRefundEdge(){
  const native=nativeCollectionEdge(),refunds=new Map(),transactions=new Map(),calls=[],keys=new Set()
  let lose=false,fail=false,visible=true,hold=null,created=Date.parse('2026-11-02T18:00:00Z')/1000
  const fetch=async request=>{
    const url=new URL(request.url),path=url.pathname.replace('/v1',''),account=request.headers.get('authorization')==='Bearer synthetic-nectar-2'?2:1
    if(path.startsWith('/charges/')&&request.method==='GET'){const row=native.charges.get(path.split('/').at(-1));return row?.account===account?Response.json(row.value):Response.json({},{status:404})}
    if(path.startsWith('/balance_transactions/')&&request.method==='GET'){const row=transactions.get(path.split('/').at(-1));return row?.account===account?Response.json(row.value):Response.json({},{status:404})}
    if(path==='/refunds'&&request.method==='POST'){
      const form=new URLSearchParams(await request.text()),key=request.headers.get('Idempotency-Key')
      calls.push({method:'POST',path,account,form:Object.fromEntries(form),key})
      assert.ok(key&&!keys.has(key),'Every durable refund request sends one create only');keys.add(key)
      assert.equal(form.get('instructions_email'),null);assert.equal(form.get('receipt_email'),null)
      if(hold){const waiting=hold;hold=null;waiting.arrived();await waiting.release}
      const source=native.charges.get(form.get('charge'));assert.equal(source.account,account)
      const amount=Number(form.get('amount'));assert.ok(amount>0&&amount<=source.value.amount_captured-source.value.amount_refunded)
      const id=`synthetic-nectar-refund-${refunds.size+1}`,balance=`synthetic-nectar-refund-transaction-${refunds.size+1}`,failed=fail;fail=false
      const refund={object:'refund',id,amount,currency:'usd',charge:source.value.id,payment_intent:source.value.payment_intent,status:failed?'failed':'succeeded',created,balance_transaction:failed?null:balance,
        metadata:Object.fromEntries([...form].filter(([name])=>name.startsWith('metadata[')).map(([name,value])=>[name.slice(9,-1),value]))}
      refunds.set(id,{account,value:refund})
      if(!failed){source.value.amount_refunded+=amount;source.value.refunded=source.value.amount_refunded===source.value.amount_captured;transactions.set(balance,{account,value:{object:'balance_transaction',id:balance,type:'refund',amount:-amount,currency:'usd',source:id,status:'available'}})}
      if(lose){lose=false;return new Response(null,{status:503})}
      return Response.json(refund)
    }
    if(path==='/refunds'&&request.method==='GET'){
      calls.push({method:'GET',path,account})
      return Response.json({object:'list',has_more:false,data:visible?[...refunds.values()].filter(row=>row.account===account&&row.value.charge===url.searchParams.get('charge')).map(row=>row.value):[]})
    }
    if(path.startsWith('/refunds/')&&request.method==='GET'){calls.push({method:'GET',path,account});const row=refunds.get(path.split('/').at(-1));return row?.account===account?Response.json(row.value):Response.json({},{status:404})}
    return native.fetch(request)
  }
  return {fetch,native,calls,refunds,loseNext(){lose=true},failNext(){fail=true},visible(value){visible=value},at(value){created=Date.parse(value)/1000;native.capturedAt(value)},pauseNext(){let arrived,release;const seen=new Promise(resolve=>arrived=resolve),wait=new Promise(resolve=>release=resolve);hold={arrived,release:wait};return {arrived:seen,release}}}
}
let edge=prepaidRefundEdge()
export const harnessOptions=()=>{edge=prepaidRefundEdge();return {stripeFetch:edge.fetch,stripeSecret:'synthetic-nectar-1',stripeSecondarySecret:'synthetic-nectar-2'}}
export async function prepaidRefundFlow(h,owner,{onState=async()=>{},onTypedState=async()=>{},onSharedState=async()=>{},approveRefund,reconcileRefund}={}){
  const api=(path,body,status)=>h.api(path,owner,body,status),refundPosts=()=>edge.calls.filter(call=>call.method==='POST').length
  await h.advanceClock('2026-11-01T18:00:00Z');edge.at('2026-11-01T18:00:00Z')
  await api('business.configure',{...await api('business'),timezone:'UTC'})
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Synthetic unused paid refund'})
  await api('tax.review',{revision:(await api('business')).revision})
  await api('access.give',{email:'synthetic-nectar-601@example.test',name:'Synthetic refund finance',role:'finance'})
  const finance=await h.signIn('synthetic-nectar-601@example.test',{requested:true}),agent={bearer:(await api('credential.issue',{name:'Synthetic refund observer',scopes:['prepare']})).key}
  const readers=[]
  for(const [index,role] of ['support','accountant','collections','developer'].entries()){
    const email=`synthetic-nectar-${650+index}@example.test`
    await api('access.give',{email,name:`Synthetic refund ${role}`,role})
    readers.push({role,who:await h.signIn(email,{requested:true})})
  }
  await api('access.give',{email:'synthetic-nectar-654@example.test',name:'Synthetic refund sales',role:'sales'})
  const sales=await h.signIn('synthetic-nectar-654@example.test',{requested:true})
  const support=readers.find(reader=>reader.role==='support').who
  const typedRefund=async(row,refund,status,{erased=false}={})=>{
    const results=[]
    for(const {role,who} of [...readers,{role:'agent',who:agent},...(erased?[{role:'owner',who:owner},{role:'finance',who:finance}]:[])]){
      const facts=(await h.api(`prepaid/refunds?subscription=${row.subscription}`,who)).find(fact=>fact.id===refund.id)
      assert.ok(facts,`${role} reads each refund lifecycle`)
      assert.equal(facts.status,status);assert.equal(facts.invoice,row.invoice);assert.equal(facts.payment,refund.quote?.payment??facts.payment)
      assert.deepEqual([facts.amountN,facts.amountCents,facts.kind],row.n===2?[2500000,83,'units']:[6000,6000,'money'])
      assert.equal(facts.reasonCategory,'unused_paid_credit');assert.ok(facts.preparedBy);assert.ok(facts.preparedAt)
      if(!['pending'].includes(status)){assert.ok(facts.approvedBy);assert.ok(facts.approvedAt)}
      if(['uncertain','refunded','failed','claimed'].includes(status))assert.equal(facts.approvalMode,'two-person')
      if(status==='refunded'){assert.ok(facts.refundRef);assert.ok(facts.creditNumber);assert.ok(facts.refundedOn);assert.equal(facts.liabilityCents,-facts.amountCents);assert.equal(facts.cashAmountCents,-facts.amountCents);assert.equal(facts.recognitionCents,0)}
      for(const key of ['quote','reason','proof','basis','quote_json','proof_json'])assert.equal(Object.hasOwn(facts,key),false,`${role} receives typed facts only`)
      if(role!=='agent'){
        const page=await h.page(`/app/prepaid/refunds/${refund.id}`,who)
        assert.ok(page.includes(refund.id));assert.ok(page.includes(status))
        assert.ok(!page.includes('Synthetic unused paid service returned to its original card'))
        assert.doesNotMatch(page,/succeeded-refund-and-balance-debit|paymentMethodRef|chargeRef/)
      }
      results.push(facts)
    }
    assert.ok(results.every(facts=>JSON.stringify(facts)===JSON.stringify(results[0])),'All typed readers share one financial projection')
    await onTypedState({label:`typed-${erased?'erased-':''}${status}`,row,refund,readers,finance})
    return results[0]
  }
  const product=(await api('product.create',{code:'synthetic-nectar-602',name:'Synthetic refund service'})).id
  const meter=(await api('meter.create',{code:'synthetic-nectar-603',name:'Synthetic refund units',unit_label:'units'})).id
  const price=(await api('price.create',{product,meter,kind:'unit',unit_amount:'2',taxable:false,billing_interval:'daily',billing_timing:'arrears'})).id
  const entities=[]
  for(let n=1;n<=2;n++)entities.push((await api('entity.create',{revision:(await api('business')).revision,legal_name:`Synthetic refund entity ${n}`,address:`${n} Synthetic Way`,ein:`${20+n}-3456789`,invoice_prefix:`REFUND${n}`,invoice_number_width:4,payment_terms_days:30,processor_account_ref:`synthetic-nectar-native-account-${n}`,ledger_company_ref:`synthetic-nectar-refund-ledger-${n}`,tax_registration:'Synthetic tax registration'})).id)
  const rows=[]
  const usage=(row,id,quantity,date)=>api('usage.submit',{events:[{event_id:`synthetic-nectar-${id}`,customer:row.external,meter:'synthetic-nectar-603',quantity,occurred_at:`${date}T12:00:00Z`}]})
  const issue=async row=>{
    const run=await api('billrun.prepare',{period:'2026-11'}),invoices=(await api(`runs/${run.id}`)).invoices.filter(invoice=>invoice.subscription_id===row.subscription&&invoice.period_end<='2026-11-02')
    for(const invoice of invoices){await api('invoice.approve',{invoice:invoice.id,acknowledge:true});await api('invoice.finalise',{invoice:invoice.id,issue_date:'2026-11-02'})}
    return Promise.all(invoices.map(invoice=>api(`invoices/${invoice.id}`)))
  }
  for(let n=1;n<=4;n++){
    const external=`synthetic-nectar-${610+n}`,customer=(await api('customer.create',{external_id:external,name:`Synthetic refund ${n}`,billing_email:`${external}@example.test`})).id
    await api('customer.entity',{revision:(await api('business')).revision,customer,entity:entities[n===2?1:0],confirm:true})
    const subscription=(await api('subscription.create',{customer,start_date:'2026-11-01',price:[price]})).id,row={customer,subscription,external,n};rows.push(row)
    const grant=await api('prepaid.prepare',{subscription,mode:'grant',kind:n===2?'units':'money',source:'purchase',amount:n===2?'3':'100',...(n===2?{meter,purchase_amount:'1'}:{}),effective_date:'2026-11-01',expires_date:'2027-01-01',priority:10,expiry_consent:true})
    await h.api('prepaid.decide',finance,{request:grant.request,decision:'approved'})
    row.invoice=(await api('prepaid.purchase.prepare',{intent:grant.request,issue_date:'2026-11-01'})).invoice
    await api('invoice.approve',{invoice:row.invoice,acknowledge:true});await api('invoice.finalise',{invoice:row.invoice,issue_date:'2026-11-01'})
    if(n===4){const payment=await api('payment.record',{customer,amount:'100',received_on:'2026-11-01',method:'bank_transfer',reference:'synthetic-nectar-620'});await api('payment.allocate',{payment:payment.payment,invoice:row.invoice,amount:'100'});await api('prepaid.funding.confirm',{intent:grant.request,confirm:true})}
    else{
      await api('collection.customer.bind',{customer,account_ref:`synthetic-nectar-native-account-${n===2?2:1}`,stripe_customer_ref:`synthetic-nectar-native-customer-${n}`,confirm:true})
      const prepared=await api('collection.prepare',{invoice:row.invoice});await api('collection.confirm',prepared.instructions.confirm)
    }
    row.original=await api(`invoices/${row.invoice}`)
  }
  // Finish all four purchases before usage makes any daily billing due.
  for(const row of rows)await usage(row,620+row.n,row.n===2?'0.5':'20','2026-11-01')
  await h.advanceClock('2026-11-02T18:00:00Z');edge.at('2026-11-02T18:00:00Z')
  for(const row of rows){row.service=(await issue(row))[0];const state=await api(`prepaid/${row.subscription}`);row.grant=state.grants[0].id;row.before=state}
  await api('prepaid.refund.prepare',{grant:rows[3].grant,reason:'Unverified bank receipt cannot be a card refund'},409)
  for(const who of [finance,support,agent])await h.api('prepaid.refund.prepare',who,{grant:rows[0].grant,reason:'Unauthorized'},403)
  const prepare=row=>api('prepaid.refund.prepare',{grant:row.grant,reason:'Synthetic unused paid service returned to its original card'})
  const first=await prepare(rows[0]);await onState({label:'prepared',rows,refund:first});assert.deepEqual([first.quote.amountN,first.quote.amountCents],[6000,6000])
  await typedRefund(rows[0],first,'pending')
  const financePending=(await h.api(`prepaid/refunds?subscription=${rows[0].subscription}`,finance)).find(row=>row.id===first.id)
  assert.deepEqual(financePending.quote,first.quote);assert.equal(financePending.reason,first.reason);assert.equal(Object.hasOwn(financePending,'proof'),false)
  assert.deepEqual(await api(`prepaid/${rows[0].subscription}`),rows[0].before,'Preparing a refund reserves no balance and changes no ledger')
  await api('prepaid.refund.decide',{refund:first.id,basis_hash:first.basis,decision:'approved'},409)
  await h.api('prepaid.refund.decide',agent,{refund:first.id,basis_hash:first.basis,decision:'approved'},403)
  const paused=edge.pauseNext(),approval=approveRefund?approveRefund({row:rows[0],refund:first,finance}):h.api('prepaid.refund.decide',finance,{refund:first.id,basis_hash:first.basis,decision:'approved'})
  await Promise.race([paused.arrived,approval.then(()=>assert.fail('Approval must reach the held network edge before completing'))])
  try{
    await onState({label:'held',rows,refund:first})
    await usage(rows[0],630,'5','2026-11-02')
    const upcoming=await api(`subscriptions/${rows[0].subscription}/upcoming?period=2026-11`)
    const next=(upcoming.invoices??[upcoming]).find(invoice=>invoice.billingDueDate==='2026-11-03')
    assert.equal(next.calculation.totalCents,1000,'Usage cannot spend credits reserved by an in-flight refund')
  }finally{paused.release()}
  const refunded=await approval
  await onState({label:'refunded',rows,refund:refunded})
  await typedRefund(rows[0],first,'refunded')
  for(const {role,who} of [...readers,{role:'agent',who:agent}]){
    const sharedInvoice=await h.api(`invoices/${rows[0].invoice}`,who)
    assert.equal(sharedInvoice.credits.find(credit=>credit.id===refunded.credit).reason,'unused_paid_credit',`${role} invoice credit has only a typed reason category`)
    const sharedCustomer=await h.api(`customers/${rows[0].customer}`,who)
    assert.equal(sharedCustomer.ledger.credits.find(credit=>credit.id===refunded.credit).reason,'unused_paid_credit',`${role} customer credit has only a typed reason category`)
    if(role!=='agent')for(const path of [`/app/invoices/${rows[0].invoice}`,`/app/customers/${rows[0].customer}`])assert.ok(!(await h.page(path,who)).includes(first.reason),`${role} shared page excludes private refund narrative`)
  }
  assert.equal((await h.api(`customers/${rows[0].customer}`,sales)).ledger.credits.find(credit=>credit.id===refunded.credit).reason,'unused_paid_credit')
  assert.ok(!(await h.page(`/app/customers/${rows[0].customer}`,sales)).includes(first.reason))
  await h.api(`invoices/${rows[0].invoice}`,sales,undefined,403)
  assert.equal((await h.api(`prepaid/refunds?subscription=${rows[0].subscription}`,finance)).find(row=>row.id===first.id).reason,first.reason,'Finance keeps private request narrative')
  await onSharedState({row:rows[0],refund:refunded,readers,sales})
  for(const who of [support,agent]){
    const auth=typeof who==='string'?{cookie:who}:who
    for(const id of [first.id,'unavailable'])assert.equal((await h.raw(`/app/prepaid/refunds/${id}/proof`,auth)).status,403)
  }
  const proof=await h.raw(`/app/prepaid/refunds/${first.id}/proof`,{cookie:finance})
  assert.equal(proof.status,200);assert.match(proof.headers.get('content-type'),/^application\/json/);assert.match(proof.headers.get('content-disposition'),/^attachment;/)
  assert.equal(proof.headers.get('cache-control'),'no-store');assert.equal(proof.headers.get('x-content-type-options'),'nosniff')
  const proofBytes=Buffer.from(await proof.arrayBuffer()),proofAudit=(await api('audit')).filter(row=>row.action==='prepaid.refund.proof.download'&&row.subject===first.id).at(-1)
  assert.ok(proofAudit);assert.equal(proofAudit.actor,'synthetic-nectar-601@example.test')
  assert.deepEqual(JSON.parse(proofAudit.detail),{request:first.id,sha256:createHash('sha256').update(proofBytes).digest('hex'),size:proofBytes.length})
  assert.equal(JSON.parse(proofBytes.toString()).proof,'succeeded-refund-and-balance-debit')
  const accountant=readers.find(reader=>reader.role==='accountant').who
  const lifecycleCsv=await h.raw(`/app/exports/prepaid-refunds.csv?subscription=${rows[0].subscription}`,{cookie:accountant});assert.equal(lifecycleCsv.status,200)
  const lifecycleText=await lifecycleCsv.text(),lifecycle=csvRows(lifecycleText).find(row=>row.id===first.id)
  assert.ok(lifecycle);assert.equal(lifecycle.preparedBy,first.preparedBy);assert.equal(lifecycle.approvedBy,financePending.approvedBy??(await h.api(`prepaid/refunds?subscription=${rows[0].subscription}`,accountant)).find(row=>row.id===first.id).approvedBy);assert.equal(lifecycle.approvalMode,'two-person')
  assert.doesNotMatch(lifecycleText,/Synthetic unused paid service returned to its original card|chargeRef|paymentMethodRef|succeeded-refund-and-balance-debit/)
  assert.equal(refunded.status,'refunded');assert.equal(refunded.cashAmountCents,-6000);assert.ok(refunded.credit)
  assert.equal(refundPosts(),1)
  await h.api('prepaid.refund.decide',finance,{refund:first.id,basis_hash:first.basis,decision:'approved'},409)
  assert.equal((await api('prepaid.refund.reconcile',{refund:first.id})).status,'refunded');assert.equal(refundPosts(),1)
  const state=await api(`prepaid/${rows[0].subscription}`),entry=state.entries.find(entry=>entry.kind==='refund')
  assert.deepEqual([entry.amountN,entry.liabilityCents,entry.recognitionCents],[-6000,-6000,0]);assert.equal(state.balances[0].remainingN,0)
  for(const original of rows[0].before.entries)assert.deepEqual(state.entries.find(entry=>entry.id===original.id),original)
  const invoice=await api(`invoices/${rows[0].invoice}`)
  assert.deepEqual(invoice.calculation,rows[0].original.calculation);assert.equal(invoice.balanceCents,0)
  const credit=invoice.credits.find(credit=>credit.id===refunded.credit)
  assert.equal(credit.amount_cents,6000);assert.equal(credit.tax_cents,0);assert.equal(credit.applied_cents,0)
  const revenue=await api(`revenue?period=2026-11&customer=${rows[0].customer}`)
  assert.deepEqual([revenue.netBillingsCents,revenue.recognizedCents,revenue.closingCents],[4000,4000,0])
  const cash=await api(`reports/refunds?period=2026-11&customer=${rows[0].customer}`);assert.equal(cash.totalCents,-6000)
  const cashSource=await api(`reports/refunds/${refunded.id}?period=2026-11&customer=${rows[0].customer}`)
  assert.equal(cashSource.components.reduce((sum,part)=>sum+part.amountCents,0),-6000)
  assert.equal(cashSource.refund.liability.recognitionCents,0);assert.equal(cashSource.refund.credit.purpose,'paid-liability-cash-refund')
  assert.equal((await api(`reports/credits?period=2026-11&customer=${rows[0].customer}`)).totalCents,0,'Returned cash is not a second customer credit')
  const exported=await h.raw(`/app/exports/reports/refunds.csv?period=2026-11&customer=${rows[0].customer}`,{cookie:owner});assert.equal(exported.status,200)
  assert.ok(csvRows(await exported.text()).some(row=>row.source_reference===refunded.id))
  await api('portal.configure',{hosts:[h.origin],parents:[]})
  for(const language of ['en','es-US']){
    const customer=await api(`customers/${rows[0].customer}`)
    await api('customer.update',{customer:customer.id,revision:customer.revision,name:customer.name,billing_email:customer.billing_email,address:customer.address,language})
    const session=await api('portal.session.issue',{customer:customer.id,origin:h.origin,audience:'hosted'})
    const dataResponse=await h.raw(`/portal/prepaid/data?session=${encodeURIComponent(session.token)}`)
    assert.equal(dataResponse.status,200)
    const lots=(await dataResponse.json()).lots,lot=lots.find(lot=>lot.id===`prepaid-${rows[0].grant}`)
    assert.deepEqual([lot.remainingN,lot.availableN,lot.liabilityCents],[0,0,0])
    assert.deepEqual(lot.entries.find(entry=>entry.kind==='refund'),{id:entry.id,kind:'refund',date:entry.serviceDate,amountN:-6000,liabilityCents:-6000,recognitionCents:0})
    const source=await h.raw(`${lot.href}?session=${encodeURIComponent(session.token)}`,{headers:{accept:'text/html'}})
    assert.equal(source.status,200)
    assert.doesNotMatch(await source.text(),/portal\.prepaid\.|untranslated_key|payment_intent|provider_ref|quote_json/)
    const portalInvoice=await h.raw(`/portal/invoices/${rows[0].invoice}?session=${encodeURIComponent(session.token)}`);assert.equal(portalInvoice.status,200);assert.ok(!(await portalInvoice.text()).includes(first.reason))
    await onState({label:'customer-refund',rows,refund:refunded,portalSession:session,portalSource:lot.href,language})
  }
  const unit=await prepare(rows[1]);assert.deepEqual([unit.quote.amountN,unit.quote.amountCents],[2500000,83])
  edge.loseNext();edge.visible(false)
  const unknown=approveRefund?await approveRefund({row:rows[1],refund:unit,finance}):await h.api('prepaid.refund.decide',finance,{refund:unit.id,basis_hash:unit.basis,decision:'approved'})
  await onState({label:'uncertain',rows,refund:unknown})
  await typedRefund(rows[1],unit,'uncertain')
  assert.equal(unknown.status,'uncertain');const afterUnknown=refundPosts(),recoveryStart=edge.calls.length
  assert.equal((reconcileRefund?await reconcileRefund({row:rows[1],refund:unit,expectedStatus:'uncertain'}):await api('prepaid.refund.reconcile',{refund:unit.id})).status,'uncertain');assert.equal(refundPosts(),afterUnknown)
  edge.visible(true)
  const recovered=reconcileRefund?await reconcileRefund({row:rows[1],refund:unit,expectedStatus:'refunded'}):await api('prepaid.refund.reconcile',{refund:unit.id})
  await onState({label:'reconciled',rows,refund:recovered})
  assert.equal(recovered.status,'refunded');assert.equal(recovered.cashAmountCents,-83);assert.equal(refundPosts(),afterUnknown)
  assert.ok(edge.calls.slice(recoveryStart).some(call=>call.path==='/refunds'&&call.method==='GET'),'Unknown recovery reads the original charge refund history')
  assert.ok(edge.calls.slice(recoveryStart).every(call=>call.method==='GET'),'Both native reconciliation attempts only read processor evidence')
  assert.deepEqual(edge.calls.filter(call=>call.method==='POST').map(call=>[call.account,Number(call.form.amount)]),[[1,6000],[2,83]],'Each refund returns only its own frozen original capture on the issued account')
  const unitState=await api(`prepaid/${rows[1].subscription}`)
  assert.equal(unitState.entries.filter(entry=>entry.kind==='refund').length,1);assert.equal(unitState.entries.find(entry=>entry.kind==='refund').recognitionCents,0)
  assert.deepEqual((await api(`invoices/${rows[1].invoice}`)).calculation,rows[1].original.calculation)
  const rejected=await prepare(rows[2]);await h.api('prepaid.refund.decide',finance,{refund:rejected.id,decision:'rejected'})
  await typedRefund(rows[2],rejected,'rejected')
  assert.equal(refundPosts(),afterUnknown)
  const failed=await prepare(rows[2]);edge.failNext()
  assert.equal((await h.api('prepaid.refund.decide',finance,{refund:failed.id,basis_hash:failed.basis,decision:'approved'})).status,'failed')
  await typedRefund(rows[2],failed,'failed')
  const afterFailed=refundPosts();assert.equal((await api(`prepaid/${rows[2].subscription}`)).balances[0].remainingN,6000)
  assert.equal((await api('prepaid.refund.reconcile',{refund:failed.id})).status,'failed');assert.equal(refundPosts(),afterFailed)
  const stale=await prepare(rows[2]);await usage(rows[2],631,'1','2026-11-02')
  await h.api('prepaid.refund.decide',finance,{refund:stale.id,basis_hash:stale.basis,decision:'approved'},409)
  assert.equal(refundPosts(),afterFailed);await h.api('prepaid.refund.decide',finance,{refund:stale.id,decision:'rejected'})
  await onState({label:'refused',rows,refund:stale})
  await h.advanceClock('2026-12-01T18:00:00Z')
  await api('report.schedule',{enabled:true,day:1})
  const scheduled=await h.raw(`/cdn-cgi/local/scheduled?time=${Date.parse('2026-12-01T20:00:00Z')}&cron=${encodeURIComponent('0 14 * * *')}`)
  assert.equal(scheduled.status,200,await scheduled.text())
  const deliveryId=(await api('report-schedule')).deliveries[0].id
  const frozen=await api(`report-deliveries/${deliveryId}`)
  assert.equal(frozen.status,'accepted')
  const frozenRefunds=frozen.reports.find(report=>report.metric==='refunds')
  assert.equal(frozenRefunds.totalCents,-6083)
  for(const outcome of [refunded,recovered]){
    const source=frozen.sourceEvidence.find(source=>source.metric==='refunds'&&source.sourceId===outcome.id)
    assert.equal(source.detail.refund.cashAmountCents,outcome.cashAmountCents)
    assert.equal(source.detail.refund.liability.recognitionCents,0)
  }
  const frozenCsv=csvRows(await(await h.raw(`/app/report-deliveries/${deliveryId}.csv`,{cookie:owner})).text())
  assert.equal(Number(frozenCsv.find(row=>row.report==='refunds'&&row.source==='TOTAL').amount.replace(/^'/,'')),-60.83)
  await h.advanceClock('2026-11-02T18:00:00Z')
  // Erasure withdraws request quotes and processor proof while retaining exact
  // cash, liability, numbered-credit and revenue facts for seven calendar years.
  const subject=rows[0],beforeErasure=await api(`invoices/${subject.invoice}`)
  const revenueBeforeErasure=await api(`revenue?period=2026-11&customer=${subject.customer}`)
  const erase=await api('erasure.request',{customer:subject.customer})
  const eraseLink=h.mails.at(-1).text.match(/https?:\/\/[^\s"<]+\/erase\/[a-f0-9]{64}/)[0]
  assert.equal((await h.raw(new URL(eraseLink).pathname,{form:new URLSearchParams({confirm:'yes'})})).status,200)
  const erased=await api('erasure.approve',{request:erase.id,confirm:true})
  assert.ok(erased.receipt.changed.some(row=>row.kind==='nc_prepaid_refunds'))
  assert.equal(erased.receipt.retained.until,'2033-11-02')
  const retainedTyped=await typedRefund(subject,first,'refunded',{erased:true})
  assert.equal(retainedTyped.refundRef,refunded.refundRef);assert.equal(retainedTyped.credit,refunded.credit)
  for(const who of [owner,finance])assert.equal((await h.raw(`/app/prepaid/refunds/${refunded.id}/proof`,{cookie:who})).status,404)
  await api('prepaid.refund.reconcile',{refund:refunded.id},404)
  const retained=await api(`invoices/${subject.invoice}`)
  for(const key of ['id','number','subtotal_cents','tax_cents','total_cents','paidCents','balanceCents','issue_date'])assert.equal(retained[key],beforeErasure[key])
  assert.deepEqual(retained.credits.map(row=>[row.id,row.number,row.amount_cents,row.applied_cents,row.tax_cents]),beforeErasure.credits.map(row=>[row.id,row.number,row.amount_cents,row.applied_cents,row.tax_cents]))
  assert.deepEqual((await api(`revenue?period=2026-11&customer=${subject.customer}`)).months,revenueBeforeErasure.months)
  const retainedCash=await api(`reports/refunds?period=2026-11&customer=${subject.customer}`)
  assert.equal(retainedCash.totalCents,-6000)
  const retainedSource=await api(`reports/refunds/${refunded.id}?period=2026-11&customer=${subject.customer}`)
  assert.equal(retainedSource.refund.cashAmountCents,-6000);assert.equal(retainedSource.refund.liability.recognitionCents,0)
  for(const marker of [subject.external,`${subject.external}@example.test`,'synthetic-nectar-native-customer-1','synthetic-nectar-native-card-1'])assert.ok(!JSON.stringify([retainedSource,await api('audit')]).includes(marker),'Refund proof and personal source evidence are withdrawn')
  assert.equal(refundPosts(),afterFailed)
  assert.deepEqual((await api('erasure.purge',{})).removed,[])
  await h.advanceClock('2033-11-01T18:00:00Z');assert.deepEqual((await api('erasure.purge',{})).removed,[])
  await h.advanceClock('2033-11-02T18:00:00Z');assert.deepEqual((await api('erasure.purge',{})).removed,[erase.id])
  await api(`reports/refunds/${refunded.id}?period=2026-11&customer=${subject.customer}`,undefined,404)
  await api(`invoices/${subject.invoice}`,undefined,404)
  const removal=JSON.parse((await api('erasures')).find(row=>row.id===erase.id).receipt_json)
  for(const kind of ['nc_prepaid_refunds','nc_prepaid_refund_credits'])assert.ok(removal.removal.records.some(row=>row.kind===kind&&row.records>0),'Both new financial families expire only with the governed custody group')
  assert.deepEqual((await api('erasure.purge',{})).removed,[]);assert.equal(refundPosts(),afterFailed)
  console.log('CAT-004 unused paid money/units refunds: original capture, independent approval, exact zero-revenue liability/cash, reservation race, rejected/failed/stale and GET-only unknown recovery passed')
  return {rows,refunded,recovered}
}

// A cash refund is immutable consideration already returned to the customer.
// Corrected history may restore retained credit or bill excess, never spend the
// refunded portion again or create another processor refund.
export async function prepaidRefundCorrectionFlow(h,owner,{onState=async()=>{}}={}) {
  for(const kind of ['money','units'])await refundCorrectionCase(h,owner,kind,onState)
}
async function refundCorrectionCase(h,owner,kind,onState) {
  const n=kind==='money'?860:880,refundCents=kind==='money'?6000:83,excessCents=kind==='money'?6000:150
  const api=(path,body,status)=>h.api(path,owner,body,status)
  await h.advanceClock('2026-01-01T18:00:00Z');edge.at('2026-01-01T18:00:00Z')
  await api('business.configure',{...await api('business'),timezone:'UTC'})
  await api('access.give',{email:`synthetic-nectar-${n+1}@example.test`,name:'Synthetic refund correction finance',role:'finance'})
  const finance=await h.signIn(`synthetic-nectar-${n+1}@example.test`,{requested:true})
  const customer=(await api('customer.create',{external_id:`synthetic-nectar-${n+2}`,name:'Synthetic refund correction customer',billing_email:`synthetic-nectar-${n+2}@example.test`})).id
  const product=(await api('product.create',{code:`synthetic-nectar-${n+3}`,name:'Synthetic refundable monthly service'})).id
  const meter=(await api('meter.create',{code:`synthetic-nectar-${n+4}`,name:'Synthetic refundable monthly units',unit_label:'units'})).id
  const price=(await api('price.create',{product,meter,kind:'unit',unit_amount:'2',taxable:false})).id
  const subscription=(await api('subscription.create',{customer,start_date:'2026-01-01',price:[price]})).id
  const grant=await api('prepaid.prepare',{subscription,mode:'grant',kind,source:'purchase',amount:kind==='money'?'100':'3',...(kind==='units'?{meter,purchase_amount:'1'}:{}),effective_date:'2026-01-01',expires_date:'2027-01-01',priority:10,expiry_consent:true})
  await h.api('prepaid.decide',finance,{request:grant.request,decision:'approved'})
  const purchase=(await api('prepaid.purchase.prepare',{intent:grant.request,issue_date:'2026-01-01'})).invoice
  await api('invoice.approve',{invoice:purchase,acknowledge:true});await api('invoice.finalise',{invoice:purchase,issue_date:'2026-01-01'})
  await api('collection.customer.bind',{customer,account_ref:'synthetic-nectar-native-account-1',stripe_customer_ref:`synthetic-nectar-native-customer-${kind==='money'?1:3}`,confirm:true})
  const prepared=await api('collection.prepare',{invoice:purchase});await api('collection.confirm',prepared.instructions.confirm)
  const state=()=>api(`prepaid/${subscription}`)
  const usage=(id,quantity)=>api('usage.submit',{events:[{event_id:`synthetic-nectar-${id}`,customer:`synthetic-nectar-${n+2}`,meter:`synthetic-nectar-${n+4}`,quantity,occurred_at:'2026-01-15T12:00:00Z'}]})
  await usage(n+5,kind==='money'?'20':'0.5');await h.advanceClock('2026-02-01T18:00:00Z');edge.at('2026-02-01T18:00:00Z')
  const run=await api('billrun.prepare',{period:'2026-01'}),invoice=(await api(`runs/${run.id}`)).invoices.find(row=>row.subscription_id===subscription)
  assert.ok(invoice);await api('invoice.approve',{invoice:invoice.id,acknowledge:true});await api('invoice.finalise',{invoice:invoice.id,issue_date:'2026-02-01'})
  const lot=(await state()).grants[0],request=await api('prepaid.refund.prepare',{grant:lot.id,reason:'Synthetic unused monthly service returned to original card'})
  const paused=edge.pauseNext(),approval=h.api('prepaid.refund.decide',finance,{refund:request.id,basis_hash:request.basis,decision:'approved'})
  await paused.arrived
  try{
    const refused=await api('usage.correction.prepare',{subscription,from_period:'2026-01',through_period:'2026-01',void_event_ids:[`synthetic-nectar-${n+5}`],add_event_ids:[],reason:'Synthetic pending refund correction',explanation:'An unresolved refund must retain its whole-lot reservation.'},409)
    assert.equal(refused.error,'prepaid_refund_pending')
  }finally{paused.release()}
  const refund=await approval
  assert.equal(refund.status,'refunded');assert.equal(refund.cashAmountCents,-refundCents)
  const originals=await Promise.all([purchase,invoice.id].map(id=>api(`invoices/${id}`))),refunded=await state(),refundEntry=refunded.entries.find(entry=>entry.kind==='refund')
  let cashRefunded=refundCents,creates=edge.calls.filter(call=>call.method==='POST').length
  for(const [id,voidId,quantity,expectedBalance,expectedLiability,expectedRecognition,expectedDelta] of (kind==='money'?[[n+6,n+5,'10',2000,2000,2000,0],[n+7,n+6,'40',0,0,2000,6000]]:[[n+6,n+5,'0.25',250000,8,9,0],[n+7,n+6,'1',0,0,9,150]])){
    await usage(id,quantity)
    const before=await state(),body={subscription,from_period:'2026-01',through_period:'2026-01',void_event_ids:[`synthetic-nectar-${voidId}`],add_event_ids:[`synthetic-nectar-${id}`]}
    const preview=await api('usage.correction.preview',body)
    assert.deepEqual(preview.delta,{subtotalCents:expectedDelta,taxCents:0,totalCents:expectedDelta})
    const correction=await api('usage.correction.prepare',{...body,reason:'Synthetic corrected monthly usage source',explanation:'The original cash refund remains fixed. This correction restores retained purchased credit or bills usage beyond it.'})
    assert.deepEqual(await state(),before,'Preparing historical correction never changes the refund or ledger')
    await api('usage.correction.decide',{correction:correction.id,decision:'approved'},409)
    const applied=await h.api('usage.correction.decide',finance,{correction:correction.id,decision:'approved'})
    assert.equal(applied.status,'approved')
    await h.api('usage.correction.decide',finance,{correction:correction.id,decision:'approved'},409)
    const after=await state()
    assert.equal(after.balances[0].remainingN,expectedBalance);assert.equal(after.balances[0].liabilityCents,expectedLiability)
    assert.equal(after.entries.reduce((total,entry)=>total+entry.recognitionCents,0),expectedRecognition)
    assert.deepEqual(after.entries.find(entry=>entry.id===refundEntry.id),refundEntry)
    for(const entry of refunded.entries)assert.deepEqual(after.entries.find(saved=>saved.id===entry.id),entry,'Every original financial statement survives correction')
    const facts=(await api(`prepaid/refunds?subscription=${subscription}`)).find(row=>row.id===refund.id)
    assert.equal(facts.status,'refunded');assert.equal(facts.credit,refund.credit);assert.equal(facts.cashAmountCents,-refundCents)
    assert.equal((await api(`reports/refunds?period=2026-02&customer=${customer}`)).totalCents,-cashRefunded)
    const rows=csvRows(await(await h.raw(`/app/exports/prepaid/${subscription}.csv`,{cookie:owner})).text())
    assert.equal(rows.length,after.entries.length)
    for(const entry of after.entries.filter(row=>row.kind==='correction'))assert.equal((await api(`prepaid/${subscription}/entries/${entry.id}`)).entry.recognitionCents,entry.recognitionCents)
    const source=await api(`revenue/${purchase}?from=2026-01&to=2026-12`)
    assert.equal(source.schedules.flatMap(row=>row.entries).reduce((total,row)=>total+row.amountCents,0),expectedRecognition)
    for(const original of originals)assert.deepEqual((await api(`invoices/${original.id}`)).calculation,original.calculation)
    assert.equal(edge.calls.filter(call=>call.method==='POST').length,creates,'Corrections never retry or increase a cash refund')
    await onState({label:`refund-correction-${kind}-${id}`,subscription,customer,purchase,invoice:invoice.id,correction:correction.id,refund:refund.id})
    if(id===n+6){
      // Credit the correction gave back is unused paid credit: only a NEW request refunds it in cash.
      const lot=(await state()).grants[0],again=await api('prepaid.refund.prepare',{grant:lot.id,reason:'Synthetic credit restored by correction returned to original card'})
      assert.notEqual(again.id,refund.id);assert.equal(again.quote.amountN,expectedBalance)
      const second=await h.api('prepaid.refund.decide',finance,{refund:again.id,basis_hash:again.basis,decision:'approved'})
      assert.equal(second.status,'refunded');assert.equal(second.cashAmountCents,-expectedLiability);cashRefunded+=expectedLiability
      assert.equal(edge.calls.filter(call=>call.method==='POST').length,++creates,'The restored credit is refunded by exactly one new processor create')
      const original=(await api(`prepaid/refunds?subscription=${subscription}`)).find(row=>row.id===refund.id)
      assert.deepEqual([original.status,original.cashAmountCents,original.credit],[facts.status,facts.cashAmountCents,facts.credit],'The completed refund is unchanged')
      assert.deepEqual((await state()).entries.find(entry=>entry.id===refundEntry.id),refundEntry)
    }
  }
  const corrections=await api(`usage/corrections?subscription=${subscription}`)
  assert.ok(corrections.some(row=>row.plan.delta.totalCents===excessCents))
  await h.advanceClock('2026-03-01T18:00:00Z')
  const nextRun=await api('billrun.prepare',{period:'2026-02'}),next=(await api(`runs/${nextRun.id}`)).invoices.find(row=>row.subscription_id===subscription)
  assert.equal(next.total_cents,excessCents,'The approved excess appears once on the ordinary next invoice')
  await api('invoice.approve',{invoice:next.id,acknowledge:true});await api('invoice.finalise',{invoice:next.id,issue_date:'2026-03-01'})
  assert.equal((await api(`invoices/${next.id}`)).total_cents,excessCents)
  assert.equal((await state()).balances[0].remainingN,0)
  assert.equal((await api(`reports/refunds?period=2026-02&customer=${customer}`)).totalCents,-cashRefunded)
  await onState({label:`refund-correction-${kind}-issued-excess`,subscription,customer,purchase,invoice:next.id,refund:refund.id})
  return {subscription,customer,purchase}
}
