// Reconciliation links an observed bank deposit to existing processor facts; it records no new cash.
import type { Bindings } from '../auth.server'
import { actorLabel, type Actor } from './actor'
import { bankAuthorityGuard, bankOperator } from './plaid-remittances'
import { clockInstant } from './clock'
import { all, commit, fingerprint, guard, insist, one, stmt } from './core'
import type { Input } from './input'

async function payoutMatch(env: Bindings, actor: Actor, input: Input) {
  await bankOperator(env, actor)
  const receipt = input.text('receipt', { max: 100 }), account = input.text('processor_account', { max: 255 })
  const requested = input.text('payout', { optional: true, max: 255 })
  const bank = await one(env, `SELECT b.*,r.status AS receipt_status,r.customer_id AS receipt_customer,r.payment_id FROM nc_plaid_deposits b JOIN nc_remittances r ON r.id=b.receipt_id WHERE b.receipt_id=?`, receipt)
  insist(bank && bank.receipt_status !== 'erased', 'bank_deposit_not_found', 404)
  insist(bank.receipt_status === 'staged' && !bank.payment_id && !bank.receipt_customer, 'bank_deposit_already_assigned', 409)
  const candidates = await all(env, `SELECT * FROM nc_processor_objects WHERE account_ref=? AND kind='payout' AND status='paid' AND amount_cents=? AND currency='usd' AND code IS NULL ${requested ? 'AND object_ref=?' : ''} ORDER BY object_ref`,
    account, bank.amount_cents, ...(requested ? [requested] : []))
  insist(candidates.length === 1, candidates.length ? 'payout_match_ambiguous' : 'payout_match_not_found', 409)
  const payout = candidates[0], transactions = await all(env, 'SELECT * FROM nc_processor_transactions WHERE account_ref=? AND payout_ref=? ORDER BY transaction_ref', account, payout.object_ref)
  const debits = transactions.filter(row => row.type === 'payout' && row.source_ref === payout.object_ref)
  insist(debits.length === 1 && debits[0].amount_cents === -bank.amount_cents && debits[0].net_cents === -bank.amount_cents && debits[0].fee_cents === 0, 'payout_membership_incomplete', 409)
  const members = transactions.filter(row => row.id !== debits[0].id)
  insist(members.length && transactions.every(row => row.currency === 'usd') && members.reduce((sum,row) => sum + row.net_cents,0) === bank.amount_cents, 'payout_membership_incomplete', 409)
  const basis = { receipt, bank: bank.id, bankSource: bank.source_hash, payout, transactions }
  return { receipt, bank, payout, transactions, amountCents: bank.amount_cents,
    invoiceIds: [...new Set(members.map(row => row.invoice_id).filter(Boolean))],
    unattributedCents: members.filter(row => !row.invoice_id).reduce((sum,row) => sum + row.net_cents,0), fingerprint: await fingerprint(basis) }
}
export async function previewPayoutMatch(env: Bindings, actor: Actor, input: Input) {
  return payoutMatch(env, actor, input)
}
export async function confirmPayoutMatch(env: Bindings, actor: Actor, input: Input) {
  await bankOperator(env, actor)
  insist(input.flag('confirm'), 'confirmation_required')
  const receipt = input.text('receipt', { max: 100 }), hash = input.text('fingerprint', { max: 64 })
  const prior = await one(env, 'SELECT * FROM nc_bank_payout_matches WHERE receipt_id=?', receipt)
  if (prior) {
    insist(prior.basis_hash === hash && prior.processor_account === input.text('processor_account',{max:255})
      && (!input.text('payout',{optional:true,max:255}) || prior.payout_ref === input.text('payout',{max:255})), 'stale', 409)
    return { receipt, payout: prior.payout_ref, duplicate: true }
  }
  const preview = await payoutMatch(env, actor, input)
  insist(preview.fingerprint === hash, 'stale', 409)
  const { bank, payout } = preview
  const statements = [bankAuthorityGuard(env, actor),
    guard(env, 'stale', `EXISTS(SELECT 1 FROM nc_remittances r JOIN nc_plaid_deposits b ON b.receipt_id=r.id WHERE r.id=? AND r.status='staged' AND r.customer_id IS NULL AND r.payment_id IS NULL AND b.id=? AND b.source_hash=?)`, receipt, bank.id, bank.source_hash),
    guard(env, 'stale', `EXISTS(SELECT 1 FROM nc_processor_objects WHERE account_ref=? AND object_ref=? AND status='paid' AND amount_cents=? AND currency='usd' AND code IS NULL AND observed_at=?)`, payout.account_ref, payout.object_ref, bank.amount_cents, payout.observed_at),
    guard(env, 'stale', '(SELECT COUNT(*) FROM nc_processor_transactions WHERE account_ref=? AND payout_ref=?)=?', payout.account_ref, payout.object_ref, preview.transactions.length),
  ]
  for (const row of preview.transactions) statements.push(guard(env, 'stale', `EXISTS(SELECT 1 FROM nc_processor_transactions WHERE id=? AND account_ref=? AND transaction_ref=? AND type=? AND source_ref=? AND amount_cents=? AND fee_cents=? AND net_cents=? AND currency=? AND status=? AND payout_ref=? AND customer_id IS ? AND invoice_id IS ? AND payment_id IS ?)`,
    row.id,row.account_ref,row.transaction_ref,row.type,row.source_ref,row.amount_cents,row.fee_cents,row.net_cents,row.currency,row.status,row.payout_ref,row.customer_id,row.invoice_id,row.payment_id))
  statements.push(stmt(env, 'INSERT INTO nc_bank_payout_matches(id,receipt_id,processor_account,payout_ref,amount_cents,basis_hash,matched_at,matched_by) VALUES(?,?,?,?,?,?,?,?)', bank.id,receipt,payout.account_ref,payout.object_ref,bank.amount_cents,hash,clockInstant(env),actorLabel(actor)))
  await commit(env, statements, { actor: actorLabel(actor), action: 'payout.match.confirm', subject: receipt, detail: { payout: payout.object_ref, account: payout.account_ref, amountCents: bank.amount_cents, invoices: preview.invoiceIds, unattributedCents: preview.unattributedCents } })
  return { receipt, payout: payout.object_ref, duplicate: false }
}
