// An explicit owner capture observes only the installation's configured sandbox
// account. No account token enters a receipt or response.
import type { Bindings } from '../auth.server'
import { matchBankPayout } from './bank-payouts'
import { requireOwner, type Actor } from './actor'
import { all, canonical, fingerprint, insist, one, type Row } from './core'
import { requireDate } from './dates'
import { cents } from './decimal'
import { Input } from './input'
import { requireFreshFactor } from './mfa'
import { BALANCE_SQL } from './receivables'
import { remittanceSources, type RemittanceSource } from './remittance-matching'
import { confirmRemittance, previewRemittance, stageRemittances } from './remittances'

type PlaidBindings = Bindings & { PLAID_CLIENT_ID?: string; PLAID_SANDBOX_SECRET?: string; PLAID_ACCESS_TOKEN?: string; PLAID_ACCOUNT_ID?: string }
export async function capturePlaidRemittances(env: PlaidBindings, actor: Actor, input: Input) {
  requireOwner(actor); await requireFreshFactor(env, actor)
  input.only(['from','through','file','confirm','returnTo'])
  insist(input.flag('confirm'), 'confirmation_required')
  const from = requireDate(input.text('from', { max: 10 }), 'from')
  const through = requireDate(input.text('through', { max: 10 }), 'through')
  insist(from <= through, 'invalid_date_range')
  insist(env.PLAID_CLIENT_ID && env.PLAID_SANDBOX_SECRET && env.PLAID_ACCESS_TOKEN && env.PLAID_ACCOUNT_ID, 'plaid_sandbox_configuration_required', 409)
  const request = async (path: string, body: Row = {}) => {
    let response: Response, result: Row
    try {
      response = await fetch('https://sandbox.plaid.com' + path, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20000),
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: env.PLAID_CLIENT_ID, secret: env.PLAID_SANDBOX_SECRET, access_token: env.PLAID_ACCESS_TOKEN, ...body }) })
      result = await response.json() as Row
    } catch { insist(false, 'plaid_provider_unavailable', 502) }
    insist(response.ok, 'plaid_provider_unavailable', 502)
    return result
  }
  const accounts = await request('/accounts/get')
  const account = accounts.accounts?.find((row: Row) => row.account_id === env.PLAID_ACCOUNT_ID)
  insist(account && account.balances?.iso_currency_code === 'USD' && accounts.item?.item_id, 'plaid_account_mismatch', 409)
  const file = await input.file('file', { optional: true, maxBytes: 128_000 })
  const advice = file ? remittanceSources(file.bytes) : []
  const transactions: Row[] = [], seen = new Set<string>()
  let total: number | undefined
  for (let offset = 0; ; offset = transactions.length) {
    const page = await request('/transactions/get', { start_date: from, end_date: through, options: { account_ids: [env.PLAID_ACCOUNT_ID], count: 100, offset } })
    insist(Number.isSafeInteger(page.total_transactions) && page.total_transactions >= 0 && Array.isArray(page.transactions) &&
      (total === undefined || total === page.total_transactions), 'plaid_history_changed', 409)
    total = page.total_transactions
    for (const row of page.transactions) {
      insist(typeof row.transaction_id === 'string' && row.transaction_id.length <= 120 && !seen.has(row.transaction_id) &&
        row.account_id === env.PLAID_ACCOUNT_ID, 'plaid_history_changed', 409)
      seen.add(row.transaction_id); transactions.push(row)
    }
    insist(transactions.length <= total!, 'plaid_history_changed', 409)
    if (transactions.length === total) break
    insist(page.transactions.length > 0 && transactions.length < 2000, 'plaid_history_incomplete', 409)
  }
  const deposits = transactions.filter(row => row.pending === false && row.amount < 0 && row.iso_currency_code === 'USD')
  insist(advice.every(source => deposits.some(row => row.transaction_id === source.receiptId)), 'plaid_advice_source_required', 409)
  const invoices = await all(env, "SELECT i.*," + BALANCE_SQL + " AS balance_cents FROM nc_invoices i JOIN nc_customers c ON c.id=i.customer_id WHERE i.status='issued' AND i.currency='USD' AND c.erased_at IS NULL AND c.status='active'")
  const sources: { source: RemittanceSource; supplied: boolean }[] = []
  for (const row of deposits) {
    const amountCents = cents(String(-row.amount)), receivedOn = requireDate(row.date, 'received_on')
    insist(receivedOn >= from && receivedOn <= through && amountCents > 0, 'plaid_transaction_invalid', 409)
    const accountHash = await fingerprint({ item: accounts.item.item_id, account: row.account_id })
    const transactionHash = await fingerprint({ accountHash, transaction: row.transaction_id })
    const bank = { accountHash, transactionHash, reference: [row.name, row.payment_meta?.reference_number].filter(value => typeof value === 'string').join(' ').slice(0, 1000) }
    const supplied = advice.find(source => source.receiptId === row.transaction_id)
    if (supplied) insist(supplied.amountCents === amountCents && supplied.receivedOn === receivedOn, 'plaid_advice_mismatch', 409)
    const referenced = invoices.filter(invoice => bank.reference.split(/[^A-Za-z0-9-]+/).some(token => token === invoice.number))
    const sameCustomer = referenced.length && referenced.every(invoice => invoice.customer_id === referenced[0].customer_id)
    const sum = referenced.reduce((value, invoice) => value + invoice.balance_cents, 0)
    const lines = !supplied && sameCustomer && (referenced.length === 1 || sum === amountCents)
      ? referenced.map(invoice => ({ invoiceReference: invoice.number, amountCents: Math.min(invoice.balance_cents, amountCents) })).filter(line => line.amountCents > 0) : []
    sources.push({ supplied: !!supplied, source: { receiptId: 'plaid:' + transactionHash, amountCents, receivedOn, currency: 'USD',
      customerReference: supplied?.customerReference ?? (sameCustomer ? referenced[0].customer_id : ''), lines: supplied?.lines ?? lines, bank } })
  }
  const receipts: string[] = [], payouts: string[] = []
  for (const { source, supplied } of sources) {
    const payout = await matchBankPayout(env, actor, source)
    if (payout) { payouts.push(payout); continue }
    const key = await fingerprint({ kind: 'usd-remittance', receiptId: source.receiptId })
    const existing = await one(env, 'SELECT r.* FROM nc_remittance_source_keys k LEFT JOIN nc_remittances r ON r.id=k.record_id WHERE k.source_key_hash=?', key)
    let id: string
    if (existing) {
      insist(existing.id && existing.status !== 'erased', 'remittance_erased', 409)
      const original = JSON.parse(existing.source_json) as RemittanceSource
      insist(original.amountCents === source.amountCents && original.receivedOn === source.receivedOn &&
        canonical(original.bank) === canonical(source.bank), 'remittance_source_changed', 409)
      if (supplied) await stageRemittances(env, actor, [source])
      id = existing.id
    } else id = (await stageRemittances(env, actor, [source])).id
    const status = await one(env, 'SELECT status FROM nc_remittances WHERE id=?', id)
    if (status?.status === 'staged') {
      const preview = await previewRemittance(env, actor, Input.of({ receipt: id }))
      if (preview.customer && preview.allocations.length)
        await confirmRemittance(env, actor, Input.of({ receipt: id, fingerprint: preview.fingerprint, confirm: true }))
    }
    receipts.push(id)
  }
  return { receipts, payouts, deposits: sources.length }
}
