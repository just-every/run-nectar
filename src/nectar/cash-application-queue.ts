// A shared read model preserves each source's existing confirmation authority.
import type { Bindings } from '../auth.server'
import { requireRead, type Actor } from './actor'
import { all } from './core'
import { clockInstant } from './clock'
import { unmatchedProcessorCash } from './processor-cash-queue'
import { readRemittances } from './remittances'

export interface CashQueueItem {
  id: string; source: 'remittance' | 'processor_cash' | 'plaid_sandbox'; sourceReference: string; status: string
  customer: string | null; customerName: string; currency: string
  receivedOn: string; amountCents: number; unallocatedCents: number; reason: string
  ageDays: number; returnDeadline: string | null; daysLeft: number | null; href: string
}
const day = 86_400_000

export function processorCashDeadline(receivedAt: number, at: number) {
  return { ageDays: Math.max(0, Math.floor((at - receivedAt) / day)),
    returnDeadline: new Date(receivedAt + 75 * day).toISOString(),
    daysLeft: Math.max(0, Math.ceil((receivedAt + 75 * day - at) / day)) }
}

export async function cashApplicationQueue(env: Bindings, actor: Actor): Promise<CashQueueItem[]> {
  for (const family of ['customers','invoices','payments'] as const) requireRead(actor, family)
  const [receipts, transfers, customers] = await Promise.all([
    readRemittances(env, actor), unmatchedProcessorCash(env, actor), all(env, 'SELECT id,name FROM nc_customers WHERE erased_at IS NULL'),
  ])
  const names = new Map(customers.map(row => [row.id, row.name])), at = clockInstant(env)
  const items: CashQueueItem[] = receipts.filter(row => row.status === 'staged' || row.available_cents > 0 || row.short.length).map(row => ({
    id: row.id, source: row.bank_transaction_ref ? 'plaid_sandbox' : 'remittance', sourceReference: row.bank_transaction_ref ?? row.source.receiptId, status: row.status,
    customer: row.customer_id, customerName: row.customer_name ?? 'Unidentified', currency: row.currency,
    receivedOn: row.received_on, amountCents: row.amount_cents,
    unallocatedCents: row.status === 'staged' ? row.amount_cents : row.available_cents,
    reason: row.status === 'staged' ? row.preview?.reason || row.reason || 'awaiting_confirmation' : row.reason,
    ageDays: Math.max(0, Math.floor((at - Date.parse(`${row.received_on}T00:00:00Z`)) / day)),
    returnDeadline: null, daysLeft: null, href: `/app/receivables?remittance=${row.id}#remittance-review`,
  }))
  for (const row of transfers) items.push({
    id: row.id, source: 'processor_cash', sourceReference: row.reference || row.transfer_ref, status: 'observed',
    customer: row.customer_id, customerName: names.get(row.customer_id) ?? 'Customer', currency: row.currency.toUpperCase(),
    receivedOn: new Date(row.occurred_at).toISOString().slice(0,10), amountCents: row.amount_cents, unallocatedCents: row.amount_cents, reason: row.reason,
    ...processorCashDeadline(row.occurred_at, at),
    href: `/app/processor-events?customer=${row.customer_id}#${row.id}`,
  })
  return items.sort((a,b) => a.receivedOn.localeCompare(b.receivedOn) || a.source.localeCompare(b.source) || a.id.localeCompare(b.id))
}
