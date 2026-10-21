import { subscriptionCalendar } from '../billing-plan'
import { addMonths } from '../dates'
import { NectarError } from '../core'
import { clockInstant } from '../clock'
// USE-006 adds a read-only calculation card to the existing subscription screen.
import type { Bindings } from '../../auth.server'
import type { Actor } from '../actor'
import { requireBusiness } from '../business'
import { insist, type Row } from '../core'
import { isMonth, periodContaining, periodStartingIn, today, formatPeriod } from '../dates'
import { quantityText } from '../decimal'
import { upcoming } from '../upcoming'
import { cents, details, field, h, table, tag, when } from './html'

export async function upcomingSection(env: Bindings, actor: Actor, sub: Row, url: URL) {
  const id=sub.id
  const month=url.searchParams.get('preview_period')
  insist(month===null || isMonth(month),'invalid_period')
  const business=await requireBusiness(env)
  const calendar=await subscriptionCalendar(env,sub),selected=month??today(business.timezone,clockInstant(env)).slice(0,7)
  const period=calendar.enabled?{start:`${selected}-01`,end:addMonths(`${selected}-01`,1)}:month ? periodStartingIn(sub.anchor_day,month) : periodContaining(sub.anchor_day,today(business.timezone,clockInstant(env)))
  const selector=h`<form method="get" action="/app/subscriptions/${id}#upcoming" class="row-form">${field('Preview month','preview_period',{type:'month',value:period.start.slice(0,7)})}<button class="secondary" type="submit">Show preview</button></form>`
  if(sub.start_date>=period.end || (sub.end_date && sub.end_date<=period.start) || (sub.cutover_start && period.end<=sub.cutover_start))
    return h`<section class="card" aria-labelledby="upcoming"><h2 id="upcoming">Upcoming invoice</h2><p>No Nectar invoice preview for this period: ${sub.cutover_start && period.end<=sub.cutover_start ? 'the previous biller owns it' : 'the subscription is outside its service dates'}. Select a month within its Nectar service dates.</p>${selector}</section>`
  let result
  try {result=await upcoming(env,actor,id,url.searchParams.get('preview_period'))}catch(error){
    if(!(error instanceof NectarError)||error.code!=='billing_window_not_due')throw error
    return h`<section class="card" aria-labelledby="upcoming"><h2 id="upcoming">Upcoming invoices</h2><p>No service component is due in this month.</p>${selector}</section>`
  }
  return h`${('invoices' in result?result.invoices:[result]).map(view=>{const calc=view.calculation;return h`<section class="card" aria-labelledby="upcoming"><div class="card-head"><h2 id="upcoming">${view.state==='issued' ? 'Issued calculation' : view.state==='shadow' ? 'Shadow calculation' : 'Upcoming invoice'}</h2>${tag(view.state==='issued' ? 'Issued' : view.state==='shadow' ? 'Shadow' : 'Preview')}</div>
    <p>${formatPeriod(view.period.start,view.period.end)} · ${view.timezone} · Due ${view.billingDueDate}</p>
    <p class="hint">${view.state==='issued' ? 'Saved issued inputs; later usage does not rewrite this invoice.' : 'Full-period fixed charges plus ingested usage. Future usage is not forecast. Refresh to read the latest recorded inputs; no invoice is prepared or approved.'}</p>
    ${selector}
    <h3>Period usage</h3>${table(['Meter','Quantity$','Events$','Earlier usage$'],view.meters.map(m=>[h`<span>${m.code}</span>${m.dimensions?h`<p>${Object.entries(m.dimensions).map(([k,v])=>`${k}: ${v}`).join(', ')}</p>`:''}`,`${quantityText(m.quantity)} ${m.unit_label}`,m.events,quantityText(m.lateQuantity)]),{empty:'No metered prices on this subscription.'})}
    <h3>Approved contract credits remaining: ${cents(view.remainingContractCreditCents)}</h3>
    ${table(['Credit','Effective from','Amount$','This period'],view.credits.map(c=>[c.note || 'Approved contract credit',c.effective_from,cents(c.amountCents),c.appliesThisPeriod ? 'Applies' : 'Scheduled for another period']),{empty:'No approved unused one-time contract credits. Prepaid credit balances are not yet available.'})}
    <h3>Calculation: ${cents(calc.totalCents)}</h3>${table(['Charge','Service from','Service until','Quantity$','Amount$'],calc.lines.map((l:any)=>[l.description,l.periodStart,l.periodEnd,l.quantity,cents(l.amountCents)]))}
    <p>Subtotal ${cents(calc.subtotalCents)} · Tax ${cents(calc.taxCents)} · Total ${cents(calc.totalCents)}</p>
    ${calc.exceptions.length ? h`<h3>Review before issue</h3><ul>${calc.exceptions.map((e:any)=>h`<li>${e.message}</li>`)}</ul>` : ''}
    ${view.invoiceId ? h`<p><a href="/app/invoices/${view.invoiceId}">Open issued invoice</a></p>` : ''}
    <p class="hint">Read at ${when(view.generatedAt,view.timezone)}</p>${details({'Input fingerprint':calc.fingerprint,'Rating rules':calc.version},'Calculation basis')}</section>`})}`
}
