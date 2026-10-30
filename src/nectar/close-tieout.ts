// A native preparation view, never a close or an instruction to move money.
import type { Bindings } from '../auth.server'
import { requireCapability, type Actor } from './actor'
import { balanceSources } from './balance'
import { BALANCE_SQL } from './balance-sql'
import { requireBusiness } from './business'
import { clockInstant } from './clock'
import { all, fingerprint, insist, one, type Row } from './core'
import { requireUsdReporting } from './currency'
import { isMonth, localDate } from './dates'
import type { Input } from './input'
import { UNALLOCATED_SQL } from './receivables'
import { nativeRevenueContributions, revenueReport } from './revenue-reports'
import { saveAssuranceProofs } from './assurance'

export const CLOSE_CASH_KIND = 'close_unapplied_cash'
export const CLOSE_LEDGER_KIND = 'close_bad_debt_sync'
export const CLOSE_KINDS = [CLOSE_CASH_KIND, CLOSE_LEDGER_KIND]
export const CLOSE_DEFINITION = 'Current recorded native USD sources through the selected month, with their current allocations, credits, returns and posting outcomes. Later human fixes change this preparation basis. This is not a frozen historical balance, bank settlement, provider tax commitment or ledger balance certification. Cash and goodwill remain separate; cash applications are counted once from allocations. A scan only records review cases. Existing financial approval and period-close authority remain required.'

// Refuse a mixed snapshot if an ordinary writer commits while the packet is read.
export const closeSequence = async (env: Bindings) => Number((await one(env, 'SELECT COALESCE(MAX(seq),0) AS seq FROM nc_audit'))!.seq)
const sum = (rows: Row[], field: string) => {
  const result = rows.reduce((n, row) => n + BigInt(row[field] ?? 0), 0n)
  insist(result >= BigInt(Number.MIN_SAFE_INTEGER) && result <= BigInt(Number.MAX_SAFE_INTEGER), 'close_total_out_of_range', 409)
  return Number(result)
}

