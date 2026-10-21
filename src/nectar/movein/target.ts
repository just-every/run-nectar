// The import kit's native targets: imported meters, products, price versions,
// customers, subscriptions (with their items and contract discounts) and the
// previous biller's invoices, written into Nectar's tables with origin
// 'import'. Each effect is one complete entity. Its snapshot counts every later
// record that depends on it (a bill run, usage, a payment, a native edit), so
// strict undo refuses once billing has started from the imported data.
// Imported subscriptions are written in shadow mode: they can be rated and
// compared but never issued until the owner adopts them at a cutover date.
import type { D1Database, D1Sql, D1TargetAdapter, Json, TargetRow } from '../../modules/import-kit/src/d1/index'

const sql = (text: string, ...params: unknown[]): D1Sql => ({ sql: text, params })
type Value = Record<string, any>

interface Kind {
  read(db: D1Database, id: string): Promise<{ value: Value; revision: string } | undefined>
  matches(value: Value, id: string, revision: string): D1Sql
  absent(id: string): D1Sql
  write(value: Value, id: string, revision: string): D1Sql[]
  remove(id: string): D1Sql[]
  ids(db: D1Database): Promise<string[]>
  count: string
}

const eq = (pairs: [string, unknown][]) => ({ text: pairs.map(([column]) => `${column} IS ?`).join(' AND '), params: pairs.map(([, value]) => value ?? null) })
const withDependents = (value: Value, dependents: number) => dependents ? { ...value, dependents } : value
const idsOf = async (db: D1Database, table: string) => (await db.prepare(`SELECT id FROM ${table} WHERE origin = 'import' ORDER BY id`).all<{ id: string }>()).results.map(row => row.id)
const at = () => Date.now()

async function dependents(db: D1Database, expression: string, id: string) {
  const count = (expression.match(/\?1/g) ?? []).length
  return (await db.prepare(`SELECT ${expression.replace(/\?1/g, '?')} AS n`).bind(...Array(count).fill(id)).first<{ n: number }>())!.n
}
const noDependents = (expression: string, id: string) => ({ text: `${expression.replace(/\?1/g, '?')} = 0`, params: Array((expression.match(/\?1/g) ?? []).length).fill(id) })

const CUSTOMER_DEPENDENTS = `((SELECT COUNT(*) FROM nc_subscriptions WHERE customer_id = ?1 AND origin = 'native') + (SELECT COUNT(*) FROM nc_usage_events WHERE customer_id = ?1)
  + (SELECT COUNT(*) FROM nc_invoices WHERE customer_id = ?1) + (SELECT COUNT(*) FROM nc_contacts WHERE customer_id = ?1) + (SELECT COUNT(*) FROM nc_payments WHERE customer_id = ?1)
  + (SELECT COUNT(*) FROM nc_tasks WHERE customer_id = ?1) + (SELECT COUNT(*) FROM nc_notices WHERE customer_id = ?1))`
const PRODUCT_DEPENDENTS = `((SELECT COUNT(*) FROM nc_prices WHERE product_id = ?1 AND origin = 'native') + (SELECT COUNT(*) FROM nc_features WHERE product_id = ?1) + (SELECT COUNT(*) FROM nc_price_requests WHERE product_id = ?1))`
const METER_DEPENDENTS = `((SELECT COUNT(*) FROM nc_prices WHERE meter_id = ?1 AND origin = 'native') + (SELECT COUNT(*) FROM nc_usage_events WHERE meter_id = ?1) + (SELECT COUNT(*) FROM nc_price_requests WHERE meter_id = ?1))`
const PRICE_DEPENDENTS = `((SELECT COUNT(*) FROM nc_items WHERE price_id = ?1 AND origin = 'native') + (SELECT COUNT(*) FROM nc_amendments WHERE price_id = ?1 AND origin <> 'import') + (SELECT COUNT(*) FROM nc_changes WHERE new_price_id = ?1))`
const SUBSCRIPTION_DEPENDENTS = `((SELECT COUNT(*) FROM nc_invoices WHERE subscription_id = ?1) + (SELECT COUNT(*) FROM nc_items WHERE subscription_id = ?1 AND origin = 'native')
  + (SELECT COUNT(*) FROM nc_amendments WHERE subscription_id = ?1 AND origin <> 'import') + (SELECT COUNT(*) FROM nc_changes WHERE subscription_id = ?1))`

