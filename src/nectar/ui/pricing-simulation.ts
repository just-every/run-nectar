import type { Row } from '../core'
import { formatDate, formatPeriod } from '../dates'
import { cents, details, h, table } from './html'

export function pricingSimulationBody(entries: Row[]) {
  const summary=entries[0]?.simulationSummary
  return h`<h2>Six-month pricing comparison</h2><p>Recorded usage is replayed through Nectar's rating engine. Historical comparisons are not a forecast. Original invoices and signed terms stay recorded.</p>
    ${summary ? h`<h3>Cohort effect</h3><p>Subtotal: ${cents(summary.totals.beforeSubtotalCents)} → ${cents(summary.totals.afterSubtotalCents)}. Change including tax: ${cents(summary.totals.deltaTotalCents)}.</p>
      ${summary.costAssumption ? h`<p>Estimated margin using assumed costs of ${cents(summary.costAssumption.costPerPeriodCents)} per subscription period: ${cents(summary.costAssumption.beforeMarginCents)} → ${cents(summary.costAssumption.afterMarginCents)}. These are estimates, not actual costs.</p>` : h`<p>No cost assumption supplied; margin is not estimated.</p>`}
      <h4>Customers most affected</h4>${table(['Customer','Change including tax$'],summary.highestAffectedCustomers.map((c:Row)=>[h`<a href="/app/subscriptions/${c.subscription}">${c.customer}</a>`,cents(c.deltaTotalCents)]))}
      <ul>${summary.assumptions.map((a:string)=>h`<li>${a}</li>`)}</ul>` : ''}
    ${entries.map(s=>h`<h3><a href="/app/subscriptions/${s.subscription}">${s.customer}</a></h3><p>Proposed change: ${formatDate(s.effective_date)}. Unselected subscriptions keep their prices.</p>
      ${table(['Issued invoice','Service period','Before$','Proposed$','Difference$'],s.historical.periods.map((p:Row)=>[h`<a href="/app/invoices/${p.invoice}">${p.invoiceNumber}</a>`,formatPeriod(p.period.start,p.period.end),cents(p.before.subtotalCents),cents(p.after.subtotalCents),cents(p.deltaSubtotalCents)]))}
      <h4>Upcoming invoices</h4>${table(['Service period','Before$','Proposed$'],s.periods.map((p:Row)=>[formatPeriod(p.period.start,p.period.end),cents(p.before.totalCents),cents(p.after.totalCents)]))}
      <h4>Prepared customer notice</h4><p class="hint">Prepared for review. No email has been sent.</p><p>${s.notice.recipient} · ${s.notice.subject}</p><p>${s.notice.body}</p>
      ${details({'Historical replay evidence':s.historical})}`)}`
}
