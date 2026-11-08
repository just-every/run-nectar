import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { comparisonFixture, comparisonOutcomes } from './recovery-assertions.mjs'

const number=text=>{const words=['zero','one','two','three','four','five','six','seven','eight'];return text==='a'?1:words.includes(text.toLowerCase())?words.indexOf(text.toLowerCase()):Number(text.replaceAll(',',''))}
const dollars=cents=>`$${(cents/100).toLocaleString('en-US')}`
const rows=text=>text.split('\n').filter(line=>line.startsWith('| ')).map(line=>line.split('|').slice(1,-1).map(cell=>cell.trim()))
const document=name=>readFile(new URL(`../../docs/${name}.md`,import.meta.url),'utf8')

export async function assertTimingTable(observed){
 const timing=await document('retry-table'),table=rows(timing).slice(2)
 assert.equal(table.length,5,'Every published reason group is reconciled')
 for(const [index,codes] of [['processing_error'],['do_not_honor'],['insufficient_funds'],['R01','R09']].entries()){
  const [reason,delay,limit]=table[index],delayHours=Number(delay.match(/^(\d+) elapsed hours$/)?.[1])
  const caps=limit.match(/^(\d+) total attempts.*?(\d+) elapsed days$/)
  assert.ok(caps,'Timing table exposes count and window')
  for(const code of codes)assert.ok(reason.includes(code),`Published timing group names ${code}`)
  for(const code of codes){
   assert.ok(observed.has(code),`The public invoice journey observed ${code}`)
   const actual=observed.get(code)
   assert.deepEqual([delayHours,Number(caps[1]),Number(caps[2])],[actual.delayHours,actual.maxAttempts,actual.windowDays],`${code} timing table equals the frozen policy and public next attempt`)
  }
 }
 assert.match(table[4][1],/^No retry$/)
 for(const code of ['stolen_card','lost_card','authentication_required','R02','R03']){
  assert.ok(observed.has(code));assert.equal(observed.get(code).delayHours,null,`${code} has no scheduled retry`)
 }
}

