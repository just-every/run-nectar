import assert from 'node:assert/strict'
import {nativeCollectionEdge} from './native-collection.mjs'
const edge=nativeCollectionEdge()
export const harnessOptions=()=>({stripeFetch:edge.fetch,stripeSecret:'synthetic-nectar-1'})
export async function hierarchiesFlow(h,owner,{onState=async()=>{},configure,consolidate}={}) {
  const api=(path,body,status)=>h.api(path,owner,body,status)
  await h.advanceClock('2026-10-22T10:00:00Z');edge.capturedAt('2026-10-22T10:00:00Z')
  await api('business.configure',{...await api('business'),timezone:'UTC'})
  const make=async(n)=>(await api('customer.create',{external_id:`synthetic-nectar-hierarchy-${n}`,name:n===0?'Parent group':`Division ${n}`,billing_email:`division-${n}@example.test`})).id
  const parent=await make(0),children=await Promise.all([1,2,3].map(make)),other=await make(4)
  await api('access.give',{email:'hierarchy-finance@example.test',name:'Hierarchy Finance',role:'finance'})
  const finance=await h.signIn('hierarchy-finance@example.test',{requested:true}),agent={bearer:(await api('credential.issue',{name:'Hierarchy observer',scopes:['prepare']})).key}
  for(const who of [finance,agent])for(const action of ['hierarchy.configure','hierarchy.invoice.prepare','hierarchy.commitment'])await h.api(action,who,{},403)
  for(const who of [finance,agent])await h.api('hierarchies',who,undefined,403)
  const link=configure??(payload=>api('hierarchy.configure',payload))
  for(const customer of children)await link({customer,parent,billing_mode:'consolidated',revision:0,consent:true})
  await api('hierarchy.configure',{customer:parent,parent:children[0],billing_mode:'consolidated',revision:0,consent:true},409)
  await api('hierarchy.configure',{customer:other,parent:children[0],billing_mode:'consolidated',revision:0,consent:true},409)
  await api('hierarchy.configure',{customer:children[0],parent,billing_mode:'separate',revision:0,consent:true},409)
  await api('hierarchy.commitment',{parent,amount:'1000',from:'2026-09-01',to:'2026-11-01',consent:true})
  const product=(await api('product.create',{code:'synthetic-nectar-hierarchy-flat',name:'Division platform'})).id
  const flat=(await api('price.create',{product,kind:'flat',unit_amount:'100',taxable:false})).id
  const meter=(await api('meter.create',{code:'synthetic-nectar-hierarchy-calls',name:'Division calls',unit_label:'calls'})).id
  const usageProduct=(await api('product.create',{code:'synthetic-nectar-hierarchy-usage',name:'Division usage'})).id
  const usagePrice=(await api('price.create',{product:usageProduct,kind:'unit',unit_amount:'1',meter,taxable:false})).id
  const subscriptions=[]
  for(let i=0;i<3;i++)subscriptions.push((await api('subscription.create',{customer:children[i],start_date:'2026-09-01',price:[flat,usagePrice]})).id)
  await api('usage.submit',{events:children.map((_,i)=>({event_id:`synthetic-nectar-hierarchy-usage-${i}`,customer:`synthetic-nectar-hierarchy-${i+1}`,meter:'synthetic-nectar-hierarchy-calls',quantity:String((i+1)*10),occurred_at:'2026-09-15T12:00:00Z'}))})
  const run=await api('billrun.prepare',{period:'2026-09'}),drafts=(await api(`runs/${run.id}`)).invoices
  assert.deepEqual(drafts.map(i=>i.subtotal_cents).sort((a,b)=>a-b),[11000,12000,13000])
  await api('invoice.approve',{invoice:drafts[0].id,acknowledge:true},409)
  const prepare=consolidate??(payload=>api('hierarchy.invoice.prepare',payload))
  const invoice=(await prepare({parent,invoices:drafts.map(i=>i.id)})).id
  const saved=await api(`invoices/${invoice}`)
  assert.equal(saved.customer_id,parent);assert.equal(saved.subtotal_cents,36000);assert.equal(saved.tax_cents,0)
  assert.deepEqual(saved.calculation.inputs.consolidation.sections.map(s=>s.subtotalCents).sort((a,b)=>a-b),[11000,12000,13000])
  for(let n=1;n<=3;n++)assert.ok((await h.page(`/app/invoices/${invoice}`,owner)).includes(`<h3>Division ${n}</h3>`),'each division has its own charge section')
  await onState({label:'consolidated-draft',parent,invoice,children})
  await h.api('invoice.approve',finance,{invoice,acknowledge:true})
  const second=(await api('hierarchy.invoice.prepare',{parent,invoices:drafts.map(i=>i.id)})).id
  await api('invoice.approve',{invoice:second,acknowledge:true})
  await h.api('invoice.finalise',finance,{invoice,issue_date:'2026-10-01'})
  await api('invoice.finalise',{invoice:second,issue_date:'2026-10-01'},409)
  assert.ok((await api(`runs/${run.id}`)).invoices.every(i=>i.status==='discarded'))
  assert.equal((await api('billrun.prepare',{period:'2026-09'})).summary.invoices,0,'division service is not billed a second time')
  const pool=(await api('hierarchies')).commitments[0]
  assert.equal(pool.drawnCents,36000);assert.equal(pool.remainingCents,64000)
  assert.equal(new Set(pool.drawdowns.map(d=>d.customer)).size,3,'each division draws down the shared spending commitment')
  const revenue=await api(`revenue/${invoice}`)
  assert.equal(revenue.schedules.reduce((n,s)=>n+s.amountCents,0),36000)
  assert.equal(revenue.schedules.flatMap(s=>s.entries).reduce((n,e)=>n+e.amountCents,0),36000,'one exact revenue source for all divisions')
  assert.equal((await api(`invoices/${invoice}`)).total_cents,36000)
  await onState({label:'consolidated-issued',parent,invoice,children})
  await link({customer:children[2],parent,billing_mode:'separate',revision:1,consent:true})
  await api('usage.submit',{events:children.map((_,i)=>({event_id:`synthetic-nectar-hierarchy-next-${i}`,customer:`synthetic-nectar-hierarchy-${i+1}`,meter:'synthetic-nectar-hierarchy-calls',quantity:'10',occurred_at:'2026-10-15T12:00:00Z'}))})
  await h.advanceClock('2026-11-02T10:00:00Z');edge.capturedAt('2026-11-02T10:00:00Z')
  const next=await api('billrun.prepare',{period:'2026-10'}),separate=(await api(`runs/${next.id}`)).invoices.find(i=>i.customer_id===children[2])
  await api('invoice.approve',{invoice:separate.id,acknowledge:true});await api('invoice.finalise',{invoice:separate.id,issue_date:'2026-11-01'})
  await api('collection.customer.bind',{customer:parent,account_ref:'synthetic-nectar-native-account-1',stripe_customer_ref:'synthetic-nectar-native-customer-1',confirm:true})
  const collection=await api('collection.prepare',{invoice:separate.id})
  assert.equal(collection.review.customerId,children[2]);assert.equal(collection.review.payerCustomerId,parent)
  assert.equal(collection.review.customerRef,'synthetic-nectar-native-customer-1')
  await onState({label:'parent-card-review',parent,invoice:separate.id,children})
  const confirmed=await api('collection.confirm',collection.instructions.confirm)
  assert.equal(confirmed.status,'collected')
  assert.equal((await api(`invoices/${separate.id}`)).balanceCents,0)
  assert.equal(edge.calls.filter(c=>c.method==='POST'&&c.path==='/payment_intents').length,1)
  assert.equal(edge.calls.find(c=>c.method==='POST'&&c.path==='/payment_intents').form.customer,'synthetic-nectar-native-customer-1')
  assert.equal((await api(`customers/${parent}`)).ledger.payments.length,0,'the parent card does not invent a second parent receivable')
  const updated=(await api('hierarchies')).commitments[0]
  assert.equal(updated.drawnCents,47000);assert.equal(updated.remainingCents,53000)
  await onState({label:'parent-card-collected',parent,invoice:separate.id,children})
  // Erasing one division removes its personal source text without losing the
  // parent's or other divisions' financial facts and saved revenue schedules.
  await api('erasure.request',{customer:children[0]})
  const message=h.mails.at(-1),href=`${message.text??''} ${message.html??''}`.match(/https?:\/\/[^\s"<]+\/erase\/[a-f0-9]{64}/)[0]
  assert.equal((await h.raw(new URL(href).pathname,{form:new URLSearchParams({confirm:'yes'})})).status,200)
  await api('erasure.approve',{request:(await api('erasures')).find(r=>r.customer_id===children[0]).id,confirm:true})
  const retained=await api(`invoices/${invoice}`)
  assert.equal(retained.total_cents,36000)
  assert.ok(!JSON.stringify(retained).includes('Division 1'))
  const afterErasure=await api(`revenue/${invoice}`)
  assert.equal(afterErasure.schedules.reduce((n,s)=>n+s.amountCents,0),36000)
  assert.ok(JSON.stringify(retained).includes('Division 2'),'another division keeps its own description')
  console.log('hierarchiesFlow: three-division frozen consolidation, once-only billing/revenue, separate parent-card collection and pooled spend passed')
  return {parent,children,invoice,separate:separate.id}
}

// Parent tax settings must never recalculate the divisions' once-rounded tax.
export async function hierarchyTaxFlow(h,owner,{onState=async()=>{}}={}) {
  const api=(path,body,status)=>h.api(path,owner,body,status)
  await h.advanceClock('2026-10-22T12:00:00Z')
  await api('business.configure',{...await api('business'),timezone:'UTC'})
  const {applyPolicy}=await import('./policy-helper.mjs')
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'flat_rate',tax_rate:'6.25',tax_note:'Synthetic division rounding proof'})
  await api('tax.review',{revision:(await api('business')).revision})
  const make=async(n,exempt=false)=>(await api('customer.create',{external_id:`synthetic-nectar-hierarchy-tax-${n}`,name:n===0?'Exempt parent':`Tax division ${n}`,billing_email:`tax-division-${n}@example.test`,tax_exempt:exempt,tax_exempt_ref:exempt?'synthetic-nectar-exempt':''})).id
  const parent=await make(0,true),children=[]
  const product=(await api('product.create',{code:'synthetic-nectar-hierarchy-rounding',name:'Rounding-sensitive service'})).id
  const price=(await api('price.create',{product,kind:'flat',unit_amount:'0.08',taxable:true})).id
  for(let n=1;n<=3;n++){
    const child=await make(n,n===3);children.push(child)
    await api('hierarchy.configure',{customer:child,parent,billing_mode:'consolidated',revision:0,consent:true})
    await api('subscription.create',{customer:child,start_date:'2026-09-01',price:[price]})
  }
  const run=await api('billrun.prepare',{period:'2026-09'}),drafts=(await api(`runs/${run.id}`)).invoices
  assert.deepEqual(drafts.map(i=>i.tax_cents).sort(),[0,1,1],'each taxable division rounds its own half-cent once')
  const invoice=(await api('hierarchy.invoice.prepare',{parent,invoices:drafts.map(i=>i.id)})).id
  const saved=await api(`invoices/${invoice}`)
  assert.deepEqual([saved.subtotal_cents,saved.tax_cents,saved.total_cents],[24,2,26])
  assert.deepEqual(saved.calculation.inputs.consolidation.sections.map(s=>s.taxCents).sort(),[0,1,1])
  await api('invoice.approve',{invoice,acknowledge:true});await api('invoice.finalise',{invoice,issue_date:'2026-10-01'})
  assert.deepEqual([(await api(`invoices/${invoice}`)).total_cents,(await api(`revenue/${invoice}`)).schedules.reduce((n,s)=>n+s.amountCents,0)],[26,24],'tax remains outside revenue')
  await onState({label:'division-tax-custody',invoice,parent,children})
  console.log('hierarchyTaxFlow: exempt parent preserves each division\'s tax exemption and once-rounded cents, outside revenue')
}

