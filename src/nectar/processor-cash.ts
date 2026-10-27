// Applies already-received customer cash; never authorizes a bank debit.
// Stripe manual reconciliation: https://docs.stripe.com/payments/customer-balance/reconciliation
import type { Bindings } from '../auth.server'
import type { Actor } from './actor'
import { BALANCE_SQL } from './balance-sql'
import { requireBusiness } from './business'
import { clockInstant } from './clock'
import { all, canonical, commit, guard, insist, NectarError, newId, one, stmt, type Row } from './core'
import { localDate } from './dates'
import { nativeCollectionSource, nativeSourceGuard } from './payments/source'
import { NativeStripeError, providerReference, stripeForAccount, type StripeClient } from './payments/stripe'
import { collectedPaymentStatements } from './receivables'
import { importedCashCandidates, importedCashSource, importedCashClaimStatements, importedCashSettlementStatements } from './processor-cash-imported'

export interface ProcessorCashApplication {
  id: string; invoice: string; transferRef: string; amountCents: number; currency: string
  status: 'uncertain' | 'collected'; paymentIntentRef: string | null; chargeRef: string | null
  payment: string | null; allocation: string | null
}
export interface ProcessorCashResult {
  availableCents: number; availableByCurrency: Record<string, number>; transactions: Row[]
  applications: ProcessorCashApplication[]
  unmatched: { transferRef: string; amountCents: number; currency: string; reference: string; reason: string }[]
}
const invalid = 'processor_cash_evidence_invalid'
const system: Actor = { id: 'processor-cash', kind: 'agent', name: 'processor-cash', email: '', role: null, sessionId: null, capabilities: new Set(['receivables']) }
const applicationView = (r: Row): ProcessorCashApplication => ({ id: r.id, invoice: r.invoice_id, transferRef: r.transfer_ref,
  amountCents: r.amount_cents, currency: r.currency, status: r.status, paymentIntentRef: r.payment_intent_ref,
  chargeRef: r.charge_ref, payment: r.payment_id, allocation: r.allocation_id })

/** All pages or an error. A partial provider history cannot authorize cash. */
async function history(stripe: StripeClient, path: string): Promise<Row[]> {
  const rows: Row[] = [], seen = new Set<string>()
  let cursor = ''
  for (;;) {
    const params = new URLSearchParams({ limit: '100', ...(cursor ? { starting_after: cursor } : {}) })
    const page = await stripe(`${path}${path.includes('?') ? '&' : '?'}${params}`)
    insist(page.object === 'list' && Array.isArray(page.data) && typeof page.has_more === 'boolean', 'processor_cash_history_incomplete', 409)
    for (const row of page.data as Row[]) {
      const id = providerReference(row.id)
      insist(!seen.has(id), 'processor_cash_history_incomplete', 409)
      seen.add(id); rows.push(row)
    }
    if (!page.has_more) return rows
    insist(page.data.length > 0, 'processor_cash_history_incomplete', 409)
    cursor = providerReference(page.data.at(-1).id)
  }
}
async function binding(env: Bindings, account: string, customer: Row) {
  insist(customer.account_ref === account, 'processor_cash_binding_mismatch', 409)
  const row = await one(env, `SELECT b.*,c.currency FROM nc_stripe_customer_bindings b JOIN nc_customers c ON c.id=b.customer_id
    WHERE b.customer_id=? AND b.account_ref=? AND b.stripe_customer_ref=? AND c.status='active' AND c.erased_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(b.id,c.id))`, customer.customer_id, account, customer.stripe_customer_ref)
  insist(row, 'processor_cash_binding_required', 409)
  return row
}
function bindingGuard(env: Bindings, b: Row) {
  return guard(env, 'processor_cash_binding_changed', `EXISTS(SELECT 1 FROM nc_stripe_customer_bindings b JOIN nc_customers c ON c.id=b.customer_id
    WHERE b.id=? AND b.customer_id=? AND b.account_ref=? AND b.stripe_customer_ref=? AND b.revision=? AND c.status='active' AND c.erased_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(?,?))`, b.id, b.customer_id, b.account_ref, b.stripe_customer_ref, b.revision, b.id, b.customer_id)
}
async function snapshot(stripe: StripeClient, customerRef: string, livemode: boolean) {
  const [cash, transactions] = await Promise.all([
    stripe(`/customers/${encodeURIComponent(customerRef)}/cash_balance`),
    history(stripe, `/customers/${encodeURIComponent(customerRef)}/cash_balance_transactions`),
  ])
  insist(cash.object === 'cash_balance' && providerReference(cash.customer) === customerRef && cash.livemode === livemode
    && cash.settings?.reconciliation_mode === 'manual', 'processor_cash_manual_reconciliation_required', 409)
  const available = (cash.available ?? {}) as Record<string, number>
  insist(typeof available === 'object' && !Array.isArray(available) && Object.entries(available).every(([currency, amount]) =>
    /^[a-z]{3}$/.test(currency) && Number.isSafeInteger(amount) && amount >= 0), invalid, 409)
  for (const t of transactions) insist(t.object === 'customer_cash_balance_transaction' && providerReference(t.customer) === customerRef
    && t.livemode === livemode && /^[a-z]{3}$/.test(t.currency) && Number.isSafeInteger(t.net_amount)
    && Number.isSafeInteger(t.created) && t.created > 0 && Number.isSafeInteger(t.ending_balance), invalid, 409)
  return { available, transactions }
}
/** Cash is pooled by Stripe. Track consumed funding oldest first; unknown
 * credits remain separate lots and never become newly matchable transfers. */
