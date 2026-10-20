// Asking is read-only. Only this explicit prepare door can save a proposal;
// its ordinary AGENT-002 approval and source checks remain the decision door.
import type { Bindings } from '../auth.server'
import { requireCapability, type Actor } from './actor'
import { billingAnswer } from './billing-answers'
import { insist } from './core'
import { Input } from './input'
import { proposeDraft } from './proposals'

export async function proposeAnswerCredit(env: Bindings, actor: Actor, input: Input) {
  requireCapability(actor, 'propose')
  const answer = await billingAnswer(env, actor, input)
  insist(answer.proposalDraft, 'credit_request_required')
  return await proposeDraft(env, actor, Input.of(answer.proposalDraft))
}