const customer: Kind = {
  async read(db, id) {
    const row = await db.prepare("SELECT * FROM nc_customers WHERE id = ? AND origin = 'import'").bind(id).first<any>()
    return row ? { revision: row.revision, value: withDependents({ externalId: row.external_id, name: row.name, billingEmail: row.billing_email, address: row.address, taxExempt: row.tax_exempt, taxExemptRef: row.tax_exempt_ref, providerRef: row.provider_ref }, await dependents(db, CUSTOMER_DEPENDENTS, id)) } : undefined
  },
  matches(value, id, revision) {
    const main = eq([['external_id', value.externalId], ['name', value.name], ['billing_email', value.billingEmail], ['address', value.address], ['tax_exempt', value.taxExempt], ['tax_exempt_ref', value.taxExemptRef], ['provider_ref', value.providerRef], ['status', 'active'], ['revision', revision]])
    const free = noDependents(CUSTOMER_DEPENDENTS, id)
    return sql(`EXISTS(SELECT 1 FROM nc_customers WHERE id = ? AND origin = 'import' AND ${main.text}) AND ${free.text}`, id, ...main.params, ...free.params)
  },
  absent: id => sql('NOT EXISTS(SELECT 1 FROM nc_customers WHERE id = ?)', id),
  write: (value, id, revision) => [sql("INSERT INTO nc_customers (id, external_id, name, billing_email, address, tax_exempt, tax_exempt_ref, origin, provider_ref, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'import', ?, ?, ?, ?)",
    id, value.externalId, value.name, value.billingEmail, value.address, value.taxExempt, value.taxExemptRef, value.providerRef, revision, at(), at())],
  remove: id => [sql("DELETE FROM nc_customers WHERE id = ? AND origin = 'import'", id)],
  ids: db => idsOf(db, 'nc_customers'),
  count: "(SELECT COUNT(*) FROM nc_customers WHERE origin = 'import')",
}

const product: Kind = {
  async read(db, id) {
    const row = await db.prepare("SELECT * FROM nc_products WHERE id = ? AND origin = 'import'").bind(id).first<any>()
    return row ? { revision: row.revision, value: withDependents({ code: row.code, name: row.name, description: row.description, providerRef: row.provider_ref }, await dependents(db, PRODUCT_DEPENDENTS, id)) } : undefined
  },
  matches(value, id, revision) {
    const main = eq([['code', value.code], ['name', value.name], ['description', value.description], ['provider_ref', value.providerRef], ['status', 'active'], ['revision', revision]])
    const free = noDependents(PRODUCT_DEPENDENTS, id)
    return sql(`EXISTS(SELECT 1 FROM nc_products WHERE id = ? AND origin = 'import' AND ${main.text}) AND ${free.text}`, id, ...main.params, ...free.params)
  },
  absent: id => sql('NOT EXISTS(SELECT 1 FROM nc_products WHERE id = ?)', id),
  write: (value, id, revision) => [sql("INSERT INTO nc_products (id, code, name, description, origin, provider_ref, revision, created_at) VALUES (?, ?, ?, ?, 'import', ?, ?, ?)", id, value.code, value.name, value.description, value.providerRef, revision, at())],
  remove: id => [sql("DELETE FROM nc_products WHERE id = ? AND origin = 'import'", id)],
  ids: db => idsOf(db, 'nc_products'),
  count: "(SELECT COUNT(*) FROM nc_products WHERE origin = 'import')",
}

