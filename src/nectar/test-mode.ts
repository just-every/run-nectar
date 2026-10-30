// Native sandbox custody: copied prices and reviewed configuration have no
// foreign keys to live billing records and confer no financial authority.
import type { Bindings } from '../auth.server'
import { actorLabel, can, type Actor } from './actor'
import { requireBusiness, taxReady } from './business'
import { MONTHLY_ARREARS, storedBillingTerms } from './billing-calendar'
import { all, commit, fingerprint, guard, insist, newId, now, one, stmt } from './core'
import type { Input } from './input'
import { requireFreshFactor } from './mfa'
import type { PriceIn, RatingInput } from './rating'
import { RETRY_TABLE_VERSION, type RetryPolicy } from './retry-policy'

export function requireSandbox(actor: Actor) {
  insist(actor.kind === 'member' && can(actor, 'credentials'), 'forbidden', 403)
}

export interface SandboxCatalog {
  id: string
  sourceFingerprint: string
  configuration: { timezone: string; currency: 'USD'; taxReviewedAt: number | null; businessRevision: number; tax: RatingInput['tax']; retry?: RetryPolicy }
  prices: (PriceIn & { sourceId: string; productRevision: string; priceRevision: string })[]
}

const supported = "p.status='active' AND pr.status='active' AND p.currency='USD' AND p.kind IN ('flat','seat') AND p.pricing_model='simple'"

export async function sandboxSource(env: Bindings, actor: Actor) {
  requireSandbox(actor)
  const b = await requireBusiness(env)
  const rows = await all(env, `SELECT p.*,pr.name AS product_name,pr.revision AS product_revision,b.interval_unit,b.interval_count,b.billing_timing FROM nc_prices p JOIN nc_products pr ON pr.id=p.product_id LEFT JOIN nc_price_intervals b ON b.price_id=p.id WHERE ${supported} ORDER BY p.id`)
  insist(rows.length <= 500, 'sandbox_catalog_too_large', 409)
  const retry = await one(env, "SELECT * FROM nc_retry_policies WHERE scope='default'")
  const configuration: SandboxCatalog['configuration'] = { timezone: b.timezone, currency: 'USD', taxReviewedAt: b.tax_reviewed_at, businessRevision: b.revision,
    retry: { version: RETRY_TABLE_VERSION, maxAttempts: retry?.max_attempts ?? 8, windowDays: retry?.window_days ?? 14, scope: 'default' },
    tax: { mode: b.tax_mode, rate: b.tax_rate, jurisdiction: b.tax_jurisdiction, exempt: false, exemptRef: '' } }
  const prices: SandboxCatalog['prices'] = rows.map(p => ({ id: p.id, sourceId: p.id, priceRevision: p.revision, productRevision: p.product_revision,
    kind: p.kind, unitAmount: p.unit_amount, taxable: !!p.taxable, meterId: null, unitLabel: '', label: `${p.product_name}${p.nickname ? ` — ${p.nickname}` : ''} (v${p.version})`, billing: storedBillingTerms(p) ?? MONTHLY_ARREARS }))
  const excluded = await all(env, `SELECT p.id,p.kind,p.currency,p.pricing_model FROM nc_prices p JOIN nc_products pr ON pr.id=p.product_id WHERE p.status='active' AND pr.status='active' AND NOT (${supported}) ORDER BY p.id`)
  return { configuration, prices, excluded, copyReady: taxReady(b) && prices.length > 0, sourceFingerprint: await fingerprint({ configuration, prices }),
    auditSequence: (await one(env, 'SELECT COALESCE(MAX(seq),0) AS seq FROM nc_audit'))!.seq as number }
}

export async function copySandboxCatalog(env: Bindings, actor: Actor, input: Input) {
  requireSandbox(actor)
  await requireFreshFactor(env, actor)
  input.only(['source_fingerprint', 'confirm', 'returnTo'])
  insist(input.flag('confirm'), 'sandbox_confirmation_required')
  const source = await sandboxSource(env, actor)
  insist(source.copyReady, 'sandbox_reviewed_catalog_required', 409)
  insist(input.text('source_fingerprint', { max: 64 }) === source.sourceFingerprint, 'sandbox_source_changed', 409)
  const existing = await one(env, 'SELECT id FROM nc_sandbox_catalogs WHERE source_fingerprint=?', source.sourceFingerprint)
  if (existing) return { id: existing.id, sourceFingerprint: source.sourceFingerprint }
  const catalog: SandboxCatalog = { id: `sandbox_catalog_${newId()}`, sourceFingerprint: source.sourceFingerprint,
    configuration: source.configuration, prices: source.prices.map(p => ({ ...p, id: `sandbox_price_${newId()}` })) }
  await commit(env, [
    guard(env, 'sandbox_source_changed', '(SELECT COALESCE(MAX(seq),0) FROM nc_audit)=?', source.auditSequence),
    guard(env, 'sandbox_source_changed', 'EXISTS(SELECT 1 FROM nc_business WHERE singleton=1 AND revision=?)', source.configuration.businessRevision),
    guard(env, 'sandbox_source_changed', `(SELECT COUNT(*) FROM nc_prices p JOIN nc_products pr ON pr.id=p.product_id WHERE ${supported})=?`, source.prices.length),
    ...source.prices.map(p => guard(env, 'sandbox_source_changed', `EXISTS(SELECT 1 FROM nc_prices p JOIN nc_products pr ON pr.id=p.product_id WHERE ${supported} AND p.id=? AND p.revision=? AND pr.revision=?)`, p.sourceId, p.priceRevision, p.productRevision)),
    stmt(env, 'INSERT INTO nc_sandbox_catalogs(id,source_fingerprint,catalog_json,created_by,created_at) VALUES(?,?,?,?,?)', catalog.id, catalog.sourceFingerprint, JSON.stringify(catalog), actorLabel(actor), now()),
  ], { actor: actorLabel(actor), action: 'sandbox.catalog.copy', subject: catalog.id, detail: { sourceFingerprint: catalog.sourceFingerprint, prices: catalog.prices.length } })
  return { id: catalog.id, sourceFingerprint: catalog.sourceFingerprint }
}

export async function sandboxCatalog(env: Bindings, id: string): Promise<SandboxCatalog> {
  const row = await one(env, 'SELECT catalog_json FROM nc_sandbox_catalogs WHERE id=?', id)
  insist(row, 'sandbox_catalog_not_found', 404)
  return JSON.parse(row.catalog_json)
}

export async function sandboxView(env: Bindings, actor: Actor) {
  requireSandbox(actor)
  return { source: await sandboxSource(env, actor),
    catalogs: (await all(env, 'SELECT catalog_json,created_at FROM nc_sandbox_catalogs ORDER BY created_at,id')).map(row => ({ ...(JSON.parse(row.catalog_json) as SandboxCatalog), createdAt: row.created_at })),
    customers: await all(env, 'SELECT id,catalog_id,label,clock_at,revision FROM nc_sandbox_customers ORDER BY created_at,id') }
}