export async function closeTieout(env: Bindings, actor: Actor, selectedPeriod?: string) {
  requireCapability(actor, 'read')
  const configuration = await requireBusiness(env)
  const period = selectedPeriod ?? localDate(clockInstant(env), configuration.timezone).slice(0, 7)
  insist(isMonth(period), 'invalid_period')
  await requireUsdReporting(env)
  const seq = await closeSequence(env)
  const invoices = await all(env, `SELECT i.id,i.customer_id,i.number,i.issue_date,i.total_cents,i.subtotal_cents,i.tax_cents,i.source_fingerprint,
    ${BALANCE_SQL} AS balance_cents FROM nc_invoices i JOIN nc_customers c ON c.id=i.customer_id
    WHERE i.status='issued' AND i.issue_date<? AND c.erased_at IS NULL ORDER BY i.id`, `${period}-32`)
  const invoiceIds = new Set(invoices.map(row => row.id))
  const payments = await all(env, `SELECT p.id,p.customer_id,p.amount_cents,p.received_on,${UNALLOCATED_SQL} AS unallocated_cents
    FROM nc_payments p JOIN nc_customers c ON c.id=p.customer_id WHERE p.received_on<? AND c.erased_at IS NULL ORDER BY p.id`, `${period}-32`)
  const paymentIds = new Set(payments.map(row => row.id))
  // Include every application of the selected cash, including a later invoice; and
  // every payment applied to the selected debt, including cash received later.
  const allocations = (await all(env, `SELECT a.id,a.payment_id,a.invoice_id,a.amount_cents FROM nc_allocations a
    JOIN nc_payments p ON p.id=a.payment_id JOIN nc_customers c ON c.id=p.customer_id WHERE c.erased_at IS NULL ORDER BY a.id`))
    .filter(row => paymentIds.has(row.payment_id) || invoiceIds.has(row.invoice_id))
  const credits = (await all(env, 'SELECT id,invoice_id,amount_cents,COALESCE(applied_cents,amount_cents) AS applied_cents FROM nc_credit_notes ORDER BY id')).filter(row => invoiceIds.has(row.invoice_id))
  const carried = (await all(env, 'SELECT id,invoice_id,credit_id,amount_cents FROM nc_usage_credit_applications ORDER BY id')).filter(row => invoiceIds.has(row.invoice_id))
  const writeOffs = (await all(env, "SELECT id,invoice_id,amount_cents FROM nc_write_offs WHERE status='executed' ORDER BY id")).filter(row => invoiceIds.has(row.invoice_id))
  const recoveries = (await all(env, 'SELECT id,invoice_id,amount_cents FROM nc_write_off_recoveries ORDER BY id')).filter(row => invoiceIds.has(row.invoice_id))
  const reversals = (await all(env, 'SELECT id,invoice_id,amount_cents FROM nc_processor_reversals ORDER BY id')).filter(row => invoiceIds.has(row.invoice_id))
  const customers = new Set([...invoices, ...payments].map(row => row.customer_id))
  const movements = (await all(env, `SELECT b.id,b.customer_id,b.kind,b.amount_cents,b.grant_id,b.invoice_id,b.payment_id,b.created_at
    FROM nc_balance_entries b JOIN nc_customers c ON c.id=b.customer_id WHERE c.erased_at IS NULL ORDER BY b.id`))

  for (const row of movements) customers.add(row.customer_id)
  const goodwill = movements.filter(row => row.kind === 'goodwill')
  const goodwillApplied = movements.filter(row => row.kind === 'application' && row.grant_id)
  const returns = movements.filter(row => row.kind === 'return' && paymentIds.has(row.payment_id))
  const cashAllocations = allocations.filter(row => paymentIds.has(row.payment_id))
  const invoiceAllocations = allocations.filter(row => invoiceIds.has(row.invoice_id))
  const invoiceGoodwill = goodwillApplied.filter(row => invoiceIds.has(row.invoice_id))

  const debt = {
    issuedCents: sum(invoices, 'total_cents'), creditNotesCents: sum(credits, 'applied_cents'),
    allocatedCents: sum(invoiceAllocations, 'amount_cents'), carriedAppliedCents: sum(carried, 'amount_cents'),
    goodwillAppliedCents: sum(invoiceGoodwill, 'amount_cents'), writeOffCents: sum(writeOffs, 'amount_cents'),
    recoveryCents: sum(recoveries, 'amount_cents'), reversedCents: sum(reversals, 'amount_cents'), reportedCents: sum(invoices, 'balance_cents'),
  }
  const debtComputed = debt.issuedCents - debt.creditNotesCents - debt.allocatedCents - debt.carriedAppliedCents - debt.goodwillAppliedCents - debt.writeOffCents + debt.recoveryCents + debt.reversedCents
  const cash = { receivedCents: sum(payments, 'amount_cents'), allocatedCents: sum(cashAllocations, 'amount_cents'), returnedCents: sum(returns, 'amount_cents'), reportedUnappliedCents: sum(payments, 'unallocated_cents') }
  const cashComputed = cash.receivedCents - cash.allocatedCents - cash.returnedCents
  const balances = []
  for (const customer of [...customers].sort()) {
    const source = await balanceSources(env, customer)
    balances.push({ customer, goodwillCents: source.goodwillCents, carriedCents: source.carriedCents,
      carried: source.carried.map(row => ({ id: row.id, availableCents: row.availableCents })) })
  }
  const credit = { grantedCents: sum(goodwill, 'amount_cents'), appliedCents: sum(goodwillApplied, 'amount_cents'), reportedGoodwillCents: sum(balances, 'goodwillCents'), carriedCents: sum(balances, 'carriedCents') }
  const creditComputed = credit.grantedCents - credit.appliedCents
  const revenueSources = await nativeRevenueContributions(env)
  const billing = (row: Row) => row.kind === 'billing' || row.kind === 'credit-billing'
  const signed = (row: Row) => billing(row) ? row.amountCents : -row.amountCents
  const before = revenueSources.filter(row => row.period < period), during = revenueSources.filter(row => row.period === period)
  const revenue = {
    openingCents: sum(before.map(row => ({ amount: signed(row) })), 'amount'),
    netBillingsCents: sum(during.filter(billing), 'amountCents'),
    recognizedCents: sum(during.filter(row => !billing(row)), 'amountCents'),
    closingCents: sum(revenueSources.filter(row => row.period <= period).map(row => ({ amount: signed(row) })), 'amount'),
  }
  const reported = (await revenueReport(env, actor, new URL(`https://nectar.invalid/?period=${period}`), { nativeActiveOnly: true })).months[0]
  const ledger = (await all(env, `SELECT l.id,l.kind,l.invoice_id,l.customer_id,l.amount_cents,l.status,l.error_code,l.external_ref,l.attempts,l.entries_json
    FROM nc_ledger_postings l JOIN nc_customers c ON c.id=l.customer_id WHERE c.erased_at IS NULL AND l.kind IN ('bad_debt','bad_debt_recovery') ORDER BY l.id`)).filter(row => invoiceIds.has(row.invoice_id))
  const proofs: Row[] = []
  for (const payment of payments) {
    const proof = { kind: CLOSE_CASH_KIND, source: `close:${period}:cash:${payment.id}`, period, customer: payment.customer_id,
      payment: payment.id, amountCents: payment.amount_cents, unappliedCents: payment.unallocated_cents,
      allocations: cashAllocations.filter(row => row.payment_id === payment.id), returns: returns.filter(row => row.payment_id === payment.id),
      category: 'review', cause: 'Recorded received cash is not fully allocated or returned. This is not a failed synchronization.',
      proposedFix: 'An authorized person reviews the received funds and uses the ordinary allocation or governed cash-return door.',
      href: `/app/payments/${payment.id}/receipt`, fixHref: '/app/receivables', mismatch: payment.unallocated_cents > 0 }
    proofs.push({ ...proof, basis: await fingerprint(proof) })
  }
  for (const posting of ledger) {
    const proof = { kind: CLOSE_LEDGER_KIND, source: `close:${period}:ledger:${posting.id}`, period, customer: posting.customer_id,
      posting: posting.id, invoice: posting.invoice_id, amountCents: posting.amount_cents, status: posting.status,
      error: posting.error_code, ledgerRef: posting.external_ref, attempts: posting.attempts,
      category: 'synchronization_failure', cause: 'The existing bad-debt journal has not been synchronized. It is not an unsynced credit note.',
      proposedFix: 'An authorized person repairs the ledger connection and retries this existing journal through its ordinary posting door.',
      href: `/app/invoices/${posting.invoice_id}#write-offs`, fixHref: `/app/invoices/${posting.invoice_id}#write-offs`, mismatch: posting.status !== 'posted' }
    proofs.push({ ...proof, basis: await fingerprint(proof) })
  }
  const totals = { debt: { ...debt, computedCents: debtComputed, differenceCents: debtComputed - debt.reportedCents },
    cash: { ...cash, computedUnappliedCents: cashComputed, differenceCents: cashComputed - cash.reportedUnappliedCents },
    credit: { ...credit, computedGoodwillCents: creditComputed, differenceCents: creditComputed - credit.reportedGoodwillCents },
    revenue: { ...revenue, differenceCents: revenue.closingCents - reported.closingCents, rollforwardDifferenceCents: revenue.openingCents + revenue.netBillingsCents - revenue.recognizedCents - revenue.closingCents } }
  const coverage = [
    { area: 'Invoice debt, received cash and allocations', state: 'native_sources', detail: 'Issued invoices and received payments dated through this month, using current reductions and allocations.' },
    { area: 'Customer credit movements', state: 'native_sources', detail: 'Current goodwill grants and applications, recorded cash returns and available carried correction credit. Cash application entries are not counted twice.' },
    { area: 'Revenue roll-forward', state: 'native_sources', detail: 'Active native issued schedules and credit contributions with existing closed-period adjustments. Imported and erased sources are excluded.' },
    { area: 'Bad-debt journal synchronization', state: 'limited', detail: 'Only existing bad-debt and recovery journal outcomes. No live ledger balance or credit-note synchronization qualification.' },
    { area: 'Payouts and processor fees', state: 'not_covered', detail: 'Complete payout and fee reconciliation remains unqualified.' },
    { area: 'Provider tax commitments', state: 'not_covered', detail: 'Native declared tax is not provider commitment proof.' },
    { area: 'Connectors, entities and currencies', state: 'limited', detail: 'USD native preparation only. Complete connector and entity qualification and other currencies remain required.' },
  ]
  const invoiceLink = (row: Row) => ({ ...row, href: `/api/nectar/invoices/${row.invoice_id}` })
  const sources = {
    invoices: invoices.map((row): Row => ({ ...row, href: `/api/nectar/invoices/${row.id}` })),
    payments: payments.map((row): Row => ({ ...row, href: `/api/nectar/payments/${row.id}/receipt` })),
    allocations: allocations.map(row => ({ ...row, href: `/api/nectar/payments/${row.payment_id}/receipt` })), credits: credits.map(invoiceLink), carried: carried.map(invoiceLink),
    writeOffs: writeOffs.map(invoiceLink), recoveries: recoveries.map(invoiceLink), reversals: reversals.map(invoiceLink),
    movements: movements.map(row => ({ ...row, href: `/api/nectar/customers/${row.customer_id}/balance` })),
    balances: balances.map(row => ({ ...row, href: `/api/nectar/customers/${row.customer}/balance` })),
    revenue: revenueSources.map(({ customerName: _name, entityName: _entity, ...row }) => row), ledger }
  const basis = await fingerprint({ period, definition: CLOSE_DEFINITION, sources, totals, coverage })
  insist(await closeSequence(env) === seq, 'close_source_changed', 409)
  return { period, currency: 'USD', definition: CLOSE_DEFINITION, basis, totals, coverage, sources, proofs }
}

export async function scanCloseTieout(env: Bindings, actor: Actor, input: Input) {
  requireCapability(actor, 'read')
  requireCapability(actor, 'propose')
  const period = input.text('period', { max: 7 }), basis = input.text('basis', { max: 64 }), owner = input.text('owner', { max: 100 })
  const seq = await closeSequence(env), packet = await closeTieout(env, actor, period)
  insist(packet.basis === basis, 'close_source_changed', 409)
  return await saveAssuranceProofs(env, actor, packet.proofs, owner, period, seq, CLOSE_KINDS, 'close.scan')
}
