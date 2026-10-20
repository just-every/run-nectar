import type { Row } from '../core'
import { cents, h, table } from './html'
import { formatPeriod } from '../dates'

export function creditCorrectionBody(p:Row){
  const i=p.impact.invoice,c=p.impact.credit,m=p.impact.mail
  return h`<h2>Invoice credit simulation</h2><p><a href="/app/invoices/${i.id}">Invoice ${i.number}</a></p>
    ${table(['Measure','Before$','After$'],[['Issued subtotal',cents(i.subtotalCents),cents(i.subtotalCents)],['Original invoice tax',cents(i.taxCents),cents(i.taxCents)],['Issued invoice total',cents(i.totalCents),cents(i.totalCents)],['Amount owed',cents(c.balanceBeforeCents),cents(c.balanceAfterCents)]])}
    <p>Proposed credit note: <strong>${cents(c.amountCents)}</strong>. ${p.impact.issuedInvoice}</p><p>${p.impact.tax}</p><p>${p.impact.futureInvoices}</p>${typeof p.impact.revenue==='string'?h`<p>${p.impact.revenue}</p>`:revenueEffect(p.impact.revenue.periods,p.impact.revenue.policyVersion)}<p>${p.impact.mrr} ${p.impact.portal}</p>
    <h3>Cited source lines</h3><ul>${m.citations.map((cite:Row)=>h`<li><a href="${cite.source}">Source line</a><blockquote>${cite.quote}</blockquote></li>`)}</ul>
    <h3>Customer explanation</h3><p>${m.explanation}</p><h3>Email after approval</h3><p>To: ${m.recipient}</p><p>Subject: ${m.subject}</p><pre class="message">${m.body}</pre><p>${m.outcome}</p>
    ${p.correctionMail?h`<p>Mail outcome: <strong>${p.correctionMail.status}</strong>. Provider acceptance does not confirm mailbox delivery.</p>`:''}`
}
export function correctionImpactRows(periods:Row[]){
  return h`${table(['Period','Subtotal before$','Subtotal after$','Tax before$','Tax after$','Total before$','Total after$','Total change$'],periods.map(p=>[formatPeriod(p.period.start,p.period.end),cents(p.before.subtotalCents),cents(p.after.subtotalCents),cents(p.before.taxCents),cents(p.after.taxCents),cents(p.before.totalCents),cents(p.after.totalCents),cents(p.after.totalCents-p.before.totalCents)]))}${periods.filter(p=>Array.isArray(p.revenueDeltas)).map(p=>revenueEffect(p.revenueDeltas,p.before.revenue.policyVersion))}`
}
export function draftCorrectionMessages(p:Row){
  const notices=p.payload.noticeDrafts??[]
  return h`${notices.map((m:Row)=>h`<section class="card"><h2>Customer explanation after approval</h2><p>To: ${m.recipient}</p><p>Subject: ${m.subject}</p><pre class="message">${m.body}</pre><ul>${m.citations.map((c:Row)=>h`<li><a href="${c.source}">${c.quote}</a></li>`)}</ul>
    <p>Mail outcome: ${p.customerMessages?.find((r:Row)=>r.customer_id===m.customer)?.status??'Awaiting human approval'}. Provider acceptance does not confirm mailbox delivery.</p></section>`)}`
}

function revenueEffect(periods:Row[],policy:string){
 return h`<h3>Revenue recognition effect</h3><p>Tax is excluded. Recognition policy: ${policy}.</p>${table(['Month','Revenue before$','Revenue after$','Revenue change$'],periods.map(r=>[h`<span data-revenue-period="${r.period}" data-before-cents="${r.beforeCents}" data-after-cents="${r.afterCents}" data-delta-cents="${r.deltaCents}">${r.period}</span>`,cents(r.beforeCents),cents(r.afterCents),cents(r.deltaCents)]))}`
}
