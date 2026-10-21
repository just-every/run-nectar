import type { Bindings } from '../auth.server'
import { all, guard, insist, newId, now, one, parseJson, stmt, type Row } from './core'
import { PREPAID_VERSION, type PrepaidBasis, type PrepaidGrant, type PrepaidTerms } from './prepaid-types'

export async function prepaidSnapshot(env: Bindings, subscription: string): Promise<PrepaidBasis | undefined> {
  const account = await one(env, 'SELECT * FROM nc_prepaid_accounts WHERE subscription_id=?', subscription)
  if (!account) return undefined
  const rows = await all(env, 'SELECT * FROM nc_prepaid_grants WHERE subscription_id=? ORDER BY priority,expires_date,effective_date,id', subscription)
  const entries = await all(env, 'SELECT * FROM nc_prepaid_ledger WHERE subscription_id=? ORDER BY service_date,created_at,id', subscription)
  return { version: PREPAID_VERSION, subscription, customer: account.customer_id, revision: account.revision,
    grants: rows.map(row => ({ id: row.id, subscription, customer: row.customer_id, kind: row.kind, source: row.source, amountN: row.amount_n, valueCents: row.value_cents, meterId: row.meter_id, effectiveDate: row.effective_date, expiresDate: row.expires_date, priority: row.priority, rolloverMonths: row.rollover_months, rolloverPercent: row.rollover_percent, rolloverCapN: row.rollover_cap_n, expiryConsent: !!row.expiry_consent, purchaseInvoice: row.purchase_invoice_id, purchaseLine: row.purchase_line_id })),
    entries: entries.map(row => ({ id: row.id, grantId: row.grant_id, kind: row.kind, amountN: row.amount_n, liabilityCents: row.liability_cents, recognitionCents: row.recognition_cents, serviceDate: row.service_date, invoiceId: row.invoice_id, lineIndex: row.line_index, purchaseInvoice: row.purchase_invoice_id, purchaseLine: row.purchase_line_id })) }
}
export const prepaidRevisionGuard = (env: Bindings, subscription: string, revision: number) => guard(env, 'prepaid_balance_changed', 'EXISTS(SELECT 1 FROM nc_prepaid_accounts WHERE subscription_id=? AND revision=?)', subscription, revision)
export function prepaidGrantStatements(env: Bindings, id: string, subscription: string, customer: string, terms: PrepaidTerms, request: string | null, funding: string | null, invoice: string | null, line: string | null) {
  const at = now()
  return [stmt(env, 'INSERT INTO nc_prepaid_grants(id,subscription_id,customer_id,request_id,funding_id,kind,source,amount_n,value_cents,meter_id,effective_date,expires_date,priority,rollover_months,rollover_percent,rollover_cap_n,expiry_consent,purchase_invoice_id,purchase_line_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, subscription, customer, request, funding, terms.kind, terms.source, terms.amountN, terms.valueCents, terms.meterId, terms.effectiveDate, terms.expiresDate, terms.priority, terms.rolloverMonths, terms.rolloverPercent, terms.rolloverCapN, 1, invoice, line, at),
    stmt(env, "INSERT INTO nc_prepaid_ledger(id,grant_id,subscription_id,customer_id,kind,amount_n,liability_cents,recognition_cents,service_date,purchase_invoice_id,purchase_line_id,created_at) VALUES(?,?,?,?,'grant',?,?,0,?,?,?,?)", newId(), id, subscription, customer, terms.amountN, terms.valueCents, terms.effectiveDate, invoice, line, at),
    stmt(env, 'UPDATE nc_prepaid_accounts SET revision=revision+1 WHERE subscription_id=?', subscription)]
}
export function prepaidFundingIntentStatements(env: Bindings, id: string, subscription: string, customer: string, terms: PrepaidTerms, request: string | null, consent: string | null) {
  insist(terms.source === 'purchase' && terms.valueCents > 0, 'prepaid_purchase_amount_required')
  return [stmt(env, 'INSERT INTO nc_prepaid_funding_intents(id,subscription_id,customer_id,request_id,consent_id,amount_cents,terms_json,created_at) VALUES(?,?,?,?,?,?,?,?)', id, subscription, customer, request, consent, terms.valueCents, JSON.stringify(terms), now())]
}
export async function prepaidFundingForInvoice(env: Bindings, invoice: string): Promise<{id:string}|null> {
  const intent = await one(env, "SELECT id,consent_id FROM nc_prepaid_funding_intents WHERE invoice_id=? AND status='pending'", invoice)
  if (intent?.consent_id) insist(await one(env, "SELECT id FROM nc_prepaid_consents WHERE id=? AND status='active'", intent.consent_id), 'prepaid_consent_revoked', 409)
  return intent ? {id:intent.id} : null
}
export function prepaidTerms(row: Row): PrepaidTerms { return parseJson<PrepaidTerms>(row.terms_json, null as never) }
