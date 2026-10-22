import type { Bindings } from '../auth.server'
import { requireOwner, type Actor } from './actor'
import type { Input } from './input'
import { runPrepaidTopup } from './prepaid-topup-jobs'

export async function runPrepaidTopupFromDoor(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor)
  return runPrepaidTopup(env,actor,input.text('authorization',{max:100}))
}
