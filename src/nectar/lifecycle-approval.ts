// A cancellation credit uses the same two-person threshold as a credit note.
import type { Bindings } from '../auth.server'
import type { Actor } from './actor'
import { all, insist, parseJson, type Row } from './core'
import { creditPolicy } from './credit-policy'

export async function cancellationApproval(env: Bindings, actor: Actor, invoice: Row) {
  const lines = await all(env,"SELECT amount_cents,evidence_json FROM nc_invoice_lines WHERE invoice_id=? AND kind='cancellation_credit'",invoice.id)
  const amount = -lines.reduce((n,l)=>n+l.amount_cents,0)
  const policy = await creditPolicy(env)
  if (policy.two_person_above_cents === null || amount <= policy.two_person_above_cents) return
  const ids = [...new Set(lines.flatMap(l=>parseJson<Row>(l.evidence_json,{}).transitions ?? []))]
  const authors = await all(env,'SELECT author_id FROM nc_subscription_lifecycle WHERE id IN (SELECT value FROM json_each(?))',JSON.stringify(ids))
  insist(authors.length > 0 && authors.every(a=>a.author_id !== actor.id),'second_approver_required',409)
}
