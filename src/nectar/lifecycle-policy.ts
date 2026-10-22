import type { Bindings } from '../auth.server'
import { requireOwner, type Actor } from './actor'
import { one,insist } from './core'
import type { Input } from './input'
import { preparePolicyChange } from './policy-changes'

export async function lifecyclePolicy(env: Bindings) {
  const saved = await one(env, 'SELECT * FROM nc_lifecycle_policy WHERE singleton=1')
  return { creditUnused: saved ? !!saved.credit_unused : true,
    prorationPolicy:saved?.proration_policy??null,reactivationDays: saved?.reactivation_days ?? 30, revision: saved?.revision ?? 0 }
}

export async function configureLifecyclePolicy(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor)
  const reactivationDays = input.integer('reactivation_days', { min: 0, max: 3650 })!
  const prorationPolicy=input.text('proration_policy',{optional:true})||(await lifecyclePolicy(env)).prorationPolicy
  insist(prorationPolicy===null||['invoice_now','next_invoice','none'].includes(prorationPolicy),'invalid_proration_policy')
  return await preparePolicyChange(env, actor, 'lifecycle', {creditUnused: input.flag('credit_unused'), reactivationDays,prorationPolicy})
}
