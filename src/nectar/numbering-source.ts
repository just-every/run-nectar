// Immutable, explicitly attributed numbering configuration. An owner's account
// settings transcription is never presented as an API-verified account setting.
import type { Bindings } from '../auth.server'
import { actorLabel, requireOwner, type Actor } from './actor'
import { requireBusiness } from './business'
import { businessRevisionGuard, requireBillingEntity } from './billing-entities'
import { commit, fingerprint, guard, insist, newId, now, one, type Row, stmt } from './core'
import { parseInstant } from './dates'
import { Input } from './input'
import { requireFreshFactor } from './mfa'
import { NUMBERING_STRIPE_VERSION, numberingStripe } from './numbering-provider'

const formatted = (prefix: string, width: number, next: number) => prefix + String(next).padStart(width, '0')
async function captureBasis(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor); await requireFreshFactor(env, actor)
  const business = await requireBusiness(env)
  insist(input.integer('revision', { min: 1, max: 1_000_000 }) === business.revision, 'stale', 409)
  const kind = input.text('kind', { max: 20, optional: true }) || 'invoice'
  insist(kind === 'invoice' || kind === 'credit-note', 'invalid_document_kind')
  const customerId = input.text('customer', { max: 100, optional: true })
  const customer = customerId ? await one(env, 'SELECT * FROM nc_customers WHERE id=? AND erased_at IS NULL', customerId) : null
  insist(!customerId || customer, 'customer_not_found', 404)
  const entityId = input.text('entity', { max: 100, optional: true }) || customer?.billing_entity_id || null
  const entity = entityId ? await requireBillingEntity(env, entityId) : null
  insist(!customer || (customer.billing_entity_id ?? null) === entityId, 'numbering_entity_customer_mismatch', 409)
  const source = await one(env, 'SELECT i.*,c.billing_entity_id AS customer_entity FROM nc_incumbent_invoices i JOIN nc_customers c ON c.id=i.customer_id WHERE i.id=? AND i.document_kind=? AND c.erased_at IS NULL', input.text('source_invoice', { max: 100 }), kind)
  insist(source && source.provider === 'stripe' && (!customer || source.customer_id === customer.id), 'source_invoice_not_found', 404)
  insist((source.billing_entity_id ?? source.customer_entity ?? null) === entityId, 'source_invoice_entity_mismatch', 409)
  return { business, kind, customer, entity, source }
}
function contiguous(source: Row, prefix: string, width: number, next: number) {
  const parsed = source.number?.match(/^(.*?)(\d+)$/)
  insist(parsed && /^[A-Z0-9-]{1,40}$/.test(prefix) && prefix.endsWith('-') && width >= 1 && width <= 12,
    'unsupported_invoice_number_format')
  const last = Number(parsed[2])
  insist(parsed[1] === prefix && Number.isSafeInteger(last) && last > 0 && formatted(prefix, width, last) === source.number,
    'numbering_source_format_mismatch', 409)
  insist(Number.isSafeInteger(next) && next === last + 1 && next < Number.MAX_SAFE_INTEGER,
    'numbering_source_not_contiguous', 409)
}
async function save(env: Bindings, actor: Actor, basis: Awaited<ReturnType<typeof captureBasis>>, value: Row) {
  const { business, kind, customer, entity, source } = basis
  contiguous(source, value.prefix, value.width, value.next)
  insist(!entity || value.accountRef === entity.processor_account_ref, 'numbering_source_account_mismatch', 409)
  insist((value.mode === 'customer') === !!customer, 'numbering_source_scope_mismatch', 409)
  const id = newId(), sourceJson = JSON.stringify(value.original), sourceHash = await fingerprint(value.original), at = now()
  await commit(env, [businessRevisionGuard(env, business),
    guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_incumbent_invoices WHERE id=? AND number=? AND revision=?)', source.id, source.number, source.revision),
    ...(customer ? [guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_customers WHERE id=? AND revision=? AND erased_at IS NULL AND billing_entity_id IS ?)', customer.id, customer.revision, entity?.id ?? null)] : []),
    ...(entity ? [guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_billing_entities WHERE id=? AND revision=?)', entity.id, entity.revision)] : []),
    stmt(env, `INSERT INTO nc_numbering_sources(id,entity_id,customer_id,source_invoice_id,kind,provider,account_ref,numbering_mode,capture_kind,prefix,width,next_number,last_number,observed_at,source_json,source_hash,captured_by,captured_at)
      VALUES(?,?,?,?,?,'stripe',?,?,?,?,?,?,?,?,?,?,?,?)`, id, entity?.id ?? null, customer?.id ?? null, source.id, kind, value.accountRef, value.mode, value.captureKind, value.prefix, value.width, value.next, source.number, value.observedAt, sourceJson, sourceHash, actorLabel(actor), at)],
    { actor: actorLabel(actor), action: value.captureKind === 'live-customer-api' ? 'invoice.series.capture-live' : 'invoice.series.capture', subject: id,
      detail: { entity: entity?.id ?? null, customer: customer?.id ?? null, kind, sourceInvoice: source.id, captureKind: value.captureKind, accountRef: value.accountRef, sourceHash } })
  return { id, kind, entity: entity?.id ?? null, customer: customer?.id ?? null, captureKind: value.captureKind, nextNumber: formatted(value.prefix, value.width, value.next), sourceHash }
}
export async function captureNumberingSource(env: Bindings, actor: Actor, input: Input) {
  const basis = await captureBasis(env, actor, input)
  insist(input.flag('confirm'), 'numbering_capture_confirmation_required')
  const raw = input.json('capture')
  insist(raw && typeof raw === 'object' && !Array.isArray(raw), 'invalid_numbering_capture')
  const capture = Input.of(raw as Row)
  capture.only(['provider','account_ref','numbering_mode','prefix','width','next_number','observed_at','evidence'])
  insist(!capture.has('provider') || capture.text('provider') === 'stripe', 'invalid_numbering_provider')
  const accountRef = capture.text('account_ref', { max: 120 }), mode = capture.text('numbering_mode', { max: 20 })
  insist(/^[A-Za-z0-9_.:-]+$/.test(accountRef) && !/^(?:sk|rk)_(?:test|live)_|^whsec_/i.test(accountRef), 'invalid_routing_reference')
  insist(mode === 'account' || mode === 'customer', 'invalid_numbering_mode')
  const prefix = capture.text('prefix', { max: 40 }), width = capture.integer('width', { min: 1, max: 12 })!, next = capture.integer('next_number', { min: 1, max: Number.MAX_SAFE_INTEGER - 1 })!
  const observedAt = parseInstant(capture.text('observed_at', { max: 50 })), evidence = capture.text('evidence', { max: 2000 })
  insist(observedAt <= now(), 'numbering_observation_in_future')
  insist(!/\b(?:sk|rk)_(?:test|live)_|\bwhsec_|\bBearer\s/i.test(evidence), 'numbering_capture_contains_credential')
  return await save(env, actor, basis, { prefix, width, next, observedAt, accountRef, mode, captureKind: 'owner-recorded-settings',
    original: { provider: 'stripe', account_ref: accountRef, numbering_mode: mode, prefix, width, next_number: next, observed_at: capture.text('observed_at'), evidence, verification: 'owner-recorded-settings' } })
}
export async function captureLiveCustomerNumberingSource(env: Bindings, actor: Actor, input: Input) {
  const basis = await captureBasis(env, actor, input)
  insist(basis.kind === 'invoice' && basis.customer, 'live_customer_invoice_scope_required')
  const customerRef = basis.customer.provider_ref || basis.customer.external_id
  insist(/^[A-Za-z0-9_-]+$/.test(customerRef) && /^[A-Za-z0-9_-]+$/.test(basis.source.provider_ref), 'invalid_stripe_numbering_resource')
  const stripe = numberingStripe(env), account = await stripe('/account')
  const customer = await stripe(`/customers/${customerRef}`), invoice = await stripe(`/invoices/${basis.source.provider_ref}`)
  insist(account.object === 'account' && typeof account.id === 'string' && customer.object === 'customer' && customer.id === customerRef && !customer.deleted, 'stripe_numbering_response_invalid', 502)
  insist(Number.isSafeInteger(customer.next_invoice_sequence) && customer.next_invoice_sequence > 0,
    'stripe_account_numbering_requires_owner_capture', 409)
  insist(invoice.object === 'invoice' && invoice.id === basis.source.provider_ref && invoice.number === basis.source.number && ['open','paid','uncollectible','void'].includes(invoice.status)
    && (typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id) === customerRef, 'stripe_numbering_source_changed', 409)
  const parsed = basis.source.number.match(/^(.*?)(\d+)$/)
  insist(parsed && typeof customer.invoice_prefix === 'string', 'unsupported_invoice_number_format')
  return await save(env, actor, basis, { prefix: `${customer.invoice_prefix}-`, width: parsed[2].length, next: customer.next_invoice_sequence,
    observedAt: now(), accountRef: account.id, mode: 'customer', captureKind: 'live-customer-api',
    original: { provider: 'stripe', api_version: NUMBERING_STRIPE_VERSION, endpoint: `/v1/customers/${customerRef}`,
      account: { id: account.id }, customer: { id: customer.id, invoice_prefix: customer.invoice_prefix, next_invoice_sequence: customer.next_invoice_sequence, livemode: customer.livemode },
      invoice: { id: invoice.id, customer: customerRef, number: invoice.number, status: invoice.status } } })
}
export async function assertLiveNumberingSourceCurrent(env: Bindings, source: Row) {
  if (source.capture_kind !== 'live-customer-api') return
  const original = JSON.parse(source.source_json), stripe = numberingStripe(env)
  const account = await stripe('/account'), customer = await stripe(`/customers/${original.customer.id}`)
  insist(account.id === source.account_ref && customer.id === original.customer.id && `${customer.invoice_prefix}-` === source.prefix && customer.next_invoice_sequence === source.next_number,
    'stripe_numbering_source_changed', 409)
}
