// Ordinary merchant portal cards, sharing the existing customer page frame.
import type { Bindings } from '../auth.server'
import type { CustomerSession } from './portal-session'
import { portalUpcoming, portalUpcomingSubscriptions } from './portal-upcoming'
import { portalCorrectionsData } from './portal-correction-data'
import { customerText } from './locale'
import { h } from './ui/html'

export async function portalUpcomingPage(env:Bindings,session:CustomerSession,url:URL,link:(path:string)=>string){
  const L=customerText(session.language,session.currency),subscriptions=await portalUpcomingSubscriptions(env,session)
  const id=url.searchParams.get('subscription')||subscriptions[0]?.id
  const preview=id?await portalUpcoming(env,session,id,url.searchParams.get('period')):null
  return h`<h1>${L.t('portal.upcoming.heading')}</h1><p><a href="${link('/portal')}">${L.t('portal.back')}</a></p>
    ${subscriptions.length?h`<form method="get" action="/portal/upcoming"><input type="hidden" name="session" value="${url.searchParams.get('session')}"><label>${L.t('portal.upcoming.subscription')}<select name="subscription">${subscriptions.map(sub=>h`<option value="${sub.id}" ${id===sub.id?'selected':''}>${sub.label||L.t('portal.upcoming.subscription')} · ${L.day(sub.start_date)}</option>`)}</select></label><label>${L.t('portal.upcoming.period')}<input type="month" name="period" value="${preview?.billingMonth}" required></label><button>${L.t('portal.upcoming.refresh')}</button></form>`:''}
    ${preview?preview.invoices.map(invoice=>h`<section class="card"><h2>${L.t(`portal.upcoming.${invoice.state}`)}</h2><p>${L.day(invoice.period.start)} – ${L.day(invoice.period.end)} · ${invoice.timezone}</p><p>${L.t('portal.upcoming.excludes')}</p><dl><dt>${L.t('portal.subtotal')}</dt><dd>${L.money(invoice.calculation.subtotalCents)}</dd><dt>${L.t('portal.tax')}</dt><dd>${L.money(invoice.calculation.taxCents)}</dd><dt>${L.t('portal.total')}</dt><dd>${L.money(invoice.calculation.totalCents)}</dd><dt>${L.t('portal.upcoming.credits')}</dt><dd>${L.money(invoice.remainingContractCreditCents)}</dd></dl>
      ${invoice.calculation.lines.map(line=>h`<p>${line.description} · ${L.day(line.periodStart)} – ${L.day(line.periodEnd)} · ${line.quantity} · ${L.money(line.amountCents)}</p>`)}
      <h3>${L.t('portal.upcoming.usage')}</h3>${invoice.meters.map(meter=>h`<p>${meter.name} · ${meter.quantity} ${meter.unit_label}</p>`)}
      <a href="${link('/portal/usage.csv')}&amp;subscription=${id}&amp;period=${preview.billingMonth}">${L.t('portal.upcoming.csv')}</a></section>`):h`<p>${L.t('portal.upcoming.empty')}</p>`}`
}

export async function portalAdjustmentsPage(env:Bindings,session:CustomerSession,link:(path:string)=>string){
  const L=customerText(session.language,session.currency),{corrections}=await portalCorrectionsData(env,session)
  return h`<h1>${L.t('portal.adjustments.heading')}</h1><p><a href="${link('/portal')}">${L.t('portal.back')}</a></p>${corrections.length?corrections.map(correction=>h`<section class="card"><h2>${correction.message.subject}</h2><p>${L.t('portal.adjustments.approved')}</p>${String(correction.message.body).split('\n').map(line=>h`<p>${line}</p>`)}${correction.periods.map((period:any)=>h`<p>${L.day(period.period.start)} – ${L.day(period.period.end)} · ${L.money(period.before.totalCents)} → ${L.money(period.after.totalCents)}</p>`)}<a href="${link(`/portal/corrections/${correction.id}`)}">${L.t('portal.answer.evidence')}</a></section>`):h`<p>${L.t('portal.adjustments.empty')}</p>`}`
}

export async function portalUsageCsv(env:Bindings,session:CustomerSession,url:URL){
  const preview=await portalUpcoming(env,session,url.searchParams.get('subscription')||'',url.searchParams.get('period'))
  const cell=(value:unknown)=>'"'+String(value??'').replaceAll('"','""')+'"'
  return ['meter,period_start,period_end,quantity,earlier_quantity',...preview.invoices.flatMap(invoice=>invoice.meters.map(meter=>[meter.code,meter.periodStart,meter.periodEnd,meter.quantity,meter.lateQuantity].map(cell).join(',')))].join('\r\n')+'\r\n'
}
