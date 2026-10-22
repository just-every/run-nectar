// A pretax monthly journal from the same saved source snapshot as the
// roll-forward. Closing a period (period-close.ts) freezes and posts it.
import type { Bindings } from '../auth.server'
import { requireCapability, type Actor } from './actor'
import { insist } from './core'
import { plainMoney } from './decimal'
import { revenueReport } from './revenue-reports'
import { csvResponse } from './report-csv'

export const JOURNAL_DEFINITION = 'USD pretax monthly journal; closing a period freezes it and posts it to the connected ledger. Debit billings clearing for net pretax billings; debit increases in accrued contract assets; credit increases in deferred revenue liabilities; credit recognized revenue. Negative movements reverse the debit or credit. Asset and liability positions are classified per invoice before aggregation. Tax, cash, collections and processor settlement entries are excluded; billings clearing is not the gross accounts-receivable balance. Map these staging account names to the business ledger before posting. Later records post to the open period and never change a closed one.'

const safe = (value: bigint) => {
  insist(value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER), 'revenue_total_out_of_range', 409)
  return Number(value)
}

export async function revenueJournal(env: Bindings, actor: Actor, url: URL) {
  const report = await revenueReport(env, actor, url)
  const entries: { period: string; account: string; debitCents: number; creditCents: number; sourcePath: string }[] = []
  const periods = report.months.map(month => {
    // Positive signed amounts are debits; BigInt preserves exact intermediate
    // differences and sums even when the offsetting amounts are large.
    const movements: [string, bigint][] = [
      ['pretax-billings-clearing', BigInt(month.netBillingsCents)],
      ['accrued-contract-assets', BigInt(month.accruedContractAssetCents) - BigInt(month.openingAccruedContractAssetCents)],
      ['deferred-revenue', BigInt(month.openingDeferredLiabilityCents) - BigInt(month.deferredLiabilityCents)],
      ['recognized-revenue', -BigInt(month.recognizedCents)],
    ]
    let debit = 0n, credit = 0n
    const query = new URLSearchParams({ period: month.period })
    if (report.customerId) query.set('customer', report.customerId)
    if (report.entityId) query.set('entity', report.entityId)
    for (const [account, amount] of movements) {
      if (!amount) continue
      const debitCents = safe(amount > 0n ? amount : 0n), creditCents = safe(amount < 0n ? -amount : 0n)
      debit += BigInt(debitCents); credit += BigInt(creditCents)
      entries.push({ period: month.period, account, debitCents, creditCents, sourcePath: `/app/revenue?${query}#contributions` })
    }
    insist(debit === credit, 'revenue_journal_unbalanced', 409)
    return { ...month, debitCents: safe(debit), creditCents: safe(credit) }
  })
  return { currency: 'USD', definition: JOURNAL_DEFINITION, policyVersion: report.policyVersion, from: report.from, to: report.to, customerId: report.customerId, entityId: report.entityId, periods, entries, sources: report.contributions }
}

const cell = (value: unknown) => {
  const text = String(value ?? ''), escaped = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return /[",\n\r]/.test(escaped) ? `"${escaped.replaceAll('"', '""')}"` : escaped
}
export async function revenueJournalCsv(env: Bindings, actor: Actor, url: URL) {
  requireCapability(actor, 'export')
  const journal = await revenueJournal(env, actor, url)
  const rows: unknown[][] = [['period', 'account', 'debit', 'credit', 'currency', 'basis', 'source_path']]
  for (const entry of journal.entries) rows.push([entry.period, entry.account, plainMoney(entry.debitCents), plainMoney(entry.creditCents), journal.currency, journal.definition, entry.sourcePath])
  return csvResponse(rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n', 'nectar-revenue-journal')
}
