import type { Bindings } from '../auth.server'
import { actorLabel, requireMember, requireRead, type Actor } from './actor'
import { clockInstant } from './clock'
import { all, commit, fingerprint, guard, insist, newId, one, stmt, type Row } from './core'
import { cents } from './decimal'
import { localDate } from './dates'
import type { Input } from './input'
import { requireFreshFactor } from './mfa'
import { providerReference, stripeForAccount } from './payments/stripe'
import { reconcileProcessorCash, type ProcessorCashResult } from './processor-cash'
import { instant, processorBinding, ref } from './processor-source'

export async function processorCashObservation(env:Bindings,account:string,customer:string,cash:ProcessorCashResult) {
 const at=clockInstant(env),statements=[stmt(env,'DELETE FROM nc_processor_cash_balances WHERE account_ref=? AND customer_id=?',account,customer),
  stmt(env,'UPDATE nc_processor_cash_unmatched SET amount_cents=0,observed_at=? WHERE account_ref=? AND customer_id=?',at,account,customer)]
 for(const [currency,amount] of Object.entries({usd:0,...cash.availableByCurrency}))statements.push(stmt(env,`INSERT INTO nc_processor_cash_balances(account_ref,customer_id,currency,amount_cents,observed_at) VALUES(?,?,?,?,?)`,account,customer,currency,amount,at))
 for(const transaction of cash.transactions)statements.push(stmt(env,`INSERT OR IGNORE INTO nc_processor_cash_transactions(id,account_ref,transaction_ref,customer_id,type,amount_cents,ending_balance_cents,currency,occurred_at,intent_ref) VALUES(?,?,?,?,?,?,?,?,?,?)`,await fingerprint({account,cashTransaction:transaction.id}),account,transaction.id,customer,transaction.type,transaction.net_amount,transaction.ending_balance,transaction.currency,instant(transaction.created),ref(transaction.applied_to_payment?.payment_intent)||null))
 for(const lot of cash.unmatched){
  const transaction=cash.transactions.find(row=>row.id===lot.transferRef)!
  const sender=transaction.funded?.bank_transfer?.us_bank_transfer?.sender_name
  statements.push(stmt(env,`INSERT INTO nc_processor_cash_unmatched(id,account_ref,transfer_ref,customer_id,amount_cents,currency,occurred_at,sender,reference,reason,observed_at)
   VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET amount_cents=excluded.amount_cents,reason=excluded.reason,observed_at=excluded.observed_at`,
  await fingerprint({account,unmatched:lot.transferRef}),account,lot.transferRef,customer,lot.amountCents,lot.currency,instant(transaction.created),typeof sender==='string'?sender.slice(0,200):'',lot.reference.slice(0,500),lot.reason,at))
 }
 return statements
}

/** The human selects an actual unmatched transfer; a receipt is created only
 * after Stripe confirms application of that customer's already received cash. */
export async function allocateProcessorCash(env:Bindings,actor:Actor,input:Input) {
 requireMember(actor,'receivables');requireRead(actor,'payments');requireRead(actor,'invoices');await requireFreshFactor(env,actor)
 input.only(['customer','account_ref','transfer_ref','invoice','amount','confirm','returnTo'])
 insist(input.flag('confirm'),'confirmation_required')
 const account=providerReference(input.text('account_ref',{max:255})),customer=input.text('customer',{max:100})
 const transfer=providerReference(input.text('transfer_ref',{max:255})),invoice=input.text('invoice',{max:100}),amount=cents(input.text('amount',{max:20}))
 const b=await one(env,'SELECT * FROM nc_stripe_customer_bindings WHERE customer_id=? AND account_ref=?',customer,account)
 insist(b,'processor_customer_binding_required',409)
 const selected=await stripeForAccount(env,account),binding=await processorBinding(env,account,b.stripe_customer_ref)
 const prior=await one(env,'SELECT * FROM nc_processor_cash_applications WHERE account_ref=? AND transfer_ref=? AND invoice_id=?',account,transfer,invoice)
  ??await one(env,'SELECT * FROM nc_processor_cash_imported_applications WHERE account_ref=? AND transfer_ref=? AND invoice_id=?',account,transfer,invoice)
 if(prior){insist(prior.customer_id===customer&&prior.amount_cents===amount,'processor_cash_application_mismatch',409);return {id:customer,application:prior.id,status:prior.status,replayed:true}}
 const queued=await one(env,'SELECT * FROM nc_processor_cash_unmatched WHERE account_ref=? AND customer_id=? AND transfer_ref=? AND amount_cents>=?',account,customer,transfer,amount)
 insist(queued&&amount>=50,'processor_cash_transfer_not_available',409)
 const authority=()=>guard(env,'authority',`EXISTS(SELECT 1 FROM nc_members m JOIN oa_operators o ON o.email=m.email LEFT JOIN nc_roles r ON r.id=m.custom_role_id
  WHERE m.id=? AND m.status='active' AND o.status='active' AND (m.role IN ('owner','finance','collections') OR m.role='custom' AND instr(' '||r.capabilities||' ',' receivables ')>0
  AND instr(' '||r.capabilities||' ',' read.payments ')>0 AND instr(' '||r.capabilities||' ',' read.invoices ')>0))`,actor.id)
 const cash=await reconcileProcessorCash(env,selected.stripe,account,binding,true,{transferRef:transfer,invoice,amountCents:amount,authority:[authority()]})
 await commit(env,[authority(),...await processorCashObservation(env,account,customer,cash)],
  {actor:actorLabel(actor),action:'processor.cash.allocate',subject:queued.id,detail:{customer,invoice,transferRef:transfer,amountCents:amount}})
 const application=cash.applications.find(row=>row.transferRef===transfer&&row.invoice===invoice)
 insist(application,'processor_cash_application_unconfirmed',409)
 return {id:customer,application:application.id,status:application.status,replayed:false}
}

