// Typed payout comparisons retain a rejected source without accepting it as cash.
import type { Bindings } from '../auth.server'
import { clockInstant } from './clock'
import { all, canonical, fingerprint, insist, NectarError, one, parseJson, stmt, type Row } from './core'
import { instant, integer, ref } from './processor-source'
import { providerReference } from './payments/stripe'

export class PayoutComparisonError extends NectarError {
  constructor(code: string, readonly statements: D1PreparedStatement[]) { super(code, 409) }
}

const total = (rows: Row[], field: string) => {
  const value = rows.reduce((sum, row) => sum + BigInt(row[field]), 0n)
  insist(value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER), 'processor_amount_invalid', 409)
  return Number(value)
}

async function withdrawn(env: Bindings, members: Row[]) {
  for (const member of members) if (member.customer && await one(env, 'SELECT 1 FROM nc_customers WHERE id=? AND erased_at IS NOT NULL', member.customer)) return true
  return false
}

export async function payoutComparison(env: Bindings, account: string, payout: Row, debit: Row, observed: { transaction: Row; context: Row }[]) {
  const id = await fingerprint({ account, payout: providerReference(payout.id) })
  const prior = await one(env, 'SELECT * FROM nc_payout_checks WHERE id=?', id)
  insist(!prior || !await withdrawn(env, parseJson<Row[]>(prior.members_json, [])), 'processor_payout_source_erased', 409)
  insist(!prior || prior.amount_cents === integer(payout.amount) && prior.currency === payout.currency && prior.automatic === (payout.automatic === true ? 1 : 0), 'processor_payout_changed', 409)
  const members: Row[] = []
  for (const { transaction: row, context } of observed) {
    insist(row.object === 'balance_transaction' && ['pending', 'available'].includes(row.status) && row.currency === payout.currency, 'processor_transaction_invalid', 409)
    const amount = integer(row.amount), fee = integer(row.fee), net = integer(row.net)
    insist(net === amount - fee, 'processor_transaction_net_mismatch', 409)
    const transaction = providerReference(row.id), source = row.source == null ? '' : providerReference(ref(row.source))
    const recorded = await one(env, 'SELECT amount_cents,fee_cents,net_cents,currency,source_ref FROM nc_processor_transactions WHERE account_ref=? AND transaction_ref=?', account, transaction)
    members.push({ transaction, source, kind: providerReference(row.type), amountCents: amount, feeCents: fee, netCents: net,
      customer: context.customer ?? null, invoice: context.invoice ?? null, paymentId: context.payment ?? null,
      recordedFeeCents: recorded?.fee_cents ?? null,
      changed: !!recorded && (recorded.amount_cents !== amount || recorded.fee_cents !== fee || recorded.net_cents !== net || recorded.currency !== row.currency || recorded.source_ref !== source) })
  }
  members.sort((a, b) => a.transaction.localeCompare(b.transaction))
  const amount = integer(payout.amount), gross = total(members, 'amountCents'), fee = total(members, 'feeCents'), net = total(members, 'netCents')
  const difference = integer(net - amount)
  const error = payout.automatic !== true ? 'manual_payout_constituents_unavailable'
    : !members.length || difference !== 0 ? 'processor_payout_does_not_reconcile'
    : members.some(row => row.changed) ? 'processor_transaction_changed' : null
  const basis = await fingerprint({ account, payout: payout.id, currency: payout.currency, amount, status: payout.status, automatic: payout.automatic === true, debit: providerReference(debit.id), gross, fee, net, difference, error, members })
  const statements = [stmt(env, `INSERT INTO nc_payout_checks(id,account_ref,payout_ref,currency,amount_cents,status,automatic,occurred_at,gross_cents,fee_cents,net_cents,difference_cents,error_code,basis_hash,members_json,observed_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,gross_cents=excluded.gross_cents,fee_cents=excluded.fee_cents,net_cents=excluded.net_cents,difference_cents=excluded.difference_cents,error_code=excluded.error_code,basis_hash=excluded.basis_hash,members_json=excluded.members_json,observed_at=excluded.observed_at`,
    id, account, payout.id, payout.currency, amount, payout.status, payout.automatic === true ? 1 : 0, instant(debit.created), gross, fee, net, difference, error, basis, canonical(members), clockInstant(env))]
  return { error, statements }
}

// Shared observations are withdrawn as a whole when any constituent was erased.
// Numeric anonymous custody remains in exports; it does not revive a case.
export async function payoutChecks(env: Bindings) {
  const result: Row[] = []
  for (const row of await all(env, 'SELECT * FROM nc_payout_checks ORDER BY occurred_at,id')) {
    const members = parseJson<Row[]>(row.members_json, [])
    if (await withdrawn(env, members)) continue
    const { members_json: _members, observed_at: _at, ...source } = row
    result.push({ ...source, members, href: `/api/nectar/processor-events#${row.id}` })
  }
  return result
}
