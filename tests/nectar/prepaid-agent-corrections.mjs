import assert from 'node:assert/strict'
import { applyPolicy } from './policy-helper.mjs'
import { csvRows } from './financial-reports.mjs'

const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0)
const numeric = value => Number(String(value).replace(/^'/, ''))
const original = invoice => ({calculation:invoice.calculation,lines:invoice.lines,number:invoice.number,total:invoice.total_cents,source:invoice.source_fingerprint})

async function fixture(h,owner,n,{annual=false,paid=false}={}) {
  const api=(path,body,status)=>h.api(path,owner,body,status)
  await h.advanceClock('2026-01-01T18:00:00Z')
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'no_tax',tax_note:'Synthetic agent prepaid correction consideration'})
  await api('tax.review',{revision:(await api('business')).revision})
  const external=`synthetic-nectar-${n}`,email=`${external}@example.test`
  await api('access.give',{email:`synthetic-nectar-${n+1}@example.test`,name:'Synthetic correction finance',role:'finance'})
  const finance=await h.signIn(`synthetic-nectar-${n+1}@example.test`,{requested:true})
  const agent={bearer:(await api('credential.issue',{name:'Synthetic prepaid correction preparer',scopes:['prepare']})).key}
  const customer=(await api('customer.create',{external_id:external,name:'Synthetic prepaid agent correction',billing_email:email})).id
  const meterCode=`synthetic-nectar-${n+2}`,meter=(await api('meter.create',{code:meterCode,name:'Synthetic corrected calls',unit_label:'calls'})).id
  const product=(await api('product.create',{code:`synthetic-nectar-${n+3}`,name:'Synthetic corrected usage'})).id
  const price=(await api('price.create',{product,kind:'unit',meter,unit_amount:'1',taxable:false})).id
  const prices=[price]
  if(annual){
    const platform=(await api('product.create',{code:`synthetic-nectar-${n+4}`,name:'Synthetic annual platform'})).id
    prices.push((await api('price.create',{product:platform,kind:'flat',unit_amount:'12000',billing_interval:'annual',billing_timing:'advance',taxable:false})).id)
  }
  const subscription=(await api('subscription.create',{customer,start_date:'2026-01-01',price:prices,term_months:24})).id
  const grant=async(source,amount,priority)=>{
    const request=await api('prepaid.prepare',{subscription,mode:'grant',kind:'money',source,amount,effective_date:'2026-01-01',expires_date:'2027-01-01',priority,expiry_consent:true})
    await h.api('prepaid.decide',finance,{request:request.request,decision:'approved'})
    return request.request
  }
  const intent=await grant('purchase','10000',10)
  const purchase=(await api('prepaid.purchase.prepare',{intent,issue_date:'2026-01-01'})).invoice
  await api('invoice.approve',{invoice:purchase,acknowledge:true});await api('invoice.finalise',{invoice:purchase,issue_date:'2026-01-01'})
  if(paid){
    const payment=await api('payment.record',{customer,amount:'10000',received_on:'2026-01-01',method:'bank_transfer',reference:`synthetic-nectar-${n+5}`})
    await api('payment.allocate',{payment:payment.payment,invoice:purchase,amount:'10000'})
    await api('prepaid.funding.confirm',{intent,confirm:true})
    await grant('promotion','1000',0)
  }
  const state=()=>api(`prepaid/${subscription}`)
  const event=(id,quantity,month)=>({event_id:`synthetic-nectar-${id}`,customer:external,meter:meterCode,quantity,occurred_at:`2026-${month}-15T12:00:00Z`})
  const propose=body=>h.api('proposal.create',agent,body)
  const detail=id=>api(`proposals/${id}`)
  const approve=async saved=>{
    await h.api('proposal.decide',agent,{proposal:saved.id,decision:'approved'},403)
    if(saved.impact.credit?.needsSecondApprover)await api('proposal.credit.prepare',{proposal:saved.id})
    await h.api('proposal.decide',finance,{proposal:saved.id,decision:'approved'})
    const decided=await detail(saved.id)
    assert.equal(decided.status,'approved');assert.deepEqual(decided.impact,saved.impact);assert.deepEqual(decided.payload,saved.payload)
    const notices=decided.correctionMail?[decided.correctionMail]:decided.customerMessages
    assert.equal(notices.length,1);assert.equal(notices[0].status,'accepted')
    const reviewed=saved.impact.mail??saved.payload.noticeDrafts[0]
    assert.equal(notices[0].recipient,email);assert.equal(notices[0].body,reviewed.body)
    const delivered=h.mails.filter(mail=>[mail.to].flat().includes(email))
    assert.equal(delivered.at(-1).text,reviewed.body)
    await h.api('proposal.decide',finance,{proposal:saved.id,decision:'approved'},409)
    assert.equal(h.mails.filter(mail=>[mail.to].flat().includes(email)).length,delivered.length,'An approved correction never repeats its reviewed customer message')
    return decided
  }
  const issue=async(period,date)=>{
    await h.advanceClock(`${date}T18:00:00Z`)
    const run=await api('billrun.prepare',{period})
    const invoices=(await api(`runs/${run.id}`)).invoices.filter(invoice=>invoice.customer_id===customer)
    assert.equal(invoices.length,1,'The actual same-due service components form one invoice')
    const id=invoices[0].id
    await api('invoice.approve',{invoice:id,acknowledge:true});await api('invoice.finalise',{invoice:id,issue_date:date})
    return api(`invoices/${id}`)
  }
  return {api,customer,subscription,price,purchase,intent,email,agent,state,event,propose,detail,approve,issue}
}