const meter: Kind = {
  async read(db, id) {
    const row = await db.prepare("SELECT * FROM nc_meters WHERE id = ? AND origin = 'import'").bind(id).first<any>()
    return row ? { revision: row.revision, value: withDependents({ code: row.code, name: row.name, unitLabel: row.unit_label, providerRef: row.provider_ref }, await dependents(db, METER_DEPENDENTS, id)) } : undefined
  },
  matches(value, id, revision) {
    const main = eq([['code', value.code], ['name', value.name], ['unit_label', value.unitLabel], ['provider_ref', value.providerRef], ['revision', revision]])
    const free = noDependents(METER_DEPENDENTS, id)
    return sql(`EXISTS(SELECT 1 FROM nc_meters WHERE id = ? AND origin = 'import' AND ${main.text}) AND ${free.text}`, id, ...main.params, ...free.params)
  },
  absent: id => sql('NOT EXISTS(SELECT 1 FROM nc_meters WHERE id = ?)', id),
  write: (value, id, revision) => [sql("INSERT INTO nc_meters (id, code, name, unit_label, origin, provider_ref, revision, created_at) VALUES (?, ?, ?, ?, 'import', ?, ?, ?)", id, value.code, value.name, value.unitLabel, value.providerRef, revision, at())],
  remove: id => [sql("DELETE FROM nc_meters WHERE id = ? AND origin = 'import'", id)],
  ids: db => idsOf(db, 'nc_meters'),
  count: "(SELECT COUNT(*) FROM nc_meters WHERE origin = 'import')",
}

const price: Kind = {
  async read(db, id) {
    const row = await db.prepare("SELECT * FROM nc_prices WHERE id = ? AND origin = 'import'").bind(id).first<any>()
    return row ? { revision: row.revision, value: withDependents({ productId: row.product_id, version: row.version, kind: row.kind, unitAmount: row.unit_amount, meterId: row.meter_id, taxable: row.taxable, nickname: row.nickname, providerRef: row.provider_ref }, await dependents(db, PRICE_DEPENDENTS, id)) } : undefined
  },
  matches(value, id, revision) {
    const main = eq([['product_id', value.productId], ['version', value.version], ['kind', value.kind], ['unit_amount', value.unitAmount], ['meter_id', value.meterId], ['taxable', value.taxable], ['nickname', value.nickname], ['provider_ref', value.providerRef], ['status', 'active'], ['revision', revision]])
    const free = noDependents(PRICE_DEPENDENTS, id)
    return sql(`EXISTS(SELECT 1 FROM nc_prices WHERE id = ? AND origin = 'import' AND ${main.text}) AND ${free.text}`, id, ...main.params, ...free.params)
  },
  absent: id => sql('NOT EXISTS(SELECT 1 FROM nc_prices WHERE id = ?)', id),
  write: (value, id, revision) => [sql("INSERT INTO nc_prices (id, product_id, version, kind, unit_amount, meter_id, taxable, nickname, origin, provider_ref, revision, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'import', ?, ?, 'import:stripe', ?)",
    id, value.productId, value.version, value.kind, value.unitAmount, value.meterId, value.taxable, value.nickname, value.providerRef, revision, at())],
  remove: id => [sql("DELETE FROM nc_prices WHERE id = ? AND origin = 'import'", id)],
  ids: db => idsOf(db, 'nc_prices'),
  count: "(SELECT COUNT(*) FROM nc_prices WHERE origin = 'import')",
}