// Existing parent credit pays a division once without inventing another grant.
export async function hierarchyCreditsFlow(h,owner,{onState=async()=>{},prepare,approve}={}) {
 const api=(path,body,status)=>h.api(path,owner,body,status)
 await h.advanceClock('2026-11-03T12:00:00Z')
 await api('business.configure',{...await api('business'),timezone:'UTC'})
 const make=async(n)=>(await api('customer.create',{external_id:`synthetic-nectar-shared-credit-${n}`,name:n===0?'Credit parent':`Credit division ${n}`,billing_email:`credit-division-${n}@example.test`})).id
 const parent=await make(0),child=await make(1),other=await make(2)
 await api('hierarchy.configure',{customer:child,parent,billing_mode:'separate',revision:0,consent:true})
 await api('hierarchy.configure',{customer:other,parent,billing_mode:'separate',revision:0,consent:true})
 await api('access.give',{email:'shared-credit-finance@example.test',name:'Shared credit finance',role:'finance'})
 await api('access.give',{email:'shared-credit-accountant@example.test',name:'Shared credit accountant',role:'accountant'})
 const finance=await h.signIn('shared-credit-finance@example.test',{requested:true}),accountant=await h.signIn('shared-credit-accountant@example.test',{requested:true}),agent={bearer:(await api('credential.issue',{name:'Shared credit observer',scopes:['prepare']})).key}
 for(const who of [finance,accountant,agent])await h.api('hierarchy.credit.prepare',who,{},403)
 for(const who of [accountant,agent,undefined])await h.api('hierarchy.credit.approve',who,{},who?403:401)
 const {applyPolicy}=await import('./policy-helper.mjs')
 await applyPolicy(h,owner,'credit.policy',{two_person_above:'1000',balance_application:'manual'})
 await api('balance.goodwill',{customer:parent,amount:'2000',reason:'Parent grant over limit'},409)
 const funding=await api('balance.prepare',{kind:'goodwill',customer:parent,amount:'2000',reason:'Authorized parent goodwill'})
 await h.api('balance.approve',finance,{request:funding.request})
 const grant=(await api(`customers/${parent}/balance`)).grants[0].id
 const manual=async(customer,amount)=>{const charge=(await api('charge.add',{customer,amount,description:'Division service',effective_date:'2026-10-01',taxable:false})).charge;const id=(await api('invoice.manual',{customer,charges:[charge],service_date:'2026-10-01'})).id;await api('invoice.approve',{invoice:id,acknowledge:true});await api('invoice.finalise',{invoice:id,issue_date:'2026-10-22'});return id}
 const invoice=await manual(child,'1500'),second=await manual(other,'100')
 const form={invoice,grant,amount:'1500',reason:'Shared parent agreement',consent:true}
 const save=prepare??(body=>api('hierarchy.credit.prepare',body)),execute=approve??((body,who)=>h.api('hierarchy.credit.approve',who,body))
 await api('hierarchy.credit.prepare',{...form,consent:false},400)
 const request=(await save(form)).request
 await api('hierarchy.credit.approve',{request,confirm:true},409)
 await h.api('hierarchy.credit.approve',finance,{request},400)
 assert.equal((await api(`invoices/${invoice}`)).balanceCents,150000)
 assert.ok((await h.page(`/app/invoices/${invoice}`,owner)).includes('A different owner or finance approver must apply this request.'))
 assert.ok((await h.page(`/app/invoices/${invoice}`,finance)).includes(`/app/customers/${parent}#balance-entry-${grant}`))
 await onState({label:'shared-credit-pending',invoice,parent,finance})
 if(approve)await execute({request,confirm:true},finance)
 else {const replies=await Promise.all([1,2].map(()=>h.raw('/api/nectar/hierarchy.credit.approve',{cookie:finance,body:{request,confirm:true}})));assert.deepEqual(replies.map(r=>r.status).sort(),[200,409],'a concurrent second approval cannot apply credit twice');assert.equal((await replies.find(r=>r.status===200).json()).appliedCents,150000)}
 await h.api('hierarchy.credit.approve',finance,{request,confirm:true},409)
 const paid=await api(`invoices/${invoice}`),balance=await api(`customers/${parent}/balance`)
 assert.deepEqual([paid.balanceCents,paid.creditedCents,paid.paidCents],[0,150000,0])
 assert.equal(balance.goodwillCents,50000);assert.equal(balance.totalCents,50000)
 assert.equal(balance.ledger.filter(r=>r.kind==='goodwill').reduce((n,r)=>n+r.amountCents,0)-balance.ledger.filter(r=>r.kind==='application').reduce((n,r)=>n+r.amountCents,0),50000)
 assert.equal((await api(`customers/${child}/balance`)).totalCents,0,'no second child grant is invented')
 assert.equal((await api('reports/credit-balances')).totalCents,50000)
 assert.equal((await api(`revenue/${invoice}`)).schedules.reduce((n,s)=>n+s.amountCents,0),150000,'sharing credit does not rewrite consideration or tax')
 assert.equal((await h.api(`invoices/${invoice}`,accountant)).hierarchyCredits,null,'nonapprovers get no request narrative or parent grant inventory')
 const custody=paid.hierarchyCredits.requests.find(r=>r.id===request)
 assert.deepEqual([custody.prepared_name,custody.approved_name,custody.approval_mode],['owner@example.test','shared-credit-finance@example.test','two-person'])
 await onState({label:'shared-credit-applied',invoice,parent,finance})
 const stale=(await api('hierarchy.credit.prepare',{...form,invoice:second,amount:'100'})).request
 await applyPolicy(h,owner,'credit.policy',{two_person_above:'900',balance_application:'manual'})
 await h.api('hierarchy.credit.approve',finance,{request:stale,confirm:true},409)
 assert.equal((await api(`invoices/${second}`)).balanceCents,10000)
 const fresh=(await api('hierarchy.credit.prepare',{...form,invoice:second,amount:'100'})).request
 await api('hierarchy.credit.approve',{request:fresh,confirm:true})
 assert.equal((await api(`customers/${parent}/balance`)).goodwillCents,40000,'below-limit application permits the explicit owner confirmation')
 // Erasure of one division withdraws its request narrative but preserves the
 // parent's remaining credit and the other division's exact settlement.
 await api('erasure.request',{customer:child})
 const mail=h.mails.at(-1),href=`${mail.text??''} ${mail.html??''}`.match(/https?:\/\/[^\s"<]+\/erase\/[a-f0-9]{64}/)[0]
 await h.raw(new URL(href).pathname,{form:new URLSearchParams({confirm:'yes'})})
 await api('erasure.approve',{request:(await api('erasures')).find(r=>r.customer_id===child).id,confirm:true})
 const erased=await api(`invoices/${invoice}`)
 assert.equal(erased.balanceCents,0);assert.equal(erased.hierarchyCredits.requests.find(r=>r.id===request).reason,'','the erased division request narrative is withdrawn')
 assert.equal((await api(`customers/${parent}/balance`)).goodwillCents,40000)
 assert.equal((await api(`invoices/${second}`)).balanceCents,0)
 console.log('hierarchyCreditsFlow: governed existing-parent goodwill, once-only application, exact ledgers/report/revenue and refusal/erasure passed')
}
