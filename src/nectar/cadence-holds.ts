import type { Bindings } from '../auth.server'
import { all, canonical, insist, one, type Row } from './core'
import { requireBusiness, type Business } from './business'
import { today } from './dates'
import { BALANCE_SQL } from './receivables'
import { clockInstant } from './clock'

/** Payments and credits reduce the ledger balance first. Open disputed cents
 * then reduce the collectible remainder, without changing books or attributing tax. */
export async function collectibleInvoice(env: Bindings, invoiceId: string, instant=clockInstant(env)): Promise<Row & {
  business: Business; day: string; disputes: Row[]; promise: Row | null; disputedCents: number;
  collectibleCents: number; paused: boolean; hold: string | null; basis: string
}> {
  const business=await requireBusiness(env)
  const invoice=await one(env,`SELECT i.*,${BALANCE_SQL} AS balance_cents,c.name AS customer_name,c.billing_email,c.language
    FROM nc_invoices i JOIN nc_customers c ON c.id=i.customer_id WHERE i.id=? AND i.status='issued'`,invoiceId)
  insist(invoice,'invoice_not_found',404)
  const disputes=await all(env,'SELECT * FROM nc_cadence_disputes WHERE invoice_id=? AND resolved_at IS NULL ORDER BY id',invoiceId)
  const processorDisputes=await all(env,"SELECT object_ref,amount_cents FROM nc_processor_objects WHERE invoice_id=? AND kind IN ('dispute','ach_return') AND status IN ('needs_response','under_review','lost','warning_needs_response','warning_under_review')",invoiceId)
  const disputedCents=disputes.reduce((sum,row)=>sum+row.amount_cents,0)+processorDisputes.reduce((sum,row)=>sum+row.amount_cents,0)
  const promise=await one(env,'SELECT rowid AS ordinal,* FROM nc_cadence_promises WHERE invoice_id=? ORDER BY rowid DESC LIMIT 1',invoiceId)
  const allocations=await all(env,'SELECT id,payment_id,amount_cents FROM nc_allocations WHERE invoice_id=? ORDER BY id',invoiceId)
  const credits=await all(env,'SELECT id,amount_cents FROM nc_credit_notes WHERE invoice_id=? ORDER BY id',invoiceId)
  const day=today(business.timezone,instant), paused=!!promise&&day<=promise.pay_date
  const collectibleCents=Math.max(0,invoice.balance_cents-disputedCents)
  const writtenOff=await one<{n:number}>(env,"SELECT COUNT(*) AS n FROM nc_write_offs WHERE invoice_id=? AND status='executed'",invoiceId)
  const hold=invoice.balance_cents<=0?(writtenOff?.n?'written_off':'paid'):paused?'promise':collectibleCents<=0?'disputed':null
  const basis=canonical({balanceCents:invoice.balance_cents,allocations,credits,writtenOff:writtenOff?.n||undefined,processorDisputes,disputes:disputes.map(row=>[row.id,row.line_id,row.amount_cents]),promise:promise?.id??null,paused})
  return {...invoice,business,day,disputes,promise,disputedCents,collectibleCents,paused,hold,basis}
}

/** Works for every issued invoice, including invoices not enrolled in a cadence. */
export async function collectionHold(env: Bindings, invoiceId: string, instant=clockInstant(env)) {
  const row=await collectibleInvoice(env,invoiceId,instant)
  return {invoice:invoiceId,balanceCents:row.balance_cents,disputedCents:row.disputedCents,collectibleCents:row.collectibleCents,
    paused:row.paused,promisedThrough:row.promise?.pay_date??null,payDate:row.promise?.pay_date??null,hold:row.hold,basis:row.basis}
}

/** AGENT-003 stops contact for the whole account, even when another invoice
 * or an undisputed remainder could still be collected through an AR door. */
export async function accountContactHold(env: Bindings, customer: string) {
  const local = await all(env, `SELECT d.id,d.invoice_id,d.amount_cents FROM nc_cadence_disputes d
    JOIN nc_invoices i ON i.id=d.invoice_id WHERE i.customer_id=? AND d.resolved_at IS NULL ORDER BY d.id`, customer)
  const processor = await all(env, `SELECT p.account_ref,p.invoice_id,p.object_ref,p.amount_cents,p.status FROM nc_processor_objects p
    WHERE p.customer_id=? AND p.kind IN ('dispute','ach_return')
    AND p.status IN ('needs_response','under_review','lost','warning_needs_response','warning_under_review') ORDER BY p.account_ref,p.object_ref`, customer)
  return { held: local.length > 0 || processor.length > 0, local, processor }
}