const subscription: Kind = {
  async read(db, id) {
    const row = await db.prepare("SELECT * FROM nc_subscriptions WHERE id = ? AND origin = 'import'").bind(id).first<any>()
    if (!row) return undefined
    const items = (await db.prepare("SELECT id, price_id, quantity, effective_from, effective_to, provider_ref FROM nc_items WHERE subscription_id = ? AND origin = 'import' ORDER BY id").bind(id).all<any>()).results
    const amendments = (await db.prepare("SELECT id, kind, value, effective_from, effective_to, note, status FROM nc_amendments WHERE subscription_id = ? AND origin = 'import' ORDER BY id").bind(id).all<any>()).results
    return {
      revision: row.revision,
      value: withDependents({
        customerId: row.customer_id, externalId: row.external_id, anchorDay: row.anchor_day, startDate: row.start_date, trialEnd: row.trial_end, endDate: row.end_date,
        providerRef: row.provider_ref, scheduleRef: row.provider_schedule_ref, collection: row.provider_collection,
        items: items.map(item => ({ id: item.id, priceId: item.price_id, quantity: item.quantity, from: item.effective_from, to: item.effective_to, providerRef: item.provider_ref })),
        amendments: amendments.map(a => ({ id: a.id, kind: a.kind, value: a.value, from: a.effective_from, to: a.effective_to, note: a.note, status: a.status })),
      }, await dependents(db, SUBSCRIPTION_DEPENDENTS, id)),
    }
  },
  matches(value, id, revision) {
    const main = eq([['customer_id', value.customerId], ['external_id', value.externalId], ['anchor_day', value.anchorDay], ['start_date', value.startDate], ['trial_end', value.trialEnd], ['end_date', value.endDate], ['billing_mode', 'shadow'], ['cutover_start', null], ['provider_ref', value.providerRef], ['provider_schedule_ref', value.scheduleRef], ['provider_collection', value.collection], ['revision', revision]])
    const parts = [`EXISTS(SELECT 1 FROM nc_subscriptions WHERE id = ? AND origin = 'import' AND ${main.text})`], params: unknown[] = [id, ...main.params]
    for (const item of value.items as Value[]) {
      const match = eq([['id', item.id], ['subscription_id', id], ['price_id', item.priceId], ['quantity', item.quantity], ['effective_from', item.from], ['effective_to', item.to], ['provider_ref', item.providerRef]])
      parts.push(`EXISTS(SELECT 1 FROM nc_items WHERE origin = 'import' AND ${match.text})`); params.push(...match.params)
    }
    for (const a of value.amendments as Value[]) {
      const match = eq([['id', a.id], ['subscription_id', id], ['kind', a.kind], ['value', a.value], ['effective_from', a.from], ['effective_to', a.to], ['note', a.note], ['status', a.status]])
      parts.push(`EXISTS(SELECT 1 FROM nc_amendments WHERE origin = 'import' AND ${match.text})`); params.push(...match.params)
    }
    parts.push("(SELECT COUNT(*) FROM nc_items WHERE subscription_id = ? AND origin = 'import') = ?", "(SELECT COUNT(*) FROM nc_amendments WHERE subscription_id = ? AND origin = 'import') = ?")
    params.push(id, value.items.length, id, value.amendments.length)
    const free = noDependents(SUBSCRIPTION_DEPENDENTS, id)
    return sql(`${parts.join(' AND ')} AND ${free.text}`, ...params, ...free.params)
  },
  absent: id => sql('NOT EXISTS(SELECT 1 FROM nc_subscriptions WHERE id = ?) AND NOT EXISTS(SELECT 1 FROM nc_items WHERE subscription_id = ?)', id, id),
  write: (value, id, revision) => [
    sql("INSERT INTO nc_subscriptions (id, customer_id, external_id, anchor_day, start_date, trial_end, end_date, billing_mode, origin, provider_ref, provider_schedule_ref, provider_collection, revision, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'shadow', 'import', ?, ?, ?, ?, 'import:stripe', ?, ?)",
      id, value.customerId, value.externalId, value.anchorDay, value.startDate, value.trialEnd, value.endDate, value.providerRef, value.scheduleRef, value.collection, revision, at(), at()),
    ...(value.items as Value[]).map(item => sql("INSERT INTO nc_items (id, subscription_id, price_id, quantity, effective_from, effective_to, origin, provider_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, 'import', ?, ?)", item.id, id, item.priceId, item.quantity, item.from, item.to, item.providerRef, at())),
    ...(value.amendments as Value[]).map(a => sql("INSERT INTO nc_amendments (id, subscription_id, kind, value, effective_from, effective_to, note, status, origin, created_by, created_at, decided_by, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'import', 'import:stripe', ?, 'import:stripe', ?)", a.id, id, a.kind, a.value, a.from, a.to, a.note, a.status, at(), at())),
  ],
  remove: id => [
    sql("DELETE FROM nc_amendments WHERE subscription_id = ? AND origin = 'import'", id),
    sql("DELETE FROM nc_items WHERE subscription_id = ? AND origin = 'import'", id),
    sql("DELETE FROM nc_subscriptions WHERE id = ? AND origin = 'import'", id),
  ],
  ids: db => idsOf(db, 'nc_subscriptions'),
  count: "(SELECT COUNT(*) FROM nc_subscriptions WHERE origin = 'import')",
}

