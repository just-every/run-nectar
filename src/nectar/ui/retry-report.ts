import type { Bindings } from '../../auth.server'
import type { Actor } from '../actor'
import { retryRecoveryReport, type RecoveryBucket } from '../retry-report'
import { retryComparisonReport } from '../retry-comparison'
import { cents, h, page, table } from './html'

const percent=(rate:number|null)=>rate===null ? '—' : `${(rate*100).toFixed(1)}%`
const label=(key:string,kind:string)=>kind==='attempt' ? key==='unattributed' ? 'No recorded retry attempt' : `Attempt ${key}`
  : kind==='step' && key==='unrecorded' ? 'No recorded dunning step' : key==='unknown' ? 'Unknown decline reason' : key.replaceAll('_',' ')
const breakdown=(rows:RecoveryBucket[],kind:string)=>table(
  [kind==='decline' ? 'First decline' : kind==='attempt' ? 'Retry attempt' : 'Dunning step','Currency','Failed invoices','Failed amount$','Recovered invoices','Recovered revenue$','Recovery rate'],
  rows.map(row=>[label(row.key,kind),row.currency,row.failedInvoices,cents(row.failedAmountCents,row.currency),row.recoveredInvoices,cents(row.recoveredAmountCents,row.currency),percent(row.recoveryRate)]),
  {empty:'No failed payment cohorts have been recorded.'})

export async function retryRecoveryPage(env: Bindings, actor: Actor, url: URL) {
  const [report,comparison]=await Promise.all([retryRecoveryReport(env,actor),retryComparisonReport(env,actor)])
  const {measured,baseline}=comparison.publishedDefault
  return page('Payment recovery',actor,h`<p class="crumbs"><a href="/app/reports/billings">Financial reports</a></p>
    <h1>Payment recovery</h1><p class="lede">${report.period} · ${report.totals.failedInvoices} failed invoices · ${report.totals.recoveredInvoices} recovered · ${percent(report.totals.recoveryRate)} recovery rate</p>
    <section class="card"><h2>Failed payments and recovered revenue</h2>
      ${table(['Currency','Failed invoices','Failed amount$','Recovered invoices','Recovered revenue$','Partial recoveries','Recovery rate'],report.currencies.map(row=>[row.currency,row.failedInvoices,cents(row.failedAmountCents,row.currency),row.recoveredInvoices,cents(row.recoveredAmountCents,row.currency),row.partiallyRecoveredInvoices,percent(row.recoveryRate)]),{empty:'No failed payment cohorts have been recorded.'})}
      <details><summary>How recovery is counted</summary><p>${report.definition}</p><p>${report.breakdownDefinition}</p><p>Amounts remain in their recorded currency. Recovered revenue is gross allocated cash before later refunds.</p></details></section>
    <section class="card"><h2>By decline reason</h2>${breakdown(report.byDecline,'decline')}</section>
    <section class="card"><h2>By retry attempt</h2>${breakdown(report.byAttempt,'attempt')}</section>
    <section class="card"><h2>By dunning step</h2>${breakdown(report.byDunningStep,'step')}</section>
    <section class="card"><h2>Involuntary churn</h2><p>${report.involuntaryChurn.reason}</p></section>
    <section class="card"><h2>Invoice evidence</h2>${table(['Invoice','First failure (UTC)','Failed amount$','Recovered revenue$','Recorded attempts'],report.invoices.map(invoice=>[h`<a href="${invoice.href}">${invoice.number}</a>`,new Date(invoice.firstFailedAt).toISOString(),cents(invoice.failedAmountCents,invoice.currency),cents(invoice.recoveredAmountCents,invoice.currency),invoice.attempts.length]),{empty:'No failed invoice evidence to show.'})}</section>
    <section class="card"><h2>Published retry comparison</h2><p>On the published ${measured.failedPayments}-payment test set, the default decline table recovers ${measured.recoveredPayments} payments (${percent(measured.recoveryRate)}) and ${cents(measured.recoveredAmountCents,comparison.currency)}; the fixed three-attempt schedule recovers ${baseline.recoveredPayments} payments (${percent(baseline.recoveryRate)}) and ${cents(baseline.recoveredAmountCents,comparison.currency)}.</p><p>${comparison.definition}</p><details><summary>Configured policy comparisons</summary>${table(['Policy','Attempts','Window','Recovered payments','Recovered amount$','Recovery rate'],comparison.configuredPolicies.map(record=>[record.measured.policy.scope,record.measured.policy.maxAttempts,`${record.measured.policy.windowDays} days`,record.measured.recoveredPayments,cents(record.measured.recoveredAmountCents,comparison.currency),percent(record.measured.recoveryRate)]),{empty:'No configured policy overrides.'})}</details><p><a href="/api/nectar/retry-comparison">Open the test set, schedules and measured record</a></p></section>`,{current:'/app/billing',url})
}