export async function assertComparisonDescription(h,owner,record){
 const [guide,timing]=await Promise.all([document('retry-comparison'),document('retry-table')])
 const fixture=await comparisonFixture(),{measured,baseline}=record.publishedDefault
 const table=rows(guide),summary=table.filter(row=>['Decline-table v1','Fixed three attempts'].includes(row[0]))
 assert.equal(summary.length,2)
 for(const [index,result] of [measured,baseline].entries())assert.deepEqual(summary[index].slice(1),[String(result.failedPayments),dollars(result.failedAmountCents),String(result.recoveredPayments),`${Number((result.recoveryRate*100).toFixed(1))}%`,dollars(result.recoveredAmountCents),`${(result.amountRecoveryRate*100).toFixed(2)}%`])
 const headline=guide.match(/recovered (\w+) of (\w+) failed payments[\s\S]*?: ([\d.]+)%, with \$([\d,]+) recovered from \$([\d,]+)\./)
 assert.ok(headline)
 assert.deepEqual([number(headline[1]),number(headline[2]),Number(headline[3]),number(headline[4])*100,number(headline[5])*100],[measured.recoveredPayments,measured.failedPayments,measured.recoveryRate*100,measured.recoveredAmountCents,measured.failedAmountCents])
 const baselineHeadline=guide.match(/fixed three-attempt schedule recovered (\w+): ([\d.]+)%, with \$([\d,]+) recovered\./)
 assert.ok(baselineHeadline)
 assert.deepEqual([number(baselineHeadline[1]),Number(baselineHeadline[2]),number(baselineHeadline[3])*100],[baseline.recoveredPayments,baseline.recoveryRate*100,baseline.recoveredAmountCents])
 const schedule=guide.match(/at most (\w+) total attempts through elapsed hour (\d+)\s*\((\d+) days\)/)
 assert.ok(schedule);assert.deepEqual([number(schedule[1]),Number(schedule[2]),Number(schedule[3])],[measured.policy.maxAttempts,measured.policy.windowDays*24,measured.policy.windowDays])
 const decline=fixture.policies.find(p=>p.intervalHoursByDecline),fixedPolicy=fixture.policies.find(p=>p.attemptOffsetsHours)
 const delays=[...guide.matchAll(/(?:processing error|do not honor|insufficient funds)\s+waits (\w+) hours/g)].map(m=>number(m[1]))
 assert.deepEqual(delays,Object.values(decline.intervalHoursByDecline))
 const fixed=guide.match(/elapsed hours (\d+) and (\d+) \(day (\d+) and day (\d+)\)/);assert.ok(fixed)
 assert.deepEqual([0,Number(fixed[1]),Number(fixed[2])],fixedPolicy.attemptOffsetsHours)
 assert.deepEqual([Number(fixed[3])*24,Number(fixed[4])*24],fixedPolicy.attemptOffsetsHours.slice(1))
 const epoch=guide.match(/starting on (\d+ \w+ \d+) at midnight/);assert.ok(epoch)
 assert.equal(Date.parse(`${epoch[1]} 00:00:00 UTC`),Date.parse(fixture.firstFailureAt))
 const measuredOutcomes=comparisonOutcomes(fixture.payments,{maxAttempts:decline.maxAttempts,windowDays:decline.windowHours/24},fixture.policies)
 const fixedOutcomes=comparisonOutcomes(fixture.payments,fixedPolicy,fixture.policies)
 const payments=table.filter(row=>row[0].startsWith('synthetic-nectar-'))
 assert.deepEqual(payments.map(row=>row[0]),fixture.payments.map(p=>p.id),'Published payment set is complete')
 for(const [index,payment] of fixture.payments.entries()){
  const windows=payment.successWindowsHours.map(([start,end])=>`${start} to before ${end}`).join(', ')||'Never'
  const hour=value=>value===null?'None':String(value)
  assert.deepEqual(payments[index],[payment.id,payment.declineCode,dollars(payment.amountCents),windows,hour(measuredOutcomes[index].recoveredAtHours),hour(fixedOutcomes[index].recoveredAtHours)],`Published inputs and both recovery hours match replay for ${payment.id}`)
 }
 const extra=guide.match(/recovers (\w+) additional payments and \$([\d,]+) more/);assert.ok(extra)
 assert.deepEqual([number(extra[1]),number(extra[2])*100],[measured.recoveredPayments-baseline.recoveredPayments,measured.recoveredAmountCents-baseline.recoveredAmountCents])
 const points=guide.match(/payment recovery rate is ([\d.]+) percentage points higher; the amount recovery\s+rate is ([\d.]+) percentage points higher/);assert.ok(points)
 assert.deepEqual([Number(points[1]),Number(points[2])],[(measured.recoveryRate-baseline.recoveryRate)*100,Number(((measured.amountRecoveryRate-baseline.amountRecoveryRate)*100).toFixed(2))])
 const asymmetric=guide.match(/includes (\w+) payment that only the fixed schedule recovers, and (\w+)\s+that neither recovers/);assert.ok(asymmetric)
 assert.deepEqual([number(asymmetric[1]),number(asymmetric[2])],[fixedOutcomes.filter((o,i)=>o.recoveredAtHours!==null&&measuredOutcomes[i].recoveredAtHours===null).length,fixedOutcomes.filter((o,i)=>o.recoveredAtHours===null&&measuredOutcomes[i].recoveredAtHours===null).length])
 assert.ok([...timing.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].some(m=>new URL(m[1],h.origin).pathname==='/docs/retry-comparison'),'Timing claims cite the reconciled comparison')
 assert.ok([...guide.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].some(m=>new URL(m[1],h.origin).pathname.endsWith('/src/nectar/retry-comparison.json')))
 const page=await h.page('/app/reports/recovery',owner),text=page.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ')
 for(const result of [measured,baseline])assert.ok(text.includes(`${result.recoveredPayments} payments (${(result.recoveryRate*100).toFixed(1)}%) and ${dollars(result.recoveredAmountCents)}`))
 assert.ok(page.includes('href="/api/nectar/retry-comparison"'),'The product comparison cites its measured API record')
}

// The manual-recovery sanity journey supplies its independently observed first
// refusal and cash, rather than computing expected results from report fields.
export function assertNativeRecovery(report,first,recoveredAmountCents){
 const row=report.invoices.find(r=>r.invoice===first.invoice)
 assert.ok(row,'The first failed invoice remains in the report after recovery')
 assert.deepEqual([row.firstFailedAt,row.failedAmountCents,row.declineCode],[first.firstFailedAt,first.failedAmountCents,first.declineCode])
 assert.equal(row.recoveredAmountCents,recoveredAmountCents)
 assert.deepEqual(row.attempts.map(a=>[a.attempt,a.outcome]),[[1,'failed'],[2,'collected']])
 assert.deepEqual(row.recoveries.map(r=>[r.amountCents,r.attempt,r.step]),[[recoveredAmountCents,2,null]])
 for(const [groups,key] of [[report.byAttempt,'2'],[report.byDecline,first.declineCode],[report.byDunningStep,'unrecorded']]){
  const bucket=groups.find(b=>b.key===key&&b.currency===first.currency)
  assert.ok(bucket)
  assert.equal(bucket.recoveryRate,bucket.recoveredInvoices/bucket.failedInvoices)
  assert.equal(bucket.amountRecoveryRate,bucket.recoveredAmountCents/bucket.failedAmountCents)
 }
 const attempt=report.byAttempt.find(b=>b.key==='2'&&b.currency===first.currency)
 assert.deepEqual([attempt.failedInvoices,attempt.recoveredInvoices,attempt.failedAmountCents,attempt.recoveredAmountCents,attempt.recoveryRate,attempt.amountRecoveryRate],[1,1,first.failedAmountCents,recoveredAmountCents,1,1])
}