// Old journal snapshots predate these columns. Their default empty source must
// retain the old value shape so strict undo still recognizes untouched imports.
const documentSource = (row: Value) => row.source_json === '{}' ? {} : {
  sourceJson: row.source_json, issueDate: row.issue_date, dueDate: row.due_date, currency: row.currency,
}
const documentSourceFields = (value: Value): [string, unknown][] => [
  ['source_json', value.sourceJson ?? '{}'], ['issue_date', value.issueDate ?? null], ['due_date', value.dueDate ?? null], ['currency', value.currency ?? null],
]
const historicalDocument = (documentKind: 'invoice' | 'credit-note'): Kind => ({
  async read(db, id) {
    const row = await db.prepare('SELECT * FROM nc_incumbent_invoices WHERE id = ? AND document_kind = ?').bind(id, documentKind).first<any>()
    return row ? { revision: row.revision, value: withDependents({ provider: row.provider, providerRef: row.provider_ref, customerId: row.customer_id, subscriptionId: row.subscription_id, number: row.number, status: row.status, periodStart: row.period_start, periodEnd: row.period_end, totalCents: row.total_cents, taxCents: row.tax_cents, paidCents: row.paid_cents, remainingCents: row.remaining_cents, lines: row.lines_json, ...documentSource(row) }, await dependents(db, `((SELECT COUNT(*) FROM nc_audit WHERE action='invoice.series' AND json_extract(detail,'$.sourceInvoice')=?1)+(SELECT COUNT(*) FROM nc_imported_collections WHERE invoice_id=?1))`, id)) } : undefined
  },
  matches(value, id, revision) {
    const main = eq([['document_kind', documentKind], ['provider', value.provider], ['provider_ref', value.providerRef], ['customer_id', value.customerId], ['subscription_id', value.subscriptionId], ['number', value.number], ['status', value.status], ['period_start', value.periodStart], ['period_end', value.periodEnd], ['total_cents', value.totalCents], ['tax_cents', value.taxCents], ['paid_cents', value.paidCents], ['remaining_cents', value.remainingCents], ['lines_json', value.lines], ['revision', revision], ...documentSourceFields(value)])
    const free = noDependents(`((SELECT COUNT(*) FROM nc_audit WHERE action='invoice.series' AND json_extract(detail,'$.sourceInvoice')=?1)+(SELECT COUNT(*) FROM nc_imported_collections WHERE invoice_id=?1))`, id)
    return sql(`EXISTS(SELECT 1 FROM nc_incumbent_invoices WHERE id = ? AND ${main.text}) AND ${free.text}`, id, ...main.params, ...free.params)
  },
  absent: id => sql('NOT EXISTS(SELECT 1 FROM nc_incumbent_invoices WHERE id = ?)', id),
  write: (value, id, revision) => [sql('INSERT INTO nc_incumbent_invoices (id, provider, provider_ref, customer_id, subscription_id, number, status, period_start, period_end, total_cents, tax_cents, paid_cents, remaining_cents, lines_json, revision, document_kind, source_json, issue_date, due_date, currency) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, value.provider, value.providerRef, value.customerId, value.subscriptionId, value.number, value.status, value.periodStart, value.periodEnd, value.totalCents, value.taxCents, value.paidCents, value.remainingCents, value.lines, revision, documentKind, value.sourceJson ?? '{}', value.issueDate ?? null, value.dueDate ?? null, value.currency ?? null)],
  remove: id => [sql('DELETE FROM nc_incumbent_invoices WHERE id = ?', id)],
  ids: async db => (await db.prepare('SELECT id FROM nc_incumbent_invoices WHERE document_kind = ? ORDER BY id').bind(documentKind).all<{ id: string }>()).results.map(row => row.id),
  count: `(SELECT COUNT(*) FROM nc_incumbent_invoices WHERE document_kind='${documentKind}')`,
})

const historyFields = (value: Value): [string, unknown][] => [
  ['provider', value.provider], ['provider_ref', value.providerRef], ['kind', value.kind], ['customer_id', value.customerId], ['occurred_on', value.occurredOn],
  ['amount_cents', value.amountCents], ['currency', value.currency], ['status', value.status], ['invoice_ref', value.invoiceRef], ['subscription_ref', value.subscriptionRef], ['payload_json', value.payloadJson],
]
const history: Kind = {
  async read(db, id) {
    const row = await db.prepare('SELECT * FROM nc_incumbent_history WHERE id=?').bind(id).first<any>()
    return row ? { revision: row.revision, value: { provider: row.provider, providerRef: row.provider_ref, kind: row.kind, customerId: row.customer_id,
      occurredOn: row.occurred_on, amountCents: row.amount_cents, currency: row.currency, status: row.status, invoiceRef: row.invoice_ref, subscriptionRef: row.subscription_ref, payloadJson: row.payload_json } } : undefined
  },
  matches(value, id, revision) {
    const fields = eq([...historyFields(value), ['revision', revision]])
    return sql(`EXISTS(SELECT 1 FROM nc_incumbent_history WHERE id=? AND ${fields.text})`, id, ...fields.params)
  },
  absent: id => sql('NOT EXISTS(SELECT 1 FROM nc_incumbent_history WHERE id=?)', id),
  write(value, id, revision) {
    const fields = historyFields(value)
    return [sql(`INSERT INTO nc_incumbent_history(id,${fields.map(([column]) => column).join(',')},revision) VALUES (?,${fields.map(() => '?').join(',')},?)`, id, ...fields.map(([, item]) => item), revision)]
  },
  remove: id => [sql('DELETE FROM nc_incumbent_history WHERE id=?', id)],
  ids: async db => (await db.prepare('SELECT id FROM nc_incumbent_history ORDER BY id').all<{ id: string }>()).results.map(row => row.id),
  count: '(SELECT COUNT(*) FROM nc_incumbent_history)',
}

export const KINDS: Record<string, Kind> = { meter, product, price, customer, subscription, invoice: historicalDocument('invoice'), credit_note: historicalDocument('credit-note'), history }
const kindOf = (name: string) => { const kind = KINDS[name]; if (!kind) throw new Error(`TARGET_KIND_UNKNOWN: ${name}`); return kind }

export const nectarTargets: D1TargetAdapter = {
  async read(db, destination, kind, id) {
    const row = await kindOf(kind).read(db, id)
    return row ? { destination, targetKind: kind, targetId: id, value: row.value as Json, revision: row.revision } : undefined
  },
  matches(row, _destination, kind, id) {
    const value = row?.value as Value | undefined
    // A row carrying dependents never matches: the fence requires the untouched entity.
    if (row && value && 'dependents' in value) return sql('0')
    return row ? kindOf(kind).matches(value!, id, row.revision) : kindOf(kind).absent(id)
  },
  write(row: TargetRow) {
    return kindOf(row.targetKind).write(row.value as Value, row.targetId, row.revision)
  },
  remove(_destination, kind, id) {
    return kindOf(kind).remove(id)
  },
  async list(db, destination) {
    const rows: TargetRow[] = []
    for (const [name, kind] of Object.entries(KINDS)) for (const id of await kind.ids(db)) rows.push((await this.read(db, destination, name, id))!)
    return rows
  },
  matchesCount(count) {
    return sql(`(${Object.values(KINDS).map(kind => kind.count).join(' + ')}) = ?`, count)
  },
}
