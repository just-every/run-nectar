import assert from 'node:assert/strict'
import { applyPolicy, reviewer } from './policy-helper.mjs'

// PORT-005 / AGENT-002: the same live customer session sees only committed
// human decisions. Compare exact saved preview figures through both doors.
export async function portalCorrections(h, owner, session, invoiceId, onState=async()=>{}) {
  const api=(path,body,status)=>h.api(path,owner,body,status)
  const read=async()=>await (await h.raw(`/portal/data?session=${session.token}`)).json()
  const before=await read(),original=await api(`invoices/${invoiceId}`)
  const customerRead = (session, path, status = 200) => portalJson(h, session, path, status)
  const nextPath=`/portal/subscriptions/${original.subscription_id}/upcoming?period=2026-09`
  const nextBefore=await customerRead(session,nextPath)
  const line=original.lines[0]
  const payload={invoice_credit:true,invoice:invoiceId,amount:'10',reason:'Reviewed platform adjustment',explanation:'The reviewed platform adjustment credits USD 10.00.',subject:'Platform adjustment',body:'A USD 10.00 credit reduces the balance from USD 175.00 to USD 165.00; the original USD 300.00 invoice and USD 0.00 tax stay unchanged.',citations:[{line_id:line.id,source:`/app/invoices/${invoiceId}/lines/${line.id}`,quote:line.description}]}
  const prepared=await api('proposal.create',{kind:'amendment',title:'Portal correction',payload})
  const proposal=await api(`proposals/${prepared.id}`)
  await customerRead(session,`/portal/corrections/${prepared.id}`,404)
  assert.equal(proposal.impact.credit.amountCents,1000,'PORT-005 correction preview credit is exact')
  assert.equal(proposal.impact.credit.balanceAfterCents,16500,'PORT-005 correction preview balance is exact')
  assert.deepEqual(await read(),before,'PORT-005 preparing a correction changes no customer figures')
  await api('proposal.decide',{proposal:prepared.id,decision:'approved'})
  const after=await read(),row=after.invoices.find(row=>row.id===invoiceId)
  assert.deepEqual([row.total_cents,row.tax_cents,row.credited_cents,row.paid_cents,row.balance_cents],[30000,0,3500,10000,16500],'PORT-005 portal original/credit/payment/owed figures equal the approved correction')
  assert.equal(row.balance_cents,proposal.impact.credit.balanceAfterCents)
  const creditView=(await customerRead(session,`/portal/corrections/${prepared.id}`)).corrections[0]
  const approvedCredit=await api(`proposals/${prepared.id}`)
  assert.deepEqual(creditView.original,{subtotalCents:original.subtotal_cents,taxCents:original.tax_cents,totalCents:original.total_cents},'PORT-005 approved credit retains exact original subtotal, tax and total')
  assert.deepEqual(creditView.credit,{amountCents:1000,balanceBeforeCents:17500,balanceAfterCents:16500})
  assert.equal(creditView.message.body,approvedCredit.correctionMail.body,'PORT-005 customer reads the exact approved frozen credit message')
  assert.equal(creditView.message.subject,approvedCredit.correctionMail.subject)
  assert.deepEqual(await customerRead(session,nextPath),nextBefore,'PORT-005 issued credit changes no next-invoice price, usage, tax or total')
  const detail=await (await h.raw(`/portal/invoices/${invoiceId}?session=${session.token}`)).text()
  for(const amount of ['USD 300.00','USD 35.00','USD 100.00','USD 165.00','USD 10.00'])assert.ok(detail.includes(amount),`PORT-005 correction shows ${amount}`)
  assert.match(detail,/Reviewed platform adjustment/)
  const now=await api(`invoices/${invoiceId}`)
  for(const key of ['calculation','lines','subtotal_cents','tax_cents','total_cents','source_fingerprint'])assert.deepEqual(now[key],original[key],'PORT-005 credit leaves original issued evidence unchanged')
  await api('proposal.decide',{proposal:prepared.id,decision:'approved'},409)
  assert.deepEqual(await read(),after,'PORT-005 duplicate approval cannot change portal figures')
  const rejected=await api('proposal.create',{kind:'amendment',title:'Rejected portal correction',payload:{...payload,body:'A second adjustment is proposed for review.'}})
  await api('proposal.decide',{proposal:rejected.id,decision:'rejected'})
  assert.deepEqual(await read(),after,'PORT-005 rejected correction changes no customer records')
  await customerRead(session,`/portal/corrections/${rejected.id}`,404)
  await nextInvoiceCorrections(h,owner,session,original,onState)
}

