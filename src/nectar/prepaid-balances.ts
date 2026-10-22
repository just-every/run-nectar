import { prepaidRefundHolds } from './prepaid-refund-records'
// Subscription-readable financial summary. No grant, expiry, funding intent or
// ledger entry is written while viewing an upcoming calculation.
import type { Bindings } from '../auth.server'
import { requireRead, type Actor } from './actor'
import { insist } from './core'
import { requireDate } from './dates'
import { lotStates } from './prepaid-math'
import { prepaidSnapshot } from './prepaid-records'
import { requireSubscription } from './subscriptions'

export interface PrepaidBalance {
  kind: 'money' | 'units'; meterId: string | null
  remainingN: number; availableN: number; liabilityCents: number
  purchasedRemainingN: number; promotionalRemainingN: number
  purchasedAvailableN: number; promotionalAvailableN: number
}
export interface PrepaidBalanceSummary { subscription: string; asOf: string; revision: number; balances: PrepaidBalance[] }

export async function prepaidBalances(env: Bindings, actor: Actor, subscription: string, date: string): Promise<PrepaidBalanceSummary> {
  requireRead(actor, 'subscriptions')
  const sub = await requireSubscription(env, subscription)
  insist(!sub.erased_at, 'customer_erased', 410)
  const asOf = requireDate(date, 'date'), recorded = await prepaidSnapshot(env, subscription)
  if (!recorded) return { subscription, asOf, revision: 0, balances: [] }
  const basis = { ...recorded, grants: recorded.grants.filter(grant => grant.effectiveDate <= asOf),
    entries: recorded.entries.filter(entry => entry.serviceDate <= asOf) }
  const held=new Set((await prepaidRefundHolds(env,subscription)).map(hold=>hold.grantId))
  const groups = new Map<string, PrepaidBalance>()
  for (const lot of lotStates(basis)) {
    const { grant } = lot, key = `${grant.kind}:${grant.meterId ?? ''}`
    const row = groups.get(key) ?? { kind: grant.kind, meterId: grant.meterId, remainingN: 0, availableN: 0, liabilityCents: 0,
      purchasedRemainingN: 0, promotionalRemainingN: 0, purchasedAvailableN: 0, promotionalAvailableN: 0 }
    // An expired, unsettled lot remains a recorded liability/quantity. It is
    // unavailable now; reading must not post its eventual expiry recognition.
    const available = held.has(grant.id) ? 0 : grant.expiresDate && grant.expiresDate <= asOf ? 0 : lot.remainingN
    row.remainingN += lot.remainingN; row.availableN += available; row.liabilityCents += lot.liabilityCents
    if (grant.source === 'purchase') { row.purchasedRemainingN += lot.remainingN; row.purchasedAvailableN += available }
    else { row.promotionalRemainingN += lot.remainingN; row.promotionalAvailableN += available }
    insist([row.remainingN, row.availableN, row.liabilityCents, row.purchasedRemainingN, row.promotionalRemainingN,
      row.purchasedAvailableN, row.promotionalAvailableN].every(Number.isSafeInteger), 'prepaid_balance_out_of_range', 409)
    groups.set(key, row)
  }
  return { subscription, asOf, revision: recorded.revision, balances: [...groups.values()].sort((a, b) => a.kind.localeCompare(b.kind) || (a.meterId ?? '').localeCompare(b.meterId ?? '')) }
}
