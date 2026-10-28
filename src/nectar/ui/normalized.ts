import { canRead, type Actor } from '../actor'
import type { ReportInvoice } from '../reports'
import type { NormalizedCorrection } from '../normalized-metrics'
import { cents, details, h, table } from './html'

export function normalizedEffectBody(value: NormalizedCorrection) {
  return h`<h3>Normalized subscription run rate</h3><p>${value.policyVersion} · month-end fixed and seat terms. Metered usage and one-time credits have no effect.</p>
    ${table(['As of','MRR before$','MRR after$','MRR change$','ARR before$','ARR after$'],value.periods.filter(effect=>effect.before.supported&&effect.after.supported).map(effect=>[
      effect.before.asOf, cents(effect.before.mrrCents), cents(effect.after.mrrCents), cents(effect.deltaMrrCents), cents(effect.before.arrCents), cents(effect.after.arrCents)]))}
    ${value.periods.some(effect=>!effect.before.supported||!effect.after.supported)?h`<p>These instruments are outside the supported USD simple fixed and seat definition. No normalized metric is claimed.</p>`:''}`
}

export function normalizedSourceBody(value: NonNullable<ReportInvoice['normalized']>, actor: Actor) {
  const snapshot = value.snapshot
  return h`<section class="card"><h2>Month-end contract evidence</h2><p>As of ${snapshot.asOf} · ${value.policyVersion} · ${value.source.provider}.</p>
    <p>${snapshot.active?'The contract is active at month end.':'The contract is in trial, paused, canceled or outside its service dates at month end.'}</p>
    <p>MRR ${cents(snapshot.mrrCents)} · ARR ${cents(snapshot.arrCents)}.</p>
    ${table(['Item','Contract price$','Quantity','Interval','Discounts','Exact monthly cents'],snapshot.components.map(component=>[
      component.priceId, component.unitAmount, component.quantity, `${component.interval.count} ${component.interval.unit}`,
      component.discounts.map(d=>`${d.percent}%`).join(' + ')||'None',`${component.exactMrrCents.numerator} ÷ ${component.exactMrrCents.denominator}`]))}
    ${canRead(actor,'customers')&&canRead(actor,'subscriptions')?h`<p><a href="${value.source.href}">Retained contract source</a></p>`:''}
    ${details({fingerprint:snapshot.fingerprint,exactMrrCents:snapshot.exactMrrCents,components:snapshot.components},'Exact normalized operands')}
    </section>`
}

// Reuse the report's existing cards and tables for the calculated analytics.
export function saasBody(value: import('../saas-metrics').SaasMetrics) {
  const current = value.months.at(-1)
  if (!current) return ''
  const percent = (ratio: import('../saas-metrics').MetricRatio) => ratio.value === null ? 'No opening basis' : `${(ratio.value * 100).toFixed(2)}%`
  const sources = (entries: import('../reports').ReportEntry[]) => entries.map(source => h`<a href="${source.href}">${source.customerName} · ${source.number} · ${cents(source.amountCents)}</a> `)
  return h`<section class="card" id="customer-movements"><h2>Customer movements</h2><p>Opening MRR ${cents(current.openingMrrCents)} · Closing MRR ${cents(current.closingMrrCents)}.</p>
    ${table(['Movement','Customer','MRR change$','Previous sources','Current sources'],current.movements.map(row=>[row.kind,row.customerName,h`<a href="#movement-sources">${cents(row.amountCents)}</a>`,sources(row.before),sources(row.after)]),{empty:'No month-end customer movements.'})}
    <div id="movement-sources"><details><summary>Opening and closing subscription sources</summary><h3>Opening month</h3><p>${sources(current.openingSources)}</p><h3>Closing month</h3><p>${sources(current.closingSources)}</p></details></div>
    ${table(['Measure','Value'],[['Paying customers',current.payingCustomers],['Logo churn',percent(current.logoChurn)],['Revenue churn',percent(current.revenueChurn)],['Net revenue retention',percent(current.netRetention)],['Gross revenue retention',percent(current.grossRetention)],['Average revenue per account',current.arpaCents === null ? 'No paying customers' : cents(current.arpaCents)]].map(([label,amount])=>[label,h`<a href="#movement-sources">${amount}</a>`]))}
    <details><summary>Analytics definitions</summary><p>${value.definition}</p></details></section>
    <section class="card"><h2>Customer retention cohorts</h2>${value.cohorts.map(cohort=>h`<h3>First paid ${cohort.period}</h3><p>Starting customers ${cohort.customers} · Starting MRR ${cents(cohort.startingMrrCents)}. ${sources(cohort.startingSources)}</p>
      <details><summary>Monthly cohort retention</summary>${table(['Month','Paying customers','MRR$','Customer retention','Net retention','Gross retention','Sources'],cohort.months.map(cell=>[cell.period,cell.payingCustomers,cents(cell.mrrCents),percent(cell.customerRetention),percent(cell.netRevenueRetention),percent(cell.grossRevenueRetention),sources(cell.sources)]))}</details>`)}</section>
    <section class="card"><h2>Trial conversion cohorts</h2>${table(['First trial month','Trial subscriptions','Converted subscriptions','Conversion','Sources'],value.trialCohorts.map(cohort=>[cohort.period,cohort.trials,cohort.converted,percent(cohort.conversion),sources(cohort.sources)]),{empty:'No observed trial cohorts.'})}</section>`
}
