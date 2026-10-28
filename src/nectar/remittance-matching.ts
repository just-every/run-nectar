// Uploaded source facts are immutable; a match is a review proposal, never debit authority.
import type { Bindings } from '../auth.server'
import { all, fingerprint, insist, one, parseJson, type Row } from './core'
import { BALANCE_SQL, UNALLOCATED_SQL } from './receivables'
import { cents } from './decimal'
import { requireDate } from './dates'
import { parseCsv } from './usage'

export interface RemittanceSource {
  receiptId: string; amountCents: number; receivedOn: string; currency: string; customerReference: string
  lines: { invoiceReference: string; amountCents: number }[]
  reviewRequired?: boolean
  bank?: { accountHash: string; transactionHash: string; reference: string }
}
export function remittanceSources(bytes: Uint8Array): RemittanceSource[] {
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '') }
  catch { insist(false, 'remittance_invalid_encoding') }
  // parseCsv handles escaped commas and newlines. Reject an unfinished quote.
  insist((text.match(/"/g)?.length ?? 0) % 2 === 0, 'remittance_invalid_csv')
  const [header, ...rows] = parseCsv(text)
  const columns = ['receipt_id','received_on','currency','amount','customer','invoice_reference','allocation_amount']
  insist(header?.length === columns.length && header.every((cell, i) => cell.trim() === columns[i]), 'remittance_csv_columns')
  insist(rows.length > 0 && rows.length <= 200, 'remittance_csv_rows')
  const sources = new Map<string, RemittanceSource>()
  for (const cells of rows) {
    insist(cells.length === columns.length, 'remittance_csv_columns')
    const [receiptId, date, currency, amount, customerReference, invoiceReference, allocated] = cells.map(cell => cell.trim())
    insist(!/^plaid:/i.test(receiptId), 'remittance_reserved_receipt_id')
    insist(receiptId.length > 0 && receiptId.length <= 120 && customerReference.length <= 120 && invoiceReference.length <= 120, 'remittance_invalid_reference')
    insist(currency === 'USD', 'remittance_usd_required')
    const amountCents = cents(amount), receivedOn = requireDate(date, 'received_on')
    insist(amountCents > 0, 'invalid_amount')
    const source = sources.get(receiptId) ?? { receiptId, receivedOn, amountCents, currency, customerReference, lines: [] }
    insist(source.receivedOn === receivedOn && source.amountCents === amountCents && source.currency === currency && source.customerReference === customerReference, 'remittance_source_changed', 409)
    insist(!!invoiceReference === !!allocated, 'remittance_allocation_required')
    if (invoiceReference) {
      const amountCents = cents(allocated)
      insist(amountCents > 0 && !source.lines.some(line => line.invoiceReference === invoiceReference), 'remittance_invalid_allocation')
      source.lines.push({ invoiceReference, amountCents })
    } else insist(!sources.has(receiptId), 'remittance_duplicate_row')
    sources.set(receiptId, source)
  }
  for (const source of sources.values()) {
    source.lines.sort((a,b) => a.invoiceReference.localeCompare(b.invoiceReference))
    insist(source.lines.reduce((sum, line) => sum + line.amountCents, 0) <= source.amountCents, 'exceeds_payment')
  }
  return [...sources.values()]
}

export async function remittanceMatch(env: Bindings, row: Row, customerId = '') {
  insist(row.status !== 'erased', 'remittance_erased', 409)
  const source = parseJson<RemittanceSource>(row.source_json, null!)
  insist(source?.receiptId, 'remittance_erased', 409)
  let customer: Row | null = null
  if (source.customerReference) {
    customer = await one(env, 'SELECT * FROM nc_customers WHERE external_id=? OR id=?', source.customerReference, source.customerReference)
    insist(!customer?.erased_at, 'customer_not_found', 404)
    insist(!customerId || !customer || customer.id === customerId, 'different_customer', 409)
  }
  const referenced: Row[] = []
  let unresolved = source.reviewRequired === true
  for (const line of source.lines) {
    const invoices = await all(env, `SELECT i.*, ${BALANCE_SQL} AS balance_cents FROM nc_invoices i WHERE i.number=? AND i.status='issued'`, line.invoiceReference)
    if (invoices.length !== 1) { unresolved = true; continue }
    referenced.push({ ...invoices[0], amountCents: line.amountCents })
  }
  if (customerId) customer = await one(env, 'SELECT * FROM nc_customers WHERE id=?', customerId)
  else if (!customer && !source.customerReference && !unresolved && referenced.length && referenced.every(i => i.customer_id === referenced[0].customer_id))
    customer = await one(env, 'SELECT * FROM nc_customers WHERE id=?', referenced[0].customer_id)
  if (customer) {
    insist(!customer.erased_at && customer.status === 'active', 'customer_not_found', 404)
    insist(customer.currency === 'USD', 'currency_mismatch', 409)
    insist(referenced.every(i => i.customer_id === customer!.id), 'different_customer', 409)
    insist(referenced.every(i => i.currency === 'USD'), 'currency_mismatch', 409)
  }
  let matches: Row[] = [], reason = !customer ? 'unidentified_customer' : unresolved ? 'unmatched_reference' : ''
  if (customer && !unresolved) {
    if (source.lines.length) {
      // Never silently shorten advice or apply only its convenient subset.
      if (referenced.some(i => i.amountCents > i.balance_cents)) reason = 'balance_requires_review'
      else matches = referenced
    } else {
      const exact = await all(env, `SELECT i.*, ${BALANCE_SQL} AS balance_cents FROM nc_invoices i WHERE i.customer_id=? AND i.status='issued' AND i.currency='USD' AND ${BALANCE_SQL}=?`, customer.id, source.amountCents)
      if (exact.length === 1) matches = [{ ...exact[0], amountCents: source.amountCents }]
      else reason = exact.length > 1 ? 'ambiguous_amount' : 'unmatched_amount'
    }
  }
  const allocations = matches.map(i => ({ invoice: i.id, number: i.number, amountCents: i.amountCents, balanceCents: i.balance_cents }))
  const allocatedCents = allocations.reduce((sum, a) => sum + a.amountCents, 0)
  if (!reason && matches.some(i => i.amountCents < i.balance_cents)) reason = 'short_payment'
  if (!reason && allocatedCents < source.amountCents) reason = 'unallocated_funds'
  const basis = { receipt: row.id, sourceHash: row.payload_hash, customer: customer?.id ?? null, customerRevision: customer?.revision ?? null, allocations, reason, amountCents: source.amountCents }
  return { ...basis, source, fingerprint: await fingerprint(basis), allocatedCents, unallocatedCents: source.amountCents - allocatedCents }
}

export async function remittanceAllocation(env: Bindings, row: Row, invoiceId: string, amountCents: number) {
  insist(row.status === 'confirmed' && row.payment_id, 'remittance_not_confirmed', 409)
  const customer = await one(env, 'SELECT * FROM nc_customers WHERE id=? AND erased_at IS NULL AND status=\'active\'', row.customer_id)
  insist(customer, 'customer_not_found', 404)
  const invoice = await one(env, `SELECT i.*, ${BALANCE_SQL} AS balance_cents FROM nc_invoices i WHERE i.id=? AND i.status='issued'`, invoiceId)
  insist(invoice, 'invoice_not_found', 404)
  insist(invoice.customer_id === customer.id, 'different_customer', 409)
  insist(customer.currency === 'USD' && invoice.currency === 'USD', 'currency_mismatch', 409)
  const payment = await one(env, `SELECT p.*, ${UNALLOCATED_SQL} AS unallocated FROM nc_payments p WHERE p.id=?`, row.payment_id)
  insist(payment && payment.customer_id === customer.id && payment.currency === 'USD', 'payment_not_found', 404)
  insist(amountCents > 0 && amountCents <= payment.unallocated && amountCents <= invoice.balance_cents, 'remittance_allocation_exceeds_balance', 409)
  const basis = { receipt: row.id, payment: payment.id, customer: customer.id, customerRevision: customer.revision,
    invoice: invoice.id, number: invoice.number, balanceCents: invoice.balance_cents, availableCents: payment.unallocated, amountCents }
  return { ...basis, fingerprint: await fingerprint(basis) }
}
