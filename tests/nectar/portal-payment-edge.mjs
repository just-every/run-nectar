// Paid processor network edge only; the actual Worker, D1 and portal are used.
import assert from 'node:assert/strict'
export function portalPaymentEdge() {
  const sessions=new Map(),calls=[]
  let lost=false,settled=false,processing=false
  const account='synthetic-nectar-account',customer='synthetic-nectar-customer',method='synthetic-nectar-method'
  const fetch=async request=>{
    const url=new URL(request.url),path=url.pathname.slice(3),post=request.method==='POST'
    assert.equal(request.headers.get('authorization'),'Bearer synthetic-nectar-1')
    if(path==='/account')return Response.json({object:'account',id:account})
    if(path===`/customers/${customer}`)return Response.json({object:'customer',id:customer,livemode:false,invoice_settings:{default_payment_method:null}})
    if(path==='/checkout/sessions'&&post) {
      const body=new URLSearchParams(await request.text()),id=body.get('client_reference_id')
      assert.equal(body.get('locale'),'es','Hosted payment follows the saved customer language');assert.equal(body.get('mode'),'payment');assert.equal(body.get('customer'),customer)
      assert.equal(body.get('payment_method_types[0]'),'us_bank_account')
      assert.equal(body.get('line_items[0][quantity]'),'1')
      assert.equal(request.headers.get('idempotency-key'),`nectar-portal-invoice-${id}`)
      assert.ok(!body.get('success_url').includes('session='),'No customer capability crosses the processor boundary')
      const amount=Number(body.get('line_items[0][price_data][unit_amount]'))
      const row={object:'checkout.session',id:`synthetic-nectar-checkout-${sessions.size+1}`,mode:'payment',customer,livemode:false,
        client_reference_id:id,amount_total:amount,currency:'usd',status:'open',payment_status:'unpaid',
        metadata:{nectar_portal_payment:id,nectar_native_invoice:body.get('metadata[nectar_native_invoice]')},
        payment_intent:`synthetic-nectar-intent-${sessions.size+1}`,url:`https://checkout.stripe.com/c/pay/synthetic-nectar-${sessions.size+1}`}
      sessions.set(id,row);calls.push({id,amount,body:Object.fromEntries(body)})
      if(lost){lost=false;return new Response('Lost response',{status:599})}
      return Response.json(row)
    }
    if(path==='/checkout/sessions')return Response.json({object:'list',has_more:false,data:[...sessions.values()]})
    const checkout=[...sessions.values()].find(row=>path.endsWith('/'+row.id))
    if(checkout)return Response.json(checkout)
    const row=[...sessions.values()].find(row=>path.endsWith('/'+row.payment_intent)||url.searchParams.get('payment_intent')===row.payment_intent
      ||path.endsWith('/'+row.payment_intent+'-charge')||path.endsWith('/'+row.payment_intent+'-balance'))
    if(path===`/payment_methods/${method}`)return Response.json({object:'payment_method',id:method,type:'us_bank_account',customer,livemode:false,us_bank_account:{last4:'6789'}})
    if(row) {
      const charge={object:'charge',id:row.payment_intent+'-charge',customer,livemode:false,currency:'usd',payment_intent:row.payment_intent,payment_method:method,
        status:'succeeded',paid:true,captured:true,amount:row.amount_total,amount_captured:row.amount_total,amount_refunded:0,refunded:false,disputed:false,created:1793178000,balance_transaction:row.payment_intent+'-balance'}
      if(path.startsWith('/payment_intents/'))return Response.json({object:'payment_intent',id:row.payment_intent,customer,payment_method:method,livemode:false,
        currency:'usd',amount:row.amount_total,amount_received:row.amount_total,status:processing?'processing':'succeeded',latest_charge:charge.id,
        metadata:{nectar_native_collection_key:row.client_reference_id,nectar_native_collection_request:row.client_reference_id,nectar_native_invoice:row.metadata.nectar_native_invoice}})
      if(path==='/charges')return Response.json({object:'list',has_more:false,data:[charge]})
      if(path.startsWith('/charges/'))return Response.json(charge)
      if(path.startsWith('/balance_transactions/'))return Response.json({object:'balance_transaction',id:row.payment_intent+'-balance',source:charge.id,type:'payment',amount:row.amount_total,currency:'usd',available_on:1793178000,status:settled?'available':'pending'})
    }
    assert.fail(`Unexpected Stripe operation ${request.method} ${path}`)
  }
  return {fetch,calls,account,customer,sessions,lose:()=>{lost=true},complete:()=>{for(const row of sessions.values()){row.status='complete';row.payment_status='paid'}processing=true},settle:()=>{processing=false;settled=true}}
}