function fundingLots(transactions: Row[], available: Record<string, number>) {
  const lots: { transaction: Row; remaining: number }[] = [], totals: Record<string, number> = {}
  for (const transaction of [...transactions].reverse()) {
    const { currency, net_amount: amount } = transaction
    totals[currency] = (totals[currency] ?? 0) + amount
    if (amount > 0) lots.push({ transaction, remaining: amount })
    else {
      let debit = -amount
      for (const lot of lots) if (lot.transaction.currency === currency) {
        const taken = Math.min(lot.remaining, debit); lot.remaining -= taken; debit -= taken
      }
      insist(debit === 0, 'processor_cash_history_incomplete', 409)
    }
    insist(totals[currency] === transaction.ending_balance, 'processor_cash_history_changed', 409)
  }
  for (const currency of new Set([...Object.keys(totals), ...Object.keys(available)])) {
    insist((totals[currency] ?? 0) === (available[currency] ?? 0), 'processor_cash_history_changed', 409)
  }
  return lots.filter(lot => lot.transaction.type === 'funded' && lot.remaining > 0)
}
function verifyIntent(intent: Row, row: Row, livemode: boolean) {
  insist(intent.object === 'payment_intent' && providerReference(intent.customer) === row.stripe_customer_ref && intent.livemode === livemode
    && intent.amount === row.amount_cents && intent.currency === row.currency && intent.metadata?.[row.source_kind==='imported'?'nectar_imported_invoice':'nectar_native_invoice'] === row.invoice_id
    && intent.metadata?.nectar_cash_application === row.id && intent.metadata?.nectar_cash_transfer === row.transfer_ref
    && Array.isArray(intent.payment_method_types) && intent.payment_method_types.length === 1 && intent.payment_method_types[0] === 'customer_balance'
    && (!row.payment_intent_ref || intent.id === row.payment_intent_ref), invalid, 409)
  return providerReference(intent.id)
}
async function settle(env: Bindings, stripe: StripeClient, b: Row, row: Row, intent: Row, livemode: boolean) {
  const intentRef = verifyIntent(intent, row, livemode)
  if (!row.payment_intent_ref) {
    const table=row.source_kind==='imported'?'nc_processor_cash_imported_applications':'nc_processor_cash_applications'
    await commit(env, [bindingGuard(env, b), stmt(env, `UPDATE ${table} SET payment_intent_ref=? WHERE id=? AND payment_intent_ref IS NULL`, intentRef, row.id)], [])
    row.payment_intent_ref = intentRef
  }
  if (intent.status !== 'succeeded') return
  insist(intent.amount_received === row.amount_cents && intent.amount_capturable === 0, invalid, 409)
  const charges = await history(stripe, `/charges?${new URLSearchParams({ payment_intent: intentRef })}`)
  const captured = charges.filter(charge => charge.status === 'succeeded' && charge.paid === true && charge.captured === true)
  insist(captured.length === 1, invalid, 409)
  const charge = captured[0], chargeRef = providerReference(charge.id)
  insist(charge.object === 'charge' && providerReference(intent.latest_charge) === chargeRef && providerReference(charge.payment_intent) === intentRef
    && providerReference(charge.customer) === row.stripe_customer_ref && charge.livemode === livemode && charge.currency === row.currency
    && charge.amount === row.amount_cents && charge.amount_captured === row.amount_cents && charge.amount_refunded === 0
    && charge.refunded === false && charge.disputed === false && charge.payment_method_details?.type === 'customer_balance'
    && Number.isSafeInteger(charge.created) && charge.created > 0 && charge.created * 1000 <= clockInstant(env), invalid, 409)
  if(row.source_kind==='imported'){
    await commit(env,await importedCashSettlementStatements(env,stripe,b,row,intent,charge),{actor:system.id,action:'processor.cash.imported.collected',subject:row.id,detail:{invoice:row.invoice_id,amountCents:row.amount_cents,paymentIntentRef:intentRef}})
    return
  }
  const source = await nativeCollectionSource(env, row.invoice_id)
  insist(source.sourceHash === row.source_hash && source.row.customer_id === b.customer_id && source.payerId === b.customer_id, 'processor_cash_source_changed', 409)
  const proof = { accountRef: b.account_ref, customerRef: b.stripe_customer_ref, transferRef: row.transfer_ref, paymentIntentRef: intentRef,
    chargeRef, amountCents: row.amount_cents, currency: row.currency, capturedAt: charge.created * 1000, livemode, kind: 'processor_cash_application' }
  const financial = await collectedPaymentStatements(env, system, { customerId: b.customer_id, invoiceId: row.invoice_id,
    amountCents: row.amount_cents, balanceCents:source.row.balance_cents, receivedOn: localDate(proof.capturedAt, (await requireBusiness(env)).timezone), currency: row.currency,
    reference: `stripe:${b.account_ref}:${intentRef}`, method: 'bank_transfer', evidence: canonical(proof) })
  await commit(env, [bindingGuard(env, b), nativeSourceGuard(env, source),
    guard(env, 'processor_cash_already_recorded', "EXISTS(SELECT 1 FROM nc_processor_cash_applications WHERE id=? AND status='uncertain' AND payment_id IS NULL)", row.id),
    ...financial.statements, stmt(env, `UPDATE nc_processor_cash_applications SET status='collected',charge_ref=?,payment_id=?,allocation_id=?,proof_json=?,reconciled_at=? WHERE id=?`,
      chargeRef, financial.paymentId, financial.allocationId, canonical(proof), clockInstant(env), row.id)],
  [...financial.audits, { actor: system.id, action: 'processor.cash.collected', subject: row.id, detail: proof }])
}