// The proposal and its customer explanation must agree with the actual credit:
// unpaid purchase consideration is liability, with no earned revenue to reverse.
export async function prepaidAgentCreditFlow(h,owner) {
  const f=await fixture(h,owner,740),{api,purchase}=f
  const issued=await api(`invoices/${purchase}`),source=await api(`revenue/${purchase}`),ledger=await f.state()
  assert.deepEqual([issued.subtotal_cents,issued.balanceCents],[1000000,1000000])
  assert.equal(sum(source.schedules.flatMap(row=>row.entries),'amountCents'),0)
  let liability=1000000
  for(const amount of ['2500','1000']){
    const cents=Number(amount)*100,line=issued.lines.find(row=>row.kind==='prepaid_purchase')
    const created=await f.propose({kind:'amendment',title:'Synthetic unpaid purchase correction',payload:{invoice_credit:true,invoice:purchase,amount,
      reason:'Reduce the unused unpaid prepaid purchase',explanation:'The cited purchase remains unpaid and has earned no revenue. The credit reduces only the outstanding contract liability.',
      subject:'Reviewed prepaid purchase credit',body:'The original purchase remains unchanged. The separately approved credit reduces the unpaid balance and deferred liability; recognized revenue is unchanged.',
      citations:[{line_id:line.id,source:`/app/invoices/${purchase}/lines/${line.id}`,quote:line.description}]}})
    const saved=await f.detail(created.id),r=saved.impact.revenue
    assert.deepEqual(r.before.schedules.slice(0,source.schedules.length),source.schedules)
    assert.deepEqual(r.after.schedules.slice(0,-1),r.before.schedules)
    assert.equal(sum(r.before.periods,'amountCents'),0);assert.equal(sum(r.after.periods,'amountCents'),0)
    assert.ok(r.periods.every(row=>row.beforeCents===0&&row.afterCents===0&&row.deltaCents===0))
    assert.deepEqual([r.adjustment.kind,r.adjustment.amountCents,r.adjustment.billingsDeltaCents,r.adjustment.liabilityDeltaCents],['prepaid-liability-reversal',0,-cents,-cents])
    assert.equal(r.after.schedules.at(-1).amountCents,0)
    for(const measure of [r.billings,r.liability])assert.deepEqual(measure,{beforeCents:liability,afterCents:liability-cents,deltaCents:-cents})
    assert.deepEqual(await f.state(),ledger,'Preparing a purchase credit never funds or mutates the prepaid ledger')
    assert.deepEqual(original(await api(`invoices/${purchase}`)),original(issued))
    await f.approve(saved);liability-=cents
    const current=await api(`invoices/${purchase}`),booked=await api(`revenue/${purchase}`)
    assert.deepEqual(original(current),original(issued));assert.equal(current.balanceCents,liability)
    assert.deepEqual(booked.schedules,source.schedules)
    assert.deepEqual(booked.credits.map(row=>[row.amountCents,row.recognitionCents]),liability===750000?[[-250000,0]]:[[-250000,0],[-100000,0]])
    const report=await api(`revenue?period=2026-01&customer=${f.customer}`)
    assert.deepEqual([report.netBillingsCents,report.recognizedCents,report.closingCents],[liability,0,liability])
    assert.equal(report.deferredLiabilityCents,liability)
    const csv=csvRows(await(await h.raw(`/app/exports/revenue.csv?period=2026-01&customer=${f.customer}`,{cookie:owner})).text())
    const rollforward=csv.find(row=>row.row_kind==='rollforward')
    assert.deepEqual(['net_billings','recognized','closing'].map(key=>numeric(rollforward[key])*100),[liability,0,liability])
    assert.ok(csv.filter(row=>row.row_kind==='credit-recognition').every(row=>numeric(row.signed_contribution)===0))
    assert.deepEqual(await f.state(),ledger)
    await api('prepaid.funding.confirm',{intent:f.intent,confirm:true},409)
  }
  return {customer:f.customer,subscription:f.subscription,invoice:purchase}
}

