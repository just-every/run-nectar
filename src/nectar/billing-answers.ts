// Parameterized billing explanations, with no provider calls or state changes.
import type { Bindings } from '../auth.server'
import { requireCapability, type Actor } from './actor'
import { requireBusiness } from './business'
import { insist, type Row } from './core'
import { planInvoiceCredit } from './credit-correction'
import { cents, plainMoney } from './decimal'
import type { Input } from './input'
import { answerComparison, answerInvoice, answerUsageLines, checkAnswerSubject, commitmentCitations, compareLines, figure, lineFigures, pointer,
  type AnswerCitation, type AnswerFigure, type AnswerInvoice } from './billing-answer-sources'

export const ANSWER_TOPICS = ['total', 'comparison', 'seats', 'usage', 'events', 'tax', 'adjustments', 'commitment', 'balance', 'terms'] as const
export type AnswerTopic = typeof ANSWER_TOPICS[number]
export interface BillingAnswer {
  customerId: string; invoiceId: string; question: string; topic: AnswerTopic; summary: string
  figures: AnswerFigure[]; citations: AnswerCitation[]; details: string[]
  comparison?: { invoiceId: string; totalDeltaCents: number; operands: AnswerFigure[]; lineDeltas: ReturnType<typeof compareLines> }
  proposalDraft?: { kind: string; title: string; payload: Row }
}

const patterns: Record<AnswerTopic, RegExp> = {
  total: /\b(total|subtotal|invoice amount|bill amount|how much|cost|charged overall|charge amount)\b/,
  comparison: /\b(higher|lower|increase[ds]?|decrease[ds]?|difference|different|compare|comparison|changed?|last month|previous (?:invoice|bill|period)|more than|less than|more expensive|cheaper|(?:went|go|gone) (?:up|down)|rose|dropped)\b/,
  seats: /\b(seats?|licenses?|licences?|users?|per[- ]seat)\b/,
  usage: /\b(usage|meter(?:ed|ing)?|consumption|consumed|overage|units?|calls?|requests?)\b/,
  events: /\b(events?|raw records?|source records?|logs?|event ids?|snapshots?)\b/,
  tax: /\b(tax(?:es|able|ation)?|sales tax|jurisdiction|exempt(?:ion)?)\b/,
  adjustments: /\b(discounts?|credits?|adjustments?|coupons?|prorat(?:a|ed|ion)|unused service)\b/,
  commitment: /\b(commitments?|minimums?|true[- ]?ups?|burn[- ]?down|shortfall|included allowance)\b/,
  balance: /\b(balance|outstanding|owed?|owing|payments?|pay|paid|receipts?|settle[ds]?|allocations?|due|unpaid)\b/,
  terms: /\b(terms?|contract|agreement|price|pricing|rate|rules?|period|service dates?|trial|cancel(?:lation|led)?|ramp|uplift)\b/,
}

