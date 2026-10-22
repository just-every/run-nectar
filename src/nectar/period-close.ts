// REV-002: finance closes a month. Closing freezes the month's contribution
// keys, its roll-forward, journals and the billings, collections and revenue
// reports into one immutable packet, and saves one summarized journal per
// ledger company for the posting queue. Contributions arriving later for a
// closed month are reported in the earliest open month (period-close-keys.ts).
import type { Bindings } from '../auth.server'
import { actorLabel, requireMember, requireRead, type Actor } from './actor'
import { requireBusiness } from './business'
import { clockInstant } from './clock'
import { all, canonical, commit, fingerprint, guard, insist, newId, one, parseJson, stmt, type Row } from './core'
import { addDays, addMonths, isMonth, localDate } from './dates'
import type { Input } from './input'
import { ledgerPostingView, postingStatement, postLedgerEntry, type PostingSeed } from './ledger-postings'
import { defaultCompany, type JournalLine } from './ledger/quickbooks'
import { requireFreshFactor } from './mfa'
import { closedPeriods, contributionKey, nextMonth } from './period-close-keys'
import { report } from './reports'
import { revenueJournal } from './revenue-journal'
import { revenueReport } from './revenue-reports'

const ACCOUNTS: Record<string, string> = { 'pretax-billings-clearing': 'Billings Clearing', 'accrued-contract-assets': 'Contract Assets', 'deferred-revenue': 'Deferred Revenue', 'recognized-revenue': 'Revenue' }
const query = (params: Record<string, string>) => new URL(`https://nectar.invalid/?${new URLSearchParams(params)}`)

/** The books of one ledger company: the installation business and each billing entity. Imported history is closed in the packet but has no issuer to post for. */
async function journals(env: Bindings, actor: Actor, period: string) {
  const entities = await all(env, 'SELECT id,legal_name,ledger_company_ref FROM nc_billing_entities ORDER BY legal_name,id')
  const books = [{ key: 'business', entityId: null as string | null, name: 'Installation business', companyRef: defaultCompany(env) }, ...entities.map(row => ({ key: row.id as string, entityId: row.id as string, name: row.legal_name as string, companyRef: row.ledger_company_ref as string | null }))]
  const result = []
  for (const book of books) {
    const journal = await revenueJournal(env, actor, query({ period, entity: book.key }))
    const month = journal.periods[0]
    const entries = journal.entries.map(entry => ({ account: entry.account, debitCents: entry.debitCents, creditCents: entry.creditCents }))
    if (entries.length) result.push({ ...book, entries, debitCents: month.debitCents, creditCents: month.creditCents })
  }
  return result
}

