// The signed customer capability is the reader; it never becomes an operator.
import type { Bindings } from '../auth.server'
import type { CustomerSession } from './portal-session'
import { billingAnswer, ANSWER_TOPICS } from './billing-answers'
import { Input } from './input'
import { portalData } from './portal-data'
import { customerText } from './locale'
import { h } from './ui/html'

const fixedLabels: Record<string, string> = {
  subtotal:'subtotal',tax:'tax',total:'total',taxableBaseCents:'taxable',rate:'rate',
  'Previous total':'previous','Selected total':'selected','Billed seats':'seats',
  'Rated line quantity':'quantity','Original tax':'tax','minimumCents':'minimum',
  nominalMinimumCents:'nominal',earnedCents:'earned',previouslySettledCents:'settled',
  'Saved signed nominal minimum':'nominal',paidCents:'paid',creditedCents:'credited',balanceCents:'owed',
  'Payment due':'due','Service begins':'start','Service ends (exclusive)':'end',
  'Saved catalogue unit price':'price','Saved tier unit price':'price','Saved tier flat fee':'fee',
  'Saved tier upper quantity':'quantity','Saved package size':'quantity',
}
const portalLink = (value: string) => value.replace(/^\/api\/nectar\/invoices\//, '/portal/evidence/invoices/').replace(/^\/app\/invoices\//, '/portal/invoices/')

export async function portalAnswer(env: Bindings, session: CustomerSession, input: Input) {
  input.only(['invoice','question','topic','comparison_invoice'])
  const answer = await billingAnswer(env, session, Input.of({ ...Object.fromEntries(['invoice','question','topic','comparison_invoice'].filter(key=>input.has(key)).map(key=>[key,input.text(key,{optional:true,max:1000})])), customer: session.customer }))
  const L = customerText(session.language,session.currency)
  const figures = answer.figures.map(figure => {
    const key = fixedLabels[figure.label]
    const label = figure.label.startsWith('Source event ') ? L.t('portal.answer.event',{id:figure.label.slice('Source event '.length)})
      : figure.label.startsWith('Credit note ') ? L.t('portal.answer.creditnote',{number:figure.label.slice('Credit note '.length)})
      : figure.label.startsWith('Allocated payment ') ? L.t('portal.answer.payment',{number:figure.label.slice('Allocated payment '.length)})
      : figure.label==='Saved discount_percent' ? L.t('portal.answer.discount')
      : figure.label==='Saved fixed_credit' ? L.t('portal.answer.fixedcredit')
      : figure.label==='Saved price_override' ? L.t('portal.answer.figure.price')
      : key ? L.t(`portal.answer.figure.${key}`)
      : /^(Source event |Event property |Credit note |Allocated payment |Prior invoice |Saved )/.test(figure.label) ? L.t('portal.answer.record') : figure.label
    return { ...figure, label, source: portalLink(figure.source) }
  })
  return { customerId:answer.customerId,invoiceId:answer.invoiceId,topic:answer.topic,
    summary:L.t(`portal.answer.topic.${answer.topic}`),figures,
    citations:answer.citations.map(citation=>({ href:portalLink(citation.href).replace(/\/lines\/[^/#]+/, ''),label:L.t('portal.answer.evidence') })),
    comparison:answer.comparison ? { ...answer.comparison,
      operands:answer.comparison.operands.map(figure=>({...figure,label:L.t('portal.answer.record'),source:portalLink(figure.source)})),
      lineDeltas:answer.comparison.lineDeltas.map(line=>({...line,before:line.before.map(f=>({...f,source:portalLink(f.source)})),after:line.after.map(f=>({...f,source:portalLink(f.source)}))})) } : undefined,
    details:[L.t('portal.answer.saved')],
  }
}

export async function portalAnswersPage(env: Bindings, session: CustomerSession, input: Input, link:(path:string)=>string) {
  const L=customerText(session.language,session.currency)
  const invoices=(await portalData(env,session)).invoices
  const invoice=input.text('invoice',{optional:true,max:100})||invoices[0]?.id||''
  const question=input.text('question',{optional:true,max:1000})
  const result=question ? await portalAnswer(env,session,input) : null
  return h`<h1>${L.t('portal.answer.heading')}</h1><p><a href="${link('/portal')}">${L.t('portal.back')}</a></p>
    <form method="get" action="/portal/answers"><input type="hidden" name="session" value="${link('').split('session=')[1]}">
    <label>${L.t('portal.answer.invoice')}<select name="invoice" required>${invoices.map(row=>h`<option value="${row.id}" ${row.id===invoice?'selected':''}>${row.number} · ${L.day(row.issue_date)}</option>`)}</select></label>
    <label>${L.t('portal.answer.question')}<input name="question" value="${question}" required maxlength="1000"></label>
    <label>${L.t('portal.answer.topic')}<select name="topic"><option value="">${L.t('portal.answer.interpret')}</option>${ANSWER_TOPICS.map(topic=>h`<option value="${topic}" ${input.text('topic',{optional:true})===topic?'selected':''}>${L.t(`portal.answer.topic.${topic}`)}</option>`)}</select></label>
    <button>${L.t('portal.answer.ask')}</button></form>
    ${result?h`<section class="card"><h2>${result.summary}</h2><p>${L.t('portal.answer.saved')}</p><dl>${result.figures.map(figure=>h`<dt>${figure.label}</dt><dd>${figure.unit==='cents'?L.money(Number(figure.value)):figure.unit==='date'?L.day(String(figure.value)):figure.unit==='percent'?L.percent(figure.value)+'%':['dollars','dollars per unit'].includes(figure.unit)?L.amount(String(figure.value)):figure.value} <a href="${link(figure.source)}">${L.t('portal.answer.evidence')}</a></dd>`)}</dl>
      ${result.comparison?h`<p>${L.t('portal.answer.change')}: ${L.money(result.comparison.totalDeltaCents)}</p><h3>${L.t('portal.answer.linechanges')}</h3>${result.comparison.lineDeltas.map(line=>h`<p>${line.after[0]?.label||line.before[0]?.label} · ${L.money(line.beforeCents)} → ${L.money(line.afterCents)} (${L.money(line.deltaCents)}) <a href="${link(line.after[0]?.source||line.before[0].source)}">${L.t('portal.answer.evidence')}</a></p>`)}`:''}
      ${result.citations.map(c=>h`<p><a href="${link(c.href)}">${c.label}</a></p>`)}
      <h3>${L.t('portal.answer.proposal')}</h3><p>${L.t('portal.answer.pending')}</p><form method="post" action="${link('/portal/answer-proposal')}"><input type="hidden" name="invoice" value="${invoice}"><input type="hidden" name="question" value="${question}"><input type="hidden" name="topic" value="${result.topic}"><label>${L.t('portal.answer.requested')}<input name="credit_amount" required inputmode="decimal"></label><label>${L.t('portal.answer.reason')}<input name="reason" required maxlength="500"></label><button>${L.t('portal.answer.prepare')}</button></form></section>`:''}`
}
