// Owner-recorded legal identities and routing intent. Provider execution and
// governed executed-order interpretation remain separate capabilities.
import type { Bindings } from '../auth.server'
import { actorLabel, requireOwner, type Actor } from './actor'
import { requireBusiness, type Business } from './business'
import { all, commit, guard, insist, newId, now, one, type Row, stmt } from './core'
import type { Input } from './input'
import { requireFreshFactor } from './mfa'

export const normalizeNumberPrefix = (value: string) => {
  const prefix = value.toUpperCase().replace(/-$/, '') + '-'
  insist(/^[A-Z0-9-]{1,40}$/.test(prefix), 'invalid_invoice_prefix')
  return prefix
}
export async function requireBillingEntity(env: Bindings, id: string) {
  const entity = await one(env, 'SELECT * FROM nc_billing_entities WHERE id=?', id)
  insist(entity, 'billing_entity_not_found', 404)
  return entity
}
export const billingRoute = (business: Business, entity: Row | null) => entity ? {
  entityId: entity.id, legalName: entity.legal_name, address: entity.address, ein: entity.ein,
  paymentTermsDays: entity.payment_terms_days, processor: 'stripe', processorAccountRef: entity.processor_account_ref,
  ledgerCompanyRef: entity.ledger_company_ref, taxRegistration: entity.tax_registration, routingCustody: 'owner-recorded',
} : { entityId: null, legalName: business.legal_name, address: business.address, paymentTermsDays: business.payment_terms_days, routingCustody: 'installation-business' }

