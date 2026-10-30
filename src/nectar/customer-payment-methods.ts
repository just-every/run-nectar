// A provider observation only: no mandate, debit authority or payment operation.
import type { Bindings } from '../auth.server'
import { actorLabel, requireRead, type Actor } from './actor'
import { clockInstant } from './clock'
import { all, commit, guard, insist, newId, one, stmt, type Row } from './core'
import type { Input } from './input'
import { collectionAuthority, collectionOwner } from './movein/collection-state'
import { providerReference, providerUnavailable, stripeForAccount, type StripeClient } from './payments/stripe'

export type SavedPaymentMethod = { methodRef: string } & (
  { type: 'card'; brand: string; last4: string; expMonth: number; expYear: number } |
  { type: 'us_bank_account'; bankName: string; last4: string; accountType: 'checking' | 'savings' })
export interface CustomerPaymentMethodSnapshot {
  snapshot: string; binding: string; customer: string; accountRef: string; customerRef: string; bindingRevision: string; fetchedAt: number
  historical: true; debitAuthority: false; methods: SavedPaymentMethod[]
}
const brands = new Set(['amex','cartes_bancaires','diners','discover','eftpos_au','interac','jcb','link','mastercard','unionpay','visa','unknown'])
const reference = (value: unknown) => providerReference(value)
const invalid = 'stripe_payment_method_evidence_invalid'
function typedMethod(row: Row, type: 'card' | 'us_bank_account', customerRef: string, livemode: boolean): SavedPaymentMethod {
  insist(row && row.object === 'payment_method' && row.type === type && reference(row.customer) === customerRef && row.livemode === livemode, invalid, 409)
  const methodRef = reference(row.id), details = row[type]
  insist(details && typeof details.last4 === 'string' && /^\d{4}$/.test(details.last4), invalid, 409)
  if (type === 'card') {
    insist(brands.has(details.brand) && Number.isSafeInteger(details.exp_month) && details.exp_month >= 1 && details.exp_month <= 12
      && Number.isSafeInteger(details.exp_year) && details.exp_year >= 2000 && details.exp_year <= 9999, invalid, 409)
    return { methodRef, type, brand: details.brand, last4: details.last4, expMonth: details.exp_month, expYear: details.exp_year }
  }
  insist(typeof details.bank_name === 'string' && details.bank_name.trim().length > 0 && details.bank_name.length <= 100
    && !/[\u0000-\u001f\u007f]|\d{12}/.test(details.bank_name) && ['checking','savings'].includes(details.account_type), invalid, 409)
  return { methodRef, type, bankName: details.bank_name, last4: details.last4, accountType: details.account_type }
}
async function listMethods(stripe: StripeClient, customerRef: string, livemode: boolean, type: 'card' | 'us_bank_account') {
  const methods: SavedPaymentMethod[] = [], seen = new Set<string>()
  let cursor = ''
  for (let page = 0; ; page++) {
    insist(page < 100, 'stripe_payment_method_history_incomplete', 409)
    const params = new URLSearchParams({ customer: customerRef, type, limit: '100', ...(cursor ? { starting_after: cursor } : {}) })
    const result = await stripe(`/payment_methods?${params}`)
    insist(result.object === 'list' && Array.isArray(result.data) && result.data.length <= 100 && typeof result.has_more === 'boolean'
      && (!result.has_more || result.data.length > 0), 'stripe_payment_method_history_incomplete', 409)
    for (const row of result.data) {
      const method = typedMethod(row, type, customerRef, livemode)
      insist(!seen.has(method.methodRef), 'stripe_payment_method_history_incomplete', 409)
      seen.add(method.methodRef); methods.push(method)
    }
    if (!result.has_more) return methods
    cursor = methods.at(-1)!.methodRef
  }
}

