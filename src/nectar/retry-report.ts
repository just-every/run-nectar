import { retryChurnReport } from './retry-churn'
import type { Bindings } from '../auth.server'
import { requireRead, type Actor } from './actor'
import { all } from './core'
import { clockInstant } from './clock'

interface Attempt { collection: string; attempt: number; at: number; outcome: string; payment: string | null; step: string | null }
interface Allocation { id: string; payment: string; amountCents: number; at: number }
interface FailedInvoice {
  invoice: string; number: string; currency: string; customer: string; firstFailedAt: number;
  failedAmountCents: number; declineCode: string | null; attemptsJson: string; allocationsJson: string
}
interface Recovery extends Allocation { attempt: number | null; step: string | null }
interface Cohort extends Omit<FailedInvoice, 'attemptsJson' | 'allocationsJson'> { attempts: Attempt[]; recoveries: Recovery[] }
export interface RecoveryTotals {
  failedInvoices: number; recoveredInvoices: number; partiallyRecoveredInvoices: number;
  failedAmountCents: number; recoveredAmountCents: number; recoveryRate: number | null; amountRecoveryRate: number | null
}
export interface RecoveryBucket extends RecoveryTotals { key: string; currency: string }

const definition = 'Each invoice enters once, at its first recorded failed attempt and for that failed amount. Recovery is actual payment allocations made after that failure, capped at the failed amount. A recovered invoice has its full failed amount allocated; partial recoveries contribute money but not a fully recovered invoice. Credits, pending charges and uncertain outcomes are not recovered cash. Rates use fully recovered invoices divided by failed invoices.'

// One statement gives the cohort, attempts and immutable allocations one read snapshot.
const sourceSql = `WITH failures AS (
 SELECT r.*,ROW_NUMBER() OVER(PARTITION BY r.invoice_id ORDER BY r.attempted_at,r.collection_id,r.attempt) AS ordinal
 FROM nc_retry_attempts r WHERE r.outcome='failed' AND r.attempted_at<=?
)
SELECT f.invoice_id AS invoice,i.number,i.currency,f.customer_id AS customer,
 f.attempted_at AS firstFailedAt,f.amount_cents AS failedAmountCents,f.decline_code AS declineCode,
 (SELECT json_group_array(json_object('collection',r.collection_id,'attempt',r.attempt,'at',r.attempted_at,
   'outcome',r.outcome,'payment',r.payment_id,'step',r.dunning_step))
  FROM nc_retry_attempts r WHERE r.invoice_id=f.invoice_id AND r.attempted_at>=f.attempted_at AND r.attempted_at<=?) AS attemptsJson,
 (SELECT json_group_array(json_object('id',a.id,'payment',a.payment_id,'amountCents',a.amount_cents,'at',a.allocated_at))
  FROM nc_allocations a JOIN nc_payments p ON p.id=a.payment_id
  WHERE a.invoice_id=f.invoice_id AND p.customer_id=f.customer_id AND p.currency=i.currency
   AND a.allocated_at>=f.attempted_at AND a.allocated_at<=? AND p.recorded_at<=?
   AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(a.id,p.id))) AS allocationsJson
FROM failures f JOIN nc_invoices i ON i.id=f.invoice_id JOIN nc_customers c ON c.id=f.customer_id
WHERE f.ordinal=1 AND c.erased_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(f.invoice_id,f.customer_id,f.collection_id))
ORDER BY f.attempted_at,f.invoice_id`

function cohort(row: FailedInvoice): Cohort {
  const { attemptsJson, allocationsJson, ...source } = row
  const attempts = (JSON.parse(attemptsJson) as Attempt[]).sort((a,b)=>a.at-b.at || a.attempt-b.attempt || a.collection.localeCompare(b.collection))
  const allocations = (JSON.parse(allocationsJson) as Allocation[]).sort((a,b)=>a.at-b.at || a.id.localeCompare(b.id))
  let remaining = source.failedAmountCents
  const recoveries: Recovery[] = []
  for (const allocation of allocations) {
    const amountCents = Math.min(remaining,allocation.amountCents)
    if (!amountCents) break
    // Payment identity, never timing proximity, attributes cash to a retry.
    const attempt = attempts.find(a=>a.outcome==='collected' && a.payment===allocation.payment)
    recoveries.push({...allocation,amountCents,attempt:attempt?.attempt ?? null,step:attempt?.step ?? null})
    remaining -= amountCents
  }
  return {...source,attempts,recoveries}
}

