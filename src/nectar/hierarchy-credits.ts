// Apply an existing parent goodwill grant to the frozen child's receivable.
// The debit stays on the parent's balance ledger; no child grant is invented.
import type { Bindings } from '../auth.server'
import { actorLabel,can,requireMember,requireOwner,type Actor } from './actor'
import { all,commit,fingerprint,guard,insist,newId,one,stmt,type Row } from './core'
import { balanceSources } from './balance'
import { creditPolicy } from './credit-policy'
import { clockInstant } from './clock'
import { cents } from './decimal'
import { Input } from './input'
import { requireFreshFactor } from './mfa'
import { BALANCE_SQL } from './balance-sql'
import { issuedInvoice } from './receivables'
const availableSQL="g.amount_cents-COALESCE((SELECT SUM(a.amount_cents) FROM nc_balance_entries a WHERE a.grant_id=g.id),0)"
async function shareSource(env:Bindings,input:Input) {
  const invoice=await issuedInvoice(env,input.text('invoice'))
  const payer=await one(env,`SELECT p.*,h.revision AS current_revision,h.parent_id,c.revision AS parent_revision,c.billing_entity_id AS parent_entity,d.revision AS child_revision,d.billing_entity_id AS child_entity FROM nc_invoice_payers p JOIN nc_customer_hierarchies h ON h.customer_id=p.customer_id JOIN nc_customers c ON c.id=p.payer_id JOIN nc_customers d ON d.id=p.customer_id WHERE p.invoice_id=? AND c.erased_at IS NULL AND d.erased_at IS NULL AND c.status='active' AND d.status='active'`,invoice.id)
  insist(payer&&payer.parent_id===payer.payer_id&&payer.parent_entity===payer.child_entity&&payer.current_revision===payer.hierarchy_revision,'hierarchy_payer_changed',409)
  const grant=await one(env,`SELECT g.id,g.customer_id,${availableSQL} AS available FROM nc_balance_entries g WHERE g.id=? AND g.kind='goodwill' AND g.customer_id=?`,input.text('grant'),payer.payer_id)
  insist(grant,'parent_goodwill_not_found',404)
  const amount=cents(input.text('amount')),reason=input.text('reason',{max:500}),policy=await creditPolicy(env)
  insist(amount>0&&amount<=invoice.balance_cents&&amount<=grant.available,'shared_credit_exceeds_balance',409)
  const basis=await fingerprint({invoice:invoice.id,balance:invoice.balance_cents,payer,grant,amount,reason,policyRevision:policy.revision,threshold:policy.two_person_above_cents})
  return {invoice,payer,grant,amount,reason,policy,basis}
}
function fences(env:Bindings,s:Awaited<ReturnType<typeof shareSource>>) {
  return [guard(env,'shared_credit_stale',`(SELECT ${BALANCE_SQL} FROM nc_invoices i WHERE i.id=? AND i.status='issued')=?`,s.invoice.id,s.invoice.balance_cents),
    guard(env,'shared_credit_stale',`(SELECT ${availableSQL} FROM nc_balance_entries g WHERE g.id=? AND g.customer_id=? AND g.kind='goodwill')=?`,s.grant.id,s.payer.payer_id,s.grant.available),
    guard(env,'shared_credit_stale','COALESCE((SELECT revision FROM nc_credit_policy WHERE singleton=1),0)=?',s.policy.revision),
    guard(env,'hierarchy_payer_changed','EXISTS(SELECT 1 FROM nc_customer_hierarchies WHERE customer_id=? AND parent_id=? AND revision=?)',s.payer.customer_id,s.payer.payer_id,s.payer.current_revision),
    ...[[s.payer.payer_id,s.payer.parent_revision],[s.payer.customer_id,s.payer.child_revision]].map(([id,revision])=>guard(env,'hierarchy_payer_changed',"EXISTS(SELECT 1 FROM nc_customers WHERE id=? AND revision=? AND erased_at IS NULL AND status='active')",id,revision))]
}
export async function prepareHierarchyCredit(env:Bindings,actor:Actor,input:Input) {
  requireOwner(actor);await requireFreshFactor(env,actor)
  input.only(['invoice','grant','amount','reason','consent','returnTo']);insist(input.flag('consent'),'shared_credit_consent_required')
  const s=await shareSource(env,input),id=newId()
  await commit(env,[...fences(env,s),stmt(env,'INSERT INTO nc_hierarchy_credit_shares(id,customer_id,invoice_id,grant_id,amount_cents,reason,basis,policy_revision,prepared_by_id,prepared_name,prepared_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',id,s.payer.payer_id,s.invoice.id,s.grant.id,s.amount,s.reason,s.basis,s.policy.revision,actor.id,actorLabel(actor),clockInstant(env))],{actor:actorLabel(actor),action:'hierarchy.credit.prepare',subject:id,detail:{parent:s.payer.payer_id,invoice:s.invoice.id,grant:s.grant.id,amount:s.amount,basis:s.basis,consent:true}})
  return {id:s.invoice.id,request:id}
}
export async function approveHierarchyCredit(env:Bindings,actor:Actor,input:Input) {
  requireMember(actor,'approve');await requireFreshFactor(env,actor)
  input.only(['request','confirm','returnTo']);insist(input.flag('confirm'),'shared_credit_confirmation_required')
  const r=await one(env,'SELECT * FROM nc_hierarchy_credit_shares WHERE id=?',input.text('request'))
  insist(r,'shared_credit_not_found',404);insist(r.status==='pending','shared_credit_already_executed',409)
  const s=await shareSource(env,Input.of({invoice:r.invoice_id,grant:r.grant_id,amount:(r.amount_cents/100).toFixed(2),reason:r.reason}))
  insist(s.basis===r.basis,'shared_credit_stale',409)
  const different=r.prepared_by_id!==actor.id,above=s.policy.two_person_above_cents!==null&&r.amount_cents>s.policy.two_person_above_cents
  insist(!above||different,'second_approver_required',409)
  const id=newId(),at=clockInstant(env),by=actorLabel(actor),mode=different?'two-person':'single-person'
  await commit(env,[...fences(env,s),guard(env,'shared_credit_already_executed',"EXISTS(SELECT 1 FROM nc_hierarchy_credit_shares WHERE id=? AND status='pending')",r.id),
    guard(env,'shared_credit_preparer_inactive',"EXISTS(SELECT 1 FROM nc_members WHERE id=? AND status='active' AND role='owner')",r.prepared_by_id),
    guard(env,'forbidden',"EXISTS(SELECT 1 FROM nc_members WHERE id=? AND status='active' AND role IN ('owner','finance'))",actor.id),
    stmt(env,"INSERT INTO nc_balance_entries(id,customer_id,kind,amount_cents,grant_id,invoice_id,mode,created_by,created_at) VALUES(?,?,'application',?,?,?,'goodwill',?,?)",id,r.customer_id,r.amount_cents,r.grant_id,r.invoice_id,by,at),
    stmt(env,"UPDATE nc_hierarchy_credit_shares SET status='executed',approved_by_id=?,approved_name=?,approved_at=?,approval_mode=?,entry_id=? WHERE id=?",actor.id,by,at,mode,id,r.id)],{actor:by,action:'hierarchy.credit.apply',subject:r.id,detail:{parent:r.customer_id,invoice:r.invoice_id,grant:r.grant_id,amount:r.amount_cents,basis:r.basis,preparedBy:r.prepared_name,approvedBy:by,approval:mode,custody:'existing parent goodwill; no new grant or cash movement'}})
  return {id:r.invoice_id,request:r.id,appliedCents:r.amount_cents}
}
export async function hierarchyCreditModel(env:Bindings,actor:Actor,invoice:Row) {
  if(actor.kind!=='member'||!can(actor,'approve')||invoice.status!=='issued')return null
  const payer=await one(env,'SELECT payer_id FROM nc_invoice_payers WHERE invoice_id=?',invoice.id);if(!payer)return null
  const parent=await one(env,'SELECT id,name FROM nc_customers WHERE id=? AND erased_at IS NULL',payer.payer_id);if(!parent)return null
  return {parent,policy:await creditPolicy(env),grants:actor.role==='owner'?(await balanceSources(env,parent.id)).grants:[],requests:await all(env,'SELECT * FROM nc_hierarchy_credit_shares WHERE invoice_id=? ORDER BY prepared_at,id',invoice.id)}
}