async function portalJson(h, session, path, status = 200) {
  const response = await h.raw(`${path}${path.includes('?') ? '&' : '?'}session=${encodeURIComponent(session.token)}`)
  assert.equal(response.status, status, `PORT-005 customer ${path} returns ${status}`)
  if (status !== 200) return
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const result = await response.json()
  assert.doesNotMatch(JSON.stringify(result), /\/app\/|\/api\/nectar\/|billing_email|recipient|provider_ref|created_by|evidence_json|calculation_json|PRIVATE-|INTERNAL-/,
    'PORT-005 upcoming and correction sources exclude private custody and operator routes')
  return result
}

const totals = value => [value.subtotalCents,value.taxCents,value.totalCents]

// All current amendment variants and ordinary/derived unbilled usage use the
// same engine as staff; the customer never receives proposal or draft records.
async function nextInvoiceCorrections(h, owner, foreignSession, issuedOriginal,onState) {
  const api = (path,body,status) => h.api(path,owner,body,status)
  await applyPolicy(h,owner,'tax.declare',{tax_jurisdiction:'CA',tax_mode:'flat_rate',tax_rate:'10',tax_note:'Reviewed PORT-005 correction parity'})
  await api('tax.review',{revision:(await api('business')).revision})
  const product=(await api('product.create',{code:'port005-correction-base',name:'Customer correction platform'})).id
  const base=(await api('price.create',{product,kind:'flat',unit_amount:'100',taxable:true})).id
  const fixtures=[]
  for (const kind of ['discount_percent','fixed_credit','price_override','usage','metric']) {
    const external=`PORT005-CORRECTION-${kind}`,email=`${kind}@portal-correction.example.test`
    const customer=(await api('customer.create',{external_id:external,name:`Customer ${kind}`,billing_email:email})).id
    let meter,source,code,price
    if (['usage','metric'].includes(kind)) {
      code=`port005-correction-${kind}`
      source=(await api('meter.create',{code,name:`Customer ${kind} events`,unit_label:'events'})).id
      meter=source
      if (kind==='metric') {
        const request=await api('meter.prepare',{code:'port005-correction-filtered',name:'Customer billable events',unit_label:'events',source_meter:source,
          definition:{aggregation:'sum',group_by:[],filters:[{property:'billable',operator:'=',value:true}]}})
        for (const period of ['2026-06','2026-07','2026-08']) await api('meter.preview',{request:request.request,customer,period})
        meter=(await api('meter.activate',{request:request.request})).id
      }
      const usageProduct=(await api('product.create',{code,name:`Customer ${kind} usage`})).id
      price=(await api('price.create',{product:usageProduct,kind:'unit',meter,unit_amount:'0.01',taxable:true})).id
    }
    const subscription=(await api('subscription.create',{customer,start_date:'2026-09-01',anchor_day:1,price:[base,...(price?[price]:[])]})).id
    const session=await api('portal.session.issue',{customer,origin:h.origin,audience:'hosted'})
    const event=(event_id,quantity,billable=true)=>({event_id,quantity,customer:external,meter:code,occurred_at:'2026-09-10T12:00:00-07:00',
      ...(kind==='metric'?{properties:{billable,internal_note:'PRIVATE-METRIC-PROPERTY'}}:{})})
    if (price) await api('usage.submit',{events:[event(`${kind}-portal-original`,'1000'),...(kind==='metric'?[event('metric-portal-excluded','99999',false)]:[])]})
    fixtures.push({kind,customer,subscription,session,event,email})
  }
  const period='2026-09'
  for (const fixture of fixtures) {
    const {kind,subscription,session,event,customer}=fixture
    const path=`/portal/subscriptions/${subscription}/upcoming?period=${period}`
    const read=()=>portalJson(h,session,path)
    const before=await read(),operator=await api(`subscriptions/${subscription}/upcoming?period=${period}`)
    assert.deepEqual(totals(before.calculation),totals(operator.calculation),'PORT-005 customer upcoming cents equal operator engine cents')
    assert.deepEqual(totals(before.calculation),['usage','metric'].includes(kind)?[11000,1100,12100]:[10000,1000,11000])
    assert.ok(!Object.hasOwn(before.calculation,'inputs'),'PORT-005 live view does not expose raw calculation inputs')
    await portalJson(h,foreignSession,path,404)
    const foreignBefore=await portalJson(h,foreignSession,'/portal/corrections')
    const input=['usage','metric'].includes(kind)
      ? {kind:'usage_correction',title:'Reviewed customer usage quantity',payload:{void:[{event_id:`${kind}-portal-original`,reason:'Source count was duplicated'}],
          add:[event(`${kind}-portal-replacement`,'500')]},evidence:{sources:['Reviewed September source count: 500 billable events.']}}
      : {kind:'amendment',title:'Reviewed customer contract correction',payload:{subscription,kind,value:kind==='discount_percent'?'10':kind==='fixed_credit'?'5':'90',
          ...(kind==='price_override'?{price:base}:{}),effective_from:'2026-09-01',note:'Reviewed customer contract'},
          evidence:{clauses:[{quote:'Executed September contract correction.'}]}}
    const proposed=await api('proposal.create',input),saved=await api(`proposals/${proposed.id}`)
    const impacts=kind==='usage'||kind==='metric'?saved.impact.invoices:saved.impact
    const impact=impacts.find(row=>(row.subscription??subscription)===subscription&&row.period.start==='2026-09-01')
    assert.ok(impact)
    const expected=kind==='fixed_credit'?[9500,950,10450]:['usage','metric'].includes(kind)?[10500,1050,11550]:[9000,900,9900]
    assert.deepEqual(totals(impact.after),expected,'PORT-005 correction preview equals independently computed taxable effect')
    assert.deepEqual(await read(),before,'PORT-005 preparation changes no customer upcoming figures')
    await onState({kind,session,subscription,period,state:'prepared'})
    await portalJson(h,session,`/portal/corrections/${proposed.id}`,404)
    const rejected=await api('proposal.create',input)
    await api('proposal.decide',{proposal:rejected.id,decision:'rejected'})
    assert.deepEqual(await read(),before,'PORT-005 rejected correction changes no upcoming figure or source')
    await portalJson(h,session,`/portal/corrections/${rejected.id}`,404)
    const approver=await reviewer(h,owner,saved.singleAllowed)
    await h.api('proposal.decide',approver,{proposal:proposed.id,decision:'approved'})
    const approved=await api(`proposals/${proposed.id}`)
    const view=(await portalJson(h,session,`/portal/corrections/${proposed.id}`)).corrections[0]
    const frozen=saved.payload.noticeDrafts.find(notice=>notice.customer===customer)
    assert.equal(view.message.subject,frozen.subject)
    assert.equal(view.message.body,frozen.body,'PORT-005 displayed correction is the exact frozen human-approved customer explanation')
    assert.equal(view.message.body,approved.customerMessages.find(message=>message.customer_id===customer).body)
    const visible=view.periods.find(row=>row.subscription===subscription&&row.period.start==='2026-09-01')
    assert.deepEqual(totals(visible.before),totals(impact.before))
    assert.deepEqual(totals(visible.after),expected)
    assert.equal(visible.before.fingerprint,impact.before.fingerprint)
    assert.equal(visible.after.fingerprint,impact.after.fingerprint)
    for (const citation of view.citations) {
      const source=await portalJson(h,session,citation.source)
      const record=citation.recordPath.split('/').slice(1).reduce((value,key)=>value[key],source)
      assert.deepEqual(record,view.periods.find(entry=>entry.subscription===record.subscription&&entry.period.start===record.period.start),
        'PORT-005 frozen before/after engine figures resolve through their own permitted customer citation')
    }
    await onState({kind,session,subscription,period,state:'approved'})
    const after=await read()
    assert.deepEqual(totals(after.calculation),expected,'PORT-005 approved correction immediately reaches the customer next-invoice engine')
    assert.deepEqual(totals(after.calculation),totals((await api(`subscriptions/${subscription}/upcoming?period=${period}`)).calculation))
    if (['usage','metric'].includes(kind)) {
      assert.equal(after.meters[0].quantity.replace(/\.0+$/,''),'500','PORT-005 exact corrected raw/derived quantity matches the customer preview')
      const csv=await h.raw(`/portal/usage.csv?session=${session.token}&subscription=${subscription}&period=${period}`)
      assert.equal(csv.status,200);assert.equal(csv.headers.get('cache-control'),'no-store')
      const rows=(await csv.text()).trim().split('\r\n').slice(1).map(line=>line.split(',').map(cell=>cell.slice(1,-1)))
      assert.equal(rows.length,1,'PORT-005 usage CSV has one exact meter-period contribution')
      assert.equal(rows[0][3].replace(/\.0+$/,''),'500','PORT-005 independently counted corrected quantity equals CSV and screen')
      assert.deepEqual(after.meters[0].eventIds,[`${kind}-portal-replacement`])
      assert.deepEqual(view.events.map(row=>[row.eventId,row.quantity.replace(/\.0+$/,''),row.action]),[[`${kind}-portal-original`,'1000','void'],[`${kind}-portal-replacement`,'500','add']])
    }
    await portalJson(h,foreignSession,`/portal/corrections/${proposed.id}`,404)
    assert.deepEqual(await portalJson(h,foreignSession,'/portal/corrections'),foreignBefore,'PORT-005 other customers see no correction or explanation')
    await api('proposal.decide',{proposal:proposed.id,decision:'approved'},409)
    assert.deepEqual(await read(),after,'PORT-005 duplicate human decisions do not change upcoming figures')
    const run=await api('billrun.prepare',{period})
    const invoice=(await api(`runs/${run.id}`)).invoices.find(row=>row.customer_id===customer)
    assert.ok(invoice)
    await api('invoice.approve',{invoice:invoice.id,acknowledge:true})
    await api('invoice.finalise',{invoice:invoice.id,issue_date:'2026-10-01'})
    const issued=await api(`invoices/${invoice.id}`),final=await read()
    assert.equal(final.state,'issued')
    await onState({kind,session,subscription,period,state:'issued'})
    assert.equal(final.invoiceId,invoice.id)
    assert.deepEqual(totals(final.calculation),expected,'PORT-005 actual issued invoice equals approved correction and customer upcoming cents')
    assert.deepEqual([issued.subtotal_cents,issued.tax_cents,issued.total_cents],expected)
    const customerInvoices=await portalJson(h,session,'/portal/data')
    assert.deepEqual(customerInvoices.invoices.map(row=>[row.subtotal_cents,row.tax_cents,row.total_cents]),[expected])
    const detail=await (await h.raw(`/portal/invoices/${invoice.id}?session=${session.token}`)).text()
    assert.ok(detail.includes(`USD ${(expected[2]/100).toFixed(2)}`),'PORT-005 issued customer page shows the same corrected total')
    assert.deepEqual((await portalJson(h,session,`/portal/corrections/${proposed.id}`)).corrections[0],view,'PORT-005 issuing freezes the customer explanation and reviewed effects')
  }
  const preserved=await api(`invoices/${issuedOriginal.id}`)
  for (const key of ['calculation','lines','subtotal_cents','tax_cents','total_cents','source_fingerprint']) assert.deepEqual(preserved[key],issuedOriginal[key],
    'PORT-005 amendments and usage corrections preserve original issued evidence')
}