/** Refresh every held binding for this customer in one fenced replacement. */
export async function refreshCustomerPaymentMethods(env: Bindings, actor: Actor, input: Input) {
  await collectionOwner(env, actor)
  insist(await one(env, `SELECT 1 FROM nc_members m JOIN oa_operators o ON lower(o.email)=m.email
    JOIN oa_sessions s ON s.operator_id=o.id WHERE m.id=? AND m.status='active' AND m.role='owner'
    AND o.status='active' AND o.role='owner' AND o.version=s.operator_version AND s.id=?
    AND s.revoked_at IS NULL AND s.expires_at>CAST(strftime('%s','now') AS INTEGER)*1000`, actor.id, actor.sessionId), 'owner_required', 403)
  input.only(['customer', 'returnTo'])
  const customerId = input.text('customer', { max: 100 })
  const customer = await one(env, "SELECT id,revision FROM nc_customers WHERE id=? AND erased_at IS NULL AND status='active'", customerId)
  insist(customer && !await one(env, 'SELECT 1 FROM nc_erased_records WHERE record_id=?', customerId), 'customer_not_found', 404)
  const bindings = await all(env, 'SELECT * FROM nc_stripe_customer_bindings WHERE customer_id=? ORDER BY id', customerId)
  insist(bindings.length > 0, 'native_customer_binding_required', 409)
  const snapshots = await Promise.all(bindings.map(async binding => {
    const accountRef = reference(binding.account_ref), customerRef = reference(binding.stripe_customer_ref)
    const selected = await stripeForAccount(env, accountRef).catch(providerUnavailable)
    const providerCustomer = await selected.stripe(`/customers/${encodeURIComponent(customerRef)}`).catch(providerUnavailable)
    insist(providerCustomer.object === 'customer' && providerCustomer.id === customerRef && providerCustomer.deleted !== true
      && typeof providerCustomer.livemode === 'boolean', 'stripe_customer_evidence_invalid', 409)
    const lists = await Promise.all(['card','us_bank_account'].map(type => listMethods(selected.stripe, customerRef, providerCustomer.livemode, type as 'card' | 'us_bank_account').catch(providerUnavailable)))
    const methods = lists.flat()
    insist(new Set(methods.map(method => method.methodRef)).size === methods.length, invalid, 409)
    return { id: newId(), binding, accountRef, customerRef, methods, fetchedAt: clockInstant(env) }
  }))
  await commit(env, [collectionAuthority(env, actor),
    guard(env, 'customer_payment_methods_source_changed', `EXISTS(SELECT 1 FROM nc_customers WHERE id=? AND revision=? AND erased_at IS NULL AND status='active')
      AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id=?) AND (SELECT count(*) FROM nc_stripe_customer_bindings WHERE customer_id=?)=?`, customerId, customer.revision, customerId, customerId, bindings.length),
    ...bindings.map(binding => guard(env, 'customer_payment_methods_binding_changed', `EXISTS(SELECT 1 FROM nc_stripe_customer_bindings WHERE id=? AND customer_id=? AND revision=? AND account_ref=? AND stripe_customer_ref=?)
      AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id=?)`, binding.id, customerId, binding.revision, binding.account_ref, binding.stripe_customer_ref, binding.id)),
    stmt(env, 'DELETE FROM nc_customer_payment_methods WHERE customer_id=?', customerId),
    stmt(env, 'DELETE FROM nc_customer_payment_method_snapshots WHERE customer_id=?', customerId),
    ...snapshots.flatMap(snapshot => [
      stmt(env, `INSERT INTO nc_customer_payment_method_snapshots(id,customer_id,binding_id,binding_revision,account_ref,stripe_customer_ref,fetched_at) VALUES(?,?,?,?,?,?,?)`, snapshot.id, customerId, snapshot.binding.id, snapshot.binding.revision, snapshot.accountRef, snapshot.customerRef, snapshot.fetchedAt),
      ...snapshot.methods.map(method => stmt(env, `INSERT INTO nc_customer_payment_methods(id,customer_id,snapshot_id,payment_method_ref,kind,brand,last4,exp_month,exp_year,bank_name,account_type) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, newId(), customerId, snapshot.id, method.methodRef, method.type,
        method.type === 'card' ? method.brand : null, method.last4, method.type === 'card' ? method.expMonth : null, method.type === 'card' ? method.expYear : null,
        method.type === 'us_bank_account' ? method.bankName : null, method.type === 'us_bank_account' ? method.accountType : null)),
    ]),
  ], { actor: actorLabel(actor), action: 'customer.payment_methods.refresh', subject: customerId, detail: { methods: snapshots.reduce((count, snapshot) => count + snapshot.methods.length, 0), observationOnly: true } })
  return readCustomerPaymentMethods(env, actor, customerId)
}

/** No parent-payer expansion: the requested customer's own rows only. */
export async function readCustomerPaymentMethods(env: Bindings, actor: Actor, customer: string): Promise<CustomerPaymentMethodSnapshot[]> {
  requireRead(actor, 'payments'); requireRead(actor, 'invoices')
  insist(typeof customer === 'string' && /^[\w-]{1,100}$/.test(customer), 'invalid_customer')
  return bindingValidPaymentMethods(env, customer)
}

/** Internal evidence projection shared with invoice-linked diagnosis. */
export async function bindingValidPaymentMethods(env: Bindings, customer: string): Promise<CustomerPaymentMethodSnapshot[]> {
  const snapshots = await all(env, `SELECT s.* FROM nc_customer_payment_method_snapshots s
    JOIN nc_customers c ON c.id=s.customer_id JOIN nc_stripe_customer_bindings b ON b.id=s.binding_id AND b.customer_id=s.customer_id
    WHERE s.customer_id=? AND c.erased_at IS NULL AND b.revision=s.binding_revision AND b.account_ref=s.account_ref AND b.stripe_customer_ref=s.stripe_customer_ref
    AND NOT EXISTS(SELECT 1 FROM nc_erased_records e WHERE e.record_id IN (s.customer_id,s.id,b.id)) ORDER BY s.account_ref,s.id`, customer)
  return Promise.all(snapshots.map(async snapshot => ({ snapshot: snapshot.id, binding: snapshot.binding_id, customer, accountRef: snapshot.account_ref, customerRef: snapshot.stripe_customer_ref,
    bindingRevision: snapshot.binding_revision, fetchedAt: snapshot.fetched_at, historical: true as const, debitAuthority: false as const,
    methods: (await all(env, `SELECT m.* FROM nc_customer_payment_methods m WHERE m.customer_id=? AND m.snapshot_id=?
      AND NOT EXISTS(SELECT 1 FROM nc_erased_records e WHERE e.record_id=m.id) ORDER BY m.kind,m.payment_method_ref`, customer, snapshot.id)).map(row => row.kind === 'card'
      ? { methodRef: row.payment_method_ref, type: 'card' as const, brand: row.brand, last4: row.last4, expMonth: row.exp_month, expYear: row.exp_year }
      : { methodRef: row.payment_method_ref, type: 'us_bank_account' as const, bankName: row.bank_name, last4: row.last4, accountType: row.account_type }) })))
}
