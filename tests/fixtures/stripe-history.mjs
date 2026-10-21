// Synthetic, documented Stripe list exports; no network credentials.
const unix = day => Date.parse(`${day}T12:00:00Z`)/1000
const month = (year,index) => new Date(Date.UTC(year,index,1)).toISOString().slice(0,10)
const list=data=>({object:'list',has_more:false,data})
export function stripeHistoryCapture() {
  const customer='synthetic-nectar-1',sub='synthetic-nectar-2',product='synthetic-nectar-3',price='synthetic-nectar-4'
  const monthly={id:price,object:'price',currency:'usd',type:'recurring',product,unit_amount:10000,recurring:{interval:'month',interval_count:1,usage_type:'licensed'},metadata:{nectar_kind:'flat'}}
  const annual={...monthly,id:'synthetic-nectar-5',unit_amount:1200000,recurring:{interval:'year',interval_count:1,usage_type:'licensed'}}
  const invoices=[],payments=[]
  const invoice=(id,number,start,end,amount,p)=>({id,object:'invoice',customer,subscription:sub,number,status:'paid',currency:'usd',created:unix(start),due_date:unix(start),status_transitions:{finalized_at:unix(start)},period_start:unix(start),period_end:unix(end),total:amount+(p===monthly?1000:0),tax:p===monthly?1000:0,amount_paid:amount+(p===monthly?1000:0),amount_remaining:0,lines:list([{id:`${id}-line`,object:'line_item',description:p===monthly?'Monthly platform':'Annual platform in advance',amount,amount_excluding_tax:amount,quantity:1,price:p,period:{start:unix(start),end:unix(end)},type:'subscription',subscription:sub}])})
  for(let index=0;index<18;index++) {
    const start=month(2025,index),end=month(2025,index+1),id=`synthetic-nectar-invoice-${index}`
    const item=invoice(id,`HIST-${String(index+1).padStart(4,'0')}`,start,end,10000,monthly);invoices.push(item)
    payments.push({id:`synthetic-nectar-payment-${index}`,object:'charge',customer,invoice:id,created:unix(start),status:'succeeded',paid:true,captured:true,amount:item.total,amount_captured:item.total,amount_refunded:index===0?2200:0,currency:'usd',refunded:false})
  }
  const yearly=invoice('synthetic-nectar-invoice-annual','ANNUAL-0001','2026-03-01','2027-03-01',1200000,annual);invoices.push(yearly)
  payments.push({id:'synthetic-nectar-payment-annual',object:'charge',customer,invoice:yearly.id,created:unix('2026-03-01'),status:'succeeded',paid:true,captured:true,amount:1200000,amount_captured:1200000,amount_refunded:0,currency:'usd',refunded:false})
  const subscription={id:sub,object:'subscription',customer,start_date:unix('2025-01-01'),billing_cycle_anchor:unix('2025-01-01'),status:'active',items:list([{id:'synthetic-nectar-item-1',price:monthly,quantity:1}])}
  const captures={customers:list([{id:customer,object:'customer',name:'Alder Research',email:'billing@alder.example',tax_exempt:'none'}]),products:list([{id:product,object:'product',name:'Platform',active:true}]),prices:list([monthly]),meters:list([]),subscriptions:list([subscription]),invoices:list(invoices),credit_notes:list([{id:'synthetic-nectar-credit-1',object:'credit_note',customer,invoice:invoices[0].id,number:'HIST-CN-0001',created:unix('2025-01-20'),status:'issued',total:2200,currency:'usd',total_tax_amounts:[{amount:200}],lines:list([])}]),payments:list(payments),refunds:list([{id:'synthetic-nectar-refund-1',object:'refund',charge:payments[0].id,created:unix('2025-01-20'),amount:2200,currency:'usd',status:'succeeded'}]),disputes:list([{id:'synthetic-nectar-dispute-1',object:'dispute',charge:payments[1].id,created:unix('2025-02-20'),amount:1000,currency:'usd',status:'won',reason:'duplicate'}]),subscription_events:list(['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted'].map((type,index)=>({id:`synthetic-nectar-event-${index}`,object:'event',type,created:unix(['2025-01-01','2025-09-01','2026-06-20'][index]),data:{object:{...subscription,status:index===2?'canceled':'active',...(index===1?{pause_collection:{behavior:'void'},trial_end:unix('2025-09-14')}:{}),items:list([{id:'synthetic-nectar-item-1',price:monthly,quantity:index+1}])}}})))}
  return {manifest:{source:'stripe',files:Object.fromEntries(Object.entries(captures).map(([name,value])=>[name,{count:value.data.length,has_more:false}]))},...captures}
}
