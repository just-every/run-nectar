import assert from 'node:assert/strict'
import { applyPolicy } from './policy-helper.mjs'

// INV-003: commercial terms enter through catalogue, subscription and usage
// doors. Expected cents below are independent hand calculations, never a
// second call to the rating engine or an operator-to-customer-only comparison.
export async function invoiceCalculations(h,owner,{sessions,path,checkPdf,onState}) {
  const api=(path,body,status)=>h.api(path,owner,body,status)
  const previous=await api('business')
  const tax=async fields=>{
    await applyPolicy(h,owner,'tax.declare',fields)
    await api('tax.review',{revision:(await api('business')).revision})
  }
  await tax({tax_jurisdiction:'CA',tax_mode:'flat_rate',tax_rate:'10',tax_note:'Synthetic invoice calculation parity'})
  const customer=(await api('customer.create',{external_id:'INV003-CALCULATIONS',name:'Cedar calculation customer',billing_email:'calculation'+'@'+'example.test'})).id
  const specs=[
    {key:'flat',kind:'flat',unit_amount:'10.005',quantity:'1',cents:516,facts:['Quantity: 1','Unit rate: USD 10.005','Proration: 16 of 31 days']},
    {key:'seats',kind:'seat',unit_amount:'1.005',quantity:'3',cents:156,facts:['Quantity: 3','Unit rate: USD 1.005','Proration: 16 of 31 days']},
    {key:'simple',kind:'unit',unit_amount:'1',quantity:'1.005',cents:101,facts:['Quantity: 1.005','Unit rate: USD 1.00']},
  ]
  // 150 units: graduated 25.01; volume 15.015; two packages 2.475134;
  // selected stair fee 15.005. Seats multiply these by 16/31 before rounding.
  const terms=[
    {model:'graduated',tiers:[{up_to:'100',unit_amount:'0.20',flat_amount:'0.005'},{up_to:null,unit_amount:'0.10',flat_amount:'0.005'}],seat:1291,unit:2501,
      facts:['Tier 1: Quantity 100.00','Tier 2: Quantity 50.00','Amount before rounding: USD 25.01']},
    {model:'volume',tiers:[{up_to:'100',unit_amount:'0.20'},{up_to:null,unit_amount:'0.10',flat_amount:'0.015'}],seat:775,unit:1502,
      facts:['Tier 2: Quantity 150.00','Unit rate USD 0.10','Fixed fee USD 0.015','Amount before rounding: USD 15.015']},
    {model:'package',package_size:'100',tiers:[{up_to:null,unit_amount:'1.234567',flat_amount:'0.006'}],seat:128,unit:248,
      facts:['Quantity 150.00 (2 × 100.00)','Unit rate USD 1.234567','Amount before rounding: USD 2.475134']},
    {model:'stair_step',tiers:[{up_to:'100',flat_amount:'7.005'},{up_to:null,flat_amount:'15.005'}],seat:774,unit:1501,
      facts:['Tier 2: Quantity 150.00','Unit rate USD 0.00','Fixed fee USD 15.005','Amount before rounding: USD 15.005']},
  ]
  for(const term of terms)for(const kind of ['seat','unit'])specs.push({...term,key:`${term.model}-${kind}`,kind,quantity:'150',cents:term[kind],facts:[...term.facts,...(kind==='seat'?['Proration: 16 of 31 days']:[])]})
  const events=[]
  for(const spec of specs){
    const product=(await api('product.create',{code:`inv003-${spec.key}`,name:`Calculation ${spec.key}`})).id
    const meter=spec.kind==='unit'?(await api('meter.create',{code:`inv003-${spec.key}`,name:`Calculation ${spec.key}`,unit_label:'units'})).id:undefined
    spec.price=(await api('price.create',{product,kind:spec.kind,taxable:true,...(meter?{meter}:{}),...(spec.model?{pricing_model:spec.model,tiers:spec.tiers,...(spec.package_size?{package_size:spec.package_size}:{})}:{unit_amount:spec.unit_amount})})).id
    if(meter)events.push({event_id:`synthetic-inv003-private-${spec.key}`,customer:'INV003-CALCULATIONS',meter:`inv003-${spec.key}`,quantity:spec.quantity,occurred_at:'2026-08-20T12:00:00Z'})
  }
  // A one-day snapshot in the business timezone is exactly 1/31 month.
  // Derived metrics use rational tier evidence, a different native path.
  const source=(await api('meter.create',{code:'inv003-snapshot',name:'Calculation snapshots',unit_label:'GB'})).id
  const request=await api('meter.prepare',{code:'inv003-month',name:'Calculation month',unit_label:'GB-month',source_meter:source,definition:{aggregation:'time_weighted',group_by:['model'],entity_property:'resource',time_unit:'month'}})
  for(const period of ['2026-05','2026-06','2026-07'])await api('meter.preview',{request:request.request,customer,period})
  const metric=await api('meter.activate',{request:request.request})
  const metricTerms=[
    {model:'simple',cents:323,facts:['Unit rate: USD 100.00']},
    {model:'graduated',tiers:[{up_to:'0.02',unit_amount:'100',flat_amount:'0.005'},{up_to:null,unit_amount:'200',flat_amount:'0.005'}],cents:446,facts:['Tier 1: Quantity 1 ÷ 50','Tier 2: Quantity 19 ÷ 1550','Amount before rounding: USD 13831 ÷ 3100']},
    {model:'volume',tiers:[{up_to:'0.02',unit_amount:'100'},{up_to:null,unit_amount:'200',flat_amount:'0.005'}],cents:646,facts:['Tier 2: Quantity 1 ÷ 31','Amount before rounding: USD 40031 ÷ 6200']},
    {model:'package',package_size:'0.01',tiers:[{up_to:null,unit_amount:'0.50',flat_amount:'0.005'}],cents:201,facts:['Quantity 4 (4 × 0.01)','Amount before rounding: USD 401 ÷ 200']},
    {model:'stair_step',tiers:[{up_to:'0.02',flat_amount:'1'},{up_to:null,flat_amount:'2.005'}],cents:201,facts:['Tier 2: Quantity 0','Fixed fee USD 2.005','Amount before rounding: USD 401 ÷ 200']},
  ]
  for(const term of metricTerms){
    const key=`metric-${term.model}`,product=(await api('product.create',{code:`inv003-${key}`,name:`Calculation ${key}`})).id
    const price=(await api('price.create',{product,meter:metric.id,dimensions:{model:term.model},kind:'unit',taxable:true,...(term.model==='simple'?{unit_amount:'100'}:{pricing_model:term.model,tiers:term.tiers,...(term.package_size?{package_size:term.package_size}:{})})})).id
    specs.push({...term,key,kind:'unit',quantity:'',price,facts:['Quantity: 0.032258 (1 ÷ 31)',...term.facts]})
    events.push({event_id:`synthetic-inv003-private-snapshot-${term.model}`,customer:'INV003-CALCULATIONS',meter:'inv003-snapshot',quantity:'1',occurred_at:'2026-08-31T07:00:00Z',properties:{resource:`synthetic-inv003-private-resource-${term.model}`,model:term.model}})
  }
  await api('subscription.create',{customer,start_date:'2026-08-16',anchor_day:1,price:specs.map(s=>s.price),quantity:specs.map(s=>s.kind==='unit'?'':s.quantity)})
  assert.equal((await api('usage.submit',{events})).accepted,events.length)
  const run=await api('billrun.prepare',{period:'2026-08'})
  const draft=(await api(`runs/${run.id}`)).invoices.find(i=>i.customer_id===customer)
  assert.ok(draft,'calculated subscription has an invoice')
  await api('invoice.approve',{invoice:draft.id,acknowledge:true})
  await api('invoice.finalise',{invoice:draft.id,issue_date:'2026-09-01'})
  const issued=await api(`invoices/${draft.id}`)
  assert.equal(issued.lines.length,specs.length)
  for(const spec of specs)assert.equal(issued.lines.find(l=>l.price_id===spec.price)?.amount_cents,spec.cents,`independent cents for ${spec.key}`)
  assert.deepEqual([issued.subtotal_cents,issued.tax_cents,issued.total_cents],[11310,1131,12441],'each line rounds once, then 10 percent tax rounds once')
  sessions.set(customer,(await api('portal.session.issue',{customer,origin:h.origin,audience:'hosted'})).token)
  const assertDocuments=async expected=>{
    const html=await h.page(path(draft.id,customer)),pdf=(await checkPdf(draft.id,customer)).text
    const decodedHtml=html.replace(/&amp;/g,'&').replace(/&#(?:215|x[dD]7);/g,'×')
    for(const [label,document] of [['HTML',decodedHtml],['PDF',pdf]]){
      const normalized=(label==='HTML'?document.replace(/<\/dt>\s*<dd>/g,': ').replace(/<[^>]*>/g,' '):document).replace(/\s+/g,' ')
      for(const text of expected)assert.ok(normalized.includes(text),`${label} contains calculated fact: ${text}`)
      for(const spec of specs){
        const marker=`Calculation ${spec.key}`,start=normalized.indexOf(marker)
        assert.ok(start>=0,`${label} contains ${marker}`)
        const next=specs.map(other=>normalized.indexOf(`Calculation ${other.key}`,start+marker.length)).filter(index=>index>=0).sort((a,b)=>a-b)[0]
        const line=normalized.slice(start,next)
        for(const fact of [...spec.facts,money(spec.cents)])assert.ok(line.includes(fact),`${label} ${spec.key} contains its own ${fact}`)
      }
      assert.doesNotMatch(document,/synthetic-inv003-private|eventIds|contextEventIds|metricPlan|roundingNumerator|\[object Object\]|undefined/,'customer documents exclude raw source and internal arithmetic inputs')
    }
  }
  const money=cents=>`USD ${(cents/100).toFixed(2)}`
  const facts=specs.flatMap(spec=>[`Calculation ${spec.key}`,...spec.facts,money(spec.cents)])
  const totals=['Subtotal: USD 113.10','Tax: USD 11.31','Total: USD 124.41']
  await assertDocuments([...facts,...totals,'Credited: USD 0.00','Paid: USD 0.00','Balance owed: USD 124.41'])
  const credit=await api('credit.issue',{invoice:draft.id,amount:'9.41',reason:'Synthetic calculation customer adjustment'})
  const payment=await api('payment.record',{customer,amount:'25',received_on:'2026-09-03',method:'bank_transfer',reference:'synthetic-inv003-recorded-cash',evidence:'Synthetic external bank receipt'})
  await api('payment.allocate',{payment:payment.payment,invoice:draft.id,amount:'25'})
  await assertDocuments([...facts,...totals,credit.number,'Credited: USD 9.41','Paid: USD 25.00','Balance owed: USD 90.00'])
  await onState?.({label:'calculated-customer-invoice',path:path(draft.id,customer),pdfPath:path(draft.id,customer,'pdf')})
  await tax({tax_jurisdiction:previous.tax_jurisdiction,tax_mode:previous.tax_mode,tax_rate:previous.tax_rate,tax_note:previous.tax_note})
}
