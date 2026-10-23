import { requireUsdCurrency } from './currency'
import type { Bindings } from '../auth.server'
import { requireAny, actorLabel, requireMember, type Actor } from './actor'
import { all, commit, guard, insist, newId, now, one, stmt, type Row } from './core'
import { requireDate } from './dates'
import type { Input } from './input'
import { collectibleInvoice } from './cadence-holds'
import { cadenceBasis } from './cadence-basis'
import { activeFinanceGuard, cadencePolicyRequests, cadenceSourceGuard, cadenceSourceSequence, currentCadencePolicy } from './cadence-policy'

export async function enrollCadence(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor,'receivables')
  const seq=await cadenceSourceSequence(env)
  const invoice=await collectibleInvoice(env,input.text('invoice',{max:100}))
  await requireUsdCurrency(env,{invoiceId:invoice.id})
  insist(invoice.balance_cents>0,'nothing_owed',409)
  const segment=input.text('segment',{max:80}), terms=input.text('transfer_terms',{max:1000})
  await commit(env,[activeFinanceGuard(env,actor),cadenceSourceGuard(env,seq),
    stmt(env,'INSERT INTO nc_cadence_enrollments(invoice_id,segment,transfer_terms,recorded_by,recorded_at) VALUES (?,?,?,?,?)',invoice.id,segment,terms,actorLabel(actor),now())],
    {actor:actorLabel(actor),action:'cadence.enroll',subject:invoice.id,detail:{segment,transferTerms:terms,evidence:'operator-recorded transfer terms'}})
  return {id:invoice.id,invoice:invoice.id,segment}
}

export async function recordPromise(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor,'receivables')
  const seq=await cadenceSourceSequence(env), invoice=await collectibleInvoice(env,input.text('invoice',{max:100}))
  insist(invoice.balance_cents>0,'nothing_owed',409)
  const payDate=requireDate(input.text('pay_date',{max:10}),'pay_date'), note=input.text('note',{max:1000})
  insist(payDate>=invoice.day,'promise_date_in_past')
  const id=newId()
  await commit(env,[activeFinanceGuard(env,actor),cadenceSourceGuard(env,seq),
    stmt(env,'INSERT INTO nc_cadence_promises(id,invoice_id,pay_date,note,recorded_by,recorded_at) VALUES (?,?,?,?,?,?)',id,invoice.id,payDate,note,actorLabel(actor),now())],
    {actor:actorLabel(actor),action:'cadence.promise',subject:invoice.id,detail:{promise:id,payDate,note,pauseInclusive:true}})
  return {id:invoice.id,promise:id,payDate}
}

export async function recordDispute(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor,'receivables')
  const seq=await cadenceSourceSequence(env),invoice=await collectibleInvoice(env,input.text('invoice',{max:100}))
  insist(invoice.balance_cents>0,'nothing_owed',409)
  const line=await one(env,'SELECT * FROM nc_invoice_lines WHERE id=? AND invoice_id=?',input.text('line',{max:100}),invoice.id)
  insist(line&&line.amount_cents>0,'positive_invoice_line_required')
  const amount=input.integer('amount_cents',{min:1,max:9_000_000_000_000})!,reason=input.text('reason',{max:1000})
  const open=invoice.disputes.filter(row=>row.line_id===line.id).reduce((sum,row)=>sum+row.amount_cents,0)
  insist(amount+open<=line.amount_cents,'dispute_exceeds_line',409)
  const id=newId()
  await commit(env,[activeFinanceGuard(env,actor),cadenceSourceGuard(env,seq),
    guard(env,'dispute_exceeds_line','COALESCE((SELECT SUM(amount_cents) FROM nc_cadence_disputes WHERE line_id=? AND resolved_at IS NULL),0)+? <= (SELECT amount_cents FROM nc_invoice_lines WHERE id=? AND invoice_id=?)',line.id,amount,line.id,invoice.id),
    stmt(env,'INSERT INTO nc_cadence_disputes(id,invoice_id,line_id,amount_cents,reason,recorded_by,recorded_at) VALUES (?,?,?,?,?,?,?)',id,invoice.id,line.id,amount,reason,actorLabel(actor),now())],
    {actor:actorLabel(actor),action:'cadence.dispute.open',subject:invoice.id,detail:{dispute:id,line:line.id,amountCents:amount,reason}})
  return {id:invoice.id,dispute:id,amountCents:amount}
}

