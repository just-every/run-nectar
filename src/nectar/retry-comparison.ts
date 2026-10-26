// This declared test-edge data is used only for the labelled policy comparison.
// Live recovery accounting never reads it or manufactures payment records.
import dataset from './retry-comparison.json'
import type { Bindings } from '../auth.server'
import { requireRead, type Actor } from './actor'
import { all } from './core'
import { nextRetry, RETRY_TABLE_VERSION, type RetryPolicy } from './retry-policy'

const HOUR=3600000
const defaultPolicy:RetryPolicy={version:RETRY_TABLE_VERSION,maxAttempts:8,windowDays:14,scope:'default'}
const fixed=dataset.policies.find(policy=>policy.id==='fixed-three-v1')!.attemptOffsetsHours!

function replay(policy:RetryPolicy|null) {
  const first=Date.parse(dataset.firstFailureAt)
  const outcomes=dataset.payments.map(payment=>{
    const attemptsHours:number[]=[]
    let at:number|null=first,recoveredAtHours:number|null=null
    while (at!==null) {
      const elapsed=(at-first)/HOUR
      attemptsHours.push(elapsed)
      if(elapsed>0 && payment.successWindowsHours.some(([start,end])=>elapsed>=start && elapsed<end)) {
        recoveredAtHours=elapsed; break
      }
      at=policy ? nextRetry(payment.declineCode,'card',attemptsHours.length,at,first,policy)
        : fixed[attemptsHours.length]===undefined ? null : first+fixed[attemptsHours.length]*HOUR
    }
    return {id:payment.id,attemptsHours,recoveredAtHours}
  })
  const failedAmountCents=dataset.payments.reduce((sum,payment)=>sum+payment.amountCents,0)
  const recovered=outcomes.filter(outcome=>outcome.recoveredAtHours!==null)
  const recoveredAmountCents=dataset.payments.reduce((sum,payment)=>sum+(recovered.some(outcome=>outcome.id===payment.id)?payment.amountCents:0),0)
  return {policy:policy ? {...policy} : {version:'fixed-three-v1',attemptOffsetsHours:fixed},
    failedPayments:outcomes.length,failedAmountCents,recoveredPayments:recovered.length,recoveredAmountCents,
    recoveryRate:recovered.length/outcomes.length,amountRecoveryRate:recoveredAmountCents/failedAmountCents,outcomes}
}

export function compareRetryPolicy(policy:RetryPolicy) {
  const measured={...replay(policy),policy:{...policy}},baseline=replay(null)
  return {measured,baseline,recoveredMore:measured.recoveredPayments>baseline.recoveredPayments && measured.recoveredAmountCents>baseline.recoveredAmountCents,
    additionalRecoveredPayments:measured.recoveredPayments-baseline.recoveredPayments,
    additionalRecoveredAmountCents:measured.recoveredAmountCents-baseline.recoveredAmountCents}
}

export async function retryComparisonReport(env:Bindings,actor:Actor) {
  requireRead(actor,'reports')
  const configured=await all<{scope:string;max_attempts:number;window_days:number}>(env,'SELECT scope,max_attempts,window_days FROM nc_retry_policies ORDER BY scope')
  return {version:dataset.version,currency:dataset.currency,firstFailureAt:dataset.firstFailureAt,
    definition:'Deterministic published test-edge outcomes. This set is not a provider comparison or a prediction of production performance.',
    outcomeRule:dataset.outcomeRule,payments:dataset.payments,publishedRecord:dataset.record,
    publishedDefault:compareRetryPolicy(defaultPolicy),
    configuredPolicies:configured.map(row=>compareRetryPolicy({version:RETRY_TABLE_VERSION,scope:row.scope,maxAttempts:row.max_attempts,windowDays:row.window_days}))}
}
