// An explicit owner association, not a guessed email or provider creation.
import type { Bindings } from '../../auth.server'
import { actorLabel, type Actor } from '../actor'
import { clockInstant } from '../clock'
import { commit, guard, insist, newId, one, stmt } from '../core'
import type { Input } from '../input'
import { collectionAuthority, collectionOwner } from '../movein/collection-state'
import { providerReference, providerUnavailable, savedCard, stripeForAccount } from './stripe'

export async function bindNativeCollectionCustomer(env: Bindings, actor: Actor, input: Input) {
  await collectionOwner(env, actor)
  input.only(['customer', 'account_ref', 'stripe_customer_ref', 'confirm', 'returnTo'])
  insist(input.flag('confirm'), 'native_customer_binding_confirmation_required')
  const customer = await one(env, "SELECT id,revision,billing_entity_id FROM nc_customers WHERE id=? AND erased_at IS NULL AND status='active'", input.text('customer', { max: 100 }))
  insist(customer && !await one(env, 'SELECT 1 FROM nc_erased_records WHERE record_id=?', customer.id), 'customer_not_found', 404)
  const account = providerReference(input.text('account_ref', { max: 255 })), customerRef = providerReference(input.text('stripe_customer_ref', { max: 255 }))
  if (customer.billing_entity_id) {
    const entity = await one(env, 'SELECT processor_account_ref FROM nc_billing_entities WHERE id=?', customer.billing_entity_id)
    // Bind only accounts present on this customer's own entity or issued route.
    insist(entity?.processor_account_ref === account || await one(env, "SELECT 1 FROM nc_invoices WHERE customer_id=? AND status='issued' AND json_extract(billing_route_json,'$.processorAccountRef')=?", customer.id, account), 'stripe_frozen_account_mismatch', 409)
  }
  const selected = await stripeForAccount(env, account).catch(providerUnavailable)
  const card = await savedCard(selected.stripe, customerRef).catch(providerUnavailable)
  const existing = await one(env, 'SELECT * FROM nc_stripe_customer_bindings WHERE customer_id=? AND account_ref=?', customer.id, account)
  if (existing) { insist(existing.stripe_customer_ref === customerRef, 'native_customer_binding_fixed', 409); return { ...existing, card: card.card } }
  const id = newId(), revision = newId(), at = clockInstant(env)
  await commit(env, [collectionAuthority(env, actor),
    guard(env, 'native_collection_source_changed', "EXISTS(SELECT 1 FROM nc_customers WHERE id=? AND revision=? AND erased_at IS NULL AND status='active') AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id=?)", customer.id, customer.revision, customer.id),
    stmt(env, 'INSERT INTO nc_stripe_customer_bindings(id,customer_id,account_ref,stripe_customer_ref,revision,created_by,created_at) VALUES(?,?,?,?,?,?,?)', id, customer.id, account, customerRef, revision, actor.id, at),
  ], { actor: actorLabel(actor), action: 'collection.customer.bind', subject: id, detail: { customer: customer.id, accountRef: account, stripeCustomerRef: customerRef } })
  return { id, customer_id: customer.id, account_ref: account, stripe_customer_ref: customerRef, revision, created_by: actor.id, created_at: at, card: card.card }
}
