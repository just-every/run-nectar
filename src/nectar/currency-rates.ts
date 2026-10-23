// Finance records a sourced daily USD value for one unit of transaction currency.
// Rates are append-only, exact decimal text; missing days never inherit a rate.
import type { Bindings } from '../auth.server'
import { actorLabel, requireMember, requireRead, type Actor } from './actor'
import { all, commit, guard, insist, newId, now, one, type Row, stmt } from './core'
import { canonicalDecimal, micros, roundHalfAway, SCALE } from './decimal'
import { localDate, requireDate } from './dates'
import { requireBusiness } from './business'
import type { Input } from './input'
import { billingCurrency } from './currency'

export async function recordDailyRate(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'approve')
  const currency = billingCurrency(input.text('currency', { max: 3 })), date = requireDate(input.text('rate_date', { max: 10 }), 'rate_date')
  insist(currency !== 'USD', 'usd_rate_is_one')
  const rate = canonicalDecimal(input.text('usd_per_unit', { max: 24 }), 'usd_per_unit')
  insist(micros(rate) > 0n, 'invalid_usd_per_unit')
  const source = input.text('source', { max: 300 })
  insist(!await one(env, 'SELECT 1 FROM nc_currency_rates WHERE currency=? AND rate_date=?', currency, date), 'daily_rate_already_recorded', 409)
  const id = newId()
  await commit(env, [guard(env, 'daily_rate_already_recorded', 'NOT EXISTS(SELECT 1 FROM nc_currency_rates WHERE currency=? AND rate_date=?)', currency, date),
    stmt(env, 'INSERT INTO nc_currency_rates(id,currency,rate_date,usd_per_unit,source,recorded_by,recorded_at) VALUES(?,?,?,?,?,?,?)', id, currency, date, rate, source, actorLabel(actor), now())],
  { actor: actorLabel(actor), action: 'currency.rate.record', subject: id, detail: { currency, date, usdPerUnit: rate, source } })
  return { id, currency, rate_date: date, usd_per_unit: rate, source }
}
export async function dailyRates(env: Bindings, actor: Actor) {
  requireRead(actor, 'reports')
  return all(env, 'SELECT * FROM nc_currency_rates ORDER BY rate_date DESC,currency LIMIT 1000')
}
export async function usdReportingValue(env: Bindings, currencyValue: unknown, amountCents: number, date: string) {
  const currency = billingCurrency(currencyValue)
  requireDate(date, 'rate_date')
  insist(Number.isSafeInteger(amountCents), 'invalid_reporting_amount')
  if (currency === 'USD') return { currency: 'USD', amountCents, rate: '1.00', source: 'USD reporting currency', rateDate: date }
  const rate = await one(env, 'SELECT * FROM nc_currency_rates WHERE currency=? AND rate_date=?', currency, date)
  insist(rate, 'daily_rate_required', 409)
  const converted = roundHalfAway(BigInt(amountCents) * micros(rate.usd_per_unit), SCALE)
  insist(converted <= BigInt(Number.MAX_SAFE_INTEGER) && converted >= BigInt(Number.MIN_SAFE_INTEGER), 'reporting_amount_overflow', 409)
  return { currency: 'USD', amountCents: Number(converted), rate: rate.usd_per_unit, source: rate.source, rateDate: rate.rate_date, rateId: rate.id }
}
/** Record views remain usable while a rate is missing; no USD value is invented. */
export async function currencyRecord(env: Bindings, row: Row, amountCents: number, date: string): Promise<Row> {
  const currency = billingCurrency(row.currency)
  const present = currency === 'USD' || await one(env, 'SELECT 1 FROM nc_currency_rates WHERE currency=? AND rate_date=?', currency, date)
  return { ...row, currency, reporting: present ? { status: 'converted', ...await usdReportingValue(env, currency, amountCents, date) }
    : { status: 'rate_required', currency: 'USD', amountCents: null, rateDate: date, transactionCurrency: currency } }
}
export async function currencyReport(env: Bindings, actor: Actor, url?: URL) {
  requireRead(actor, 'reports')
  const from = url?.searchParams.get('from') || '0001-01-01', to = url?.searchParams.get('to') || '9999-12-31'
  requireDate(from, 'from'); requireDate(to, 'to'); insist(from <= to, 'invalid_date_range')
  const business = await requireBusiness(env)
  const [invoices, payments, credits] = await Promise.all([
    all(env, "SELECT id,number,customer_id,currency,total_cents AS amount_cents,issue_date AS transaction_date FROM nc_invoices WHERE status='issued' AND issue_date>=? AND issue_date<=? ORDER BY issue_date,id", from, to),
    all(env, 'SELECT id,reference,customer_id,currency,amount_cents,received_on AS transaction_date FROM nc_payments WHERE received_on>=? AND received_on<=? ORDER BY received_on,id', from, to),
    all(env, 'SELECT id,number,customer_id,invoice_id,currency,amount_cents,issued_at FROM nc_credit_notes ORDER BY issued_at,id'),
  ])
  const creditRows = credits.map(row => ({ ...row, transaction_date: localDate(row.issued_at, business.timezone) })).filter(row => row.transaction_date >= from && row.transaction_date <= to)
  const project = async (rows: Row[], kind: string):Promise<Row[]> => Promise.all(rows.map(async row => ({ ...row, kind, reporting: await usdReportingValue(env, row.currency, row.amount_cents, row.transaction_date) })))
  const transactions = [...await project(invoices, 'invoice'), ...await project(payments, 'payment'), ...await project(creditRows, 'credit')]
  const totals: Record<string, number> = { invoice: 0, payment: 0, credit: 0 }
  for (const row of transactions) { totals[row.kind] += row.reporting.amountCents; insist(Number.isSafeInteger(totals[row.kind]), 'reporting_amount_overflow', 409) }
  return { reportingCurrency: 'USD', from, to, ratePolicy: 'Transaction date; exact decimal USD per unit, rounded half away from zero per transaction.', transactions, totals }
}
