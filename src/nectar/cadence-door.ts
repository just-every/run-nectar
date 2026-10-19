// The form uses decimal dollars; the documented JSON door uses integer cents.
import type { Bindings } from '../auth.server'
import { requireMember, requireOwner, type Actor } from './actor'
import { cents } from './decimal'
import { Input } from './input'
import { recordDispute } from './cadence-actions'
import { prepareCadencePolicy } from './cadence-policy'

export async function prepareCadencePolicyFromDoor(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor)
  if (input.has('rules')) return await prepareCadencePolicy(env, actor, input)
  const segment = input.list('rule_segment', { keepEmpty: true })
  const minimum = input.list('rule_minimum', { keepEmpty: true })
  const subject = input.list('rule_subject', { keepEmpty: true })
  const body = input.list('rule_body', { keepEmpty: true })
  return await prepareCadencePolicy(env, actor, Input.of({ enabled: input.flag('enabled'), require_human: input.flag('require_human'),
    rules: segment.flatMap((value, index) => value ? [{ segment: value, minimum_cents: cents(minimum[index] || '0'), subject: subject[index], body: body[index] }] : []) }))
}

export async function disputeFromDoor(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'receivables')
  return await recordDispute(env, actor, input.has('amount_cents') ? input : Input.of({
    invoice: input.text('invoice'), line: input.text('line'), amount_cents: cents(input.text('amount')), reason: input.text('reason', { max: 1000 }),
  }))
}