function totals(cohorts: Cohort[]): RecoveryTotals {
  let recoveredInvoices=0,partiallyRecoveredInvoices=0,failedAmountCents=0,recoveredAmountCents=0
  for (const invoice of cohorts) {
    const recovered=invoice.recoveries.reduce((sum,r)=>sum+r.amountCents,0)
    failedAmountCents+=invoice.failedAmountCents; recoveredAmountCents+=recovered
    if (recovered>=invoice.failedAmountCents) recoveredInvoices++
    else if (recovered>0) partiallyRecoveredInvoices++
  }
  return {failedInvoices:cohorts.length,recoveredInvoices,partiallyRecoveredInvoices,failedAmountCents,recoveredAmountCents,
    recoveryRate:cohorts.length ? recoveredInvoices/cohorts.length : null,
    amountRecoveryRate:failedAmountCents ? recoveredAmountCents/failedAmountCents : null}
}

function buckets(cohorts: Cohort[], dimension: 'decline' | 'attempt' | 'step'): RecoveryBucket[] {
  const groups=new Map<string,{key:string;currency:string;invoices:Cohort[]}>()
  for (const invoice of cohorts) {
    const recoveryKey=(r:Recovery)=>dimension==='decline' ? invoice.declineCode ?? 'unknown' : dimension==='attempt' ? String(r.attempt ?? 'unattributed') : r.step ?? 'unrecorded'
    const keys=new Set(dimension==='decline' ? [invoice.declineCode ?? 'unknown'] : dimension==='attempt'
      ? invoice.attempts.map(a=>String(a.attempt)) : invoice.attempts.map(a=>a.step ?? 'unrecorded'))
    invoice.recoveries.forEach(r=>keys.add(recoveryKey(r)))
    for (const key of keys) {
      const id=JSON.stringify([invoice.currency,key]),group=groups.get(id) ?? {key,currency:invoice.currency,invoices:[]}
      group.invoices.push({...invoice,recoveries:invoice.recoveries.filter(r=>recoveryKey(r)===key)})
      groups.set(id,group)
    }
  }
  return [...groups.values()].sort((a,b)=>a.currency.localeCompare(b.currency) || a.key.localeCompare(b.key,undefined,{numeric:true}))
    .map(group=>({key:group.key,currency:group.currency,...totals(group.invoices)}))
}

export async function retryRecoveryReport(env: Bindings, actor: Actor) {
  requireRead(actor,'reports'); requireRead(actor,'payments'); requireRead(actor,'invoices')
  const asOf=clockInstant(env)
  const cohorts=(await all<FailedInvoice>(env,sourceSql,asOf,asOf,asOf,asOf)).map(cohort)
  const currencies=[...new Set(cohorts.map(c=>c.currency))].sort().map(currency=>({currency,...totals(cohorts.filter(c=>c.currency===currency))}))
  const counts=totals(cohorts)
  return {asOf,definition,period:'All recorded failures',
    totals:{...counts,failedAmountCents:currencies.length>1 ? null : counts.failedAmountCents,
      recoveredAmountCents:currencies.length>1 ? null : counts.recoveredAmountCents,
      amountRecoveryRate:currencies.length>1 ? null : counts.amountRecoveryRate},
    currencies,byDecline:buckets(cohorts,'decline'),byAttempt:buckets(cohorts,'attempt'),byDunningStep:buckets(cohorts,'step'),
    breakdownDefinition:'Decline groups use the first failure reason. Attempt and step groups count each invoice once per group reached, so exposure counts and failed amounts are not additive across groups. Cash is attributed by the collected attempt payment ID; other allocations have no recorded attempt or step. A group recovery rate counts invoices whose entire failed amount was recovered in that group.',
    involuntaryChurn:await retryChurnReport(env,actor),
    invoices:cohorts.map(invoice=>({...invoice,href:`/app/invoices/${invoice.invoice}`,recoveredAmountCents:invoice.recoveries.reduce((sum,r)=>sum+r.amountCents,0)}))}
}
