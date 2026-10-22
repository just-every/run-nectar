// REV-002: which month each revenue contribution belongs to once months are
// closed. A close freezes the exact contribution keys of its month. A saved
// contribution that was not in its month's close (it arrived afterwards) is
// reported in the earliest open month; frozen contributions never move.
import type { Bindings } from '../auth.server'
import { all, parseJson } from './core'

export interface ClosedPeriods { through: string | null; open: string | null; owner: Map<string, string> }
const monthIndex = (period: string) => { const [year, month] = period.split('-').map(Number); return year * 12 + month - 1 }
const monthAt = (index: number) => `${String(Math.floor(index / 12)).padStart(4, '0')}-${String(index % 12 + 1).padStart(2, '0')}`
export const nextMonth = (period: string) => monthAt(monthIndex(period) + 1)

export interface KeyedContribution { period: string; kind: string; invoiceId: string; lineId: string | null; creditId: string | null; amountCents: number; adjustedFrom?: string }
/** Stable across re-dating: always built from the contribution's own saved period. */
export const contributionKey = (row: KeyedContribution) => `${row.invoiceId}|${row.kind}|${row.lineId ?? row.creditId ?? ''}|${row.adjustedFrom ?? row.period}|${row.amountCents}`

export async function closedPeriods(env: Bindings): Promise<ClosedPeriods> {
  const owner = new Map<string, string>()
  let through: string | null = null
  for (const row of await all(env, 'SELECT period,keys_json FROM nc_period_closes ORDER BY period')) {
    for (const key of parseJson<string[]>(row.keys_json, [])) owner.set(key, row.period)
    through = row.period
  }
  return { through, open: through ? nextMonth(through) : null, owner }
}

/** Re-dates contributions that arrived after their month closed; everything else is untouched. */
export function adjustForClosed<T extends KeyedContribution>(rows: T[], closed: ClosedPeriods): T[] {
  if (!closed.through) return rows
  return rows.map(row => {
    const frozen = closed.owner.get(contributionKey(row))
    if (frozen) return frozen === row.period ? row : { ...row, adjustedFrom: row.period, period: frozen }
    return row.period <= closed.through! ? { ...row, adjustedFrom: row.period, period: closed.open! } : row
  })
}
