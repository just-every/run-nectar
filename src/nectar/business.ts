// Flow 1: the business's billing identity, USD currency, billing timezone and
// declared tax policy. A tax policy is a declaration the owner reviews; until
// it is reviewed, no invoice can be finalised (unknown tax is never zero).
import type { Bindings } from '../auth.server'
import { actorLabel, requireCapability, requireOwner, type Actor } from './actor'
import { commit, guard, insist, now, one, stmt } from './core'
import { canonicalDecimal, micros } from './decimal'
import { validTimeZone } from './dates'
import { preparePolicyChange } from './policy-changes'
import type { Input } from './input'
import { invoiceFields, invoiceFieldInput } from './invoice-content'

export interface Business {
  legal_name: string; address: string; billing_email: string; currency: 'USD'; timezone: string; invoice_prefix: string
  next_invoice_number: number; next_credit_number: number; payment_terms_days: number; invoice_fields_json: string
  tax_jurisdiction: string; tax_mode: 'undeclared' | 'no_tax' | 'flat_rate'; tax_rate: string; tax_note: string
  tax_reviewed_by: string | null; tax_reviewed_at: number | null; revision: number; updated_at: number
}

export const US_STATES = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY']

export async function business(env: Bindings): Promise<Business | null> {
  return await one<Business>(env, 'SELECT * FROM nc_business WHERE singleton = 1')
}

export async function requireBusiness(env: Bindings): Promise<Business> {
  const found = await business(env)
  insist(found, 'business_not_configured', 409)
  return found
}

export const taxReady = (b: Business) => b.tax_mode !== 'undeclared' && !!b.tax_reviewed_at

export async function businessView(env: Bindings, actor: Actor) {
  requireCapability(actor, 'read')
  const found = await business(env)
  return found ? { ...found, taxReady: taxReady(found) } : null
}

/** Saves identity and timezone. The timezone sets period boundaries, so it is fixed once an invoice is issued. */
export async function configureBusiness(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor)
  const current = await business(env)
  const legalName = input.text('legal_name', { max: 160 })
  const timezone = input.text('timezone', { max: 60 })
  insist(validTimeZone(timezone), 'invalid_timezone')
  const prefix = input.text('invoice_prefix', { max: 12 }).toUpperCase()
  insist(/^[A-Z0-9-]{1,12}$/.test(prefix), 'invalid_invoice_prefix')
  const terms = input.integer('payment_terms_days', { min: 0, max: 120 })!
  const email = input.text('billing_email', { max: 200, optional: true }).toLowerCase()
  insist(!email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 'invalid_billing_email')
  const currency = input.text('currency', { max: 3, optional: true }) || 'USD'
  insist(currency === 'USD', 'unsupported_currency')
  const address = input.text('address', { max: 400, optional: true })
  const invoiceFieldsJson = input.has('invoice_fields') ? JSON.stringify(invoiceFields(input.json('invoice_fields'))) : input.flag('invoice_fields_edit') ? JSON.stringify(invoiceFieldInput(input)) : current?.invoice_fields_json ?? '{}'
  if (!current) {
    await commit(env, [stmt(env, 'INSERT INTO nc_business (singleton, legal_name, address, billing_email, timezone, invoice_prefix, payment_terms_days, invoice_fields_json, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)', legalName, address, email, timezone, prefix, terms, invoiceFieldsJson, now())],
      { actor: actorLabel(actor), action: 'business.configure', subject: 'business', detail: { legalName, timezone, prefix, terms } })
    return await business(env)
  }
  const revision = input.integer('revision', { min: 1, max: 1_000_000 })
  insist(revision === current.revision, 'stale', 409)
  insist(timezone === current.timezone || !await one(env, "SELECT 1 FROM nc_invoices WHERE status = 'issued' LIMIT 1"), 'timezone_fixed_after_first_invoice', 409)
  await commit(env, [
    guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_business WHERE singleton = 1 AND revision = ?)', current.revision),
    guard(env, 'timezone_fixed_after_first_invoice', "? = (SELECT timezone FROM nc_business) OR NOT EXISTS(SELECT 1 FROM nc_invoices WHERE status = 'issued')", timezone),
    stmt(env, 'UPDATE nc_business SET legal_name = ?, address = ?, billing_email = ?, timezone = ?, invoice_prefix = ?, payment_terms_days = ?, invoice_fields_json = ?, revision = revision + 1, updated_at = ? WHERE singleton = 1', legalName, address, email, timezone, prefix, terms, invoiceFieldsJson, now()),
  ], { actor: actorLabel(actor), action: 'business.configure', subject: 'business', detail: { legalName, timezone, prefix, terms } })
  return await business(env)
}

/** Prepares a tax policy change. Applying it clears the review before finalising. */
export async function declareTax(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor)
  const current = await requireBusiness(env)
  const jurisdiction = input.text('tax_jurisdiction', { max: 2 }).toUpperCase()
  insist(US_STATES.includes(jurisdiction), 'invalid_tax_jurisdiction')
  const mode = input.text('tax_mode', { max: 20 })
  insist(mode === 'no_tax' || mode === 'flat_rate', 'invalid_tax_mode')
  const rate = mode === 'flat_rate' ? canonicalDecimal(input.text('tax_rate', { max: 12 }), 'tax_rate') : '0.00'
  insist(mode === 'no_tax' || (micros(rate) > 0n && micros(rate) < 100n * 1_000_000n), 'invalid_tax_rate')
  const note = input.text('tax_note', { max: 1000 })
  return await preparePolicyChange(env, actor, 'tax', { jurisdiction, mode, rate, note })
}

/** The owner confirms the declared policy has been reviewed (for example with their accountant). */
export async function reviewTax(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor)
  const current = await requireBusiness(env)
  insist(current.tax_mode !== 'undeclared', 'tax_not_declared', 409)
  const revision = input.integer('revision', { min: 1, max: 1_000_000 })
  insist(revision === current.revision, 'stale', 409)
  await commit(env, [
    guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_business WHERE singleton = 1 AND revision = ?)', current.revision),
    stmt(env, 'UPDATE nc_business SET tax_reviewed_by = ?, tax_reviewed_at = ?, revision = revision + 1, updated_at = ? WHERE singleton = 1', actorLabel(actor), now(), now()),
  ], { actor: actorLabel(actor), action: 'tax.review', subject: 'business', detail: { jurisdiction: current.tax_jurisdiction, mode: current.tax_mode, rate: current.tax_rate } })
  return await business(env)
}