export async function unmatchedProcessorCash(env:Bindings,actor:Actor,customer?:string): Promise<Row[]> {
 requireRead(actor,'payments');requireRead(actor,'invoices')
 const rows=await all(env,`SELECT u.* FROM nc_processor_cash_unmatched u JOIN nc_customers c ON c.id=u.customer_id WHERE u.amount_cents>0 AND c.erased_at IS NULL
  AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id=c.id) ${customer?'AND u.customer_id=?':''} ORDER BY u.occurred_at,u.id`,...(customer?[customer]:[]))
 const at=clockInstant(env)
 return rows.map(row=>{const ageDays=Math.max(0,Math.floor((at-row.occurred_at)/86400000));return {...row,ageDays,daysLeft:Math.max(0,75-ageDays),returnDeadline:row.occurred_at+75*86400000}})
}

/** An escalation is a once-only assigned owner task, never an automatic return. */
export async function escalateProcessorCash(env:Bindings,at=clockInstant(env)) {
 const owner=await one(env,"SELECT m.id,m.email FROM nc_members m JOIN oa_operators o ON o.email=m.email WHERE m.status='active' AND m.role='owner' AND o.status='active' AND o.role='owner' ORDER BY m.id LIMIT 1")
 if(!owner)return
 const timezone=(await one(env,'SELECT timezone FROM nc_business WHERE singleton=1'))?.timezone??'UTC'
 for(const row of await all(env,`SELECT u.* FROM nc_processor_cash_unmatched u JOIN nc_customers c ON c.id=u.customer_id WHERE u.amount_cents>0 AND c.erased_at IS NULL`))for(const age of [7,30,60]){
  if(at-row.occurred_at<age*86400000||await one(env,'SELECT id FROM nc_processor_cash_escalations WHERE transfer_id=? AND age_days=?',row.id,age))continue
  const task=newId(),id=await fingerprint({transfer:row.id,age})
  await commit(env,[guard(env,'authority',"EXISTS(SELECT 1 FROM nc_members WHERE id=? AND status='active' AND role='owner')",owner.id),
   guard(env,'cash_transfer_changed','EXISTS(SELECT 1 FROM nc_processor_cash_unmatched WHERE id=? AND amount_cents=? AND amount_cents>0)',row.id,row.amount_cents),
   stmt(env,`INSERT INTO nc_tasks(id,customer_id,title,due_date,status,created_by,created_at) VALUES(?,?,?,?,'open',?,?)`,task,row.customer_id,`Unapplied bank transfer: ${age} days`,localDate(at,timezone),'system:processor',at),
   stmt(env,'INSERT INTO nc_processor_cash_escalations(id,customer_id,transfer_id,age_days,assigned_member_id,task_id,created_at) VALUES(?,?,?,?,?,?,?)',id,row.customer_id,row.id,age,owner.id,task,at)],
  {actor:'system:processor',action:'processor.cash.escalate',subject:row.id,detail:{assignedOwner:owner.id,task,ageDays:age,amountCents:row.amount_cents}})
 }
}