function interpret(question: string, chosen: string): AnswerTopic {
  const normalized = question.toLowerCase().replace(/[’']/g, '').replace(/\s+/g, ' ')
  // These requests ask for another subject or unavailable capabilities. An
  // explicit interpretation never turns them into a successful answer.
  insist(!/\b(another|other|every|all) customers?\b|\b(refund|bank account|card number|forecast|predict|journal|revenue recognition|upcoming|next (?:invoice|bill|month|period))\b/.test(normalized), 'answer_question_unsupported', 400)
  if (chosen) {
    insist(ANSWER_TOPICS.includes(chosen as AnswerTopic), 'answer_topic_unsupported', 400)
    return chosen as AnswerTopic
  }
  const found = ANSWER_TOPICS.filter(topic => patterns[topic].test(normalized))
  // More specific explanations include their natural operands: tax on a total,
  // events behind usage, seat price, commitment terms, and credit balance.
  const specific = found.filter(topic => !['total', 'terms'].includes(topic))
  if (specific.includes('comparison')) {
    insist(!/\b(and|also|plus|as well as)\b/.test(normalized), 'answer_question_ambiguous', 400)
    return 'comparison'
  }
  let candidates = specific.includes('events') ? specific.filter(topic => topic !== 'usage') : specific
  // A balance naturally includes payments and credit notes. Contract credits
  // without settlement words still ask about billed adjustments instead.
  if (candidates.includes('balance') && /\b(balance|outstanding|owed?|owing|payments?|paid|allocations?)\b/.test(normalized)) candidates = candidates.filter(topic => topic !== 'adjustments')
  if (candidates.length === 1) return candidates[0]
  if (!candidates.length && found.length === 1) return found[0]
  insist(false, found.length ? 'answer_question_ambiguous' : 'answer_question_unsupported', 400)
}

const labels: Record<AnswerTopic, string> = {
  total: 'Original issued invoice totals', comparison: 'Changes between the selected issued invoices', seats: 'Saved seat charges and quantities',
  usage: 'Saved billed usage and calculation evidence', events: 'Original events retained with the issued calculation', tax: 'Original saved tax calculation',
  adjustments: 'Billed adjustments and issued credit notes', commitment: 'Saved minimum commitment and true-up evidence',
  balance: 'Recorded payments, credits, due date and remaining balance', terms: 'Terms retained in the issued calculation',
}

async function addTopic(env: Bindings, actor: Actor, record: AnswerInvoice, answer: BillingAnswer, input: Input) {
  const { invoice } = record, lines = invoice.lines as Row[], saved = invoice.calculation?.inputs
  const add = (label: string, value: unknown, unit: string, path: string) => answer.figures.push(figure(record, label, value, unit, path))
  const selectLines = (test: (line: Row) => boolean) => {
    answer.figures.push(...lineFigures(record, test))
    lines.filter(test).forEach(line => answer.citations.push({ href: `${record.href}/lines/${encodeURIComponent(line.id)}`, label: line.description }))
  }
  switch (answer.topic) {
    case 'total':
      for (const key of ['subtotal', 'tax', 'total']) add(key, invoice[`${key}_cents`], 'cents', `/${key}_cents`)
      break
    case 'comparison': {
      const previous = await answerComparison(env, actor, record, input.text('comparison_invoice', { optional: true, max: 100 }))
      const before = figure(previous, 'Previous total', previous.invoice.total_cents, 'cents', '/total_cents')
      const after = figure(record, 'Selected total', invoice.total_cents, 'cents', '/total_cents')
      answer.figures.push(before, after)
      answer.citations.push({ href: previous.href, label: `Comparison invoice ${previous.invoice.number}` })
      const delta = invoice.total_cents - previous.invoice.total_cents
      insist(Number.isSafeInteger(delta), 'answer_amount_out_of_range', 409)
      answer.comparison = { invoiceId: previous.invoice.id, totalDeltaCents: delta, operands: [after, before], lineDeltas: compareLines(record, previous) }
      answer.details.push('Deltas subtract the comparison invoice from the selected invoice. Split service lines are grouped by immutable price, charge kind and meter; original invoices remain unchanged.')
      break
    }
    case 'seats':
      selectLines(line => line.kind === 'seat')
      lines.forEach((line, index) => { if (line.kind === 'seat') add('Billed seats', line.quantity, 'seats', `/lines/${index}/quantity`) })
      break
    case 'usage':
    case 'events': {
      const evidence = await answerUsageLines(env, actor, record)
      for (const item of evidence) {
        const source = `/api/nectar/invoices/${encodeURIComponent(invoice.id)}/lines/${encodeURIComponent(item.line.id)}`
        answer.citations.push({ href: `${record.href}/lines/${encodeURIComponent(item.line.id)}`, label: item.line.description })
        answer.figures.push({ label: item.line.description, value: item.line.amount_cents, unit: 'cents', source, recordPath: '/line/amount_cents' },
          { label: 'Rated line quantity', value: item.line.quantity, unit: 'units', source, recordPath: '/line/quantity' })
        item.events.forEach((event, index) => {
          answer.figures.push({ label: `Source event ${event.eventId}`, value: event.quantity, unit: 'raw units', source, recordPath: `/events/${index}/quantity` })
          if (answer.topic === 'events') {
            answer.details.push(`Saved event ${event.eventId}; meter ${event.meterId}; recorded properties ${JSON.stringify(event.properties ?? {})}.`)
            Object.entries(event.properties ?? {}).forEach(([key, value]) => {
              if (typeof value === 'number' || typeof value === 'string') answer.figures.push({ label: `Event property ${key}`, value, unit: 'property', source, recordPath: `/events/${index}/properties/${pointer(key)}` })
            })
          }
        })
      }
      answer.details.push('Raw source quantities are evidence inputs; derived metric quantities can differ under the saved aggregation and pricing rules. Later ingestion does not rewrite this invoice.')
      break
    }
    case 'tax':
      add('Original tax', invoice.tax_cents, 'cents', '/tax_cents')
      for (const [key, unit] of [['taxableBaseCents', 'cents'], ['rate', 'percent']] as const)
        if (invoice.calculation.tax?.[key] !== undefined) add(key, invoice.calculation.tax[key], unit, `/calculation/tax/${key}`)
      answer.details.push(`Saved tax rule: ${invoice.calculation.tax?.rule ?? 'No tax rule was retained.'}`)
      break
    case 'adjustments':
      selectLines(line => ['discount', 'credit', 'cancellation_credit'].includes(line.kind))
      ;(invoice.credits as Row[]).forEach((credit, index) => add(`Credit note ${credit.number}`, credit.amount_cents, 'cents', `/credits/${index}/amount_cents`))
      answer.details.push('Credit notes reduce the outstanding balance. They do not rewrite the original invoice tax or issued totals.')
      break
    case 'commitment':
      selectLines(line => line.kind === 'commitment_trueup')
      lines.forEach((line, index) => {
        if (line.kind !== 'commitment_trueup') return
        for (const key of ['minimumCents', 'nominalMinimumCents', 'earnedCents', 'previouslySettledCents'])
          if (line.evidence[key] !== undefined) add(key, line.evidence[key], 'cents', `/lines/${index}/evidence/${key}`)
        ;(line.evidence.priorInvoices ?? []).forEach((prior: Row, priorIndex: number) => add(`Prior invoice ${prior.number} eligible earnings`, prior.earnedCents, 'cents', `/lines/${index}/evidence/priorInvoices/${priorIndex}/earnedCents`))
      })
      ;(saved?.contracts?.commitments ?? []).forEach((window: Row, index: number) => add('Saved signed nominal minimum', window.minimumCents, 'cents', `/calculation/inputs/contracts/commitments/${index}/minimumCents`))
      answer.citations.push(...await commitmentCitations(env, record))
      break
    case 'balance':
      for (const key of ['paidCents', 'creditedCents', 'balanceCents']) add(key, invoice[key], 'cents', `/${key}`)
      add('Payment due', invoice.due_date, 'date', '/due_date')
      ;(invoice.allocations as Row[]).forEach((payment, index) => add(`Allocated payment ${payment.reference}`, payment.amount_cents, 'cents', `/allocations/${index}/amount_cents`))
      answer.details.push('Payments shown are recorded receipts allocated to this invoice; this answer does not independently verify bank or processor settlement.')
      break
    case 'terms':
      insist(saved, 'answer_evidence_missing', 409)
      add('Service begins', invoice.period_start, 'date', '/period_start')
      add('Service ends (exclusive)', invoice.period_end, 'date', '/period_end')
      Object.entries(saved.prices ?? {}).forEach(([id, price]) => {
        const value = price as Row
        const path = `/calculation/inputs/prices/${pointer(id)}`
        if (!value.pricing) add('Saved catalogue unit price', value.unitAmount, 'dollars per unit', `${path}/unitAmount`)
        else {
          answer.details.push(`Price ${id} uses its saved ${value.pricing.model} quantity-pricing model.`)
          ;(value.pricing.tiers ?? []).forEach((tier: Row, index: number) => {
            add('Saved tier unit price', tier.unitAmount, 'dollars per unit', `${path}/pricing/tiers/${index}/unitAmount`)
            add('Saved tier flat fee', tier.flatAmount, 'dollars', `${path}/pricing/tiers/${index}/flatAmount`)
            if (tier.upTo !== null) add('Saved tier upper quantity', tier.upTo, 'units', `${path}/pricing/tiers/${index}/upTo`)
          })
          if (value.pricing.packageSize !== undefined) add('Saved package size', value.pricing.packageSize, 'units', `${path}/pricing/packageSize`)
        }
      })
      ;(saved.amendments ?? []).forEach((amendment: Row, index: number) => {
        add(`Saved ${amendment.kind}`, amendment.value, amendment.kind === 'discount_percent' ? 'percent' : 'dollars', `/calculation/inputs/amendments/${index}/value`)
        answer.details.push(`Saved amendment ${amendment.id}: ${amendment.note || 'No note recorded.'}`)
      })
      answer.details.push('These are the billing inputs retained when this invoice was issued. They do not substitute current plan values or verify execution of a signed document.')
  }
  if (!answer.figures.length) answer.details.push('The selected issued invoice contains no saved records for this topic.')
}

export async function billingAnswer(env: Bindings, actor: Actor, input: Input): Promise<BillingAnswer> {
  requireCapability(actor, 'read')
  const customer = input.text('customer', { max: 100 }), id = input.text('invoice', { max: 100 })
  const question = input.text('question', { max: 1000 })
  const record = await answerInvoice(env, actor, customer, id)
  await checkAnswerSubject(env, customer, question)
  const topic = interpret(question, input.text('topic', { optional: true, max: 30 }))
  if (input.has('comparison_invoice') && topic !== 'comparison') await answerComparison(env, actor, record, input.text('comparison_invoice', { max: 100 }))
  const answer: BillingAnswer = { customerId: customer, invoiceId: id, question, topic, summary: labels[topic], figures: [],
    citations: [{ href: record.href, label: `Issued invoice ${record.invoice.number}` }], details: [] }
  await addTopic(env, actor, record, answer, input)
  if (input.has('credit_amount')) {
    const amount = cents(input.text('credit_amount', { max: 20 }), 'credit_amount')
    insist(amount > 0, 'invalid_credit_amount')
    const reason = input.text('reason', { max: 500 })
    const line = (record.invoice.lines as Row[])[0]
    insist(line, 'invoice_credit_line_not_found', 409)
    const explanation = `A requested credit of $${plainMoney(amount)} would reduce the recorded outstanding balance from $${plainMoney(record.invoice.balanceCents)} to $${plainMoney(record.invoice.balanceCents - amount)}. This is a proposal for human review, not a finding that the billed charge was incorrect. Original invoice tax remains unchanged.`
    const payload = { invoice_credit: true, invoice: id, amount: plainMoney(amount), reason, explanation,
      subject: `Proposed credit for invoice ${record.invoice.number}`, body: explanation,
      citations: [{ line_id: line.id, source: `${record.href}/lines/${encodeURIComponent(line.id)}`, quote: line.description }] }
    const plan = await planInvoiceCredit(env, await requireBusiness(env), payload)
    answer.proposalDraft = { kind: 'amendment', title: `Requested credit for invoice ${record.invoice.number}`, payload: plan.normalized }
    answer.details.push('A credit draft is available for separate preparation and human approval. Reading this answer creates no proposal, credit, adjustment or message.')
  }
  return answer
}
