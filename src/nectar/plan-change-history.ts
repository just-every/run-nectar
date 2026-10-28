import type { Bindings } from '../auth.server'
import { all,canonical,guard,insist,parseJson,type Row } from './core'
import { rateIntervalInvoiceService,type RatingInput } from './rating'
import { BALANCE_SQL } from './balance-sql'

const totals=(r:Row)=>({subtotalCents:r.subtotalCents,taxCents:r.taxCents,totalCents:r.totalCents})

// Rechecking a quote and writing it are separate awaits. Fence every financial
// source again inside the atomic batch, including paid sources whose balance
// stays zero when an unrelated carried credit is issued concurrently.
export function planChangeSourceGuards(env:Bindings,quote:Row){
  const sources=[{id:quote.sourceInvoice,balance_cents:quote.sourceBalance,credits:quote.history.flatMap((h:Row)=>h.credit?[h.credit.id]:[])},
    ...quote.history.flatMap((h:Row)=>h.debit?[{...h.debit,credits:[]}]:[])]
  return [guard(env,'plan_change_source_changed',"EXISTS(SELECT 1 FROM nc_invoices WHERE id=? AND status='issued' AND source_fingerprint=?)",quote.sourceInvoice,quote.sourceFingerprint),
    ...sources.flatMap(source=>[
      guard(env,'plan_change_source_changed',`(SELECT ${BALANCE_SQL} FROM nc_invoices i WHERE i.id=? AND i.status='issued')=?`,source.id,source.balance_cents),
      guard(env,'plan_change_source_already_adjusted','(SELECT COUNT(*) FROM nc_credit_notes WHERE invoice_id=?)=? AND NOT EXISTS(SELECT 1 FROM nc_credit_notes WHERE invoice_id=? AND id NOT IN (SELECT value FROM json_each(?)))',source.id,source.credits.length,source.id,JSON.stringify(source.credits)),
    ])]
}

// Quotes and replacement item identities are immutable. Follow their chain,
// rather than reconstructing historical prices from today's mutable items.
export async function planChangeHistory(env:Bindings,invoice:Row,original:RatingInput,expanded:RatingInput[],item:Row){
  const remaining=await all(env,"SELECT * FROM nc_plan_changes WHERE source_invoice_id=? AND status='approved'",invoice.id)
  const waivedService=remaining.some(change=>parseJson<Row>(change.quote_json,{}).waivedDelta?.totalCents)
  const credits=await all(env,'SELECT * FROM nc_credit_notes WHERE invoice_id=?',invoice.id)
  insist(credits.every(c=>remaining.some(r=>r.id===c.plan_change_id&&r.credit_id===c.id)),'plan_change_source_already_adjusted',409)
  let services=expanded,items=original.items,prices=original.prices
  const history:Row[]=[]
  while(remaining.length){
    // Independent component chains still share one invoice and tax basis.
    // The saved history establishes their actual approval order.
    const index=remaining.findIndex(r=>canonical(parseJson<Row>(r.quote_json,{}).history?.map((h:Row)=>h.id)??[])===canonical(history.map(h=>h.id)))
    insist(index!==-1,'plan_change_history_changed',409)
    const [change]=remaining.splice(index,1),quote=parseJson<Row>(change.quote_json,{})
    insist(quote.sourceInvoice===invoice.id&&quote.sourceFingerprint===invoice.source_fingerprint,'plan_change_history_changed',409)
    const service=services.findIndex(input=>input.items.some(i=>i.id===change.item_id))
    insist(service!==-1,'plan_change_history_changed',409)
    const current=services[service],active=current.items.find(i=>i.id===change.item_id)!
    const before=rateIntervalInvoiceService(original,services)
    insist(canonical(totals(before))===canonical(quote.before),'plan_change_history_changed',409)
    const next:RatingInput={...current,prices:{...current.prices,[change.new_price_id]:quote.targetPrice},items:[...current.items.map(i=>i.id===change.item_id?{...i,to:change.effective_date}:i),{id:change.new_item_id,priceId:change.new_price_id,quantity:change.new_quantity,from:change.effective_date,to:active.to}]}
    const nextServices=services.map((input,index)=>index===service?next:input)
    // A scheduled change leaves this period's service intact.
    const after=change.mode==='period_end'?before:rateIntervalInvoiceService(original,nextServices)
    insist(canonical(totals(after))===canonical(quote.after),'plan_change_history_changed',409)
    const debit=change.invoice_id?(await all(env,`SELECT i.id,i.status,${BALANCE_SQL} AS balance_cents FROM nc_invoices i WHERE i.id=?`,change.invoice_id))[0]:null
    insist(!change.invoice_id||debit?.status==='issued','plan_change_debit_not_issued',409)
    insist(!change.invoice_id||!await all(env,'SELECT id FROM nc_credit_notes WHERE invoice_id=?',change.invoice_id).then(rows=>rows.length),'plan_change_source_already_adjusted',409)
    history.push({id:change.id,basis:change.basis,debit,credit:credits.find(c=>c.id===change.credit_id)??null})
    services=nextServices
    const live=items.find(i=>i.id===change.item_id)
    insist(live,'plan_change_history_changed',409)
    items=[...items.map(i=>i.id===change.item_id?{...i,to:change.effective_date}:i),{id:change.new_item_id,priceId:change.new_price_id,quantity:change.new_quantity,from:change.effective_date,to:live.to}]
    prices={...prices,[change.new_price_id]:quote.targetPrice}
  }
  const service=services.findIndex(input=>input.items.some(i=>i.id===item.id))
  insist(service!==-1,'plan_change_history_changed',409)
  const current=services[service]
  const active=current.items.find(i=>i.id===item.id)
  const live=items.find(i=>i.id===item.id)
  insist(active&&live&&live.priceId===item.price_id&&live.quantity===item.quantity&&live.from===item.effective_from&&live.to===item.effective_to,'plan_change_history_changed',409)
  // Validate live dates against the retained timeline, rather than the clipped
  // service window of a co-termed stub.
  return {input:current,services,service,items,prices,history,waivedService}
}