/** A durable uncertain claim is never sent again, even if no intent can be
 * found. Later invocations reconcile it using reads of complete intent history. */
export async function reconcileProcessorCash(env: Bindings, stripe: StripeClient, accountRef: string, customer: Row, allowApply=true, selection?:{transferRef:string;invoice:string;amountCents:number;authority?:D1PreparedStatement[]}): Promise<ProcessorCashResult> {
  providerReference(accountRef)
  const b = await binding(env, accountRef, customer), customerRef = providerReference(b.stripe_customer_ref)
  const [account, remote] = await Promise.all([stripe('/account'), stripe(`/customers/${encodeURIComponent(customerRef)}`)])
  insist(account.object === 'account' && account.id === accountRef && remote.object === 'customer' && remote.id === customerRef
    && remote.deleted !== true && typeof remote.livemode === 'boolean', invalid, 409)
  const livemode = remote.livemode as boolean
  let current = await snapshot(stripe, customerRef, livemode)
  const rows = async() => [...await all(env, "SELECT *,'native' AS source_kind FROM nc_processor_cash_applications WHERE customer_id=? AND account_ref=?", b.customer_id, accountRef),
    ...await all(env,"SELECT *,'imported' AS source_kind FROM nc_processor_cash_imported_applications WHERE customer_id=? AND account_ref=?",b.customer_id,accountRef)].sort((a,b)=>a.claimed_at-b.claimed_at||a.id.localeCompare(b.id))
  for (const row of (await rows()).filter(row => row.status === 'uncertain')) {
    const intents = row.payment_intent_ref ? [await stripe(`/payment_intents/${encodeURIComponent(row.payment_intent_ref)}`)]
      : (await history(stripe, `/payment_intents?${new URLSearchParams({ customer: customerRef })}`)).filter(intent => intent.metadata?.nectar_cash_application === row.id)
    insist(intents.length <= 1, invalid, 409)
    if (intents.length) await settle(env, stripe, b, row, intents[0], livemode)
  }
  current = await snapshot(stripe, customerRef, livemode)
  const lots = fundingLots(current.transactions, current.available)
  const unmatched: ProcessorCashResult['unmatched'] = []
  for (const lot of allowApply?lots.filter(lot=>!selection||lot.transaction.id===selection.transferRef):[]) {
    const invoices = [...await all(env, `SELECT i.*,${BALANCE_SQL} AS balance_cents,'native' AS source_kind FROM nc_invoices i WHERE i.customer_id=? AND i.status='issued'
      AND ${BALANCE_SQL}>0`, b.customer_id),...await importedCashCandidates(env,b)].sort((a,b)=>String(a.issue_date).localeCompare(String(b.issue_date))||(a.issued_at??0)-(b.issued_at??0)||(a.created_at??0)-(b.created_at??0)||String(a.number).localeCompare(String(b.number))||a.id.localeCompare(b.id))
    const t = lot.transaction, reference = typeof t.funded?.bank_transfer?.reference === 'string' ? t.funded.bank_transfer.reference : ''
    const existing = await rows()
    if (existing.some(row => row.transfer_ref === t.id && (!selection||row.invoice_id===selection.invoice))) continue
    let reason = 'no_matching_invoice'
    // Only this customer's own issued number can match, on word boundaries.
    const referenced = invoices.filter(invoice => invoice.number && new RegExp(`(^|[^A-Za-z0-9])${String(invoice.number).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9])`, 'i').test(reference))
    const candidate = selection ? invoices.find(invoice=>invoice.id===selection.invoice) : referenced.length === 1 ? referenced[0] : referenced.length === 0
      ? invoices.find(invoice => invoice.balance_cents === lot.remaining && invoice.currency.toLowerCase() === t.currency) : null
    if (t.currency !== 'usd') reason = 'currency_not_supported'
    else if (existing.some(row => row.status === 'uncertain')) reason = 'application_unconfirmed'
    else if (!selection&&referenced.length > 1) reason = 'ambiguous_reference'
    else if (candidate && candidate.currency.toLowerCase() === t.currency && lot.remaining > 0 && Math.min(candidate.balance_cents,lot.remaining) <= (current.available[t.currency] ?? 0)) {
      try {
        const imported=candidate.source_kind==='imported'
        const source = imported?await importedCashSource(env,stripe,b,candidate.id):await nativeCollectionSource(env, candidate.id)
        const amount=selection?.amountCents??Math.min(source.row.balance_cents,lot.remaining)
        insist(Number.isSafeInteger(amount)&&amount>=50&&amount<=source.row.balance_cents&&amount<=lot.remaining&&amount<=(current.available[t.currency]??0),'processor_cash_allocation_exceeds_balance',409)
        insist(!await one(env,"SELECT id FROM nc_processor_cash_returns WHERE account_ref=? AND stripe_customer_ref=? AND status IN ('claimed','uncertain')",accountRef,customerRef),'processor_cash_return_unconfirmed',409)
        if(!('takeover' in source)){
          insist(source.payerId === b.customer_id && source.row.customer_id === b.customer_id && source.disputedCents === 0, 'processor_cash_own_invoice_required', 409)
          insist(source.accountRef === accountRef || source.accountRef === null && accountRef === (await stripeForAccount(env, null)).account,
            'processor_cash_invoice_account_mismatch', 409)
        }
        const row: Row = { id: newId(), customer_id: b.customer_id, invoice_id: candidate.id, account_ref: accountRef, stripe_customer_ref: customerRef,
          transfer_ref: t.id, amount_cents: amount, currency: t.currency, source_hash: source.sourceHash, claimed_at: clockInstant(env), payment_intent_ref: null,source_kind:imported?'imported':'native' }
        const claim='takeover' in source?importedCashClaimStatements(env,b,source,row):[bindingGuard(env, b), nativeSourceGuard(env, source), stmt(env, `INSERT INTO nc_processor_cash_applications
          (id,customer_id,invoice_id,account_ref,stripe_customer_ref,transfer_ref,amount_cents,currency,source_hash,claimed_at,status) VALUES(?,?,?,?,?,?,?,?,?,?,'uncertain')`,
          row.id, row.customer_id, row.invoice_id, accountRef, customerRef, row.transfer_ref, row.amount_cents, row.currency, row.source_hash, row.claimed_at)]
        await commit(env, [...selection?.authority??[],...claim],
        { actor: system.id, action: 'processor.cash.claim', subject: row.id, detail: { invoice: row.invoice_id, transferRef: t.id, amountCents: row.amount_cents } })
        // Only this invocation that inserted the claim may make these writes.
        let intent = await stripe('/payment_intents', new URLSearchParams({ customer: customerRef, amount: String(row.amount_cents), currency: row.currency,
          'payment_method_types[]': 'customer_balance', 'payment_method_data[type]': 'customer_balance',
          'payment_method_options[customer_balance][funding_type]': 'bank_transfer',
          'payment_method_options[customer_balance][bank_transfer][type]': 'us_bank_transfer', confirm: 'true',
          [imported?'metadata[nectar_imported_invoice]':'metadata[nectar_native_invoice]']: row.invoice_id, 'metadata[nectar_cash_application]': row.id, 'metadata[nectar_cash_transfer]': row.transfer_ref }), `nectar-cash-${row.id}`)
        verifyIntent(intent, row, livemode)
        await settle(env, stripe, b, row, intent, livemode)
        if (intent.status !== 'succeeded' && ['requires_action', 'requires_payment_method'].includes(intent.status) && intent.amount_received === 0) {
          intent = await stripe(`/payment_intents/${encodeURIComponent(providerReference(intent.id))}/apply_customer_balance`,
            new URLSearchParams({ amount: String(row.amount_cents), currency: row.currency }), `nectar-cash-apply-${row.id}`)
          await settle(env, stripe, b, row, intent, livemode)
        }
        current = await snapshot(stripe, customerRef, livemode)
        continue
      } catch (error) {
        if (!(error instanceof NectarError) && !(error instanceof NativeStripeError)) throw error
        reason = error instanceof NectarError ? error.code : 'processor_outcome_unconfirmed'
      }
    }
    unmatched.push({ transferRef: t.id, amountCents: lot.remaining, currency: t.currency, reference, reason })
  }
  current = await snapshot(stripe, customerRef, livemode)
  const applications = (await rows()).map(applicationView)
  const remaining = fundingLots(current.transactions, current.available).map(lot => ({ transferRef: lot.transaction.id as string,
    amountCents: lot.remaining, currency: lot.transaction.currency as string,
    reference: typeof lot.transaction.funded?.bank_transfer?.reference === 'string' ? lot.transaction.funded.bank_transfer.reference : '',
    reason: applications.some(row => row.transferRef === lot.transaction.id) ? 'remaining_transfer_balance'
      : unmatched.find(row => row.transferRef === lot.transaction.id)?.reason ?? 'no_matching_invoice' }))
  return { availableCents: current.available.usd ?? 0, availableByCurrency: current.available, transactions: current.transactions,
    applications, unmatched: remaining }
}
