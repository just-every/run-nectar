// The ledger posting queue (AR-004): every bad-debt write-off and recovery saves
// its balanced journal entry in the same transaction as the receivable fact,
// then posts it to the connected ledger. A failed or unconfigured post never
// rolls back the fact; it stays pending with its error code until a person
// retries it, and re-posting adopts an entry the ledger already recorded.
import type { Bindings } from '../auth.server'
import { actorLabel, requireMember, requireRead, type Actor } from './actor'
import { requireBusiness } from './business'
import { all, commit, insist, NectarError, one, parseJson, stmt, type Row } from './core'
import { clockInstant } from './clock'
import { localDate } from './dates'
import { defaultCompany, postJournalEntry, type JournalLine } from './ledger/quickbooks'
import type { Input } from './input'

export interface PostingSeed { id: string; kind: 'bad_debt' | 'bad_debt_recovery' | 'period_close'; sourceId: string; writeOffId?: string; invoiceId?: string; customerId?: string; period?: string; txnDate?: string; entityId: string | null; companyRef: string | null; amountCents: number; lines: JournalLine[]; docNumber: string }

export const postingStatement = (env: Bindings, seed: PostingSeed) => stmt(env,
  "INSERT INTO nc_ledger_postings(id,kind,source_id,write_off_id,invoice_id,customer_id,period,txn_date,entity_id,company_ref,amount_cents,entries_json,doc_number,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)",
  seed.id, seed.kind, seed.sourceId, seed.writeOffId ?? null, seed.invoiceId ?? null, seed.customerId ?? null, seed.period ?? null, seed.txnDate ?? null, seed.entityId, seed.companyRef, seed.amountCents, JSON.stringify(seed.lines), seed.docNumber, clockInstant(env))

export const ledgerPostingView = (row: Row) => ({ id: row.id, kind: row.kind, writeOff: row.write_off_id, invoice: row.invoice_id, customer: row.customer_id, period: row.period, entity: row.entity_id, companyRef: row.company_ref,
  amountCents: row.amount_cents, entries: parseJson<JournalLine[]>(row.entries_json, []), docNumber: row.doc_number, status: row.status, ledgerRef: row.external_ref, attempts: row.attempts, error: row.error_code, createdAt: row.created_at, postedAt: row.posted_at })
export type LedgerPosting = ReturnType<typeof ledgerPostingView>

export async function ledgerPostings(env: Bindings, actor: Actor, invoiceId?: string): Promise<LedgerPosting[]> {
  requireRead(actor, 'invoices')
  return (await all(env, `SELECT * FROM nc_ledger_postings ${invoiceId ? 'WHERE invoice_id=?' : ''} ORDER BY created_at,id`, ...(invoiceId ? [invoiceId] : []))).map(ledgerPostingView)
}

/** One attempt per pending posting; the outcome is recorded either way. Returns the stored posting. */
export async function postLedgerEntry(env: Bindings, actor: Actor, id: string): Promise<LedgerPosting> {
  const row = await one(env, 'SELECT * FROM nc_ledger_postings WHERE id=?', id)
  insist(row, 'ledger_posting_not_found', 404)
  if (row.status === 'posted') return ledgerPostingView(row)
  const business = await requireBusiness(env)
  const customer = row.customer_id ? await one(env, 'SELECT name FROM nc_customers WHERE id=?', row.customer_id) : null
  let outcome: { ref: string } | { error: string }
  try {
    const companyRef = row.company_ref ?? defaultCompany(env)
    insist(companyRef, 'ledger_company_missing', 409)
    outcome = { ref: await postJournalEntry(env, { companyRef, docNumber: row.doc_number, requestId: row.id, date: row.txn_date ?? localDate(row.created_at, business.timezone),
      memo: `Nectar ${({ bad_debt: 'bad debt write-off', bad_debt_recovery: 'bad debt recovery', period_close: 'period close' } as Record<string, string>)[row.kind]} ${row.doc_number}`, customerName: customer?.name ?? '', lines: parseJson<JournalLine[]>(row.entries_json, []) }) }
  } catch (error) {
    if (!(error instanceof NectarError)) throw error
    outcome = { error: error.code }
  }
  const at = clockInstant(env), done = 'ref' in outcome ? outcome : null, failed = 'error' in outcome ? outcome : null
  await commit(env, [done
    ? stmt(env, "UPDATE nc_ledger_postings SET status='posted',external_ref=?,posted_at=?,attempts=attempts+1,error_code=NULL WHERE id=? AND status='pending'", done.ref, at, id)
    : stmt(env, "UPDATE nc_ledger_postings SET attempts=attempts+1,error_code=? WHERE id=? AND status='pending'", failed!.error, id)],
    { actor: actorLabel(actor), action: 'ledger.post', subject: id, detail: { kind: row.kind, docNumber: row.doc_number, writeOff: row.write_off_id, ...(done ? { ledgerRef: done.ref } : { error: failed!.error }) } })
  return ledgerPostingView((await one(env, 'SELECT * FROM nc_ledger_postings WHERE id=?', id))!)
}

/** The error queue's retry door: every pending posting, or one named posting. */
export async function postPendingLedger(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'approve')
  const ids = input.has('posting') ? [input.text('posting', { max: 100 })] : (await all(env, "SELECT id FROM nc_ledger_postings WHERE status='pending' ORDER BY created_at,id")).map(row => row.id)
  const postings: LedgerPosting[] = []
  for (const id of ids) postings.push(await postLedgerEntry(env, actor, id))
  return { postings }
}
