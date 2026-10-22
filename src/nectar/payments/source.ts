import type { Bindings } from '../../auth.server'
import { fingerprint, guard, insist, one, parseJson, type Row } from '../core'
import { BALANCE_SQL } from '../receivables'

export async function nativeCollectionSource(env: Bindings, invoiceId: string) {
  const row = await one(env, `SELECT i.*,${BALANCE_SQL} AS balance_cents,c.revision AS customer_revision,c.erased_at,c.status AS customer_status,
    c.billing_entity_id AS customer_entity_id FROM nc_invoices i JOIN nc_customers c ON c.id=i.customer_id WHERE i.id=?`, invoiceId)
  insist(row && row.status === 'issued' && row.customer_status === 'active' && !row.erased_at
    && !await one(env, 'SELECT 1 FROM nc_erased_records WHERE record_id IN (?,?)', invoiceId, row.customer_id), 'native_issued_invoice_required', 409)
  insist(Number.isSafeInteger(row.balance_cents) && row.balance_cents >= 50 && row.balance_cents <= 99999999, 'native_collectible_balance_required', 409)
  const route = parseJson<Row>(row.billing_route_json, {}), calculation = parseJson<Row>(row.calculation_json, {})
  insist(calculation.inputs && row.source_fingerprint && route.entityId === row.billing_entity_id
    && (row.customer_entity_id ?? null) === (row.billing_entity_id ?? null), 'native_invoice_route_invalid', 409)
  const accountRef = row.billing_entity_id ? route.processorAccountRef : null
  insist(row.billing_entity_id ? route.processor === 'stripe' && typeof accountRef === 'string' && /^[A-Za-z0-9_-]{1,255}$/.test(accountRef)
    : route.routingCustody === 'installation-business', 'native_invoice_route_invalid', 409)
  const payer=await one(env,'SELECT p.payer_id,c.revision,c.billing_entity_id,c.erased_at,c.status FROM nc_invoice_payers p JOIN nc_customers c ON c.id=p.payer_id WHERE p.invoice_id=?',row.id)
  insist(!payer||payer.erased_at===null&&payer.status==='active'&&payer.billing_entity_id===row.billing_entity_id,'native_payer_changed',409)
  const payerId=payer?.payer_id??row.customer_id,payerRevision=payer?.revision??row.customer_revision
  const sourceHash = await fingerprint({...(payer?{payerId,payerRevision}:{}), invoice: row.id, number: row.number, customer: row.customer_id, status: row.status, total: row.total_cents,
    balance: row.balance_cents, issuedAt: row.issued_at, sourceFingerprint: row.source_fingerprint, calculation: row.calculation_json,
    route: row.billing_route_json, entity: row.billing_entity_id, currency: 'usd', customerRevision: row.customer_revision })
  return { row, route, payerId,payerRevision,accountRef: accountRef as string | null, sourceHash }
}
export function nativeSourceGuard(env: Bindings, source: Awaited<ReturnType<typeof nativeCollectionSource>>) {
  const { row,payerId,payerRevision } = source
  return guard(env, 'native_collection_source_changed', `EXISTS(SELECT 1 FROM nc_invoices i JOIN nc_customers c ON c.id=i.customer_id
    WHERE i.id=? AND i.customer_id=? AND i.status='issued' AND i.total_cents=? AND i.source_fingerprint=? AND i.calculation_json=?
      AND i.billing_route_json=? AND i.billing_entity_id IS ? AND ${BALANCE_SQL}=?
      AND c.revision=? AND c.status='active' AND c.erased_at IS NULL AND c.billing_entity_id IS ?)
    AND EXISTS(SELECT 1 FROM nc_customers payer WHERE payer.id=? AND payer.revision=? AND payer.status='active' AND payer.erased_at IS NULL AND payer.billing_entity_id IS ?)
    AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN (?,?))`, row.id, row.customer_id, row.total_cents,
    row.source_fingerprint, row.calculation_json, row.billing_route_json, row.billing_entity_id, row.balance_cents,
    row.customer_revision, row.billing_entity_id,payerId,payerRevision,row.billing_entity_id,row.id,row.customer_id)
}
