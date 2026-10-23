// Flow 2: customers and their billing contacts, each customer keyed by the
// business's own external id (the id their CRM or previous biller uses).
import type { Bindings } from '../auth.server'
import { requireRead, actorLabel, requireCapability, type Actor } from './actor'
import { all, commit, guard, insist, newId, now, one, stmt } from './core'
import { withMetadata } from './metadata'
import { metadataFilter,metadataPredicate } from './metadata-query'
import type { Input } from './input'
import { languageInput } from './locale'
import { invoiceSettingsInput } from './invoice-content'
import { customerEvidenceMatches } from './customer-search'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const EXTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/

export async function customers(env: Bindings, actor: Actor,url?:URL) {
  requireRead(actor, 'customers')
  const filter=metadataPredicate('customer','c.id',url?metadataFilter(url):null)
  const search=(url?.searchParams.get('search')??'').trim()
  const rows=await all(env, `SELECT c.id, c.external_id, c.name, c.billing_email, c.language, c.status, c.origin, c.tax_exempt,
    (SELECT COUNT(*) FROM nc_subscriptions s WHERE s.customer_id = c.id) AS subscriptions
    FROM nc_customers c WHERE ${filter.sql} ORDER BY c.name COLLATE NOCASE`,...filter.params)
  const projected=await withMetadata(env,'customer',rows)
  if(!search)return projected
  const matches=await all(env,`SELECT m.kind,m.record_id,m.metadata_json FROM nc_metadata_revisions m WHERE m.revision=(SELECT MAX(x.revision) FROM nc_metadata_revisions x WHERE x.kind=m.kind AND x.record_id=m.record_id)`)
  const found=await customerEvidenceMatches(env,search,actor)
  for(const m of matches){
    if(!Object.values(JSON.parse(m.metadata_json)).some(v=>String(v).toLowerCase().includes(search.toLowerCase())))continue
    if(m.kind==='customer')found.add(m.record_id)
    else if(m.kind==='price'){for(const r of await all(env,'SELECT DISTINCT s.customer_id FROM nc_items i JOIN nc_subscriptions s ON s.id=i.subscription_id WHERE i.price_id=?',m.record_id))found.add(r.customer_id)}
    else {const table=({'subscription':'nc_subscriptions','invoice':'nc_invoices','payment':'nc_payments','credit-note':'nc_credit_notes'} as Record<string,string>)[m.kind];if(table)for(const r of await all(env,`SELECT customer_id FROM ${table} WHERE id=?`,m.record_id))found.add(r.customer_id)}
  }
  const text=search.toLowerCase()
  return projected.filter(r=>found.has(r.id)||[r.name,r.external_id,r.billing_email].some(v=>String(v).toLowerCase().includes(text)))
}

export async function requireCustomer(env: Bindings, id: string) {
  const row = await one(env, 'SELECT * FROM nc_customers WHERE id = ?', id)
  insist(row, 'customer_not_found', 404)
  return row
}

export async function createCustomer(env: Bindings, actor: Actor, input: Input) {
  requireCapability(actor, 'records')
  const externalId = input.text('external_id', { max: 80 })
  insist(EXTERNAL_ID.test(externalId), 'invalid_external_id')
  const name = input.text('name', { max: 160 })
  const email = input.text('billing_email', { max: 200 }).toLowerCase()
  insist(EMAIL.test(email), 'invalid_billing_email')
  const address = input.text('address', { max: 400, optional: true })
  const exempt = input.flag('tax_exempt')
  const exemptRef = input.text('tax_exempt_ref', { max: 120, optional: true })
  insist(!exempt || exemptRef, 'exemption_reference_required')
  const language = languageInput(input.text('language', { max: 35, optional: true }))
  insist(!await one(env, 'SELECT 1 FROM nc_customers WHERE external_id = ?', externalId), 'external_id_in_use', 409)
  const settings = invoiceSettingsInput(input)
  const id = newId()
  await commit(env, [stmt(env, "INSERT INTO nc_customers (id, external_id, name, billing_email, address, tax_exempt, tax_exempt_ref, language, invoice_settings_json, origin, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'native', ?, ?, ?)",
    id, externalId, name, email, address, exempt ? 1 : 0, exempt ? exemptRef : '', language, settings, newId(), now(), now())],
  { actor: actorLabel(actor), action: 'customer.create', subject: id, detail: { externalId, name, language } })
  return { id, external_id: externalId }
}

export async function updateCustomer(env: Bindings, actor: Actor, input: Input) {
  requireCapability(actor, 'records')
  const customer = await requireCustomer(env, input.text('customer', { max: 100 }))
  insist(input.text('revision', { max: 100 }) === customer.revision, 'stale', 409)
  const name = input.text('name', { max: 160 })
  const email = input.text('billing_email', { max: 200 }).toLowerCase()
  insist(EMAIL.test(email), 'invalid_billing_email')
  const address = input.text('address', { max: 400, optional: true })
  const exempt = input.flag('tax_exempt')
  const exemptRef = input.text('tax_exempt_ref', { max: 120, optional: true })
  insist(!exempt || exemptRef, 'exemption_reference_required')
  // Omitted on an update keeps the customer's current language.
  const language = languageInput(input.text('language', { max: 35, optional: true }) || customer.language)
  const settings = invoiceSettingsInput(input, customer.invoice_settings_json)
  await commit(env, [
    guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_customers WHERE id = ? AND revision = ?)', customer.id, customer.revision),
    stmt(env, "UPDATE nc_customers SET name = ?, billing_email = ?, address = ?, tax_exempt = ?, tax_exempt_ref = ?, language = ?, invoice_settings_json = ?, revision = ?, updated_at = ? WHERE id = ?", name, email, address, exempt ? 1 : 0, exempt ? exemptRef : '', language, settings, newId(), now(), customer.id),
  ], { actor: actorLabel(actor), action: 'customer.update', subject: customer.id, detail: { name, email, exempt, language } })
  return { id: customer.id }
}

export async function addContact(env: Bindings, actor: Actor, input: Input) {
  requireCapability(actor, 'records')
  const customer = await requireCustomer(env, input.text('customer', { max: 100 }))
  const name = input.text('name', { max: 120 })
  const email = input.text('email', { max: 200 }).toLowerCase()
  insist(EMAIL.test(email), 'invalid_email')
  const role = input.text('role', { max: 40, optional: true }) || 'billing'
  insist(!await one(env, 'SELECT 1 FROM nc_contacts WHERE customer_id = ? AND email = ?', customer.id, email), 'contact_exists', 409)
  const id = newId()
  await commit(env, [stmt(env, 'INSERT INTO nc_contacts (id, customer_id, name, email, role, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, customer.id, name, email, role, actorLabel(actor), now())],
    { actor: actorLabel(actor), action: 'contact.add', subject: customer.id, detail: { contact: id, email, role } })
  return { id: customer.id, contact: id }
}
