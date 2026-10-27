import type { Bindings } from '../../auth.server'
import type { Actor } from '../actor'
import { reportSchedule, reportDelivery } from '../report-schedules'
import { cents, check, details, field, form, h, page, table } from './html'

export async function reportSchedulePage(env: Bindings,actor: Actor,url: URL) {
  const view=await reportSchedule(env,actor)
  return page('Monthly financial reports',actor,h`<p class="crumbs"><a href="/app/reports/billings">Financial reports</a></p><h1>Monthly financial reports</h1>
    <section class="card"><h2>Your email schedule</h2><p>Send the previous month's reports to your own email on the chosen day in the billing timezone. Reports include recorded gross receipts, available processor settlements, successful cash refunds and current AR at generation, with their exact definitions. Provider acceptance does not confirm mailbox delivery.</p>
      ${form('report.schedule','/app/report-schedule',h`${check('Email my monthly report','enabled',{checked:view.schedule.enabled})}${field('Day of month','day',{type:'number',value:view.schedule.day,hint:'Choose a day from 1 to 28.'})}`,'Save schedule')}</section>
    <section class="card"><h2>Your report history</h2>${table(['Month','Generated report','Mail outcome'],view.deliveries.map(d=>[d.period,h`<a href="/app/report-deliveries/${d.id}">Open frozen report</a>`,d.status]),{empty:'No monthly reports have been generated for you.'})}</section>`,{current:'/app/billing',url})
}
export async function reportDeliveryPage(env: Bindings,actor: Actor,id: string,url: URL) {
  const d=await reportDelivery(env,actor,id)
  return page('Frozen financial reports',actor,h`<p class="crumbs"><a href="/app/report-schedule">Your report schedule</a></p><h1>Financial reports · ${d.period}</h1><p class="lede">Frozen when generated · Mail outcome: ${d.status}</p>
    <p><a href="/app/report-deliveries/${id}.csv">Download this snapshot as CSV</a></p>
    ${d.reports.map(r=>h`<section class="card"><h2>${r.title}: ${cents(r.totalCents)}</h2><p>${r.definition}</p><p>Report basis: ${r.period}. Source links open the saved calculation below. Figures and source evidence remain frozen.</p>
      ${table(['Source','Customer','Contribution$'],r.entries.map(e=>[h`<a href="${e.href}">${e.number}</a>`,e.customerName,cents(e.amountCents)]),{empty:'No source records contribute.'})}</section>`)}
    ${d.sourceEvidence.map((source:any)=>h`<section class="card" id="source-${source.metric}-${source.sourceId}"><h2>Saved source · ${source.detail.number}</h2><p>${source.detail.definition}</p>${table(['Source','Contribution$'],source.detail.components.map((c:any)=>[c.label,cents(c.amountCents)]))}${details(source.detail,'Frozen lines, calculation and source evidence')}<p><a href="${source.sourcePath}">Open current source</a></p></section>`)}`,{current:'/app/billing',url})
}
