import type { Bindings } from '../auth.server'
import { all,canonical,insist,parseJson,type Row } from './core'
import { rateIntervalService,type RatingInput } from './rating'
import { BALANCE_SQL } from './balance-sql'

const totals=(r:Row)=>({subtotalCents:r.subtotalCents,taxCents:r.taxCents,totalCents:r.totalCents})

// Quotes and replacement item identities are immutable. Follow their chain,
// rather than reconstructing historical prices from today's mutable items.
export async function planChangeHistory(env:Bindings,invoice:Row,original:RatingInput,expanded:RatingInput,item:Row){
  const remaining=await all(env,"SELECT * FROM nc_plan_changes WHERE source_invoice_id=? AND status='approved'",invoice.id)
  const credits=await all(env,'SELECT * FROM nc_credit_notes WHERE invoice_id=?',invoice.id)
  insist(credits.every(c=>remaining.some(r=>r.id===c.plan_change_id&&r.credit_id===c.id)),'plan_change_source_already_adjusted',409)
  let current=expanded,head=expanded.items[0].id
  const history:Row[]=[]
  while(remaining.length){
    const index=remaining.findIndex(r=>r.item_id===head)
    insist(index!==-1,'plan_change_history_changed',409)
    const [change]=remaining.splice(index,1),quote=parseJson<Row>(change.quote_json,{})
    insist(quote.sourceInvoice===invoice.id&&quote.sourceFingerprint===invoice.source_fingerprint,'plan_change_history_changed',409)
    const before=rateIntervalService(current)
    insist(canonical(totals(before))===canonical(quote.before),'plan_change_history_changed',409)
    const next:RatingInput={...current,prices:{...current.prices,[change.new_price_id]:quote.targetPrice},items:[...current.items.map(i=>i.id===head?{...i,to:change.effective_date}:i),{id:change.new_item_id,priceId:change.new_price_id,quantity:change.new_quantity,from:change.effective_date,to:expanded.items[0].to}]}
    // A scheduled change leaves this period's service intact.
    const after=change.mode==='period_end'?before:rateIntervalService(next)
    insist(canonical(totals(after))===canonical(quote.after),'plan_change_history_changed',409)
    const debit=change.invoice_id?(await all(env,`SELECT i.id,i.status,${BALANCE_SQL} AS balance_cents FROM nc_invoices i WHERE i.id=?`,change.invoice_id))[0]:null
    insist(!change.invoice_id||debit?.status==='issued','plan_change_debit_not_issued',409)
    insist(!change.invoice_id||!await all(env,'SELECT id FROM nc_credit_notes WHERE invoice_id=?',change.invoice_id).then(rows=>rows.length),'plan_change_source_already_adjusted',409)
    history.push({id:change.id,basis:change.basis,debit,credit:credits.find(c=>c.id===change.credit_id)??null})
    current=next;head=change.new_item_id
  }
  const active=current.items.find(i=>i.id===item.id)
  insist(head===item.id&&active&&active.priceId===item.price_id&&active.quantity===item.quantity&&(history.length?active.from:original.items.find(i=>i.id===item.id)?.from)===item.effective_from,'plan_change_history_changed',409)
  // The saved original may have been a co-termed stub. Its live item began
  // before that service window, so only replacement items bind their start.
  return {input:current,history}
}
