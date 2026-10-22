// The QuickBooks Online edge for journal entries. The origin is fixed by the
// installation's environment setting; the access token is an installation
// secret, never stored in these records. Connection grant and refresh belong to
// BOOK-001. Every write carries the posting id as QuickBooks' request id, and a
// lost response is recovered by reading the entry back by its document number.
import type { Bindings } from '../../auth.server'
import { insist, NectarError } from '../core'

export const BAD_DEBT_ACCOUNT = 'Bad Debts'
export const RECEIVABLE_ACCOUNT = 'Accounts Receivable (A/R)'
export interface JournalLine { side: 'debit' | 'credit'; account: string; amountCents: number; customer?: boolean }
export interface JournalEntry { companyRef: string; docNumber: string; requestId: string; date: string; memo: string; customerName: string; lines: JournalLine[] }

const ORIGINS: Record<string, string> = { sandbox: 'https://sandbox-quickbooks.api.intuit.com', production: 'https://quickbooks.api.intuit.com' }
const quoted = (value: string) => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`

/** The company a posting goes to: the entity's recorded company, else the installation's single company. */
export const defaultCompany = (env: Bindings) => env.QUICKBOOKS_COMPANY_ID?.trim() || null

export async function postJournalEntry(env: Bindings, entry: JournalEntry): Promise<string> {
  const { QUICKBOOKS_ACCESS_TOKEN: token, QUICKBOOKS_ENVIRONMENT: environment } = env
  insist(token?.trim() && environment && ORIGINS[environment!], 'ledger_not_configured', 409)
  insist(/^[A-Za-z0-9_.:-]{1,60}$/.test(entry.companyRef), 'ledger_company_invalid', 409)
  const base = `${ORIGINS[environment!]}/v3/company/${encodeURIComponent(entry.companyRef)}`
  const call = async (path: string, body?: unknown) => {
    let response: Response
    try {
      response = await fetch(`${base}${path}`, { method: body ? 'POST' : 'GET', redirect: 'manual', signal: AbortSignal.timeout(20000),
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    } catch { throw new NectarError('ledger_unavailable', 502) }
    let result: any
    try { result = await response.json() } catch { throw new NectarError('ledger_unavailable', 502) }
    if (response.status === 401 || response.status === 403) throw new NectarError('ledger_unauthorized', 502)
    if (!response.ok) throw new NectarError(response.status >= 500 || response.status === 429 ? 'ledger_unavailable' : 'ledger_rejected', 502)
    return result
  }
  const query = async (statement: string, kind: string): Promise<any[]> => {
    const result = await call(`/query?${new URLSearchParams({ query: statement, minorversion: '75' })}`)
    const rows = result?.QueryResponse?.[kind]
    return Array.isArray(rows) ? rows : []
  }
  // A prior attempt may have been recorded although its response was lost.
  const prior = await query(`select Id, DocNumber from JournalEntry where DocNumber = ${quoted(entry.docNumber)}`, 'JournalEntry')
  if (prior.length) {
    insist(prior.length === 1 && typeof prior[0].Id === 'string', 'ledger_ambiguous', 409)
    return prior[0].Id
  }
  const accounts = new Map<string, string>()
  for (const name of new Set(entry.lines.map(line => line.account))) {
    const found = await query(`select Id, Name from Account where Name = ${quoted(name)}`, 'Account')
    insist(found.length === 1 && typeof found[0].Id === 'string', 'ledger_account_missing', 409)
    accounts.set(name, found[0].Id)
  }
  const named = entry.lines.some(line => line.customer)
  const customers = named ? await query(`select Id, DisplayName from Customer where DisplayName = ${quoted(entry.customerName)}`, 'Customer') : []
  insist(!named || customers.length === 1 && typeof customers[0].Id === 'string', 'ledger_customer_missing', 409)
  const created = await call(`/journalentry?${new URLSearchParams({ minorversion: '75', requestid: entry.requestId })}`, {
    DocNumber: entry.docNumber, TxnDate: entry.date, PrivateNote: entry.memo,
    Line: entry.lines.map(line => ({
      Description: entry.memo, Amount: line.amountCents / 100, DetailType: 'JournalEntryLineDetail',
      JournalEntryLineDetail: { PostingType: line.side === 'debit' ? 'Debit' : 'Credit', AccountRef: { value: accounts.get(line.account) },
        ...(line.customer ? { Entity: { Type: 'Customer', EntityRef: { value: customers[0].Id } } } : {}) },
    })),
  })
  const id = created?.JournalEntry?.Id
  insist(typeof id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(id) && created.JournalEntry.DocNumber === entry.docNumber, 'ledger_unconfirmed', 502)
  return id
}
