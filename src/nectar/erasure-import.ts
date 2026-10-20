import type { Bindings } from '../auth.server'
import { retireD1ImportCustody, type D1ImportContext, type D1Sql, type D1TargetAdapter, type Json } from '../modules/import-kit/src/d1/index'
import { requireOwner, type Actor } from './actor'
import { insist, type Row } from './core'
import { nectarTargets } from './movein/target'

/** Exact leaves, including object keys, cover expanded Stripe customer objects
 * and references inside metadata without selecting another customer's ID prefix. */
function holdsIdentity(value: unknown, identities: ReadonlySet<string>): boolean {
  if (typeof value === 'string') return identities.has(value)
  if (Array.isArray(value)) return value.some(item => holdsIdentity(item, identities))
  if (value && typeof value === 'object') return Object.entries(value).some(([key, item]) => identities.has(key) || holdsIdentity(item, identities))
  return false
}

/** The normal move-in adapter deliberately refuses strict undo after billing.
 * Erasure instead fences every customer column and permits the anonymous parent
 * retained for financial foreign keys to count as an absent import target. */
function erasureTargets(customerId: string): D1TargetAdapter {
  return {
    ...nectarTargets,
    async read(db, destination, kind, id) {
      if (kind !== 'customer' || id !== customerId) return nectarTargets.read(db, destination, kind, id)
      const row = await db.prepare('SELECT * FROM nc_customers WHERE id=? AND erased_at IS NULL').bind(id).first<Row>()
      return row ? { destination, targetKind: kind, targetId: id, revision: row.revision, value: row as Json } : undefined
    },
    matches(row, destination, kind, id) {
      if (kind !== 'customer' || id !== customerId) return nectarTargets.matches(row, destination, kind, id)
      if (!row) return { sql: 'NOT EXISTS(SELECT 1 FROM nc_customers WHERE id=? AND erased_at IS NULL)', params: [id] }
      const entries = Object.entries(row.value as Row)
      const columns = entries.map(([column]) => `"${column.replace(/"/g, '""')}" IS ?`).join(' AND ')
      return { sql: `EXISTS(SELECT 1 FROM nc_customers WHERE id=? AND erased_at IS NULL AND ${columns})`, params: [id, ...entries.map(([, value]) => value)] }
    },
  }
}

/** Native erasure, all import originals/before-images and the portability
 * checkpoint commit together; no erased customer value enters the kit receipt. */
export async function eraseImportCopies(env: Bindings, actor: Actor, customer: Row, nativeStatements: D1Sql[], checkpoint: D1Sql[]) {
  requireOwner(actor)
  insist(actor.sessionId && customer.id && checkpoint.length > 0, 'erasure_context_required', 409)
  const identities = new Set<string>([customer.id, customer.provider_ref, customer.external_id].filter((value): value is string => typeof value === 'string' && value.length > 0))
  const values = [...new Set([...identities, customer.name, customer.billing_email, customer.address, customer.tax_exempt_ref]
    .filter((value): value is string => typeof value === 'string' && value.length > 0))]
  const personalValues = new Set(values)
  const selectedColumns = ['id', 'external_id', 'provider_ref', 'name', 'billing_email', 'address', 'tax_exempt_ref', 'revision']
  const selectionGuard: D1Sql = {
    sql: `INSERT INTO ik_d1_assertions(ok) SELECT CASE WHEN EXISTS(SELECT 1 FROM nc_customers WHERE erased_at IS NULL AND ${selectedColumns.map(column => `${column} IS ?`).join(' AND ')}) THEN 1 ELSE 0 END`,
    params: selectedColumns.map(column => customer[column] ?? null),
  }
  const context: D1ImportContext = {
    destination: 'billing', namespace: 'stripe', mappingVersion: 'stripe-billing-1',
    originalErasurePolicy: 'withdraw-affected-artifacts',
    storage: { database: env.DB, targets: erasureTargets(customer.id) },
    authorization: {
      principalId: actor.id,
      predicate: () => ({
        sql: `EXISTS(SELECT 1 FROM oa_sessions s JOIN oa_operators o ON o.id=s.operator_id
          JOIN nc_members m ON m.id=? AND m.email=lower(o.email)
          WHERE s.id=? AND s.revoked_at IS NULL AND s.expires_at>CAST(strftime('%s','now') AS INTEGER)*1000
          AND o.version=s.operator_version AND o.status='active' AND o.role='owner'
          AND m.status='active' AND m.role='owner')`,
        params: [actor.id, actor.sessionId],
      }),
    },
  }
  const result = await retireD1ImportCustody({
    target: { kind: 'customer', id: customer.id }, values,
    related: {
      source: record => identities.has(record.sourceId) || [...identities].some(id => record.sourceId === `customer:${id}`) || holdsIdentity(record.payload, identities),
      // Every retained artifact accepted by Nectar's Stripe door is JSON.
      // Invalid custody must abort, rather than leave an unexamined copy.
      original: bytes => holdsIdentity(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), personalValues),
    },
  }, [selectionGuard, ...nativeStatements], context, checkpoint)
  return { ...result, nativeResults: result.nativeResults.slice(1) }
}
