// MOVE-011: choose numbers from immutable imported history, never by guessing
// which processor settings were in force. Live provider configuration is separate.
import type { Bindings } from '../auth.server'
import { actorLabel, requireOwner, type Actor } from './actor'
import { requireBusiness, type Business } from './business'
import { all, commit, guard, insist, newId, now, one, stmt, type Row } from './core'
import type { Input } from './input'
import { requireFreshFactor } from './mfa'
import { billingRoute, bumpBusinessRevision, businessRevisionGuard, normalizeNumberPrefix, requireBillingEntity } from './billing-entities'
import { assertLiveNumberingSourceCurrent } from './numbering-source'

const suffix = (number: string) => number.match(/^(.*?)(\d+)$/)
export const formattedInvoiceNumber = (prefix: string, width: number, sequence: number) => `${prefix}${String(sequence).padStart(width, '0')}`

/** The normal issue transaction consumes this exact sequence, including its CAS. */
export function invoiceNumberAllocation(env: Bindings, business: Business, customer: Row) {
  return documentNumberAllocation(env, business, customer, 'invoice')
}

/** Shared by normal issue and every governed credit path; one atomic CAS. */
export async function documentNumberAllocation(env: Bindings, business: Business, customer: Row, kind: 'invoice' | 'credit-note', entitySequenceOffset = 0) {
  insist(Number.isSafeInteger(entitySequenceOffset) && entitySequenceOffset >= 0, 'invalid_number_reservation')
  const credit = kind === 'credit-note'
  const prefixField = credit ? 'credit_prefix' : 'invoice_prefix'
  const widthField = credit ? 'credit_number_width' : 'invoice_number_width'
  const sequenceField = credit ? 'next_credit_number' : 'next_invoice_number'
  const entity = customer.billing_entity_id ? await requireBillingEntity(env, customer.billing_entity_id) : null
  const entityCustomer = entity ? await one(env, 'SELECT * FROM nc_entity_customer_numbers WHERE customer_id=? AND entity_id=? AND kind=?', customer.id, entity.id, kind) : null
  const own = !entity && customer[prefixField] !== null && customer[prefixField] !== undefined
  const sequence = entityCustomer ? entityCustomer.next_number + entitySequenceOffset : entity ? entity[sequenceField] + entitySequenceOffset : own ? customer[sequenceField] : business[sequenceField]
  const prefix = entityCustomer ? entityCustomer.prefix : entity ? entity[prefixField] : own ? customer[prefixField] : credit ? business.credit_prefix ?? `${business.invoice_prefix}-CN-` : `${business.invoice_prefix}-`
  const width = entityCustomer ? entityCustomer.width : entity ? entity[widthField] : own ? customer[widthField] : business[widthField]
  insist(Number.isSafeInteger(sequence) && sequence > 0 && sequence < Number.MAX_SAFE_INTEGER, 'invoice_sequence_exhausted', 409)
  const number = formattedInvoiceNumber(prefix, width, sequence)
  return { number, entityId: entity?.id ?? null, routeJson: JSON.stringify(billingRoute(business, entity)), statements: [
    businessRevisionGuard(env, business),
    guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_customers WHERE id=? AND revision=? AND billing_entity_id IS ? AND erased_at IS NULL)', customer.id, customer.revision, entity?.id ?? null),
    ...(entity ? [guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_billing_entities WHERE id=? AND revision=?)', entity.id, entity.revision)] : []),
    entityCustomer ? guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_entity_customer_numbers WHERE customer_id=? AND entity_id=? AND kind=? AND revision=? AND next_number=? AND prefix=? AND width=?)', customer.id, entity!.id, kind, entityCustomer.revision, sequence, prefix, width)
      : entity ? guard(env, 'stale', `EXISTS(SELECT 1 FROM nc_billing_entities WHERE id=? AND ${sequenceField}=? AND ${prefixField}=? AND ${widthField}=?)`, entity.id, sequence, prefix, width)
      : guard(env, 'stale', own ? `EXISTS(SELECT 1 FROM nc_customers WHERE id=? AND ${sequenceField}=? AND ${prefixField}=? AND ${widthField}=?)` : `EXISTS(SELECT 1 FROM nc_business WHERE singleton=1 AND ${sequenceField}=? AND revision=?)`, ...(own ? [customer.id, sequence, prefix, width] : [sequence, business.revision])),
    guard(env, 'number_already_used', 'NOT EXISTS(SELECT 1 FROM nc_incumbent_invoices WHERE number=?) AND NOT EXISTS(SELECT 1 FROM nc_invoices WHERE number=?) AND NOT EXISTS(SELECT 1 FROM nc_credit_notes WHERE number=?)', number, number, number),
    entityCustomer ? stmt(env, 'UPDATE nc_entity_customer_numbers SET next_number=next_number+1 WHERE customer_id=? AND kind=?', customer.id, kind)
      : entity ? stmt(env, `UPDATE nc_billing_entities SET ${sequenceField}=${sequenceField}+1 WHERE id=?`, entity.id)
      : own ? stmt(env, `UPDATE nc_customers SET ${sequenceField}=${sequenceField}+1 WHERE id=?`, customer.id) : stmt(env, `UPDATE nc_business SET ${sequenceField}=${sequenceField}+1 WHERE singleton=1`),
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
  const entityId = input.text('entity', { max: 100, optional: true }) || customer?.billing_entity_id || null
  const entity = entityId ? await requireBillingEntity(env, entityId) : null
  insist(!customer || (customer.billing_entity_id ?? null) === entityId, 'numbering_entity_customer_mismatch', 409)
  const mode = input.text('mode', { max: 20 })
  insist(mode === 'continue' || mode === 'new', 'invalid_numbering_mode')
  const kind = input.text('kind', { max: 20, optional: true }) || 'invoice'
  insist(kind === 'invoice' || kind === 'credit-note', 'invalid_document_kind')
  const prefixField = kind === 'invoice' ? 'invoice_prefix' : 'credit_prefix'
  const widthField = kind === 'invoice' ? 'invoice_number_width' : 'credit_number_width'
  const sequenceField = kind === 'invoice' ? 'next_invoice_number' : 'next_credit_number'
  let prefix: string, width: number, next: number, source: Row | null = null, capture: Row | null = null
  if (mode === 'continue') {
    const captureId = input.text('source_capture', { max: 100, optional: true })
    if (captureId) {
      capture = await one(env, 'SELECT * FROM nc_numbering_sources WHERE id=? AND kind=? AND entity_id IS ? AND customer_id IS ?', captureId, kind, entity?.id ?? null, customer?.id ?? null)
      insist(capture, 'numbering_source_not_found', 404)
      await assertLiveNumberingSourceCurrent(env, capture)
    }
    source = await one(env, 'SELECT i.*,c.billing_entity_id AS customer_entity FROM nc_incumbent_invoices i JOIN nc_customers c ON c.id=i.customer_id WHERE i.id=? AND i.document_kind=? AND c.erased_at IS NULL', capture?.source_invoice_id ?? input.text('source_invoice', { max: 100 }), kind)
    insist(source && (!customer || source.customer_id === customer.id), 'source_invoice_not_found', 404)
    insist((source.billing_entity_id ?? source.customer_entity ?? null) === (entity?.id ?? null), 'source_invoice_entity_mismatch', 409)
    const parsed = suffix(source.number)
    insist(parsed && parsed[1].endsWith('-') && /^[A-Z0-9-]{1,40}$/.test(parsed[1]), 'unsupported_invoice_number_format')
    prefix = capture?.prefix ?? parsed[1]; width = capture?.width ?? parsed[2].length; next = capture?.next_number ?? Number(parsed[2]) + 1
    insist(!capture || source.number === capture.last_number, 'numbering_source_changed', 409)
    const previous = await all(env, `SELECT number FROM nc_incumbent_invoices WHERE id<>? UNION ALL SELECT number FROM nc_invoices WHERE status='issued' UNION ALL SELECT number FROM nc_credit_notes`, source.id)
    insist(!previous.some(row => { const p = suffix(row.number); return p && p[1] === prefix && Number(p[2]) >= next }), 'source_is_not_last_number', 409)
  } else {
    prefix = normalizeNumberPrefix(input.text('prefix', { max: 39 }))
    width = input.integer('width', { min: 1, max: 12 })!; next = 1
    const previous = await all(env, "SELECT number FROM nc_incumbent_invoices UNION ALL SELECT number FROM nc_invoices WHERE status='issued' UNION ALL SELECT number FROM nc_credit_notes")
    insist(!previous.some(row => suffix(row.number)?.[1] === prefix), 'series_already_used', 409)
  }
  insist(width <= 12 && Number.isSafeInteger(next) && next > 0 && next < Number.MAX_SAFE_INTEGER, 'unsupported_invoice_number_format')
  if (entity) insist(!await one(env, 'SELECT 1 FROM nc_billing_entities WHERE id<>? AND (invoice_prefix=? OR credit_prefix=?)', entity.id, prefix, prefix), 'series_already_configured', 409)
  const number = formattedInvoiceNumber(prefix, width, next)
  const scope = customer ? customer.id : entity?.id ?? 'business'
  await commit(env, [
    businessRevisionGuard(env, business),
    ...(entity ? [guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_billing_entities WHERE id=? AND revision=?)', entity.id, entity.revision)] : []),
    ...(source ? [guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_incumbent_invoices WHERE id=? AND number=?)', source.id, source.number)] : []),
    // Recheck after the asynchronous read/provider boundary: a concurrent issue
    // cannot turn continuation into a rewind, even if its revision is unchanged.
    guard(env, 'stale', `NOT EXISTS(SELECT 1 FROM (SELECT number FROM nc_incumbent_invoices ${source ? 'WHERE id<>?' : ''} UNION ALL SELECT number FROM nc_invoices WHERE status='issued' UNION ALL SELECT number FROM nc_credit_notes)
      WHERE substr(number,1,?)=? AND substr(number,?+1)<>'' AND substr(number,?+1) NOT GLOB '*[^0-9]*' AND CAST(substr(number,?+1) AS INTEGER)>=?)`, ...(source ? [source.id] : []), prefix.length, prefix, prefix.length, prefix.length, prefix.length, next),
    ...(customer ? [guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_customers WHERE id=? AND revision=? AND erased_at IS NULL AND billing_entity_id IS ?)', customer.id, customer.revision, entity?.id ?? null),
      ...(entity ? [stmt(env, `INSERT INTO nc_entity_customer_numbers(customer_id,entity_id,kind,prefix,width,next_number,source_id,revision) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(customer_id,kind) DO UPDATE SET entity_id=excluded.entity_id,prefix=excluded.prefix,width=excluded.width,next_number=excluded.next_number,source_id=excluded.source_id,revision=excluded.revision`, customer.id, entity.id, kind, prefix, width, next, capture?.id ?? null, newId()),
        stmt(env, 'UPDATE nc_customers SET revision=?,updated_at=? WHERE id=?', newId(), now(), customer.id)]
        : [stmt(env, `UPDATE nc_customers SET ${prefixField}=?,${widthField}=?,${sequenceField}=?,revision=?,updated_at=? WHERE id=?`, prefix, width, next, newId(), now(), customer.id)])]
      : entity ? [stmt(env, `UPDATE nc_billing_entities SET ${prefixField}=?,${widthField}=?,${sequenceField}=?,revision=?,updated_at=? WHERE id=?`, prefix, width, next, newId(), now(), entity.id)]
      : [stmt(env, `UPDATE nc_business SET ${prefixField}=?,${widthField}=?,${sequenceField}=? WHERE singleton=1`, kind === 'invoice' ? prefix.slice(0,-1) : prefix, width, next)]),
    bumpBusinessRevision(env),
  ], { actor: actorLabel(actor), action: 'invoice.series', subject: scope, detail: { entity: entity?.id ?? null, kind, mode, prefix, width, next, sourceCapture: capture?.id ?? null, sourceInvoice: source?.id ?? null, sourceNumber: source?.number ?? null, sourceProvider: source?.provider ?? null } })
  return { scope, entity: entity?.id ?? null, kind, mode, nextNumber: number }
}
