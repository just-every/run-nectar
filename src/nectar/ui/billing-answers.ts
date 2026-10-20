import type { Bindings } from '../../auth.server'
import { can, type Actor } from '../actor'
import { requireAnswerRead } from '../billing-answer-sources'
import { ANSWER_TOPICS, billingAnswer } from '../billing-answers'
import { all, NectarError, type Row } from '../core'
import { money } from '../decimal'
import { Input } from '../input'
import { field, form, h, hidden, page, select, table } from './html'

const TOPIC_LABELS: Record<string, string> = {
  total: 'Invoice total', comparison: 'Change from an earlier invoice', seats: 'Seat charges',
  usage: 'Usage charges', events: 'Source usage events', tax: 'Tax calculation',
  adjustments: 'Discounts and contract credits', commitment: 'Commitments and true-ups',
  balance: 'Balance, payments and credit notes', terms: 'Saved billing terms',
}
const FIGURE_LABELS: Record<string, string> = {
  subtotal: 'Subtotal', tax: 'Tax', total: 'Total', taxableBaseCents: 'Taxable charges', rate: 'Tax rate',
  minimumCents: 'Minimum for active service', nominalMinimumCents: 'Signed minimum', earnedCents: 'Eligible charges',
  previouslySettledCents: 'Previously billed true-ups', paidCents: 'Payments allocated', creditedCents: 'Credit notes', balanceCents: 'Still owed',
}
const CHARGE_LABELS: Record<string, string> = {
  flat: 'Plan fee', seat: 'Seats', usage: 'Usage', overage: 'Overage', metric_usage: 'Metered usage',
  late_usage: 'Late usage', discount: 'Discount', credit: 'Contract credit', cancellation_credit: 'Cancellation credit',
  commitment_trueup: 'Minimum commitment true-up', one_time: 'One-time charge',
}
const recordedValue = (value: string | number, unit: string) => unit === 'cents' ? money(Number(value))
  : unit === 'percent' ? `${value}%` : unit === 'dollars' ? `$${value}`
  : unit === 'dollars per unit' ? `$${value} per unit` : ['seats', 'units', 'raw units'].includes(unit) ? `${value} ${unit}` : String(value)

export async function billingAnswersPage(env: Bindings, actor: Actor, url: URL, input?: Input) {
  requireAnswerRead(actor)
  const customers = await all(env, 'SELECT id,name,external_id FROM nc_customers ORDER BY name,id')
  const customer = input?.text('customer', { optional: true }) || url.searchParams.get('customer') || customers[0]?.id || ''
  const invoices = await all(env, "SELECT id,number,period_start FROM nc_invoices WHERE customer_id=? AND status='issued' ORDER BY period_start DESC,issued_at DESC,id", customer)
  const invoice = input?.text('invoice', { optional: true }) || url.searchParams.get('invoice') || invoices[0]?.id || ''
  const question = input?.text('question', { optional: true, max: 1000 }) || ''
  const topic = input?.text('topic', { optional: true }) || ''
  let answer: Awaited<ReturnType<typeof billingAnswer>> | undefined
  let error = '', status = 200
  if (input) {
    try { answer = await billingAnswer(env, actor, input) }
    catch (failure) {
      if (!(failure instanceof NectarError) || failure.status >= 500) throw failure
      error = ({ answer_question_unsupported: 'This question is outside the supported billing topics', answer_question_ambiguous: 'Choose one topic to clarify this question',
        invoice_not_found: 'The selected invoice is unavailable for this customer', answer_subject_not_found: 'The question names a different customer' } as Record<string, string>)[failure.code] || failure.code.replaceAll('_', ' ')
      status = failure.status
    }
  }
  const context = h`${hidden('customer', customer)}${hidden('invoice', invoice)}${hidden('question', question)}${hidden('topic', answer?.topic || topic)}`
  const result = answer ? h`<section class="card" aria-labelledby="answer"><h2 id="answer">${TOPIC_LABELS[answer.topic]}</h2>
    <p>${answer.summary}</p><p class="hint">Interpreted as: ${TOPIC_LABELS[answer.topic]}. Figures come from the linked saved records; differences are calculated from those figures.</p>
    ${table(['Figure', 'Recorded value', 'Source'], answer.figures.map(figure => [FIGURE_LABELS[figure.label] || figure.label.replaceAll('_', ' '),
      recordedValue(figure.value, figure.unit),
      h`<a href="${figure.source.replace('/api/nectar/', '/app/')}">View calculation evidence</a>`]))}
    ${answer.comparison ? h`<p>Change in total: ${money(answer.comparison.totalDeltaCents)}.</p>
      ${table(['Charge', 'Earlier', 'This invoice', 'Difference'], answer.comparison.lineDeltas.map(line => [CHARGE_LABELS[line.kind] || line.kind.replaceAll('_', ' '), money(line.beforeCents), money(line.afterCents), money(line.deltaCents)]))}` : ''}
    <ul>${answer.details.map(detail => h`<li>${detail}</li>`)}</ul>
    <h3>Calculation evidence</h3><ul>${answer.citations.map(citation => h`<li><a href="${citation.href}">${citation.label}</a></li>`)}</ul>
    <p class="hint">This answer changes no records. It does not establish that a charge is incorrect.</p>
    ${can(actor, 'propose') ? h`<details><summary>Request a credit proposal</summary><p>A requested credit is prepared for human review. No credit or customer message is issued here.</p>
      ${form('answer.propose', '/app/proposals/{id}', h`${context}${field('Requested credit ($)', 'credit_amount')}${field('Reason for review', 'reason')}`, 'Prepare credit proposal')}
    </details>` : ''}</section>` : ''
  return page('Billing answers', actor, h`<h1>Billing answers</h1>
    <p>Ask about an issued invoice. Answers use its saved calculation, usage and terms.</p>
    <section class="card"><h2>Choose a customer</h2>${customers.length ? h`<form method="get" action="/app/answers">${select('Customer', 'customer', customers.map((row: Row) => ({ value: row.id, label: `${row.name} · ${row.external_id}` })), customer)}<button type="submit">Choose customer</button></form>` : h`<p>Add a customer and issue an invoice to ask a billing question.</p>`}</section>
    ${invoices.length ? h`<section class="card"><h2>Ask a question</h2><form method="post" action="/app/answers">${hidden('customer', customer)}
      ${select('Issued invoice', 'invoice', invoices.map((row: Row) => ({ value: row.id, label: `${row.number} · ${row.period_start}` })), invoice)}
      ${field('Question', 'question', { value: question, hint: 'For example: Why is this invoice higher than the previous invoice?' })}
      ${select('Question topic', 'topic', [{ value: '', label: 'Interpret my question' }, ...ANSWER_TOPICS.map(value => ({ value, label: TOPIC_LABELS[value] }))], topic, { required: false, hint: 'Choose a topic if your question is unclear. Questions outside these topics are refused.' })}
      <button type="submit">Explain from billing evidence</button></form></section>` : customers.length ? h`<section class="card"><p>This customer has no issued invoice yet.</p></section>` : ''}
    ${error ? h`<p class="flash error" role="alert">${error}. Choose a supported topic or check the selected invoice.</p>` : ''}${result}`, { current: '/app/answers', url, status })
}
