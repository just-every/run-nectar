import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const totalFields=['failedInvoices','recoveredInvoices','partiallyRecoveredInvoices','failedAmountCents','recoveredAmountCents','recoveryRate','amountRecoveryRate']
export function recoveryTotals(rows){
 const failedAmountCents=rows.reduce((sum,r)=>sum+r.failedAmountCents,0),recoveredAmountCents=rows.reduce((sum,r)=>sum+r.recoveredAmountCents,0)
 const recoveredInvoices=rows.filter(r=>r.recoveredAmountCents===r.failedAmountCents).length
 return {failedInvoices:rows.length,recoveredInvoices,partiallyRecoveredInvoices:rows.filter(r=>r.recoveredAmountCents>0&&r.recoveredAmountCents<r.failedAmountCents).length,failedAmountCents,recoveredAmountCents,recoveryRate:rows.length?recoveredInvoices/rows.length:null,amountRecoveryRate:failedAmountCents?recoveredAmountCents/failedAmountCents:null}
}
export function assertRecoveryTotals(actual,expected){
 assert.deepEqual(Object.fromEntries(totalFields.map(k=>[k,actual[k]])),recoveryTotals(expected))
}
export function assertRecoveryBuckets(report,rows){
 assertRecoveryTotals(report.totals,rows)
 for(const [field,exposures,attribution] of [
  ['byDecline',r=>[r.declineCode??'unknown'],(r,c)=>r.declineCode??'unknown'],
  ['byAttempt',r=>r.attempts.map(a=>String(a.attempt)),(r,c)=>String(c.attempt??'unattributed')],
  ['byDunningStep',r=>[...(r.steps??[]),...r.attempts.map(a=>a.step??'unrecorded')],(r,c)=>c.step??'unrecorded']
 ]){
  const groups=new Map()
  for(const row of rows){
   const keys=new Set([...exposures(row),...row.recoveries.map(c=>attribution(row,c))])
   for(const key of keys){
    const id=JSON.stringify([row.currency,key]),group=groups.get(id)??[]
    group.push({...row,recoveredAmountCents:row.recoveries.filter(c=>attribution(row,c)===key).reduce((sum,c)=>sum+c.amountCents,0)})
    groups.set(id,group)
   }
  }
  assert.deepEqual(report[field].map(b=>JSON.stringify([b.currency,b.key])).sort(),[...groups.keys()].sort(),`${field} contains every reached group exactly once`)
  for(const bucket of report[field])assertRecoveryTotals(bucket,groups.get(JSON.stringify([bucket.currency,bucket.key])))
 }
}

export async function comparisonFixture(){return JSON.parse(await readFile(new URL('../../src/nectar/retry-comparison.json',import.meta.url),'utf8'))}
export function comparisonOutcomes(payments,policy,schedules){
 const offsets=policy.attemptOffsetsHours,table=schedules.find(p=>p.intervalHoursByDecline)
 return payments.map(p=>{
  const attemptsHours=[];let recoveredAtHours=null
  const candidates=offsets??Array.from({length:policy.maxAttempts},(_,n)=>n*table.intervalHoursByDecline[p.declineCode]).filter(at=>at<=policy.windowDays*24)
  for(const at of candidates){attemptsHours.push(at);if(at>0&&p.successWindowsHours.some(([start,end])=>at>=start&&at<end)){recoveredAtHours=at;break}}
  return {id:p.id,attemptsHours,recoveredAtHours}
 })
}
function assertReplay(result,fixture,policy){
 const outcomes=comparisonOutcomes(fixture.payments,policy,fixture.policies),recovered=outcomes.filter(o=>o.recoveredAtHours!==null)
 const failedAmountCents=fixture.payments.reduce((sum,p)=>sum+p.amountCents,0),recoveredAmountCents=fixture.payments.filter(p=>recovered.some(o=>o.id===p.id)).reduce((sum,p)=>sum+p.amountCents,0)
 assert.deepEqual(result.outcomes,outcomes,'Every attempted offset and outcome matches the independently replayed fixture')
 assert.deepEqual(Object.fromEntries(['failedPayments','failedAmountCents','recoveredPayments','recoveredAmountCents','recoveryRate','amountRecoveryRate'].map(k=>[k,result[k]])),{failedPayments:fixture.payments.length,failedAmountCents,recoveredPayments:recovered.length,recoveredAmountCents,recoveryRate:recovered.length/fixture.payments.length,amountRecoveryRate:recoveredAmountCents/failedAmountCents})
}
export function retryPolicyWrites(api){
 const expected=new Map()
 return {expected,configure:async input=>{
  await api('retry.policy.configure',input)
  const scope=input.plan?`plan:${input.plan}`:input.segment?`segment:${input.segment}`:'default'
  expected.set(scope,{scope,maxAttempts:input.max_attempts,windowDays:input.window_days})
 }}
}
export async function assertComparisons(record,expectedPolicies){
 const fixture=await comparisonFixture(),fixed=fixture.policies.find(p=>p.attemptOffsetsHours),decline=fixture.policies.find(p=>p.intervalHoursByDecline)
 assert.deepEqual(record.payments,fixture.payments)
 assert.deepEqual(record.publishedRecord,fixture.record)
 assertReplay(record.publishedDefault.measured,fixture,{maxAttempts:decline.maxAttempts,windowDays:decline.windowHours/24})
 assertReplay(record.publishedDefault.baseline,fixture,fixed)
 for(const result of [record.publishedDefault.measured,record.publishedDefault.baseline]){
  const published=fixture.record.find(row=>row.policy===result.policy.version||row.policy===decline.id&&!result.policy.attemptOffsetsHours)
  assert.ok(published)
  for(const key of Object.keys(published).filter(k=>k!=='policy'))assert.deepEqual(result[key],published[key],`Published ${key} agrees with replay`)
 }
 assert.deepEqual(record.configuredPolicies.map(p=>p.measured.policy.scope).sort(),[...expectedPolicies.keys()].sort(),'Every configured scope has a measured comparison')
 for(const pair of record.configuredPolicies){
  const expected=expectedPolicies.get(pair.measured.policy.scope)
  assert.deepEqual(Object.fromEntries(Object.keys(expected).map(key=>[key,pair.measured.policy[key]])),expected,'Comparison limits equal the saved configuration writes')
  assertReplay(pair.measured,fixture,expected);assertReplay(pair.baseline,fixture,fixed)
  assert.deepEqual(pair.baseline,record.publishedDefault.baseline)
  assert.equal(pair.additionalRecoveredPayments,pair.measured.recoveredPayments-pair.baseline.recoveredPayments)
  assert.equal(pair.additionalRecoveredAmountCents,pair.measured.recoveredAmountCents-pair.baseline.recoveredAmountCents)
  assert.equal(pair.recoveredMore,pair.additionalRecoveredPayments>0&&pair.additionalRecoveredAmountCents>0)
 }
}
