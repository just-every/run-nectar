// What the app frame shows around every page: the business and where it is,
// the proposals waiting for a decision, and when usage last arrived. Loaded
// once per page request and kept beside the request's actor.
import type { Bindings } from '../../auth.server'
import type { Actor } from '../actor'
import { business } from '../business'
import { one } from '../core'

export interface Shell { legalName: string; place: string; timezone: string; pending: number; lastUsage: number | null }

const shells = new WeakMap<Actor, Shell>()
export const shellOf = (actor: Actor | null) => actor ? shells.get(actor) ?? null : null

/** "1600 Wynkoop St, Denver, CO 80202" reads as "Denver, CO". */
export function placeOf(address: string) {
  const parts = address.split(',').map(part => part.trim()).filter(Boolean)
  if (parts.length < 2) return ''
  return `${parts[parts.length - 2]}, ${parts[parts.length - 1].replace(/\s*\d{5}(-\d{4})?$/, '')}`
}

export async function loadShell(env: Bindings, actor: Actor) {
  const b = await business(env)
  if (!b) return
  const pending = await one<{ n: number }>(env, "SELECT COUNT(*) AS n FROM nc_proposals WHERE status = 'pending'")
  const usage = await one<{ at: number | null }>(env, 'SELECT MAX(created_at) AS at FROM nc_usage_batches')
  shells.set(actor, { legalName: b.legal_name, place: placeOf(b.address ?? ''), timezone: b.timezone, pending: pending?.n ?? 0, lastUsage: usage?.at ?? null })
}
