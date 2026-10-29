// Read-only sandbox bank capture. Only posted funds can support remittance advice.
import type { Bindings } from '../auth.server'
import { actorLabel, requireOwner, requireRead, type Actor } from './actor'
import { clockInstant } from './clock'
import { commit, fingerprint, guard, insist, one, stmt, type Row } from './core'
import { cents } from './decimal'
import type { Input } from './input'
import { standing, STEP_UP_MS } from './mfa'
import { remittanceMatch, remittanceSources } from './remittance-matching'
import { remittanceConfirmationStatements, stageRemittanceSources } from './remittances'

type PlaidBindings = Bindings & { PLAID_CLIENT_ID?: string; PLAID_SECRET?: string; PLAID_ACCESS_TOKEN?: string }
async function bankOperator(env: Bindings, actor: Actor) {
  requireOwner(actor)
  for (const family of ['customers','invoices','payments'] as const) requireRead(actor, family)
  const factor = await standing(env, actor)
  insist(factor.verifiedAt !== null && clockInstant(env) - factor.verifiedAt <= STEP_UP_MS, 'mfa_step_up_required', 403)
}
function plaid(env: PlaidBindings) {
  insist(env.PLAID_CLIENT_ID?.trim() && env.PLAID_SECRET?.trim() && env.PLAID_ACCESS_TOKEN?.trim(), 'plaid_sandbox_credentials_required', 409)
  return async (path: '/accounts/get' | '/transactions/get', body: Row = {}): Promise<Row> => {
    let response: Response, result: Row
    try {
      response = await fetch(`https://sandbox.plaid.com${path}`, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20_000),
        headers: { 'content-type': 'application/json', 'Plaid-Version': '2020-09-14' },
        body: JSON.stringify({ ...body, client_id: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET, access_token: env.PLAID_ACCESS_TOKEN }) })
      result = await response.json() as Row
    } catch { insist(false, 'plaid_capture_unavailable', 502) }
    insist(response.ok && result && typeof result === 'object' && !Array.isArray(result), 'plaid_capture_unavailable', 502)
    return result
  }
}
async function capture(env: Bindings, actor: Actor, input: Input) {
  await bankOperator(env, actor)
  const account = input.text('account', { max: 120 }), file = (await input.file('file', { maxBytes: 128_000 }))!
  const advice = remittanceSources(file.bytes).sort((a,b) => a.receiptId.localeCompare(b.receiptId)), client = plaid(env)
  const accounts = await client('/accounts/get')
  insist(accounts.item && typeof accounts.item.item_id === 'string' && !accounts.item.error && Array.isArray(accounts.accounts), 'plaid_account_unavailable', 409)
  const bank = accounts.accounts.filter((row: Row) => row.account_id === account)
  insist(bank.length === 1 && bank[0].type === 'depository' && bank[0].balances?.iso_currency_code === 'USD', 'plaid_account_unavailable', 409)
  const dates = advice.map(row => row.receivedOn).sort(), transactions: Row[] = [], seen = new Set<string>()
  let total: number | null = null
  for (let offset = 0; ; offset += 100) {
    const page = await client('/transactions/get', { start_date: dates[0], end_date: dates.at(-1), options: { account_ids: [account], count: 100, offset } })
    insist(page.item?.item_id === accounts.item.item_id && Array.isArray(page.transactions) && Number.isSafeInteger(page.total_transactions)
      && page.total_transactions >= 0 && page.total_transactions <= 5000 && (total === null || total === page.total_transactions), 'plaid_history_incomplete', 409)
    total = page.total_transactions
    for (const row of page.transactions) {
      insist(typeof row.transaction_id === 'string' && !seen.has(row.transaction_id) && row.account_id === account, 'plaid_history_incomplete', 409)
      seen.add(row.transaction_id); transactions.push(row)
    }
    insist(transactions.length <= total!, 'plaid_history_incomplete', 409)
    if (transactions.length === total) break
    insist(page.transactions.length === 100, 'plaid_history_incomplete', 409)
  }
  const deposits: Row[] = [], sources = []
  for (const source of advice) {
    const transaction = transactions.find(row => row.transaction_id === source.receiptId)
    insist(transaction && transaction.pending === false && transaction.iso_currency_code === 'USD' && typeof transaction.amount === 'number'
      && Number.isFinite(transaction.amount) && transaction.amount < 0 && transaction.date === source.receivedOn
      && cents(String(-transaction.amount)) === source.amountCents, 'plaid_deposit_mismatch', 409)
    const id = await fingerprint({ item: accounts.item.item_id, account, transaction: transaction.transaction_id })
    const sourceHash = await fingerprint({ account, transaction: transaction.transaction_id, amount: transaction.amount, date: transaction.date,
      currency: transaction.iso_currency_code, pending: transaction.pending, reference: transaction.payment_meta?.reference_number ?? null, description: transaction.name ?? null })
    sources.push({ ...source, receiptId: `plaid-${id}` })
    deposits.push({ id, account, transaction: transaction.transaction_id, sourceHash })
  }
  const staged = await stageRemittanceSources(env, actor, sources, true), plans = []
  for (let i = 0; i < staged.rows.length; i++) {
    const row = staged.rows[i], deposit = deposits[i], existing = await one(env, 'SELECT * FROM nc_plaid_deposits WHERE id=?', deposit.id)
    insist(!existing || existing.receipt_id === row.id && existing.source_hash === deposit.sourceHash, 'plaid_deposit_changed', 409)
    plans.push({ row, deposit, captured: !!existing, preview: row.status === 'confirmed' ? null : await remittanceMatch(env, row) })
  }
  const basis = plans.map(plan => ({ receipt: plan.row.id, payload: plan.row.payload_hash, source: plan.deposit.sourceHash,
    match: plan.row.status === 'confirmed' ? plan.row.confirmation_hash : plan.preview!.fingerprint }))
  return { ...staged, plans, fingerprint: await fingerprint({ account, item: accounts.item.item_id, basis }) }
}
export async function previewPlaidRemittances(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor)
  input.only(['account','file','returnTo'])
  const prepared = await capture(env, actor, input)
  return { fingerprint: prepared.fingerprint, receipts: prepared.plans.map(plan => ({ id: plan.row.id, source: plan.deposit.transaction,
    alreadyCaptured: plan.captured, autoApply: !!plan.preview?.allocations.length, preview: plan.preview })) }
}
export async function confirmPlaidRemittances(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor)
  input.only(['account','file','fingerprint','confirm','returnTo'])
  insist(input.flag('confirm'), 'confirmation_required')
  const prepared = await capture(env, actor, input), hash = input.text('fingerprint', { max: 64 })
  if (prepared.plans.every(plan => plan.captured)) return { receipts: prepared.ids, duplicate: true }
  insist(hash === prepared.fingerprint, 'stale', 409)
  const statements = [guard(env, 'authority', `EXISTS(SELECT 1 FROM nc_members m JOIN oa_operators o ON o.email=m.email JOIN nc_mfa_sessions s ON s.member_id=m.id
    WHERE m.id=? AND m.status='active' AND m.role='owner' AND o.status='active' AND o.role='owner' AND s.session_id=? AND s.verified_at>=?)`, actor.id, actor.sessionId, clockInstant(env)-STEP_UP_MS), ...prepared.statements], audit = []
  for (const { row, deposit, captured, preview } of prepared.plans) {
    if (captured) continue
    statements.push(stmt(env, `INSERT INTO nc_plaid_deposits(id,receipt_id,customer_id,account_ref,transaction_ref,source_hash,amount_cents,currency,received_on,captured_at,captured_by) VALUES(?,?,?,?,?,?,?,'USD',?,?,?)`,
      deposit.id, row.id, preview?.customer ?? row.customer_id ?? null, deposit.account, deposit.transaction, deposit.sourceHash, row.amount_cents, row.received_on, clockInstant(env), actorLabel(actor)))
    if (preview?.customer && preview.allocations.length) {
      const confirmation = remittanceConfirmationStatements(env, actor, row, preview)
      statements.push(...confirmation.statements)
      audit.push({ actor: actorLabel(actor), action: 'remittance.confirm', subject: row.id, detail: { source: 'plaid_sandbox',
        customer: preview.customer, payment: confirmation.payment, allocations: preview.allocations, reason: preview.reason } })
    }
  }
  audit.push({ actor: actorLabel(actor), action: 'bank.remittance.confirm', subject: prepared.ids[0], detail: { receipts: prepared.ids, fingerprint: hash } })
  await commit(env, statements, audit)
  return { receipts: prepared.ids, duplicate: false }
}
