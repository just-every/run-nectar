// A reviewed setup becomes ordinary billing records in the proposal's one batch.
import type { Bindings } from '../auth.server'
import { actorLabel, type Actor } from './actor'
import { guard, newId, now, stmt, type Row } from './core'
import { priceStatements } from './price-drafts'
import { notIssuedGuard } from './subscriptions'

export function setupStatements(env: Bindings, actor: Actor, payload: Row, proposal: Row) {
  const p=payload.plan, at=now(),by=actorLabel(actor),revision=newId(),statements:D1PreparedStatement[]=[]
  const customer=p.customer,sub=p.subscription
  if(customer.create) statements.push(
    guard(env,'external_id_in_use','NOT EXISTS(SELECT 1 FROM nc_customers WHERE external_id=?)',customer.externalId),
    stmt(env,"INSERT INTO nc_customers(id,external_id,name,billing_email,address,tax_exempt,tax_exempt_ref,origin,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'native',?,?,?)",customer.id,customer.externalId,customer.name,customer.billingEmail,customer.address,customer.taxExempt?1:0,customer.taxExemptRef,newId(),at,at))
  for(const product of p.products.filter((v:Row)=>v.create)) statements.push(
    guard(env,'code_in_use','NOT EXISTS(SELECT 1 FROM nc_products WHERE code=?)',product.code),
    stmt(env,"INSERT INTO nc_products(id,code,name,description,status,origin,revision,created_at) VALUES(?,?,?,'','active','native',?,?)",product.id,product.code,product.name,newId(),at))
  for(const price of p.prices.filter((v:Row)=>v.create))statements.push(...priceStatements(env,actor,{...price,productCode:p.products.find((v:Row)=>v.id===price.product).code},price.id))
  if(sub.create) statements.push(stmt(env,"INSERT INTO nc_subscriptions(id,customer_id,external_id,anchor_day,start_date,trial_end,end_date,billing_mode,origin,revision,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'live','native',?,?,?,?)",sub.id,customer.id,sub.externalId,sub.anchorDay,sub.startDate,sub.trialEnd,sub.endDate,revision,by,at,at))
  else {
    statements.push(guard(env,'proposal_stale','EXISTS(SELECT 1 FROM nc_subscriptions WHERE id=? AND revision=?)',sub.id,sub.revision),notIssuedGuard(env,sub.id,sub.effectiveDate))
    for(const item of p.itemUpdates)statements.push(stmt(env,'UPDATE nc_items SET price_id=?,quantity=?,effective_from=?,effective_to=?,change_id=? WHERE id=? AND subscription_id=?',item.priceId,item.quantity,item.from,item.to,proposal.id,item.id,sub.id))
    statements.push(stmt(env,'UPDATE nc_subscriptions SET revision=?,updated_at=? WHERE id=?',revision,at,sub.id))
  }
  if(p.renewal) {
    const term=p.renewal
    statements.push(stmt(env,"INSERT INTO nc_renewal_terms(id,subscription_id,subscription_revision,start_date,end_date,months,auto_renew,notice_days,uplift_percent,status,prepared_by_id,prepared_by,created_at,decided_by,decided_at,approval_mode,revision,quote) VALUES(?,?,?,?,?,?,?,?,?,'active',?,?,?,?,?,'two-person',?,?)",term.id,sub.id,revision,term.start_date,term.end_date,term.months,term.auto_renew,term.notice_days,term.uplift_percent,proposal.prepared_by_id,proposal.created_by,proposal.created_at,by,at,newId(),term.quote))
  }
  for(const item of p.items.filter((v:Row)=>v.create))statements.push(stmt(env,"INSERT INTO nc_items(id,subscription_id,price_id,quantity,effective_from,effective_to,change_id,origin,created_at) VALUES(?,?,?,?,?,?,?,'native',?)",item.id,sub.id,item.priceId,item.quantity,item.from,item.to,proposal.id,at))
  for(const a of p.amendments)statements.push(stmt(env,"INSERT INTO nc_amendments(id,subscription_id,kind,value,price_id,effective_from,effective_to,note,clause,status,origin,proposal_id,created_by,created_at,decided_by,decided_at,prepared_by_id) VALUES(?,?,?,?,?,?,?,?,?,'approved','proposal',?,?,?,?,?,?)",a.id,sub.id,a.kind,a.value,a.priceId,a.from,a.to,a.note,a.clause,proposal.id,proposal.created_by,proposal.created_at,by,at,proposal.prepared_by_id))
  statements.push(stmt(env,"INSERT INTO nc_contracts(id,subscription_id,subscription_revision,clause,terms_json,status,prepared_by_id,prepared_by,created_at,decided_by,decided_at) VALUES(?,?,?,?,?,'approved',?,?,?,?,?)",p.contract.id,sub.id,sub.revision??revision,p.contract.clause,JSON.stringify(p.contract.terms),proposal.prepared_by_id,proposal.created_by,proposal.created_at,by,at))
  return {statements,result:{subscription:sub.id,customer:customer.id,contract:p.contract.id,prices:p.prices.map((v:Row)=>v.id),sourceSha256:payload.source.sha256},audit:{actor:by,action:'setup.apply',subject:sub.id,detail:{proposal:proposal.id,preparedBy:proposal.created_by,sourceSha256:payload.source.sha256,createdCustomer:customer.create,createdSubscription:sub.create}}}
}
