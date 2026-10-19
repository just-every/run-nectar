import type { Bindings } from '../auth.server'
import { requireOwner, type Actor } from './actor'
import { one } from './core'
import type { Input } from './input'
import { preparePolicyChange } from './policy-changes'

export async function lifecyclePolicy(env: Bindings) {
  const saved = await one(env, 'SELECT * FROM nc_lifecycle_policy WHERE singleton=1')
  return { creditUnused: saved ? !!saved.credit_unused : true,
    reactivationDays: saved?.reactivation_days ?? 30, revision: saved?.revision ?? 0 }
}

export async function configureLifecyclePolicy(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor)
  const reactivationDays = input.integer('reactivation_days', { min: 0, max: 3650 })!
  return await preparePolicyChange(env, actor, 'lifecycle', {creditUnused: input.flag('credit_unused'), reactivationDays})
}