export async function closePeriod(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'approve')
  await requireFreshFactor(env, actor)
  const period = input.text('period', { max: 7 })
  insist(isMonth(period), 'invalid_period')
  const business = await requireBusiness(env), current = localDate(clockInstant(env), business.timezone).slice(0, 7)
  insist(period < current, 'period_not_ended', 409)
  const closed = await closedPeriods(env)
  insist(!closed.through || period === nextMonth(closed.through), closed.through && period <= closed.through ? 'period_already_closed' : 'period_out_of_order', 409)
  const overall = await revenueReport(env, actor, query({ period }))
  const keys = overall.contributions.filter(row => row.period === period).map(contributionKey).sort()
  const month = overall.months[0]
  const books = await journals(env, actor, period)
  insist(books.every(book => book.debitCents === book.creditCents), 'revenue_journal_unbalanced', 409)
  // Opaque source ids and amounts only: names and payment references stay erasable (GOV-005).
  const reports = {} as Record<string, { totalCents: number; entries: { source: string; amountCents: number }[] }>
  for (const metric of ['billings', 'collections']) {
    const view = await report(env, actor, metric, query({ period }))
    reports[metric] = { totalCents: view.totalCents, entries: view.entries.map(entry => ({ source: entry.invoiceId, amountCents: entry.amountCents })) }
  }
  const id = newId(), at = clockInstant(env)
  const packet = { period, closedAt: at, closedBy: actorLabel(actor), policyVersion: overall.policyVersion, rollforward: { openingCents: month.openingCents, billingsCents: month.billingsCents, creditsCents: month.creditsCents, netBillingsCents: month.netBillingsCents, recognizedCents: month.recognizedCents, closingCents: month.closingCents, accruedContractAssetCents: month.accruedContractAssetCents, deferredLiabilityCents: month.deferredLiabilityCents },
    journals: books.map(({ key, name, entries, debitCents, creditCents }) => ({ book: key, name, entries, debitCents, creditCents })), reports, contributions: keys.length }
  insist(BigInt(month.openingCents) + BigInt(month.netBillingsCents) - BigInt(month.recognizedCents) === BigInt(month.closingCents), 'revenue_rollforward_mismatch', 409)
  const date = addDays(addMonths(`${period}-01`, 1), -1)
  const postings: PostingSeed[] = books.map((book, index) => {
    const lines: JournalLine[] = book.entries.map(entry => ({ side: entry.debitCents ? 'debit' : 'credit', account: ACCOUNTS[entry.account], amountCents: entry.debitCents || entry.creditCents }))
    return { id: newId(), kind: 'period_close', sourceId: `${id}:${book.key}`, period, txnDate: date, entityId: book.entityId, companyRef: book.companyRef, amountCents: book.debitCents, lines, docNumber: `PC-${period}-${book.entityId ? book.entityId.slice(0, 8) : 'BUSINESS'}`.slice(0, 21) }
  })
  await commit(env, [
    guard(env, 'period_out_of_order', closed.through ? 'NOT EXISTS(SELECT 1 FROM nc_period_closes WHERE period>=?)' : 'NOT EXISTS(SELECT 1 FROM nc_period_closes)', ...(closed.through ? [period] : [])),
    guard(env, 'forbidden', "EXISTS(SELECT 1 FROM nc_members WHERE id=? AND status='active')", actor.id),
    stmt(env, 'INSERT INTO nc_period_closes(id,period,closed_by_id,closed_by,closed_at,keys_json,keys_hash,packet_json,packet_hash) VALUES(?,?,?,?,?,?,?,?,?)', id, period, actor.id, actorLabel(actor), at, JSON.stringify(keys), await fingerprint(keys), canonical(packet), await fingerprint(packet)),
    ...postings.map(seed => postingStatement(env, seed)),
  ], { actor: actorLabel(actor), action: 'revenue.close', subject: id, detail: { period, contributions: keys.length, rollforward: packet.rollforward, journals: packet.journals.map(book => [book.book, book.debitCents]) } })
  const posted = []
  for (const seed of postings) posted.push(await postLedgerEntry(env, actor, seed.id))
  return { id, period, rollforward: packet.rollforward, postings: posted.map(row => ({ id: row.id, entity: row.entity, status: row.status, error: row.error })) }
}

/** Closed months and their frozen packets; one month with `id` set to it. */
export async function periodCloses(env: Bindings, actor: Actor, period?: string) {
  requireRead(actor, 'reports')
  const rows = await all(env, `SELECT * FROM nc_period_closes ${period ? 'WHERE period=?' : ''} ORDER BY period`, ...(period ? [period] : []))
  insist(!period || rows.length, 'period_not_closed', 404)
  const postings = (await all(env, "SELECT * FROM nc_ledger_postings WHERE kind='period_close' ORDER BY created_at,id")).map(ledgerPostingView)
  const closed = await closedPeriods(env)
  return { through: closed.through, open: closed.open, closes: rows.map((row: Row) => ({ id: row.id, period: row.period, closedBy: row.closed_by, closedAt: row.closed_at, packetHash: row.packet_hash, keysHash: row.keys_hash,
    packet: parseJson<Row>(row.packet_json, {}), postings: postings.filter(posting => posting.period === row.period) })) }
}
