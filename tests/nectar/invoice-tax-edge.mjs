// Tax is a network edge; all local money travels through the real HTTP doors.
export function invoiceTaxEdge(fallback) {
  const transactions=new Map(),calls=[]
  let count=0,lose=false
  const attach=(invoice,customerRef)=>{
    const id=`synthetic-nectar-tax-${++count}`
    transactions.set(id,{id,object:'tax.transaction',type:'transaction',livemode:false,currency:'usd',reference:invoice.id,customer:customerRef,shipping_cost:null,
      lines:invoice.lines.map(line=>({id:`synthetic-nectar-tax-line-${++count}`,reference:line.id,type:'transaction',livemode:false,tax_behavior:'exclusive',amount:line.amount_cents,amount_tax:invoice.tax_cents}))})
    return id
  }
  const fetch=async request=>{
    const url=new URL(request.url),path=url.pathname
    if(!path.startsWith('/v1/tax/'))return fallback(request)
    const fields=request.method==='POST'?new URLSearchParams(await request.text()):null
    calls.push({method:request.method,path,fields})
    if(path==='/v1/tax/transactions/create_reversal') {
      const original=transactions.get(fields.get('original_transaction'))
      if(!original)return Response.json({error:{code:'resource_missing'}},{status:404})
      const lines=[]
      for(let n=0;fields.has(`line_items[${n}][original_line_item]`);n++)lines.push({id:`synthetic-nectar-tax-line-${++count}`,reference:fields.get(`line_items[${n}][reference]`),type:'reversal',livemode:false,tax_behavior:'exclusive',reversal:{original_line_item:fields.get(`line_items[${n}][original_line_item]`)},amount:Number(fields.get(`line_items[${n}][amount]`)),amount_tax:Number(fields.get(`line_items[${n}][amount_tax]`))})
      const id=`synthetic-nectar-tax-${++count}`,transaction={...original,id,type:'reversal',reference:fields.get('reference'),reversal:{original_transaction:original.id},lines}
      transactions.set(id,transaction)
      if(lose){lose=false;return Response.json({error:{code:'synthetic_response_lost'}},{status:503})}
      return Response.json(transaction)
    }
    const match=/^\/v1\/tax\/transactions\/([^/]+)(\/line_items)?$/.exec(path)
    if(match){const transaction=transactions.get(match[1]);if(transaction)return Response.json(match[2]?{object:'list',has_more:false,data:transaction.lines}:transaction)}
    return Response.json({error:{code:'resource_missing'}},{status:404})
  }
  return {fetch,attach,transactions,calls,loseNext:()=>{lose=true}}
}
