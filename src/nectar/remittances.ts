import type { Bindings } from '../auth.server'
import { actorLabel, requireMember, requireRead, type Actor } from './actor'
import { all, commit, fingerprint, guard, insist, newId, one, parseJson, stmt, type Row } from './core'
import { clockInstant } from './clock'
import { cents } from './decimal'
import { Input } from './input'
import { allocationFactStatements, BALANCE_SQL, paymentFactStatement, UNALLOCATED_SQL } from './receivables'
import { remittanceAllocation, remittanceMatch, remittanceSources } from './remittance-matching'

function readable(actor: Actor) {
  for (const family of ['customers','invoices','payments'] as const) requireRead(actor, family)
}
function operator(actor: Actor) { requireMember(actor, 'receivables'); readable(actor) }
async function receipt(env: Bindings, input: Input) {
  const row = await one(env, 'SELECT * FROM nc_remittances WHERE id=?', input.text('receipt', { max: 100 }))
  insist(row, 'remittance_not_found', 404)
  insist(row.status !== 'erased', 'remittance_erased', 409)
  return row
}
export async function uploadRemittances(env: Bindings, actor: Actor, input: Input) {
  return uploadSource(env, actor, input, 'ordinary_remittance')
}
export async function uploadBankDeposit(env: Bindings, actor: Actor, input: Input) {
  operator(actor)
  return uploadSource(env, actor, input, 'bank_deposit', input.text('bank_source_id', { max: 120 }))
}
async function uploadSource(env: Bindings, actor: Actor, input: Input, kind: string, bankId = '') {
  operator(actor)
  const file = (await input.file('file', { maxBytes: 128_000 }))!
  const sources = remittanceSources(file.bytes), ids: string[] = [], origins: string[] = [], statements: D1PreparedStatement[] = []
  insist(kind !== 'bank_deposit' || sources.length === 1, 'bank_deposit_one_receipt_required')
  for (const source of sources) {
    const sourceKey = await fingerprint({ kind: 'usd-remittance', receiptId: source.receiptId }), payloadHash = await fingerprint(source)
    const originKey = kind === 'ordinary_remittance' ? sourceKey : await fingerprint({ kind: 'bank-deposit', id: bankId })
    const key = await one(env, 'SELECT * FROM nc_remittance_source_keys WHERE source_key_hash=?', sourceKey)
    const bankKey = originKey === sourceKey ? key : await one(env, 'SELECT * FROM nc_remittance_source_keys WHERE source_key_hash=?', originKey)
    const existing = key ? await one(env, 'SELECT * FROM nc_remittances WHERE id=?', key.record_id) : null
    insist(!key || existing, 'remittance_erased', 409)
    insist(!bankKey || (key && bankKey.record_id === key.record_id && bankKey.payload_hash === payloadHash), 'remittance_source_changed', 409)
    let id: string
    if (existing) {
      insist(existing.status !== 'erased', 'remittance_erased', 409)
      insist(existing.payload_hash === payloadHash, 'remittance_source_changed', 409)
      id = existing.id
    } else {
      id = newId()
      const row = { id, status: 'staged', source_json: JSON.stringify(source), payload_hash: payloadHash }
      const match = await remittanceMatch(env, row)
      if (match.customer) statements.push(customerGuard(env, match.customer, match.customerRevision))
      statements.push(stmt(env, `INSERT INTO nc_remittances(id,source_key_hash,payload_hash,source_json,amount_cents,currency,received_on,customer_id,status,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,'staged',?,?)`,
        id, sourceKey, payloadHash, row.source_json, source.amountCents, source.currency, source.receivedOn, match.customer, actorLabel(actor), clockInstant(env)))
      statements.push(stmt(env, 'INSERT INTO nc_remittance_source_keys(source_key_hash,payload_hash,record_id) VALUES(?,?,?)', sourceKey, payloadHash, id))
    }
    if (originKey !== sourceKey && !bankKey) statements.push(stmt(env, 'INSERT INTO nc_remittance_source_keys(source_key_hash,payload_hash,record_id) VALUES(?,?,?)', originKey, payloadHash, id))
    if (!await one(env, 'SELECT 1 FROM nc_remittance_origins WHERE source_key_hash=?', originKey)) {
      if (existing) statements.push(guard(env, 'remittance_erased', "EXISTS(SELECT 1 FROM nc_remittances WHERE id=? AND status<>'erased' AND payload_hash=?)", id, payloadHash))
      statements.push(stmt(env, 'INSERT INTO nc_remittance_origins(source_key_hash,receipt_id,kind,source_reference) VALUES(?,?,?,?)', originKey, id, kind, bankId || source.receiptId))
    }
    ids.push(id); origins.push(originKey)
  }
  if (statements.length) await commit(env, statements, { actor: actorLabel(actor), action: 'remittance.upload', subject: ids[0], detail: { receipts: ids, kind, origins } })
  return { id: ids[0], receipts: ids, source: origins[0], sources: origins }
}
async function selectedOrigin(env: Bindings, row: Row, input: Input) {
  const source = input.text('source', { optional: true, max: 64 })
  const origin = source ? await one(env, 'SELECT * FROM nc_remittance_origins WHERE receipt_id=? AND source_key_hash=?', row.id, source)
    : await one(env, "SELECT * FROM nc_remittance_origins WHERE receipt_id=? ORDER BY kind='ordinary_remittance' DESC,source_key_hash LIMIT 1", row.id)
  insist(origin, 'remittance_source_not_found', 404)
  return origin
}
async function confirmationPreview(env: Bindings, row: Row, origin: Row, customer = '') {
  if (row.status === 'confirmed') {
    insist(!customer || customer === row.customer_id, 'different_customer', 409)
    const person = await one(env, "SELECT * FROM nc_customers WHERE id=? AND erased_at IS NULL AND status='active'", row.customer_id)
    insist(person, 'customer_not_found', 404)
    const basis = { receipt: row.id, sourceHash: row.payload_hash, origin: origin.source_key_hash, customer: row.customer_id,
      customerRevision: person.revision, payment: row.payment_id }
    return { ...basis, origin, source: parseJson<Row>(row.source_json, {}), allocations: [] as Row[], allocatedCents: 0, unallocatedCents: 0,
      existingPayment: row.payment_id as string, reason: 'already_recorded', fingerprint: origin.confirmation_hash ?? await fingerprint(basis) }
  }
  const match = await remittanceMatch(env, row, customer)
  return { ...match, origin, existingPayment: null, fingerprint: await fingerprint({ match: match.fingerprint, origin: origin.source_key_hash }) }
}
export async function previewRemittance(env: Bindings, actor: Actor, input: Input) {
  operator(actor)
  const row = await receipt(env, input), origin = await selectedOrigin(env, row, input)
  return confirmationPreview(env, row, origin, input.text('customer', { optional: true, max: 100 }))
}
function customerGuard(env: Bindings, customer: string, revision: string) {
  return guard(env, 'stale', "EXISTS(SELECT 1 FROM nc_customers WHERE id=? AND revision=? AND erased_at IS NULL AND status='active' AND currency='USD')", customer, revision)
}
function balanceGuard(env: Bindings, invoice: string, customer: string, balance: number) {
  return guard(env, 'stale', `EXISTS(SELECT 1 FROM nc_invoices i WHERE i.id=? AND i.customer_id=? AND i.status='issued' AND i.currency='USD' AND ${BALANCE_SQL}=?)`, invoice, customer, balance)
}
export async function confirmRemittance(env: Bindings, actor: Actor, input: Input) {
  operator(actor)
  insist(input.flag('confirm'), 'confirmation_required')
  const row = await receipt(env, input), hash = input.text('fingerprint', { max: 64 }), origin = await selectedOrigin(env, row, input)
  const selected = input.text('customer', { optional: true, max: 100 })
  if (origin.confirmed_at !== null) {
    insist(origin.confirmation_hash === hash && (!selected || selected === row.customer_id), 'stale', 409)
    return { id: row.id, payment: row.payment_id, duplicate: true }
  }
  const preview = await confirmationPreview(env, row, origin, selected)
  insist(preview.customer, 'remittance_customer_required', 409)
  insist(hash === preview.fingerprint, 'stale', 409)
  const payment = preview.existingPayment || newId(), statements = [
    guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_remittance_origins WHERE source_key_hash=? AND receipt_id=? AND confirmed_at IS NULL)', origin.source_key_hash, row.id),
    customerGuard(env, preview.customer, preview.customerRevision),
  ]
  if (preview.existingPayment) {
    statements.push(guard(env, 'stale', "EXISTS(SELECT 1 FROM nc_remittances WHERE id=? AND status='confirmed' AND payment_id=? AND payload_hash=?)", row.id, payment, row.payload_hash))
  } else {
    statements.push(guard(env, 'stale', "EXISTS(SELECT 1 FROM nc_remittances WHERE id=? AND status='staged' AND payload_hash=?)", row.id, row.payload_hash),
      paymentFactStatement(env, actor, { paymentId: payment, customerId: preview.customer, amountCents: row.amount_cents, receivedOn: row.received_on,
        currency: 'USD', method: 'bank_transfer', reference: `remittance:${row.id}`, evidence: '' }))
    for (const allocation of preview.allocations) statements.push(balanceGuard(env, allocation.invoice, preview.customer, allocation.balanceCents),
      ...allocationFactStatements(env, actor, payment, { id: allocation.invoice }, allocation.amountCents, newId()))
    statements.push(stmt(env, "UPDATE nc_remittances SET status='confirmed',customer_id=?,payment_id=?,confirmation_hash=?,confirmed_by=?,confirmed_at=? WHERE id=?", preview.customer, payment, hash, actorLabel(actor), clockInstant(env), row.id))
  }
  statements.push(stmt(env, 'UPDATE nc_remittance_origins SET customer_id=?,confirmed_at=?,confirmed_by=?,confirmation_hash=? WHERE source_key_hash=?', preview.customer, clockInstant(env), actorLabel(actor), hash, origin.source_key_hash))
  const sources = await all(env, 'SELECT kind,source_reference FROM nc_remittance_origins WHERE receipt_id=? AND (confirmed_at IS NOT NULL OR source_key_hash=?) ORDER BY kind,source_reference', row.id, origin.source_key_hash)
  await commit(env, statements, { actor: actorLabel(actor), action: preview.existingPayment ? 'remittance.reconcile' : 'remittance.confirm', subject: payment,
    detail: { customer: preview.customer, receipt: row.id, payment, sources, allocations: preview.allocations, reason: preview.reason } })
  return { id: row.id, payment, duplicate: !!preview.existingPayment }
}
export async function previewRemittanceAllocation(env: Bindings, actor: Actor, input: Input) {
  operator(actor)
  return remittanceAllocation(env, await receipt(env, input), input.text('invoice', { max: 100 }), cents(input.text('amount', { max: 20 })))
}
export async function allocateRemittance(env: Bindings, actor: Actor, input: Input) {
  operator(actor)
  insist(input.flag('confirm'), 'confirmation_required')
  const row = await receipt(env, input), hash = input.text('fingerprint', { max: 64 })
  const invoice = input.text('invoice', { max: 100 }), amount = cents(input.text('amount', { max: 20 }))
  const prior = await one(env, 'SELECT * FROM nc_remittance_allocations WHERE receipt_id=? AND basis_hash=?', row.id, hash)
  if (prior) {
    insist(prior.invoice_id === invoice && prior.amount_cents === amount, 'stale', 409)
    return { id: row.id, allocation: prior.allocation_id, duplicate: true }
  }
  const preview = await remittanceAllocation(env, row, invoice, amount)
  insist(preview.fingerprint === hash, 'stale', 409)
  const allocation = newId()
  await commit(env, [customerGuard(env, preview.customer, preview.customerRevision),
    guard(env, 'stale', "EXISTS(SELECT 1 FROM nc_remittances WHERE id=? AND status='confirmed' AND payment_id=?)", row.id, preview.payment),
    balanceGuard(env, invoice, preview.customer, preview.balanceCents),
    guard(env, 'stale', `(SELECT ${UNALLOCATED_SQL} FROM nc_payments p WHERE p.id=?)=?`, preview.payment, preview.availableCents),
    ...allocationFactStatements(env, actor, preview.payment, { id: invoice }, amount, allocation),
    stmt(env, 'INSERT INTO nc_remittance_allocations(id,receipt_id,customer_id,payment_id,invoice_id,allocation_id,amount_cents,basis_hash) VALUES(?,?,?,?,?,?,?,?)', newId(), row.id, preview.customer, preview.payment, invoice, allocation, amount, hash),
  ], { actor: actorLabel(actor), action: 'remittance.allocate', subject: row.id, detail: { payment: preview.payment, invoice, amount, allocation } })
  return { id: row.id, allocation, duplicate: false }
}
export async function readRemittances(env: Bindings, actor: Actor): Promise<Row[]> {
  readable(actor)
  const rows = await all(env, `SELECT r.*,c.name AS customer_name,${UNALLOCATED_SQL} AS available_cents FROM nc_remittances r LEFT JOIN nc_customers c ON c.id=r.customer_id LEFT JOIN nc_payments p ON p.id=r.payment_id WHERE r.status<>'erased' ORDER BY r.created_at DESC,r.id`)
  return Promise.all(rows.map(async row => {
    const source = parseJson<Row>(row.source_json, {}), origins = await all(env, 'SELECT * FROM nc_remittance_origins WHERE receipt_id=? ORDER BY kind,source_reference', row.id)
    if (row.status === 'staged') {
      // A stale source remains visible for review, without proposing any money movement.
      try { return { ...row, source, origins, preview: await remittanceMatch(env, row) } }
      catch { return { ...row, source, origins, preview: null, reason: 'source_requires_review' } }
    }
    const allocations = await all(env, 'SELECT a.invoice_id,a.amount_cents,i.number FROM nc_allocations a JOIN nc_invoices i ON i.id=a.invoice_id WHERE a.payment_id=? ORDER BY a.allocated_at,a.id', row.payment_id)
    const short = await all(env, `SELECT i.number,${BALANCE_SQL} AS balance_cents FROM nc_invoices i WHERE i.customer_id=? AND i.status='issued' AND i.number IN(SELECT json_extract(value,'$.invoiceReference') FROM json_each(?)) AND ${BALANCE_SQL}>0`, row.customer_id, JSON.stringify(source.lines ?? []))
    return { ...row, source, origins, allocations, short, reason: row.available_cents > 0 ? 'unallocated_funds' : short.length ? 'short_payment' : 'allocated' }
  }))
}
