import type { Bindings } from '../auth.server'
import { basisKey, reminderBasis, reminderDraft } from '../nectar/collections'
import { requireBusiness } from '../nectar/business'
import { addDays, addMonths } from '../nectar/dates'
import { ratingInputs } from '../nectar/inputs'
import { rate, type AmendmentIn } from '../nectar/rating'
import { one } from '../nectar/core'
import { finance, insert } from './records'

export async function seedWork(env: Bindings, month: string, at: number) {
  const basis = await reminderBasis(env, 'demo-summit')
  const draft = reminderDraft(basis), hour = 3600000
  // Marcus noted the follow-up when he recorded Birchwood's partial check.
  const checkRecorded = (await one<{ at: number }>(env, "SELECT recorded_at AS at FROM nc_payments WHERE id = 'demo-payment-birchwood-2'"))?.at ?? at - hour
  // Summit Outfitters' reminder waits for the owner's decision (none on the one day nothing is past due yet).
  await env.DB.batch([
    ...basis.overdue.length ? [insert(env, 'nc_notices', { id: 'demo-reminder-summit', customer_id: 'demo-summit', invoice_ids: JSON.stringify(basis.overdue.map(i => i.id)), balance_cents: basis.balanceCents, recipient: basis.customer.billing_email, subject: draft.subject, body: draft.body, basis: basisKey(basis), status: 'draft', created_by: finance, created_at: at - 2 * hour })] : [],
    insert(env, 'nc_tasks', { id: 'demo-task-birchwood', customer_id: 'demo-birchwood', invoice_id: 'demo-invoice--2-birchwood', title: 'Confirm when Owen sends the rest of the check', due_date: addDays(new Date(at).toISOString().slice(0, 10), 2), status: 'open', created_by: finance, created_at: Math.min(checkRecorded + 30 * 60000, at - 60000) }),
  ])
  const b = await requireBusiness(env), from = addMonths(month, 1)
  const amendment: AmendmentIn = { id: 'proposed', kind: 'discount_percent', value: '5', priceId: null, from, to: null, note: 'Annual renewal agreement' }
  const impact = []
  for (const start of [from, addMonths(from, 1)]) {
    const inputs = await ratingInputs(env, b, 'demo-sub-lumen', { start, end: addMonths(start, 1) })
    const total = (input: typeof inputs) => { const r = rate(input); return { subtotalCents: r.subtotalCents, totalCents: r.totalCents, lines: r.lines.map(l => ({ description: l.description, amountCents: l.amountCents })) } }
    impact.push({ period: inputs.period, before: total(inputs), after: total({ ...inputs, amendments: [...inputs.amendments, amendment] }) })
  }
  await env.DB.batch([
    insert(env, 'nc_proposals', { id: 'demo-proposal-renewal', kind: 'amendment', title: 'Lumen Health annual renewal: 5% discount', payload_json: JSON.stringify({ subscription: 'demo-sub-lumen', kind: amendment.kind, value: amendment.value, price: null, effective_from: from, effective_to: null, note: amendment.note, clause: 'Five percent off seats on annual renewal.' }), evidence_json: JSON.stringify({ note: 'Renewal terms agreed with Grace Kim; ready for owner review.' }), impact_json: JSON.stringify(impact), basis_json: JSON.stringify({ subscription: ['demo-sub-lumen', 'demo-v1'] }), status: 'pending', created_by: finance, created_by_kind: 'member', created_at: at - 26 * hour }),
  ])
}
