import type { Bindings } from '../auth.server'
import { basisKey, reminderBasis, reminderDraft } from '../nectar/collections'
import { requireBusiness } from '../nectar/business'
import { addDays, addMonths } from '../nectar/dates'
import { ratingInputs } from '../nectar/inputs'
import { rate, type AmendmentIn } from '../nectar/rating'
import { insert } from './records'

export async function seedWork(env: Bindings, actor: string, month: string, at: number) {
  const basis = await reminderBasis(env, 'demo-harbor')
  const draft = reminderDraft(basis)
  await env.DB.batch([
    insert(env, 'nc_notices', { id: 'demo-reminder-harbor', customer_id: 'demo-harbor', invoice_ids: JSON.stringify(basis.overdue.map(i => i.id)), balance_cents: basis.balanceCents, recipient: basis.customer.billing_email, subject: draft.subject, body: draft.body, basis: basisKey(basis), status: 'draft', created_by: actor, created_at: at }),
    insert(env, 'nc_tasks', { id: 'demo-task-cedar', customer_id: 'demo-cedar', invoice_id: 'demo-invoice--2-cedar', title: 'Confirm the remittance date with Sofia', due_date: addDays(new Date(at).toISOString().slice(0, 10), 2), status: 'open', created_by: actor, created_at: at }),
  ])
  const b = await requireBusiness(env), from = addMonths(month, 1)
  const amendment: AmendmentIn = { id: 'proposed', kind: 'discount_percent', value: '5', priceId: null, from, to: null, note: 'Annual renewal agreement' }
  const impact = []
  for (const start of [from, addMonths(from, 1)]) {
    const inputs = await ratingInputs(env, b, 'demo-sub-cedar', { start, end: addMonths(start, 1) })
    const total = (input: typeof inputs) => { const r = rate(input); return { subtotalCents: r.subtotalCents, totalCents: r.totalCents, lines: r.lines.map(l => ({ description: l.description, amountCents: l.amountCents })) } }
    impact.push({ period: inputs.period, before: total(inputs), after: total({ ...inputs, amendments: [...inputs.amendments, amendment] }) })
  }
  await env.DB.batch([
    insert(env, 'nc_proposals', { id: 'demo-proposal-renewal', kind: 'amendment', title: 'Cedar annual renewal: 5% discount', payload_json: JSON.stringify({ subscription: 'demo-sub-cedar', kind: amendment.kind, value: amendment.value, price: null, effective_from: from, effective_to: null, note: amendment.note, clause: 'Five percent off platform and seats on annual renewal.' }), evidence_json: JSON.stringify({ note: 'Renewal terms agreed with Sofia; ready for owner review.' }), impact_json: JSON.stringify(impact), basis_json: JSON.stringify({ subscription: ['demo-sub-cedar', 'demo-v1'] }), status: 'pending', created_by: actor, created_by_kind: 'member', created_at: at }),
    ...['business.configure', 'tax.review', 'usage.submit', 'billrun.prepare', 'invoice.finalise', 'payment.record', 'reminder.prepare', 'proposal.prepare'].map((action, i) => insert(env, 'nc_audit', { seq: i + 1, at: at - (8 - i) * 3600000, actor, action, subject: 'Riverbend billing workspace', detail: JSON.stringify({ note: 'Sample billing history' }) })),
  ])
}
