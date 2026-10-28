import type { Bindings } from '../auth.server'
import { actorLabel, type Actor } from './actor'
import { clockInstant } from './clock'
import { all, commit, fingerprint, guard, insist, one, stmt } from './core'
import type { RemittanceSource } from './remittance-matching'

export async function matchBankPayout(env: Bindings, actor: Actor, source: RemittanceSource) {
  const bank = source.bank!
  const payloadHash = await fingerprint({ bank, amountCents: source.amountCents, receivedOn: source.receivedOn })
  const prior = await one(env, 'SELECT * FROM nc_bank_payout_matches WHERE transaction_hash=?', bank.transactionHash)
  if (prior) {
    insist(prior.payload_hash === payloadHash, 'bank_payout_source_changed', 409)
    return prior.id as string
  }
  const tokens = bank.reference.split(/[^A-Za-z0-9_-]+/)
  const payouts = await all(env, "SELECT * FROM nc_processor_objects WHERE kind='payout' AND status='paid' AND currency='usd' AND code IS NULL")
  const referenced = payouts.filter(row => tokens.includes(row.object_ref))
  const candidates = referenced
  if (!candidates.length) return null
  insist(candidates.length === 1 && candidates[0].amount_cents === source.amountCents, 'bank_payout_requires_review', 409)
  const payout = candidates[0]
  const receiptKey = await fingerprint({ kind: 'usd-remittance', receiptId: source.receiptId })
  insist(!await one(env, 'SELECT record_id FROM nc_remittance_source_keys WHERE source_key_hash=?', receiptKey), 'bank_payout_already_staged', 409)
  const id = bank.transactionHash
  const reconciled = "EXISTS(SELECT 1 FROM nc_processor_objects WHERE account_ref=? AND object_ref=? AND kind='payout' AND status='paid' AND amount_cents=? AND currency='usd' AND code IS NULL AND observed_at=?) AND (SELECT SUM(net_cents) FROM nc_processor_transactions WHERE account_ref=? AND payout_ref=? AND type<>'payout')=? AND EXISTS(SELECT 1 FROM nc_processor_transactions WHERE account_ref=? AND payout_ref=? AND type='payout' AND amount_cents=? AND occurred_at<=?)"
  await commit(env, [
    guard(env, 'bank_payout_changed', reconciled, payout.account_ref, payout.object_ref, source.amountCents, payout.observed_at, payout.account_ref, payout.object_ref, source.amountCents, payout.account_ref, payout.object_ref, -source.amountCents, Date.parse(source.receivedOn+'T23:59:59.999Z')),
    guard(env, 'bank_payout_already_matched', 'NOT EXISTS(SELECT 1 FROM nc_bank_payout_matches WHERE transaction_hash=? OR (account_ref=? AND payout_ref=?))', bank.transactionHash, payout.account_ref, payout.object_ref),
    stmt(env, 'INSERT INTO nc_bank_payout_matches(id,transaction_hash,payload_hash,account_ref,payout_ref,amount_cents,received_on,matched_by,matched_at) VALUES(?,?,?,?,?,?,?,?,?)',
      id, bank.transactionHash, payloadHash, payout.account_ref, payout.object_ref, source.amountCents, source.receivedOn, actorLabel(actor), clockInstant(env)),
  ], { actor: actorLabel(actor), action: 'bank.payout.match', subject: id, detail: { account: payout.account_ref, payout: payout.object_ref, amountCents: source.amountCents } })
  return id
}
