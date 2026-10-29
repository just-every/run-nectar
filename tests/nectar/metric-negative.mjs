import assert from 'node:assert/strict'

// USE-002: signed SQL is visible, never a route around credit governance.
export async function metricNegative(h,owner,{source}) {
  const api=(path,body,status)=>h.api(path,owner,body,status)
  const customer=(await api('customer.create',{external_id:'USE002-SIGNED',name:'Signed metric result',billing_email:'ap@signed.example'})).id
  const event={event_id:'use002-negative-raw',customer:'USE002-SIGNED',meter:source.code,quantity:'3',occurred_at:'2024-05-10T00:00:00Z',properties:{}}
  await api('usage.submit',{events:[event]})
  const request=await api('meter.prepare',{code:'use002-negative',name:'Signed net units',unit_label:'units',source_meter:source.id,sql:'SELECT SUM(quantity - 5) AS quantity FROM usage_events'})
  for(const period of ['2024-03','2024-04','2024-05']) {
    const preview=await api('meter.preview',{request:request.request,customer,period})
    assert.deepEqual(preview.results[0].exact,{numerator:period==='2024-05'?'-2':'0',denominator:'1'},'USE-002 signed previews retain the exact negative aggregate')
  }
  const meter=await api('meter.activate',{request:request.request})
  const flatProduct=(await api('product.create',{code:'use002-positive-base',name:'Positive base'})).id
  const metricProduct=(await api('product.create',{code:'use002-negative-metric',name:'Signed metric'})).id
  const flat=(await api('price.create',{product:flatProduct,kind:'flat',unit_amount:'100',taxable:false})).id
  const price=(await api('price.create',{product:metricProduct,kind:'unit',meter:meter.id,unit_amount:'2',taxable:false})).id
  const subscription=(await api('subscription.create',{customer,start_date:'2024-05-01',price:[flat,price]})).id
  const prepare=async()=>{const run=await api('billrun.prepare',{period:'2024-05'});const rows=(await api(`runs/${run.id}`)).invoices;const i=rows.find(i=>i.customer_id===customer);return api(`invoices/${i.id}`)}
  const rejected=await prepare()
  const exception=rejected.exceptions.find(e=>e.code==='metric_negative_quantity')
  assert.ok(exception,'USE-002 negative quantity is an explicit blocking exception')
  assert.deepEqual(exception.detail.exact,{numerator:'-2',denominator:'1'},'USE-002 refusal names the signed result without clamping')
  assert.equal(rejected.total_cents,10000,'USE-002 positive base remains recorded while invalid negative metric is unrated')
  await api('invoice.approve',{invoice:rejected.id,acknowledge:true},409)
  assert.ok(!(await api(`subscriptions/${subscription}`)).invoices.some(i=>i.status==='issued'),'USE-002 a negative metric cannot issue as an ungoverned credit behind positive charges')
  await api('usage.submit',{events:[{...event,event_id:'use002-negative-corrected',quantity:'9',occurred_at:'2024-05-11T00:00:00Z'}]})
  const corrected=await prepare()
  assert.ok(!corrected.exceptions.some(e=>e.code==='metric_negative_quantity'),'USE-002 a corrected aggregate can be prepared afresh')
  assert.notEqual(corrected.source_fingerprint,rejected.source_fingerprint,'USE-002 corrected source receives a new exact approval basis')
  assert.equal(corrected.total_cents,10400,'USE-002 corrected net units rate exactly without the earlier negative being silently clamped')
  await api('invoice.approve',{invoice:corrected.id,acknowledge:true})
  await api('invoice.finalise',{invoice:corrected.id,issue_date:'2024-06-01'})
  assert.equal((await api(`invoices/${corrected.id}`)).status,'issued','USE-002 only the corrected positive result reaches the issued ledger')
  console.log('USE-002 exact signed previews, negative-result blocking and corrected fresh issuance passed')
  return {customer,subscription,request:request.request,invoice:corrected.id}
}