// Paid and promotional funds are re-evaluated by the same engine as the next
// invoice. Previews reserve nothing, and the issued annual source stays intact.
export async function prepaidAgentDraftCorrectionsFlow(h,owner) {
  for(const kind of ['terms','usage']){
    const f=await fixture(h,owner,kind==='terms'?760:780,{annual:true,paid:true}),{api}=f
    const month=kind==='terms'?'02':'01',event=f.event(kind==='terms'?766:786,'6000',month)
    await h.advanceClock('2026-03-01T18:00:00Z')
    await api('usage.submit',{events:[event]})
    const state=await f.state(),purchase=await api(`invoices/${f.purchase}`)
    assert.equal(sum(state.balances,'remainingN'),1100000)
    // A term proposal precedes the original annual issue; it cannot rewrite an
    // already issued advance service term. Usage correction needs no term edit.
    let annual=kind==='usage'?await f.issue('2026-01','2026-01-01'):null
    if(annual)await h.advanceClock('2026-03-01T18:00:00Z')
    const proposal=kind==='terms'
      ? {kind:'amendment',title:'Synthetic signed unit-price correction',payload:{subscription:f.subscription,kind:'price_override',price:f.price,value:'0.50',effective_from:'2026-02-01',note:'Correct future usage to the signed unit rate'},evidence:{clauses:[{quote:'From 1 February 2026, recorded calls cost USD 0.50 each.',reference:'Synthetic executed rate clause'}]}}
      : {kind:'usage_correction',title:'Synthetic unbilled source correction',payload:{void:[{event_id:event.event_id,reason:'Source count was duplicated'}],add:[f.event(787,'3000',month)]},evidence:{sources:['Synthetic gateway source: 3000 calls, not 6000.']}}
    const created=await f.propose(proposal),saved=await f.detail(created.id)
    const impacts=kind==='terms'?saved.impact:saved.impact.invoices
    const relevant=impacts.find(row=>row.before.lines.some(line=>line.amountCents===600000))
    assert.ok(relevant,'The correction includes the actual metered service window')
    for(const [side,expectedUsage,expectedDraw] of [['before',600000,-600000],['after',300000,-300000]]){
      assert.equal(sum(relevant[side].lines.filter(row=>row.amountCents>0),'amountCents'),expectedUsage)
      assert.equal(sum(relevant[side].lines.filter(row=>row.amountCents<0),'amountCents'),expectedDraw)
      assert.deepEqual([relevant[side].subtotalCents,relevant[side].taxCents,relevant[side].totalCents],[0,0,0])
      assert.equal(sum(relevant[side].revenue.periods,'amountCents'),0,'Service redemption offsets source consideration; purchased value is earned on the original paid purchase')
    }
    assert.ok(relevant.revenueDeltas.every(row=>row.deltaCents===0))
    assert.deepEqual(await f.state(),state,'Preparing either correction does not reserve, consume or restore funds')
    assert.deepEqual(original(await api(`invoices/${f.purchase}`)),original(purchase))
    await f.approve(saved)
    if(!annual)annual=await f.issue('2026-01','2026-01-01')
    const annualSource=await api(`revenue/${annual.id}?from=2026-01&to=2026-12`)
    assert.deepEqual(annualSource.schedules.find(row=>row.kind==='flat').entries.map(row=>row.amountCents),Array(12).fill(100000))
    const next=await f.issue(kind==='terms'?'2026-03':'2026-02',kind==='terms'?'2026-03-01':'2026-02-01')
    assert.deepEqual([next.subtotal_cents,next.tax_cents,next.total_cents],[0,0,0])
    assert.equal(sum(next.lines.filter(row=>row.kind==='usage'),'amount_cents'),300000)
    assert.equal(sum(next.lines.filter(row=>row.kind==='prepaid_drawdown'),'amount_cents'),-300000)
    const after=await f.state()
    assert.equal(sum(after.balances,'remainingN'),800000)
    assert.equal(sum(after.balances,'liabilityCents'),800000)
    const draws=after.entries.filter(row=>row.kind==='drawdown')
    assert.equal(sum(draws,'amountN'),-300000);assert.equal(sum(draws,'recognitionCents'),200000)
    assert.equal(draws.filter(row=>row.purchaseInvoice).length,1)
    assert.deepEqual(original(await api(`invoices/${annual.id}`)),original(annual))
    assert.deepEqual((await api(`revenue/${annual.id}?from=2026-01&to=2026-12`)).schedules,annualSource.schedules)
    const purchaseSource=await api(`revenue/${f.purchase}?from=2026-01&to=2026-12`)
    assert.equal(sum(purchaseSource.schedules.flatMap(row=>row.entries),'amountCents'),200000)
    const source=await api(`revenue/${next.id}`)
    assert.equal(sum(source.schedules.flatMap(row=>row.entries),'amountCents'),0)
    const report=await api(`revenue?period=2026-${month}&customer=${f.customer}`)
    assert.equal(report.recognizedCents,300000,'Actual service month earns USD 1000 annual allocation plus USD 2000 purchased consumption; promotion earns no liability revenue')
    const csv=csvRows(await(await h.raw(`/app/exports/prepaid/${f.subscription}.csv`,{cookie:owner})).text())
    assert.equal(csv.length,after.entries.length)
    assert.deepEqual(original(await api(`invoices/${f.purchase}`)),original(purchase))
  }
}