async function ownerBasis(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor); await requireFreshFactor(env, actor)
  const business = await requireBusiness(env)
  insist(input.integer('revision', { min: 1, max: 1_000_000 }) === business.revision, 'stale', 409)
  return business
}
export const businessRevisionGuard = (env: Bindings, business: Business) => guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_business WHERE singleton=1 AND revision=?)', business.revision)
export const bumpBusinessRevision = (env: Bindings) => stmt(env, 'UPDATE nc_business SET revision=revision+1,updated_at=? WHERE singleton=1', now())
const routedReference = (input: Input, name: string) => {
  const value = input.text(name, { max: 120 })
  insist(/^[A-Za-z0-9_.:-]+$/.test(value) && !/^(?:sk|rk)_(?:test|live)_|^whsec_/i.test(value), 'invalid_routing_reference')
  return value
}
function identity(input: Input) {
  const ein = input.text('ein', { max: 10 })
  insist(/^\d{2}-\d{7}$/.test(ein), 'invalid_ein')
  return { legalName: input.text('legal_name', { max: 160 }), address: input.text('address', { max: 400 }), ein,
    terms: input.integer('payment_terms_days', { min: 0, max: 120 })!, processor: routedReference(input, 'processor_account_ref'),
    ledger: routedReference(input, 'ledger_company_ref'), taxRegistration: input.text('tax_registration', { max: 240 }) }
}
export async function billingEntities(env: Bindings, actor: Actor) {
  requireOwner(actor)
  return { revision: (await requireBusiness(env)).revision,
    entities: await all(env, 'SELECT * FROM nc_billing_entities ORDER BY legal_name,id'),
    customerSeries: await all(env, 'SELECT * FROM nc_entity_customer_numbers ORDER BY entity_id,customer_id,kind'),
    sources: await all(env, 'SELECT * FROM nc_numbering_sources ORDER BY captured_at,id') }
}
export async function createBillingEntity(env: Bindings, actor: Actor, input: Input) {
  const business = await ownerBasis(env, actor, input), value = identity(input)
  const prefix = normalizeNumberPrefix(input.text('invoice_prefix', { max: 39 })), width = input.integer('invoice_number_width', { min: 1, max: 12 })!
  const used = await all(env, "SELECT number FROM nc_incumbent_invoices UNION ALL SELECT number FROM nc_invoices WHERE status='issued' UNION ALL SELECT number FROM nc_credit_notes")
  insist(!used.some(row => row.number?.match(/^(.*?)(\d+)$/)?.[1] === prefix), 'series_already_used', 409)
  insist(!await one(env, 'SELECT 1 FROM nc_billing_entities WHERE invoice_prefix=? OR credit_prefix=?', prefix, prefix), 'series_already_configured', 409)
  const id = newId(), revision = newId(), at = now()
  await commit(env, [businessRevisionGuard(env, business),
    stmt(env, `INSERT INTO nc_billing_entities(id,legal_name,address,ein,invoice_prefix,invoice_number_width,credit_prefix,credit_number_width,payment_terms_days,processor_account_ref,ledger_company_ref,tax_registration,revision,created_by,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, value.legalName, value.address, value.ein, prefix, width, `${prefix}CN-`, width, value.terms, value.processor, value.ledger, value.taxRegistration, revision, actorLabel(actor), at, at),
    bumpBusinessRevision(env)], { actor: actorLabel(actor), action: 'entity.create', subject: id,
      detail: { legalName: value.legalName, processorAccountRef: value.processor, ledgerCompanyRef: value.ledger, routingCustody: 'owner-recorded' } })
  return { id, revision }
}
export async function updateBillingEntity(env: Bindings, actor: Actor, input: Input) {
  const business = await ownerBasis(env, actor, input), entity = await requireBillingEntity(env, input.text('entity', { max: 100 })), value = identity(input), revision = newId()
  await commit(env, [businessRevisionGuard(env, business), guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_billing_entities WHERE id=? AND revision=?)', entity.id, entity.revision),
    stmt(env, 'UPDATE nc_billing_entities SET legal_name=?,address=?,ein=?,payment_terms_days=?,processor_account_ref=?,ledger_company_ref=?,tax_registration=?,revision=?,updated_at=? WHERE id=?',
      value.legalName, value.address, value.ein, value.terms, value.processor, value.ledger, value.taxRegistration, revision, now(), entity.id), bumpBusinessRevision(env)],
    { actor: actorLabel(actor), action: 'entity.update', subject: entity.id, detail: { legalName: value.legalName, processorAccountRef: value.processor, ledgerCompanyRef: value.ledger } })
  return { id: entity.id, revision }
}
export async function assignCustomerEntity(env: Bindings, actor: Actor, input: Input) {
  const business = await ownerBasis(env, actor, input), entity = await requireBillingEntity(env, input.text('entity', { max: 100 }))
  insist(input.flag('confirm'), 'entity_assignment_confirmation_required')
  const customer = await one(env, "SELECT * FROM nc_customers WHERE id=? AND erased_at IS NULL AND status='active'", input.text('customer', { max: 100 }))
  insist(customer, 'customer_not_found', 404)
  insist(customer.billing_entity_id !== entity.id, 'customer_entity_unchanged', 409)
  const free = "NOT EXISTS(SELECT 1 FROM nc_invoices WHERE customer_id=? AND status='issued') AND NOT EXISTS(SELECT 1 FROM nc_credit_notes WHERE customer_id=?)"
  insist(!await one(env, "SELECT 1 FROM nc_invoices WHERE customer_id=? AND status='issued' UNION ALL SELECT 1 FROM nc_credit_notes WHERE customer_id=? LIMIT 1", customer.id, customer.id), 'customer_entity_fixed_after_issue', 409)
  await commit(env, [businessRevisionGuard(env, business), guard(env, 'stale', `EXISTS(SELECT 1 FROM nc_customers WHERE id=? AND revision=? AND erased_at IS NULL) AND ${free}`, customer.id, customer.revision, customer.id, customer.id),
    guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_billing_entities WHERE id=? AND revision=?)', entity.id, entity.revision),
    stmt(env, 'DELETE FROM nc_entity_customer_numbers WHERE customer_id=?', customer.id),
    stmt(env, 'UPDATE nc_customers SET billing_entity_id=?,invoice_prefix=NULL,invoice_number_width=NULL,next_invoice_number=NULL,credit_prefix=NULL,credit_number_width=NULL,next_credit_number=NULL,revision=?,updated_at=? WHERE id=?', entity.id, newId(), now(), customer.id),
    stmt(env, 'UPDATE nc_incumbent_invoices SET billing_entity_id=? WHERE customer_id=?', entity.id, customer.id), bumpBusinessRevision(env)],
    { actor: actorLabel(actor), action: 'customer.entity', subject: customer.id, detail: { entity: entity.id, previousEntity: customer.billing_entity_id, processorAccountRef: entity.processor_account_ref, ledgerCompanyRef: entity.ledger_company_ref } })
  return { customer: customer.id, entity: entity.id }
}
