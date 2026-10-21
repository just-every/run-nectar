// MOVE-011: choose numbers from immutable imported history, never by guessing
// which processor settings were in force. Live provider configuration is separate.
import type { Bindings } from '../auth.server'
import { actorLabel, requireOwner, type Actor } from './actor'
import { requireBusiness, type Business } from './business'
import { all, commit, guard, insist, newId, now, one, stmt, type Row } from './core'
import type { Input } from './input'
import { requireFreshFactor } from './mfa'

const suffix = (number: string) => number.match(/^(.*?)(\d+)$/)
export const formattedInvoiceNumber = (prefix: string, width: number, sequence: number) => `${prefix}${String(sequence).padStart(width, '0')}`

/** The normal issue transaction consumes this exact sequence, including its CAS. */
export function invoiceNumberAllocation(env: Bindings, business: Business, customer: Row) {
  return documentNumberAllocation(env, business, customer, 'invoice')
}

/** Shared by normal issue and every governed credit path; one atomic CAS. */
export function documentNumberAllocation(env: Bindings, business: Business, customer: Row, kind: 'invoice' | 'credit-note') {
  const credit = kind === 'credit-note'
  const prefixField = credit ? 'credit_prefix' : 'invoice_prefix'
  const widthField = credit ? 'credit_number_width' : 'invoice_number_width'
  const sequenceField = credit ? 'next_credit_number' : 'next_invoice_number'
  const own = customer[prefixField] !== null && customer[prefixField] !== undefined
  const sequence = own ? customer[sequenceField] : business[sequenceField]
  const prefix = own ? customer[prefixField] : credit ? business.credit_prefix ?? `${business.invoice_prefix}-CN-` : `${business.invoice_prefix}-`
  const width = own ? customer[widthField] : business[widthField]
  insist(Number.isSafeInteger(sequence) && sequence > 0 && sequence < Number.MAX_SAFE_INTEGER, 'invoice_sequence_exhausted', 409)
  const number = formattedInvoiceNumber(prefix, width, sequence)
  return { number, statements: [
    guard(env, 'stale', own ? `EXISTS(SELECT 1 FROM nc_customers WHERE id=? AND ${sequenceField}=? AND ${prefixField}=? AND ${widthField}=?)` : `EXISTS(SELECT 1 FROM nc_business WHERE singleton=1 AND ${sequenceField}=? AND revision=?)`, ...(own ? [customer.id, sequence, prefix, width] : [sequence, business.revision])),
    guard(env, 'number_already_used', 'NOT EXISTS(SELECT 1 FROM nc_incumbent_invoices WHERE number=?) AND NOT EXISTS(SELECT 1 FROM nc_invoices WHERE number=?) AND NOT EXISTS(SELECT 1 FROM nc_credit_notes WHERE number=?)', number, number, number),
    own ? stmt(env, `UPDATE nc_customers SET ${sequenceField}=${sequenceField}+1 WHERE id=?`, customer.id) : stmt(env, `UPDATE nc_business SET ${sequenceField}=${sequenceField}+1 WHERE singleton=1`),
  ] }
}

/** Owner chooses continuation from a captured invoice, or an unused new series. */
export async function configureInvoiceSeries(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor)
  await requireFreshFactor(env, actor)
  const business = await requireBusiness(env)
  const revision = input.integer('revision', { min: 1, max: 1_000_000 })
  insist(revision === business.revision, 'stale', 409)
  const customerId = input.text('customer', { max: 100, optional: true })
  const customer = customerId ? await one(env, 'SELECT * FROM nc_customers WHERE id=? AND erased_at IS NULL', customerId) : null
  insist(!customerId || customer, 'customer_not_found', 404)
  const mode = input.text('mode', { max: 20 })
  insist(mode === 'continue' || mode === 'new', 'invalid_numbering_mode')
  const kind = input.text('kind', { max: 20, optional: true }) || 'invoice'
  insist(kind === 'invoice' || kind === 'credit-note', 'invalid_document_kind')
  const prefixField = kind === 'invoice' ? 'invoice_prefix' : 'credit_prefix'
  const widthField = kind === 'invoice' ? 'invoice_number_width' : 'credit_number_width'
  const sequenceField = kind === 'invoice' ? 'next_invoice_number' : 'next_credit_number'
  let prefix: string, width: number, next: number, source: Row | null = null
  if (mode === 'continue') {
    source = await one(env, 'SELECT * FROM nc_incumbent_invoices WHERE id=? AND document_kind=?', input.text('source_invoice', { max: 100 }), kind)
    insist(source && (!customer || source.customer_id === customer.id), 'source_invoice_not_found', 404)
    const parsed = suffix(source.number)
    insist(parsed && parsed[1].endsWith('-') && /^[A-Z0-9-]{1,40}$/.test(parsed[1]), 'unsupported_invoice_number_format')
    prefix = parsed[1]; width = parsed[2].length; next = Number(parsed[2]) + 1
    const previous = await all(env, `SELECT number FROM nc_incumbent_invoices WHERE id<>? UNION ALL SELECT number FROM nc_invoices WHERE status='issued' UNION ALL SELECT number FROM nc_credit_notes`, source.id)
    insist(!previous.some(row => { const p = suffix(row.number); return p && p[1] === prefix && Number(p[2]) >= next }), 'source_is_not_last_number', 409)
  } else {
    prefix = input.text('prefix', { max: 39 }).toUpperCase().replace(/-$/, '') + '-'
    insist(/^[A-Z0-9-]{1,40}$/.test(prefix), 'invalid_invoice_prefix')
    width = input.integer('width', { min: 1, max: 12 })!; next = 1
    const previous = await all(env, "SELECT number FROM nc_incumbent_invoices UNION ALL SELECT number FROM nc_invoices WHERE status='issued' UNION ALL SELECT number FROM nc_credit_notes")
    insist(!previous.some(row => suffix(row.number)?.[1] === prefix), 'series_already_used', 409)
  }
  insist(width <= 12 && Number.isSafeInteger(next) && next > 0 && next < Number.MAX_SAFE_INTEGER, 'unsupported_invoice_number_format')
  const number = formattedInvoiceNumber(prefix, width, next)
  const scope = customer ? customer.id : 'business'
  await commit(env, [
    guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_business WHERE singleton=1 AND revision=?)', business.revision),
    ...(source ? [guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_incumbent_invoices WHERE id=? AND number=?)', source.id, source.number)] : []),
    ...(customer ? [guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_customers WHERE id=? AND revision=? AND erased_at IS NULL)', customer.id, customer.revision), stmt(env, `UPDATE nc_customers SET ${prefixField}=?,${widthField}=?,${sequenceField}=?,revision=?,updated_at=? WHERE id=?`, prefix, width, next, newId(), now(), customer.id)] : [stmt(env, `UPDATE nc_business SET ${prefixField}=?,${widthField}=?,${sequenceField}=? WHERE singleton=1`, kind === 'invoice' ? prefix.slice(0,-1) : prefix, width, next)]),
    stmt(env, 'UPDATE nc_business SET revision=revision+1,updated_at=? WHERE singleton=1', now()),
  ], { actor: actorLabel(actor), action: 'invoice.series', subject: scope, detail: { kind, mode, prefix, width, next, sourceInvoice: source?.id ?? null, sourceNumber: source?.number ?? null, sourceProvider: source?.provider ?? null } })
  return { scope, kind, mode, nextNumber: number }
}
