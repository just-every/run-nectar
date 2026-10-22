import assert from 'node:assert/strict'
import { nativeCollectionEdge } from './native-collection.mjs'
import { applyPolicy } from './policy-helper.mjs'

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
const edge=prepaidRefundEdge()
export const harnessOptions=()=>({stripeFetch:edge.fetch,stripeSecret:'synthetic-nectar-1',stripeSecondarySecret:'synthetic-nectar-2'})
export async function prepaidRefundFlow(h,owner){
  const api=(path,body,status)=>h.api(path,owner,body,status),refundPosts=()=>edge.calls.filter(call=>call.method==='POST').length
  await h.advanceClock('2026-11-02T18:00:00Z');edge.at('2026-11-02T18:00:00Z')
  await api('business.configure',{...await api('business'),timezone:'UTC'})
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Synthetic unused paid refund'})
  await api('tax.review',{revision:(await api('business')).revision})
  await api('access.give',{email:'synthetic-nectar-601@example.test',name:'Synthetic refund finance',role:'finance'})
  const finance=await h.signIn('synthetic-nectar-601@example.test',{requested:true}),agent={bearer:(await api('credential.issue',{name:'Synthetic refund observer',scopes:['prepare']})).key}
  const product=(await api('product.create',{code:'synthetic-nectar-602',name:'Synthetic refund service'})).id
  const meter=(await api('meter.create',{code:'synthetic-nectar-603',name:'Synthetic refund units',unit_label:'units'})).id
  const price=(await api('price.create',{product,meter,kind:'unit',unit_amount:'2',taxable:false,billing_interval:'daily',billing_timing:'arrears'})).id
  const rows=[]
  const usage=(row,id,quantity,date)=>api('usage.submit',{events:[{event_id:`synthetic-nectar-${id}`,customer:row.external,meter:'synthetic-nectar-603',quantity,occurred_at:`${date}T12:00:00Z`}]})
  const issue=async row=>{
    const run=await api('billrun.prepare',{period:'2026-11'}),invoices=(await api(`runs/${run.id}`)).invoices.filter(invoice=>invoice.subscription_id===row.subscription&&invoice.period_end<='2026-11-02')
    for(const invoice of invoices){await api('invoice.approve',{invoice:invoice.id,acknowledge:true});await api('invoice.finalise',{invoice:invoice.id,issue_date:'2026-11-02'})}
    return Promise.all(invoices.map(invoice=>api(`invoices/${invoice.id}`)))
  }
  for(let n=1;n<=4;n++){
    const external=`synthetic-nectar-${610+n}`,customer=(await api('customer.create',{external_id:external,name:`Synthetic refund ${n}`,billing_email:`${external}@example.test`})).id
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
    await usage(row,620+n,n===2?'0.5':'20','2026-11-01');row.service=(await issue(row))[0]
    const state=await api(`prepaid/${subscription}`);row.grant=state.grants[0].id;row.before=state;row.original=await api(`invoices/${row.invoice}`)
  }
  await api('prepaid.refund.prepare',{grant:rows[3].grant,reason:'Unverified bank receipt cannot be a card refund'},409)
  for(const who of [finance,agent])await h.api('prepaid.refund.prepare',who,{grant:rows[0].grant,reason:'Unauthorized'},403)
  const prepare=row=>api('prepaid.refund.prepare',{grant:row.grant,reason:'Synthetic unused paid service returned to its original card'})
  const first=await prepare(rows[0]);assert.deepEqual([first.quote.amountN,first.quote.amountCents],[6000,6000])
  assert.deepEqual(await api(`prepaid/${rows[0].subscription}`),rows[0].before,'Preparing a refund reserves no balance and changes no ledger')
  await api('prepaid.refund.decide',{refund:first.id,basis_hash:first.basis,decision:'approved'},409)
  await h.api('prepaid.refund.decide',agent,{refund:first.id,basis_hash:first.basis,decision:'approved'},403)
  const paused=edge.pauseNext(),approval=h.api('prepaid.refund.decide',finance,{refund:first.id,basis_hash:first.basis,decision:'approved'})
  await paused.arrived
  try{
    await usage(rows[0],630,'5','2026-11-02')
    const upcoming=await api(`subscriptions/${rows[0].subscription}/upcoming?period=2026-11`)
    const next=(upcoming.invoices??[upcoming]).find(invoice=>invoice.billingDueDate==='2026-11-03')
    assert.equal(next.calculation.totalCents,1000,'Usage cannot spend credits reserved by an in-flight refund')
  }finally{paused.release()}
  const refunded=await approval
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
  const unit=await prepare(rows[1]);assert.deepEqual([unit.quote.amountN,unit.quote.amountCents],[2500000,83])
  edge.loseNext();edge.visible(false)
  const unknown=await h.api('prepaid.refund.decide',finance,{refund:unit.id,basis_hash:unit.basis,decision:'approved'})
  assert.equal(unknown.status,'uncertain');const afterUnknown=refundPosts()
  assert.equal((await api('prepaid.refund.reconcile',{refund:unit.id})).status,'uncertain');assert.equal(refundPosts(),afterUnknown)
  edge.visible(true)
  const recovered=await api('prepaid.refund.reconcile',{refund:unit.id})
  assert.equal(recovered.status,'refunded');assert.equal(recovered.cashAmountCents,-83);assert.equal(refundPosts(),afterUnknown)
  const unitState=await api(`prepaid/${rows[1].subscription}`)
  assert.equal(unitState.entries.filter(entry=>entry.kind==='refund').length,1);assert.equal(unitState.entries.find(entry=>entry.kind==='refund').recognitionCents,0)
  assert.deepEqual((await api(`invoices/${rows[1].invoice}`)).calculation,rows[1].original.calculation)
  const rejected=await prepare(rows[2]);await h.api('prepaid.refund.decide',finance,{refund:rejected.id,decision:'rejected'})
  assert.equal(refundPosts(),afterUnknown)
  const failed=await prepare(rows[2]);edge.failNext()
  assert.equal((await h.api('prepaid.refund.decide',finance,{refund:failed.id,basis_hash:failed.basis,decision:'approved'})).status,'failed')
  const afterFailed=refundPosts();assert.equal((await api(`prepaid/${rows[2].subscription}`)).balances[0].remainingN,6000)
  assert.equal((await api('prepaid.refund.reconcile',{refund:failed.id})).status,'failed');assert.equal(refundPosts(),afterFailed)
  const stale=await prepare(rows[2]);await usage(rows[2],631,'1','2026-11-02')
  await h.api('prepaid.refund.decide',finance,{refund:stale.id,basis_hash:stale.basis,decision:'approved'},409)
  assert.equal(refundPosts(),afterFailed);await h.api('prepaid.refund.decide',finance,{refund:stale.id,decision:'rejected'})
  console.log('CAT-004 unused paid money/units refunds: original capture, independent approval, exact zero-revenue liability/cash, reservation race, rejected/failed/stale and GET-only unknown recovery passed')
  return {rows,refunded,recovered}
}
