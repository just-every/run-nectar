import { insist } from './core'
import { addMonthsClamped } from './dates'
import { roundHalfAway } from './decimal'
import type { PrepaidBasis, PrepaidEntry, PrepaidGrant } from './prepaid-types'
export interface PrepaidLotState { grant: PrepaidGrant; remainingN: number; liabilityCents: number; lastBoundary: string }
export function lotStates(basis: PrepaidBasis) {
  return basis.grants.map(grant => {
    const entries = basis.entries.filter(entry => entry.grantId === grant.id)
    const remainingN = entries.reduce((sum, entry) => sum + entry.amountN, 0), liabilityCents = entries.reduce((sum, entry) => sum + entry.liabilityCents, 0)
    insist(Number.isSafeInteger(remainingN) && remainingN >= 0 && Number.isSafeInteger(liabilityCents) && liabilityCents >= 0, 'prepaid_ledger_invalid', 409)
    return { grant, remainingN, liabilityCents, lastBoundary: entries.filter(entry => ['expiry','rollover'].includes(entry.kind)).map(entry => entry.serviceDate).sort().at(-1) ?? grant.effectiveDate }
  })
}
export function releaseValue(lot: PrepaidLotState, amount: number) {
  insist(Number.isSafeInteger(amount) && amount >= 0 && amount <= lot.remainingN, 'prepaid_balance_changed', 409)
  const before = BigInt(lot.grant.amountN - lot.remainingN), after = before + BigInt(amount)
  return Number(roundHalfAway(BigInt(lot.grant.valueCents) * after, BigInt(lot.grant.amountN)) - roundHalfAway(BigInt(lot.grant.valueCents) * before, BigInt(lot.grant.amountN)))
}
export function boundaryEntries(lot: PrepaidLotState, until: string): PrepaidEntry[] {
  const grant = lot.grant, entries: PrepaidEntry[] = []
  const boundaries = new Set<string>()
  if (grant.expiresDate && grant.expiresDate <= until && grant.expiresDate > lot.lastBoundary) boundaries.add(grant.expiresDate)
  if (grant.rolloverMonths) for (let index = 1;; index++) {
    const date = addMonthsClamped(grant.effectiveDate, index * grant.rolloverMonths)
    if (date > until || grant.expiresDate && date > grant.expiresDate) break
    if (date > lot.lastBoundary) boundaries.add(date)
  }
  for (const date of [...boundaries].sort()) {
    const expiry = grant.expiresDate === date
    const retained = expiry ? 0 : Math.min(Math.floor(lot.remainingN * grant.rolloverPercent / 100), grant.rolloverCapN ?? lot.remainingN)
    const amount = lot.remainingN - retained, value = releaseValue(lot, amount)
    entries.push({ id: `${grant.id}:${expiry ? 'expiry' : 'rollover'}:${date}`, grantId: grant.id, kind: expiry ? 'expiry' : 'rollover', amountN: -amount, liabilityCents: -value, recognitionCents: value, serviceDate: date, invoiceId: null, lineIndex: null, purchaseInvoice: grant.purchaseInvoice, purchaseLine: grant.purchaseLine })
    lot.remainingN -= amount; lot.liabilityCents -= value; lot.lastBoundary = date
  }
  return entries
}
export const lotPriority = (a: PrepaidLotState, b: PrepaidLotState) => a.grant.priority - b.grant.priority || (a.grant.expiresDate ?? '9999').localeCompare(b.grant.expiresDate ?? '9999') || a.grant.effectiveDate.localeCompare(b.grant.effectiveDate) || a.grant.id.localeCompare(b.grant.id)