export async function resolveDispute(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor,'receivables')
  const row=await one(env,'SELECT * FROM nc_cadence_disputes WHERE id=?',input.text('dispute',{max:100}))
  insist(row,'dispute_not_found',404)
  insist(row.resolved_at===null,'dispute_already_resolved',409)
  const outcome=input.text('outcome',{max:1000})
  await commit(env,[activeFinanceGuard(env,actor),guard(env,'dispute_already_resolved','EXISTS(SELECT 1 FROM nc_cadence_disputes WHERE id=? AND resolved_at IS NULL)',row.id),
    stmt(env,'UPDATE nc_cadence_disputes SET resolved_by=?,resolved_at=?,outcome=? WHERE id=?',actorLabel(actor),now(),outcome,row.id)],
    {actor:actorLabel(actor),action:'cadence.dispute.resolve',subject:row.invoice_id,detail:{dispute:row.id,outcome}})
  return {id:row.invoice_id,dispute:row.id,status:'resolved'}
}

export async function approveCadenceStage(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor,'receivables')
  const seq=await cadenceSourceSequence(env)
  const row=await one(env,'SELECT * FROM nc_cadence_deliveries WHERE id=?',input.text('delivery',{max:100}))
  insist(row,'cadence_delivery_not_found',404)
  insist(row.status==='awaiting_approval','cadence_already_decided',409)
  const basis=await cadenceBasis(env,row.invoice_id,row.stage)
  insist(!basis.reason,'cadence_held',409,{reason:basis.reason})
  insist(basis.basisKey===row.basis_key,'cadence_source_changed',409)
  insist(input.text('recipient',{max:200})===row.recipient&&input.text('subject',{max:400})===row.subject&&input.text('body',{max:16000}).replace(/\r\n/g,'\n')===row.body,'cadence_wording_changed',409)
  await commit(env,[activeFinanceGuard(env,actor),cadenceSourceGuard(env,seq),guard(env,'cadence_already_decided',"EXISTS(SELECT 1 FROM nc_cadence_deliveries WHERE id=? AND status='awaiting_approval')",row.id),
    stmt(env,"UPDATE nc_cadence_deliveries SET status='pending',approved_by=?,approved_at=?,approval_mode='human' WHERE id=?",actorLabel(actor),now(),row.id)],
    {actor:actorLabel(actor),action:'cadence.stage.approve',subject:row.id,detail:{invoice:row.invoice_id,stage:row.stage,basis:row.basis_key,recipient:row.recipient,subject:row.subject,body:row.body}})
  return {id:row.invoice_id,delivery:row.id,status:'pending'}
}

export async function cadenceReport(env: Bindings, actor: Actor) {
  // Collections members handle cadences (GOV-001); full readers see them too.
  requireAny(actor,['read','receivables'])
  const policy=await currentCadencePolicy(env),requests=await cadencePolicyRequests(env,actor)
  const invoices=await all(env,"SELECT i.id,i.number,c.name AS customer_name,e.segment,e.transfer_terms FROM nc_invoices i JOIN nc_customers c ON c.id=i.customer_id LEFT JOIN nc_cadence_enrollments e ON e.invoice_id=i.id WHERE i.status='issued' ORDER BY i.due_date,i.id")
  const enrolled: (Row & { lines: Row[] })[]=[]
  for(const invoice of invoices) {
    const hold=await collectibleInvoice(env,invoice.id)
    enrolled.push({...invoice,balanceCents:hold.balance_cents,collectibleCents:hold.collectibleCents,disputedCents:hold.disputedCents,paused:hold.paused,
      promisedThrough:hold.promise?.pay_date??null,hold:hold.hold,due_date:hold.due_date,disputes:hold.disputes,
      lines:await all(env,'SELECT id,seq,description,amount_cents FROM nc_invoice_lines WHERE invoice_id=? ORDER BY seq',invoice.id)})
  }
  return {policy,requests,invoices:enrolled,
    deliveries:await all(env,'SELECT d.*,i.number AS invoice_number,c.name AS customer_name FROM nc_cadence_deliveries d JOIN nc_invoices i ON i.id=d.invoice_id JOIN nc_customers c ON c.id=i.customer_id ORDER BY d.reserved_at DESC,d.id'),
    promises:await all(env,'SELECT * FROM nc_cadence_promises ORDER BY recorded_at DESC'),
    disputes:await all(env,'SELECT * FROM nc_cadence_disputes ORDER BY recorded_at DESC'),
    escalations:await all(env,'SELECT e.*,m.name AS owner_name,m.email AS owner_email,t.status AS task_status FROM nc_cadence_escalations e JOIN nc_members m ON m.id=e.assigned_member_id JOIN nc_tasks t ON t.id=e.task_id ORDER BY e.created_at DESC')}
}
