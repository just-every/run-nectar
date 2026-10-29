// Explicit finance observations of exact native credit notes in QuickBooks.
// Scans consume saved evidence and never initiate a provider read or write.
import type { Bindings } from '../auth.server'
import { actorLabel, requireCapability, requireMember, type Actor } from './actor'
import { clockInstant } from './clock'
import { all, commit, fingerprint, guard, insist, NectarError, one, parseJson, stmt, type Row } from './core'
import { cents } from './decimal'
import type { Input } from './input'
import { defaultCompany, ledgerQuery, quoted } from './ledger/quickbooks'
import { requireFreshFactor } from './mfa'
import { closeSequence, closeTieout } from './close-tieout'

export const CLOSE_CREDIT_KIND = 'close_credit_note_sync'
export const creditMarker = (credit: string, invoice: string) => `Nectar credit ${credit} for invoice ${invoice}`

export async function closeCreditSources(env: Bindings, invoiceIds: Set<string>) {
  const sources: Row[] = []
  for (const row of await all(env, `SELECT n.id,n.number,n.invoice_id,n.customer_id,n.amount_cents,n.currency,n.billing_entity_id,n.billing_route_json,
    c.name AS customer_name,c.revision AS customer_revision FROM nc_credit_notes n JOIN nc_customers c ON c.id=n.customer_id
    WHERE c.erased_at IS NULL ORDER BY n.id`)) {
    if (!invoiceIds.has(row.invoice_id)) continue
    const route = parseJson<Row>(row.billing_route_json, {})
    const company = row.billing_entity_id ? route.ledgerCompanyRef ?? null : defaultCompany(env)
    const sourceBasis = await fingerprint({ credit: row.id, number: row.number, invoice: row.invoice_id, customer: row.customer_id, customerRevision: row.customer_revision, amountCents: row.amount_cents, currency: row.currency, company })
    const observed = await one(env, 'SELECT * FROM nc_close_credit_observations WHERE credit_id=?', row.id)
    const current = observed?.basis_hash === sourceBasis
    sources.push({ id: row.id, number: row.number, invoice: row.invoice_id, customer: row.customer_id, amountCents: row.amount_cents, currency: row.currency, company,
      sourceBasis, status: current ? observed.status : 'unobserved', ledgerRef: current ? observed.external_ref : null,
      observedCents: current ? observed.observed_cents : null, observedCurrency: current ? observed.currency : null,
      error: current ? observed.error_code : null, href: `/api/nectar/invoices/${row.invoice_id}` })
  }
  return sources
}

export async function observeCloseCredits(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'approve')
  requireCapability(actor, 'read')
  await requireFreshFactor(env, actor)
  const period = input.text('period', { max: 7 }), basis = input.text('basis', { max: 64 })
  const seq = await closeSequence(env), packet = await closeTieout(env, actor, period)
  insist(packet.basis === basis, 'close_source_changed', 409)
  const statements: D1PreparedStatement[] = [guard(env, 'close_source_changed', '(SELECT COALESCE(MAX(seq),0) FROM nc_audit)=?', seq),
    guard(env, 'authority', "EXISTS(SELECT 1 FROM nc_members WHERE id=? AND status='active' AND role IN ('owner','finance'))", actor.id)]
  const observations = []
  for (const source of packet.sources.creditSync) {
    let status = 'missing', reference: string | null = null, observedCents: number | null = null, currency: string | null = null, error: string | null = null
    try {
      insist(source.currency === 'USD' && source.company, 'ledger_credit_source_unsupported', 409)
      const query = ledgerQuery(env, source.company)
      const customer = await one(env, 'SELECT name FROM nc_customers WHERE id=? AND erased_at IS NULL', source.customer)
      insist(customer, 'customer_not_found', 404)
      const customers = await query(`select Id, DisplayName from Customer where DisplayName = ${quoted(customer.name)}`, 'Customer')
      insist(customers.length === 1 && typeof customers[0].Id === 'string', 'ledger_customer_missing', 409)
      const rows = await query(`select * from CreditMemo where DocNumber = ${quoted(source.number)}`, 'CreditMemo')
      if (rows.length) {
        const memo = rows[0]
        status = 'mismatch'
        if (rows.length === 1 && typeof memo.Id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(memo.Id)) {
          reference = memo.Id
          observedCents = cents(String(memo.TotalAmt))
          currency = memo.CurrencyRef?.value === 'USD' ? 'USD' : null
          if (memo.DocNumber === source.number && memo.PrivateNote === creditMarker(source.id, source.invoice)
            && memo.CustomerRef?.value === customers[0].Id && observedCents === source.amountCents && currency === source.currency) status = 'synced'
        }
      }
    } catch (caught) {
      if (!(caught instanceof NectarError)) throw caught
      status = 'unavailable'; error = caught.code
    }
    statements.push(stmt(env, `INSERT INTO nc_close_credit_observations(credit_id,customer_id,invoice_id,company_ref,basis_hash,status,external_ref,observed_cents,currency,error_code,observed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(credit_id) DO UPDATE SET company_ref=excluded.company_ref,basis_hash=excluded.basis_hash,status=excluded.status,external_ref=excluded.external_ref,observed_cents=excluded.observed_cents,currency=excluded.currency,error_code=excluded.error_code,observed_at=excluded.observed_at`,
      source.id, source.customer, source.invoice, source.company ?? '', source.sourceBasis, status, reference, observedCents, currency, error, clockInstant(env)))
    observations.push({ credit: source.id, status, error })
  }
  await commit(env, statements, { actor: actorLabel(actor), action: 'close.credits.observe', subject: period, detail: { basis, observations } })
  return { observations }
}
