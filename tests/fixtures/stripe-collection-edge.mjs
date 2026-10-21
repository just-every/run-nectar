// Fake only at Stripe's paid network edge; the Worker, auth, D1 and forms are real.
import assert from 'node:assert/strict'
import { stripeHistoryCapture } from './stripe-history.mjs'
export function collectionCapture() {
  const capture=stripeHistoryCapture(),template=capture.invoices.data[0]
  for(let n=1;n<=4;n++)capture.invoices.data.push({...structuredClone(template),id:`synthetic-nectar-open-${n}`,number:`OPEN-${n}`,status:'open',amount_paid:0,amount_remaining:11000,auto_advance:true,collection_method:'send_invoice',livemode:false,attempt_count:0,attempted:false,default_payment_method:'synthetic-nectar-method',due_date:Date.parse('2026-06-20T00:00:00Z')/1000})
  capture.invoices.data.push({...structuredClone(template),id:'synthetic-nectar-void',number:'VOID-1',status:'void',amount_paid:0,amount_remaining:0})
  for(const value of capture.invoices.data)Object.assign(value,{auto_advance:value.auto_advance??false,collection_method:value.collection_method??'charge_automatically',livemode:false})
  for(const [name,value]of Object.entries(capture))if(value?.object==='list')capture.manifest.files[name]={count:value.data.length,has_more:false}
  return capture
}
export function stripeCollectionEdge() {
  const originals=collectionCapture().invoices.data,invoices=new Map(originals.map(row=>[row.id,structuredClone(row)])),payments=new Map(),charges=new Map(),calls=[]
  let loseNextPayment=false,loseNextMirror=false
  const response=value=>Response.json(value),list=data=>({object:'list',has_more:false,data})
  const fetch=async request=>{
    const url=new URL(request.url),path=url.pathname.slice(3),body=request.method==='POST'?new URLSearchParams(await request.text()):null
    calls.push({method:request.method,path,query:url.searchParams,body,key:request.headers.get('Idempotency-Key')})
    assert.ok(request.headers.get('authorization'),'provider authorization is bound')
    if(path==='/account')return response({object:'account',id:'synthetic-nectar-account'})
    if(path.startsWith('/customers/'))return response({object:'customer',id:'synthetic-nectar-1',invoice_settings:{default_payment_method:'synthetic-nectar-method'},default_source:null})
    if(path.startsWith('/payment_methods/'))return response({object:'payment_method',id:'synthetic-nectar-method',customer:'synthetic-nectar-1',type:'card'})
    if(path==='/payment_methods')return response(list([{object:'payment_method',id:'synthetic-nectar-method',customer:'synthetic-nectar-1',type:'card'}]))
    if(path==='/invoice_payments')return response(list([]))
    if(path==='/payment_intents/search') {
      const query=url.searchParams.get('query')??''
      return response({...list([...payments.values()].filter(row=>Object.values(row.metadata).some(value=>query.includes(value)))),next_page:null,object:'search_result'})
    }
    if(path==='/payment_intents'&&body) {
      assert.equal(body.get('amount'),'11000');assert.equal(body.get('currency'),'usd');assert.equal(body.get('customer'),'synthetic-nectar-1')
      assert.equal(body.get('payment_method'),'synthetic-nectar-method');assert.equal(body.get('confirm'),'true');assert.equal(body.get('off_session'),'true');assert.equal(body.has('receipt_email'),false)
      const metadata=Object.fromEntries([...body].filter(([key])=>key.startsWith('metadata[')).map(([key,value])=>[key.slice(9,-1),value]))
      const id=`synthetic-nectar-intent-${payments.size+1}`,charge=`synthetic-nectar-charge-${payments.size+1}`,created=Date.parse('2026-07-01T16:00:00Z')/1000
      const receipt={id,object:'payment_intent',status:'succeeded',amount:11000,amount_received:11000,currency:'usd',customer:'synthetic-nectar-1',livemode:false,latest_charge:charge,payment_method:'synthetic-nectar-method',metadata,created}
      payments.set(id,receipt);charges.set(charge,{id:charge,object:'charge',payment_intent:id,customer:'synthetic-nectar-1',paid:true,captured:true,status:'succeeded',currency:'usd',amount:11000,amount_captured:11000,livemode:false,created})
      if(loseNextPayment){loseNextPayment=false;throw new Error('synthetic lost provider response')}
      return response(receipt)
    }
    if(path.startsWith('/payment_intents/'))return response(payments.get(path.split('/').at(-1)))
    if(path==='/charges')return response(list([...charges.values()].filter(row=>row.payment_intent===url.searchParams.get('payment_intent'))))
    if(path.startsWith('/charges/'))return response(charges.get(path.split('/').at(-1)))
    if(path.startsWith('/invoices/')) {
      const id=path.split('/')[2],invoice=invoices.get(id);assert.ok(invoice,`known original ${id}`)
      if(body&&path.endsWith('/pay')) {
        assert.equal(body.get('paid_out_of_band'),'true','native charge is mirrored, never charged through the old invoice')
        invoice.status='paid';invoice.amount_paid=invoice.total;invoice.amount_remaining=0;invoice.auto_advance=false;invoice.paid_out_of_band=true
        if(loseNextMirror){loseNextMirror=false;throw new Error('synthetic lost mirror response')}
      } else if(body){assert.equal(body.get('auto_advance'),'false');invoice.auto_advance=false}
      return response(invoice)
    }
    throw new Error(`unexpected Stripe edge ${request.method} ${path}`)
  }
  return {fetch,calls,invoices,payments,charges,losePayment:()=>{loseNextPayment=true},loseMirror:()=>{loseNextMirror=true}}
}
