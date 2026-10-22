// INV-006 in RPT-002: the credit-balances report includes each customer's cash
// overpayments (a payment's unallocated amount) and goodwill grants, less their
// applications and returns, with source components that tie to the balance ledger.
import type { Bindings } from '../auth.server'
import { all, type Row } from './core'
import { UNALLOCATED_SQL } from './receivables'
import type { ReportComponent, ReportEntry } from './reports'

type Href = (id: string) => string
const entry = (id: string, number: string, row: Row, amountCents: number, href: Href): ReportEntry => ({ invoiceId: id, number, customerId: row.customer_id, customerName: row.customer_name, amountCents, sourceKind: 'customer_balance', href: href(id) })

export async function balanceFinancialSources(env: Bindings, customer: string | null, href: Href) {
  const scope = customer ? 'AND x.customer_id=?' : '', params = customer ? [customer] : []
  const receipts = (await all(env, `SELECT p.*,c.name AS customer_name,${UNALLOCATED_SQL} AS unallocated FROM nc_payments p JOIN nc_customers c ON c.id=p.customer_id WHERE 1=1 ${scope.replace('x.', 'p.')} ORDER BY p.received_on,p.id`, ...params)).filter(row => row.unallocated > 0)
  const grants = (await all(env, `SELECT x.*,c.name AS customer_name,x.amount_cents-COALESCE((SELECT SUM(a.amount_cents) FROM nc_balance_entries a WHERE a.grant_id=x.id),0) AS remaining FROM nc_balance_entries x JOIN nc_customers c ON c.id=x.customer_id WHERE x.kind='goodwill' ${scope} ORDER BY x.created_at,x.id`, ...params)).filter(row => row.remaining > 0)
  return [...receipts.map(row => entry(`receipt-${row.id}`, row.reference, row, row.unallocated, href)), ...grants.map(row => entry(`goodwill-${row.id}`, 'Goodwill credit', row, row.remaining, href))]
}

/** Source components for one balance entry; they sum to the entry's amount. */
export async function balanceSourceComponents(env: Bindings, sourceId: string): Promise<ReportComponent[]> {
  if (sourceId.startsWith('receipt-')) {
    const id = sourceId.slice('receipt-'.length)
    const payment = (await all(env, 'SELECT * FROM nc_payments WHERE id=?', id))[0]
    const allocations = await all(env, 'SELECT a.amount_cents,i.number,i.id AS invoice_id FROM nc_allocations a JOIN nc_invoices i ON i.id=a.invoice_id WHERE a.payment_id=? ORDER BY a.allocated_at,a.id', id)
    const returns = await all(env, "SELECT amount_cents FROM nc_balance_entries WHERE kind='return' AND payment_id=? ORDER BY created_at,id", id)
    return [{ kind: 'receipt', label: `Receipt ${payment.reference} received ${payment.received_on}`, amountCents: payment.amount_cents },
      ...allocations.map(a => ({ kind: 'allocation', label: `Applied to invoice ${a.number}`, amountCents: -a.amount_cents, href: `/app/invoices/${a.invoice_id}#recv` })),
      ...returns.map(r => ({ kind: 'return', label: 'Returned to the customer', amountCents: -r.amount_cents }))]
  }
  const id = sourceId.slice('goodwill-'.length)
  const grant = (await all(env, "SELECT * FROM nc_balance_entries WHERE id=? AND kind='goodwill'", id))[0]
  const applications = await all(env, "SELECT a.amount_cents,i.number,i.id AS invoice_id FROM nc_balance_entries a JOIN nc_invoices i ON i.id=a.invoice_id WHERE a.grant_id=? ORDER BY a.created_at,a.id", id)
  return [{ kind: 'goodwill', label: 'Goodwill credit granted', amountCents: grant.amount_cents },
    ...applications.map(a => ({ kind: 'application', label: `Applied to invoice ${a.number}`, amountCents: -a.amount_cents, href: `/app/invoices/${a.invoice_id}#recv` }))]
}
