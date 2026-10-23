// Intake records preserve the customer or support requester separately from the
// financial preparer. The same id becomes the governed refund after review.
import type { Bindings } from '../auth.server'
import { actorLabel, requireRead, type Actor } from './actor'
import { clockInstant } from './clock'
import { all, commit, guard, insist, newId, one, stmt, type Row } from './core'
import type { Input } from './input'
import { customerSession, type CustomerSession } from './portal-session'
import { prepaidRefundSource } from './prepaid-refund-records'
import { prepaidRevisionGuard } from './prepaid-records'

const liveSession = (env:Bindings,session:CustomerSession) => guard(env,'invalid_customer_session',`EXISTS(SELECT 1 FROM nc_portal_sessions s JOIN nc_customers c ON c.id=s.customer_id JOIN nc_portal_policy p ON p.singleton=1 AND p.revision=s.policy_revision WHERE s.id=? AND s.customer_id=? AND s.revoked_at IS NULL AND s.expires_at>? AND c.erased_at IS NULL)`,session.jti,session.customer,clockInstant(env))
const pending = (env:Bindings,grant:string) => one(env,"SELECT id FROM nc_prepaid_refund_intakes WHERE grant_id=? AND status='pending' UNION ALL SELECT id FROM nc_prepaid_refunds WHERE grant_id=? AND status IN ('pending','approved','claimed','uncertain')",grant,grant)

async function submitIntake(env:Bindings,grantId:string,requester:{kind:'member'|'customer';id:string;label:string},authority:ReturnType<typeof guard>){
  const existing=await pending(env,grantId)
  if(existing)return {id:existing.id,status:'pending'}
  const source=await prepaidRefundSource(env,grantId),{grant,basis,lot}=source,id=newId()
  await commit(env,[authority,prepaidRevisionGuard(env,grant.subscription_id,basis.revision),
    guard(env,'prepaid_refund_not_pending',"NOT EXISTS(SELECT 1 FROM nc_prepaid_refunds WHERE grant_id=? AND status IN ('pending','approved','claimed','uncertain'))",grantId),
    stmt(env,"INSERT INTO nc_prepaid_refund_intakes(id,grant_id,customer_id,subscription_id,requested_by_kind,requested_by_id,requested_at,amount_n,amount_cents,status,kind) VALUES(?,?,?,?,?,?,?,?,?,'pending',?) ON CONFLICT DO NOTHING",id,grantId,grant.customer_id,grant.subscription_id,requester.kind,requester.id,clockInstant(env),lot.remainingN,lot.liabilityCents,grant.kind)],
    {actor:requester.label,action:'prepaid.refund.request',subject:grantId,detail:{category:'unused_paid_credit',customer:grant.customer_id,requesterKind:requester.kind,requester:requester.id}})
  return {id:(await pending(env,grantId))!.id,status:'pending'}
}
export async function requestSupportPrepaidRefund(env:Bindings,actor:Actor,input:Input){
  insist(actor.kind==='member'&&actor.role==='support','forbidden',403)
  requireRead(actor,'payments');requireRead(actor,'invoices')
  const grant=input.text('grant',{max:100})
  const authority=guard(env,'forbidden',"EXISTS(SELECT 1 FROM nc_members m JOIN oa_operators o ON o.email=m.email JOIN oa_sessions s ON s.operator_id=o.id WHERE m.id=? AND m.role='support' AND m.status='active' AND o.status='active' AND s.id=? AND s.revoked_at IS NULL AND o.version=s.operator_version AND s.expires_at>CAST(strftime('%s','now') AS INTEGER)*1000)",actor.id,actor.sessionId)
  return submitIntake(env,grant,{kind:'member',id:actor.id,label:actorLabel(actor)},authority)
}
export async function requestPortalPrepaidRefund(env:Bindings,request:Request,input:Input){
  const session=await customerSession(env,request)
  insist(request.headers.get('origin')===session.origin,'forbidden',403)
  input.only(['grant'])
  const grant=input.text('grant',{max:100})
  insist(await one(env,`SELECT g.id FROM nc_prepaid_grants g JOIN nc_subscriptions s ON s.id=g.subscription_id JOIN nc_customers c ON c.id=g.customer_id WHERE g.id=? AND g.customer_id=? AND s.customer_id=? AND s.billing_mode='live' AND c.erased_at IS NULL`,grant,session.customer,session.customer),'not_found',404)
  return submitIntake(env,grant,{kind:'customer',id:session.customer,label:`customer:portal:${session.customer}`},liveSession(env,session))
}
export async function refundIntakeForPreparation(env:Bindings,id:string){
  const row=await one(env,"SELECT t.* FROM nc_prepaid_refund_intakes t JOIN nc_customers c ON c.id=t.customer_id WHERE t.id=? AND t.status='pending' AND c.erased_at IS NULL",id)
  insist(row,'prepaid_refund_not_pending',409);return row
}
export async function refundIntakeViews(env:Bindings,subscription?:string,customer?:string):Promise<Row[]>{
  const rows=await all(env,`SELECT t.*,i.number AS purchase_number,g.purchase_invoice_id,f.payment_id,g.purchase_line_id,m.unit_label FROM nc_prepaid_refund_intakes t JOIN nc_prepaid_grants g ON g.id=t.grant_id JOIN nc_prepaid_funding_intents f ON f.id=g.funding_id JOIN nc_customers c ON c.id=t.customer_id JOIN nc_invoices i ON i.id=g.purchase_invoice_id LEFT JOIN nc_meters m ON m.id=g.meter_id WHERE t.status='pending' ${subscription?'AND t.subscription_id=?':''} ${customer?'AND t.customer_id=?':''} ORDER BY t.requested_at,t.id`,...(subscription?[subscription]:[]),...(customer?[customer]:[]))
  return rows.map((r:Row)=>({id:r.id,status:'pending',grant:r.grant_id,subscription:r.subscription_id,customer:r.customer_id,invoice:r.purchase_invoice_id,purchaseNumber:r.purchase_number,payment:r.payment_id,purchaseLine:r.purchase_line_id,amountN:r.amount_n,amountCents:r.amount_cents,kind:r.kind,unitLabel:r.unit_label,reasonCategory:'unused_paid_credit',requestedBy:r.requested_by_id,requestedByKind:r.requested_by_kind,requestedAt:r.requested_at,preparedBy:null,preparedAt:null,approvedBy:null,approvalMode:null,source:`/app/prepaid/refunds/${r.id}`,intake:true}))
}
