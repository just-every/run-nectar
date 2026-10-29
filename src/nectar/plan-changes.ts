import type { Bindings } from '../auth.server'
import { actorLabel,can,canRead,requireAny,requireMember,requireRead,type Actor } from './actor'
import { all,commit,fingerprint,guard,insist,newId,now,one,parseJson,stmt,type Row } from './core'
import { clockInstant } from './clock'
import { requireBusiness } from './business'
import { addDays,localDate } from './dates'
import { lifecyclePolicy } from './lifecycle-policy'
import { requireFreshFactor } from './mfa'
import { requireSubscription } from './subscriptions'
import { Input } from './input'
import { planChangeLine,planChangeQuote } from './plan-change-preview'
import { creditBasis,creditPolicy,authorizeCredit } from './credit-policy'
import { issuedInvoice } from './receivables'
import { documentNumberAllocation } from './invoice-numbering'
import { REVENUE_POLICY_VERSION } from './revenue-allocation'
import { billingComponentClaimStatements } from './billing-components'
import { invoiceContent } from './invoice-content'
import { carriedUsageCredits,usageCreditApplicationLines } from './usage-correction-records'
import { planChangeSourceGuards } from './plan-change-history'

const reason='Unused advance service from approved plan change'
const quoteView=(q:Row)=>({effectiveDate:q.effectiveDate,period:q.period,policy:q.policy,mode:q.mode,before:q.before,after:q.after,delta:q.delta,waivedDelta:q.waivedDelta})
export async function preparePlanChange(env: Bindings, actor: Actor, input: Input) {
  requireAny(actor,['records','draft']);requireRead(actor,'subscriptions')
  input.only(['subscription','item','price','quantity','mode','returnTo'])
  const generation=(await one(env,'SELECT value FROM nc_privacy_generation WHERE id=1'))!.value
  const sub=await requireSubscription(env,input.text('subscription')),item=await one(env,'SELECT * FROM nc_items WHERE id=? AND subscription_id=?',input.text('item'),sub.id)
  insist(item&&sub.billing_mode==='live'&&!sub.erased_at,'item_not_found',404)
  const mode=input.text('mode');insist(['immediate','period_end'].includes(mode),'invalid_change_mode')
  const policy=await lifecyclePolicy(env);insist(policy.prorationPolicy,'proration_policy_required',409)
  const price=await one(env,"SELECT * FROM nc_prices WHERE id=? AND status='active'",input.text('price'));insist(price,'price_not_found',404)
  const quantity=price.kind==='seat'?input.integer('quantity',{min:1,max:1000000})!:1,id=newId(),newItem=newId(),b=await requireBusiness(env),date=localDate(clockInstant(env),b.timezone)
  const quote=await planChangeQuote(env,sub,item,price.id,quantity,mode,date,policy.prorationPolicy,newItem),cp=await creditPolicy(env),statements=[
    guard(env,'stale','(SELECT value FROM nc_privacy_generation WHERE id=1)=?',generation),
    guard(env,'stale','EXISTS(SELECT 1 FROM nc_subscriptions WHERE id=? AND revision=?)',sub.id,sub.revision),
    guard(env,'policy_changed','COALESCE((SELECT revision FROM nc_lifecycle_policy WHERE singleton=1),0)=?',policy.revision),
    ...planChangeSourceGuards(env,quote),
    stmt(env,'INSERT INTO nc_plan_changes(id,subscription_id,customer_id,item_id,new_item_id,new_price_id,new_quantity,effective_date,mode,policy,policy_revision,subscription_revision,source_invoice_id,quote_json,basis,prepared_by,prepared_name,prepared_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',id,sub.id,sub.customer_id,item.id,newItem,price.id,quantity,quote.effectiveDate,mode,policy.prorationPolicy,policy.revision,sub.revision,quote.sourceInvoice,JSON.stringify(quote),quote.basis,actor.id,actorLabel(actor),now()),
  ]
  if(quote.delta.totalCents<0&&can(actor,'approve')){
    requireMember(actor,'approve')
    const invoice=await issuedInvoice(env,quote.sourceInvoice),request=newId()
    statements.push(stmt(env,'INSERT INTO nc_credit_requests(id,invoice_id,amount_cents,reason,prepared_by,prepared_name,prepared_at,basis,policy_revision,balance_cents) VALUES(?,?,?,?,?,?,?,?,?,?)',request,invoice.id,-quote.delta.totalCents,reason,actor.id,actorLabel(actor),now(),await creditBasis(invoice,cp),cp.revision,invoice.balance_cents),stmt(env,'INSERT INTO nc_plan_change_credit_requests(request_id,change_id,invoice_id,customer_id) VALUES(?,?,?,?)',request,id,invoice.id,sub.customer_id))
  }
  await commit(env,statements,{actor:actorLabel(actor),action:'plan-change.prepare',subject:id,detail:{subscription:sub.id,mode,policy:policy.prorationPolicy,effective:quote.effectiveDate,basis:quote.basis,delta:quote.delta}})
  return {id:sub.id,change:id,quote:canRead(actor,'invoices')?quote:quoteView(quote)}
}
async function documentInput(env: Bindings, row: Row, date: string) {
  const b=await requireBusiness(env)
  return {version:'nectar-plan-change-1',date,planChange:row.id,quoteBasis:row.basis,invoiceContent:await invoiceContent(env,b,row.customer_id),usageCredits:await carriedUsageCredits(env,row.customer_id)}
}
export async function planChangeInvoiceFingerprint(env: Bindings, invoice: Row) {
  const saved=parseJson<Row>(invoice.calculation_json,{}).inputs,row=await one(env,"SELECT * FROM nc_plan_changes WHERE id=? AND status='approved' AND invoice_id=?",saved.planChange,invoice.id)
  insist(row&&row.basis===saved.quoteBasis,'plan_change_source_changed',409)
  return await fingerprint(await documentInput(env,row,saved.date))
}
async function debitInvoice(env: Bindings, actor: Actor, row: Row, quote: Row, date: string) {
  const run=newId(),invoice=newId(),line=planChangeLine(row,quote),inputs=await documentInput(env,row,date),basis=await fingerprint(inputs),at=now()
  const lines=[line,...usageCreditApplicationLines(inputs.usageCredits,quote.delta.totalCents,{start:date,end:addDays(date,1)})]
  const calculation={version:inputs.version,fingerprint:basis,inputs,tax:{rule:'exact approved issued-source tax difference',historicalTaxDeltaCents:quote.delta.taxCents},consumedEvents:[]}
  const statements=[
    stmt(env,"INSERT INTO nc_bill_runs(id,period,cutoff_at,calc_version,status,summary_json,created_by,created_at,kind) VALUES(?,?,?,?,'draft',?,?,?,'manual')",run,date.slice(0,7),at,inputs.version,JSON.stringify({invoices:1,shadow:0,totals:{subtotal:quote.delta.subtotalCents,tax:quote.delta.taxCents,total:quote.delta.totalCents},exceptions:{},planChange:row.id}),actorLabel(actor),at),
    stmt(env,"INSERT INTO nc_invoices(id,bill_run_id,customer_id,subscription_id,invoice_kind,period_start,period_end,status,subtotal_cents,tax_cents,total_cents,calc_version,source_fingerprint,calculation_json,comparison_json,exceptions_json,created_at,approved_fingerprint,approved_by,approved_at) VALUES(?,?,?,?,'manual',?,?,'approved',?,?,?,?,?,?,'{}','[]',?,?,?,?)",invoice,run,row.customer_id,row.subscription_id,date,addDays(date,1),quote.delta.subtotalCents,quote.delta.taxCents,quote.delta.totalCents,inputs.version,basis,JSON.stringify(calculation),at,basis,actorLabel(actor),at),
    ...lines.map((l,index)=>stmt(env,'INSERT INTO nc_invoice_lines(id,invoice_id,seq,kind,description,quantity,unit_amount,amount_cents,taxable,price_id,meter_id,period_start,period_end,evidence_json) VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?,?,?)',newId(),invoice,index+1,l.kind,l.description,l.quantity,l.unitAmount,l.amountCents,l.taxable?1:0,l.priceId,l.periodStart,l.periodEnd,JSON.stringify(l.evidence))),
  ]
  return {invoice,statements}
}
export async function decidePlanChange(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor,'approve');input.only(['change','decision','returnTo'])
  const row=await one(env,'SELECT * FROM nc_plan_changes WHERE id=?',input.text('change'));insist(row,'change_not_found',404)
  insist(row.status==='pending','already_decided',409)
  const decision=input.text('decision');insist(['approved','rejected'].includes(decision),'invalid_decision')
  const pending=guard(env,'already_decided',"EXISTS(SELECT 1 FROM nc_plan_changes WHERE id=? AND status='pending')",row.id)
  if(decision==='rejected'){
    await commit(env,[pending,stmt(env,"UPDATE nc_plan_changes SET status='rejected',decided_by=?,decided_at=? WHERE id=?",actor.id,now(),row.id)],{actor:actorLabel(actor),action:'plan-change.reject',subject:row.id});return {id:row.subscription_id,status:'rejected'}
  }
  insist(row.prepared_by!==actor.id,'second_approver_required',409)
  const generation=(await one(env,'SELECT value FROM nc_privacy_generation WHERE id=1'))!.value
  const sub=await requireSubscription(env,row.subscription_id),item=await one(env,'SELECT * FROM nc_items WHERE id=?',row.item_id),policy=await lifecyclePolicy(env)
  insist(!sub.erased_at,'customer_erased',410)
  insist(sub.revision===row.subscription_revision&&policy.revision===row.policy_revision,'stale',409)
  const b=await requireBusiness(env),saved=parseJson<Row>(row.quote_json,{}),date=localDate(clockInstant(env),b.timezone)
  // An immediate quote names its actual business-local date; approval tomorrow
  // must be prepared again rather than silently changing its proration.
  insist(row.mode==='immediate'?row.effective_date===date:date<=row.effective_date,'plan_change_date_changed',409)
  insist(!await one(env,"SELECT 1 FROM nc_invoices i WHERE i.subscription_id=? AND i.status='issued' AND i.period_end>? AND i.id<>? AND NOT EXISTS(SELECT 1 FROM nc_plan_changes c WHERE c.invoice_id=i.id AND c.status='approved' AND c.source_invoice_id=?)",sub.id,row.effective_date,row.source_invoice_id,row.source_invoice_id),'plan_change_source_already_adjusted',409)
  const quote=await planChangeQuote(env,sub,item!,row.new_price_id,row.new_quantity,row.mode,saved.mode==='period_end'?saved.period.start:row.effective_date,row.policy,row.new_item_id)
  insist(quote.basis===row.basis,'stale',409)
  const statements=[pending,guard(env,'stale','(SELECT value FROM nc_privacy_generation WHERE id=1)=?',generation),guard(env,'stale','EXISTS(SELECT 1 FROM nc_subscriptions WHERE id=? AND revision=?)',sub.id,sub.revision),guard(env,'policy_changed','COALESCE((SELECT revision FROM nc_lifecycle_policy WHERE singleton=1),0)=?',row.policy_revision),...planChangeSourceGuards(env,quote)]
  let debit:string|null=null,credit:string|null=null
  if(quote.delta.totalCents>0&&row.policy==='invoice_now'){
    const prepared=await debitInvoice(env,actor,row,quote,date);debit=prepared.invoice;statements.push(...prepared.statements)
  }else if(quote.delta.totalCents>0&&row.policy==='next_invoice'){
    statements.push(stmt(env,'INSERT INTO nc_plan_change_adjustments(id,subscription_id,customer_id,line_json,tax_cents) VALUES(?,?,?,?,?)',row.id,sub.id,sub.customer_id,JSON.stringify(planChangeLine(row,quote)),quote.delta.taxCents))
  }else if(quote.delta.totalCents<0){
    const original=await issuedInvoice(env,quote.sourceInvoice),binding=await one(env,'SELECT request_id FROM nc_plan_change_credit_requests WHERE change_id=?',row.id)
    insist(binding,'credit_request_not_found',409)
    const auth=await authorizeCredit(env,actor,Input.of({request:binding.request_id}),original,-quote.delta.totalCents,reason,undefined,undefined,row.id)
    const customer=await one(env,'SELECT * FROM nc_customers WHERE id=?',sub.customer_id),allocation=await documentNumberAllocation(env,b,customer!,'credit-note'),at=clockInstant(env)
    credit=newId();const applied=Math.min(-quote.delta.totalCents,Math.max(0,original.balance_cents))
    statements.push(...auth.guards,...allocation.statements,stmt(env,'INSERT INTO nc_credit_notes(id,number,invoice_id,customer_id,amount_cents,reason,issued_by,issued_at,applied_cents,subtotal_cents,tax_cents,plan_change_id,billing_entity_id,billing_route_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',credit,allocation.number,original.id,sub.customer_id,-quote.delta.totalCents,reason,actorLabel(actor),at,applied,-quote.delta.subtotalCents,-quote.delta.taxCents,row.id,allocation.entityId,allocation.routeJson),stmt(env,'INSERT INTO nc_revenue_credits(id,credit_id,invoice_id,customer_id,recognition_date,amount_cents,policy_version,basis_json) VALUES(?,?,?,?,?,?,?,?)',credit,credit,original.id,sub.customer_id,`${date.slice(0,7)}-01`,quote.delta.subtotalCents,REVENUE_POLICY_VERSION,JSON.stringify({method:'unused-advance-plan-change',planChange:row.id,sourceInvoice:original.id,originalTaxUnchanged:true,taxDeltaCents:quote.delta.taxCents,servicePeriodDeltas:quote.revenue.map(e=>({period:e.period,deltaCents:e.amountCents}))})),stmt(env,"UPDATE nc_credit_requests SET status='issued',approved_by=?,approved_at=?,credit_id=? WHERE id=?",actorLabel(actor),at,credit,binding.request_id))
  }
  statements.push(stmt(env,'UPDATE nc_items SET effective_to=? WHERE id=?',row.effective_date,row.item_id),stmt(env,"INSERT INTO nc_items(id,subscription_id,price_id,quantity,effective_from,effective_to,origin,created_at) VALUES(?,?,?,?,?,?,'native',?)",row.new_item_id,sub.id,row.new_price_id,row.new_quantity,row.effective_date,item!.effective_to,now()),stmt(env,'UPDATE nc_subscriptions SET revision=?,updated_at=? WHERE id=?',newId(),now(),sub.id),stmt(env,"UPDATE nc_plan_changes SET status='approved',decided_by=?,decided_at=?,invoice_id=?,credit_id=? WHERE id=?",actor.id,now(),debit,credit,row.id))
  // The original advance invoice plus this saved delta covers the changed
  // current service. Claim its new stub so an ordinary run cannot charge it again.
  for(const window of quote.windows)statements.push(...billingComponentClaimStatements(env,sub.id,quote.sourceInvoice,window))
  await commit(env,statements,{actor:actorLabel(actor),action:'plan-change.approve',subject:row.id,detail:{subscription:sub.id,policy:row.policy,effective:row.effective_date,delta:quote.delta,invoice:debit,credit}})
  if(debit){const {finalise}=await import('./billruns');await finalise(env,actor,Input.of({invoice:debit,issue_date:date}))}
  return {id:sub.id,status:'approved',change:row.id,invoice:debit,credit,delta:quote.delta}
}
// Sales prepare a priced quote, never a credit request or invoice read.
export async function preparePlanChangeCredit(env:Bindings,actor:Actor,input:Input){
  requireMember(actor,'approve');await requireFreshFactor(env,actor)
  input.only(['change','returnTo'])
  const generation=(await one(env,'SELECT value FROM nc_privacy_generation WHERE id=1'))!.value
  const row=await one(env,"SELECT * FROM nc_plan_changes WHERE id=? AND status='pending'",input.text('change'))
  insist(row,'pending_change_not_found',404)
  const saved=parseJson<Row>(row.quote_json,{}),sub=await requireSubscription(env,row.subscription_id),item=await one(env,'SELECT * FROM nc_items WHERE id=?',row.item_id),policy=await lifecyclePolicy(env)
  insist(!sub.erased_at,'customer_erased',410)
  insist(saved.delta?.totalCents<0,'no_credit_required',409)
  insist(sub.revision===row.subscription_revision&&policy.revision===row.policy_revision,'stale',409)
  const b=await requireBusiness(env),date=localDate(clockInstant(env),b.timezone)
  insist(row.mode==='immediate'?date===row.effective_date:date<=row.effective_date,'plan_change_date_changed',409)
  const quote=await planChangeQuote(env,sub,item!,row.new_price_id,row.new_quantity,row.mode,row.mode==='period_end'?saved.period.start:row.effective_date,row.policy,row.new_item_id)
  insist(quote.basis===row.basis,'stale',409)
  const invoice=await issuedInvoice(env,row.source_invoice_id),cp=await creditPolicy(env),request=newId()
  await commit(env,[guard(env,'stale','(SELECT value FROM nc_privacy_generation WHERE id=1)=?',generation),...planChangeSourceGuards(env,quote),guard(env,'plan_credit_already_prepared','NOT EXISTS(SELECT 1 FROM nc_plan_change_credit_requests WHERE change_id=?)',row.id),
    stmt(env,'INSERT INTO nc_credit_requests(id,invoice_id,amount_cents,reason,prepared_by,prepared_name,prepared_at,basis,policy_revision,balance_cents) VALUES(?,?,?,?,?,?,?,?,?,?)',request,invoice.id,-quote.delta.totalCents,reason,actor.id,actorLabel(actor),now(),await creditBasis(invoice,cp),cp.revision,invoice.balance_cents),
    stmt(env,'INSERT INTO nc_plan_change_credit_requests(request_id,change_id,invoice_id,customer_id) VALUES(?,?,?,?)',request,row.id,invoice.id,row.customer_id)],{actor:actorLabel(actor),action:'plan-change.credit.prepare',subject:row.id,detail:{request,invoice:invoice.id,amount:-quote.delta.totalCents,basis:row.basis}})
  return {id:row.subscription_id,change:row.id,request}
}
export async function planChangesFor(env: Bindings, actor: Actor, subscription: string) {
  requireRead(actor,'subscriptions')
  const full=canRead(actor,'invoices'),rows=await all(env,'SELECT c.*,p.version AS target_version,r.name AS target_name FROM nc_plan_changes c JOIN nc_prices p ON p.id=c.new_price_id JOIN nc_products r ON r.id=p.product_id WHERE c.subscription_id=? ORDER BY c.prepared_at,c.id',subscription)
  if(!full)return rows.filter(r=>r.prepared_by===actor.id&&(can(actor,'draft')||can(actor,'records'))).map(r=>({id:r.id,subscription_id:r.subscription_id,new_price_id:r.new_price_id,new_quantity:r.new_quantity,...(canRead(actor,'catalog')?{target_name:r.target_name,target_version:r.target_version}:{}),effective_date:r.effective_date,mode:r.mode,policy:r.policy,status:r.status,prepared_by:r.prepared_by,prepared_name:r.prepared_name,prepared_at:r.prepared_at,quote:quoteView(parseJson<Row>(r.quote_json,{}))}))
  const cp=await creditPolicy(env)
  const result=[]
  for(const r of rows){const credit=await one(env,'SELECT c.* FROM nc_plan_change_credit_requests b JOIN nc_credit_requests c ON c.id=b.request_id WHERE b.change_id=?',r.id);result.push({...r,quote:parseJson<Row>(r.quote_json,{}),quote_json:undefined,creditRequest:credit?{id:credit.id,preparedBy:credit.prepared_by,requiresOther:cp.two_person_above_cents!==null&&credit.amount_cents>cp.two_person_above_cents}:null})}
  return result
}
