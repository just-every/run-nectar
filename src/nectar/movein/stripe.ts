import { importedAmountDiscounts } from './imported-discounts'
import { pendingItemValue } from './pending-items'
import { importedCancellation } from './cancellation'
import { importedSchedule } from './schedules'
import { importedTaxFields } from './tax-ids'
import { importOriginalFiles } from '../import-originals'
// Move-in kit 1: Stripe Billing records. Reads owner-captured Stripe API list
// responses (customers, products, prices, subscriptions, invoices and,
// for metered prices, billing meters) plus a manifest of what was captured.
// Through Base's import kit: a dry-run preview that writes nothing, apply bound
// to the reviewed fingerprint, a durable journal with retained originals,
// re-import that adds nothing, and strict undo of an untouched batch.
// Import is read-only history: subscriptions arrive in shadow mode and cannot
// be issued until the owner adopts each one at a cutover date after the last
// period Stripe billed, so a moved-in subscription never bills twice.
import type { Bindings } from '../../auth.server'
import { planD1Import, createD1ImportJob, applyD1ImportBatches, resumeD1Import, undoD1Import, canonicalJson, sha256, type D1ImportContext, type SourceBundle, type SourceRecord, type Json, type TargetEffect } from '../../modules/import-kit/src/d1/index'
import { sourceIdentity } from '../../modules/import-kit/src/provenance/identity'
import { actorLabel, requireMember, requireOwner, type Actor } from '../actor'
import { requireFreshFactor } from '../mfa'
import { requireBusiness } from '../business'
import { NectarError, all, commit, guard, insist, newId, now, one, parseJson, stmt, type Row } from '../core'
import { decimalText, micros } from '../decimal'
import { isDate, localDate, periodContaining } from '../dates'
import type { Input } from '../input'
import { KINDS, auditedNectarTargets } from './target'
import { HISTORY_FILES, duplicateStripeSource, stripeCreditEvidence, stripeHistoryValue, stripeInvoiceEvidence, type HistorySourceKind } from './history'

const namespace = 'stripe', mappingVersion = 'stripe-billing-1', destination = 'billing'
const FILE_BYTES = 6_000_000
export const FILES = ['manifest', 'customers', 'products', 'prices', 'meters', 'subscriptions', 'invoice_items', 'invoices', 'credit_notes', ...HISTORY_FILES] as const
type FileName = typeof FILES[number]
const REQUIRED: FileName[] = ['manifest', 'customers', 'products', 'prices', 'subscriptions']
const MAX_ITEMS = 6

export interface Preview {
  fingerprint: string
  counts: Json
  create: Record<string, number>
  rejected: { location: string; reason: string }[]
  attention: { location: string; reason: string }[]
  coverage: { file: string; manifest: number | null; found: number; complete: boolean }[]
  gaps: string[]
  carry: Record<string, string>
}

interface KitFile { filename: string; bytes: Uint8Array }

async function kitFile(input: Input, name: FileName, optional: boolean): Promise<KitFile | null> {
  if (input.has(`${name}_b64`)) {
    const base64 = input.text(`${name}_b64`, { max: 9_000_000 })
    insist(/^[A-Za-z0-9+/]*={0,2}$/.test(base64), 'invalid_base64')
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0))
    insist(bytes.length > 0 && bytes.length <= FILE_BYTES, 'file_size')
    return { filename: input.text(`${name}_name`, { max: 200 }), bytes }
  }
  const file = await input.file(name, { optional, maxBytes: FILE_BYTES })
  return file ? { filename: file.filename, bytes: file.bytes } : null
}

const hex = (text: string) => sha256(text).slice(0, 32)
export const targetIds = {
  customer: (id: string) => hex(`nectar:stripe:customer:${id}`), product: (id: string) => hex(`nectar:stripe:product:${id}`), meter: (id: string) => hex(`nectar:stripe:meter:${id}`),
  price: (id: string) => hex(`nectar:stripe:price:${id}`), subscription: (id: string) => hex(`nectar:stripe:subscription:${id}`), invoice: (id: string) => hex(`nectar:stripe:invoice:${id}`),
  item: (id: string) => hex(`nectar:stripe:item:${id}`), amendment: (id: string) => hex(`nectar:stripe:discount:${id}`),
}

/** Stripe stores amounts in cents; unit_amount_decimal may carry up to twelve decimals of a cent. */
function dollarsFromCents(decimalCents: string): string | null {
  if (!/^\d{1,12}(\.\d{1,12})?$/.test(decimalCents)) return null
  const [whole, fraction = ''] = decimalCents.split('.')
  if (fraction.length > 4 && /[1-9]/.test(fraction.slice(4))) return null
  return decimalText(micros(`${whole}.${fraction.slice(0, 4) || '0'}`) / 100n)
}

const listOf = (json: any, file: string): any[] => {
  if (Array.isArray(json)) return json
  if (json && json.object === 'list' && Array.isArray(json.data)) return json.data
  throw new NectarError('not_a_stripe_list', 400, { file })
}
const idOf = (value: any): string => typeof value === 'string' ? value : typeof value?.id === 'string' ? value.id : ''

async function build(env: Bindings, actor: Actor, input: Input) {
  const business = await requireBusiness(env)
  const zone = business.timezone
  const files = {} as Record<FileName, KitFile | null>
  for (const name of FILES) files[name] = await kitFile(input, name, !REQUIRED.includes(name))
  const carry: Record<string, string> = {}
  const artifacts: SourceBundle['artifacts'] = [], records: SourceRecord[] = []
  const parsed = {} as Record<FileName, any>
  const hashes = {} as Record<FileName, string>
  for (const name of FILES) {
    const file = files[name]
    if (!file) continue
    const base64 = btoa(Array.from(file.bytes, byte => String.fromCharCode(byte)).join(''))
    hashes[name] = sha256(file.bytes)
    artifacts.push({ name: file.filename, sha256: hashes[name], size: file.bytes.length, original: { status: 'available', base64 } })
    carry[`${name}_b64`] = base64
    carry[`${name}_name`] = file.filename
    try { parsed[name] = JSON.parse(new TextDecoder().decode(file.bytes)) } catch { throw new NectarError('invalid_json_file', 400, { file: name }) }
  }
  const manifest = parsed.manifest
  insist(manifest && typeof manifest === 'object' && manifest.source === 'stripe', 'invalid_manifest')
  const lists = {} as Record<FileName, any[]>
  const coverage: Preview['coverage'] = []
  for (const name of FILES.filter(n => n !== 'manifest')) {
    if (!parsed[name]) continue
    lists[name] = listOf(parsed[name], name)
    const declared = manifest.files?.[name]
    const hasMore = parsed[name]?.has_more === true || declared?.has_more === true
    coverage.push({ file: name, manifest: typeof declared?.count === 'number' ? declared.count : null, found: lists[name].length, complete: !hasMore && declared?.count === lists[name].length })
    const invalid = duplicateStripeSource(lists[name])
    insist(!invalid, 'invalid_capture_source', 400, { file: name, reason: invalid })
  }
  insist(!manifest.files?.credit_notes?.count || !!parsed.credit_notes, 'capture_incomplete')
  for (const name of HISTORY_FILES) insist(!manifest.files?.[name] || !!parsed[name], 'capture_incomplete', 400, { file: name })
  insist(!manifest.files?.invoice_items || !!parsed.invoice_items, 'capture_incomplete', 400, { file: 'invoice_items' })
  const incomplete = coverage.filter(entry => !entry.complete)
  if (incomplete.length) throw new NectarError('capture_incomplete', 400, incomplete)

  const record = (kind: string, object: any, file: FileName, index: number) => {
    const payload = object as Json
    records.push({ namespace, kind, sourceId: `${kind}:${object.id}`, payload, payloadHash: sha256(canonicalJson(payload)), artifactHash: hashes[file], location: { artifact: files[file]!.filename, row: index + 1 } })
  }
  // Order matters: everything an entity refers to is planned before it.
  for (const [index, meter] of (lists.meters ?? []).entries()) record('meter', meter, 'meters', index)
  for (const [index, item] of lists.products.entries()) record('product', item, 'products', index)
  for (const [index, item] of [...lists.prices.entries()].sort((a, b) => (a[1].created ?? 0) - (b[1].created ?? 0) || String(a[1].id).localeCompare(String(b[1].id)))) record('price', item, 'prices', index)
  for (const [index, item] of lists.customers.entries()) record('customer', item, 'customers', index)
  for (const [index, item] of lists.subscriptions.entries()) record('subscription', item, 'subscriptions', index)
  for (const [index, item] of (lists.invoice_items ?? []).entries()) record('pending_item', item, 'invoice_items', index)
  for (const [index, item] of (lists.invoices ?? []).entries()) record('invoice', item, 'invoices', index)
  for (const [index, item] of (lists.credit_notes ?? []).entries()) record('credit_note', item, 'credit_notes', index)
  for (const [file, kind] of [['payments','payment'],['refunds','refund'],['disputes','dispute'],['subscription_events','subscription_event']] as const)
    for (const [index, item] of (lists[file] ?? []).entries()) record(kind, item, file, index)

  // What already exists in Nectar.
  const nativeCustomers = new Map((await all(env, "SELECT id, external_id, origin FROM nc_customers")).map(row => [row.external_id, row]))
  const nativeProducts = new Set((await all(env, "SELECT code FROM nc_products WHERE origin = 'native'")).map(row => row.code))
  const nativeMeters = new Map((await all(env, 'SELECT id, code, origin FROM nc_meters')).map(row => [row.code, row]))
  const claimed = new Map((await all(env, 'SELECT target_kind, target_id, record_json FROM ik_provenance WHERE destination = ? AND reversed = 0', destination)).map(row => [`${row.target_kind}:${row.target_id}`, JSON.parse(row.record_json).sourceIdentity as string]))
  const conflict = (kind: string, id: string, source: SourceRecord) => { const owner = claimed.get(`${kind}:${id}`); return owner !== undefined && owner !== sourceIdentity(destination, namespace, source.kind, source.sourceId) }
  const existing = new Set<string>()
  for (const [kind, target] of Object.entries(KINDS)) for (const id of await target.ids(env.DB as never)) existing.add(`${kind}:${id}`)

  const rejected: Preview['rejected'] = [], attention: Preview['attention'] = []
  const create: Record<string, number> = { meter: 0, product: 0, price: 0, customer: 0, subscription: 0, invoice: 0 }
  if (lists.credit_notes) create.credit_note = 0
  if (lists.invoice_items) create.pending_item = 0
  if (HISTORY_FILES.some(name => lists[name])) create.history = 0
  const at = (source: SourceRecord) => `${source.location.artifact} #${source.location.row} (${String(source.sourceId).split(':').slice(1).join(':')})`
  const reject = (source: SourceRecord, reason: string) => { rejected.push({ location: at(source), reason }); return { effects: [], rejection: reason } }
  const note = (source: SourceRecord, reason: string) => attention.push({ location: at(source), reason })
  const effect = (targetKind: string, targetId: string, value: Record<string, Json>): TargetEffect => ({ targetKind, targetId, value })
  const dateOf = (unix: unknown) => typeof unix === 'number' && Number.isFinite(unix) ? localDate(unix * 1000, zone) : null

  // Pre-pass: which prices and customers will map, so subscriptions can refer to them.
  const meters = new Map<string, { id: string; code: string; unit: string }>()
  for (const m of lists.meters ?? []) if (typeof m?.event_name === 'string') meters.set(m.id, { id: nativeMeters.get(m.event_name.toLowerCase())?.origin === 'native' ? nativeMeters.get(m.event_name.toLowerCase())!.id : targetIds.meter(m.id), code: m.event_name.toLowerCase(), unit: String(m.display_name ?? m.event_name) })
  const products = new Map(lists.products.map(p => [p.id, p]))
  const quantityOver1 = new Set<string>()
  for (const s of lists.subscriptions) for (const item of s?.items?.data ?? []) if ((item.quantity ?? 1) !== 1) quantityOver1.add(idOf(item.price))
  const priceVersion = new Map<string, number>(), versions = new Map<string, number>()
  const priceOk = (p: any) => p && p.currency === 'usd' && p.recurring?.interval === 'month' && (p.recurring?.interval_count ?? 1) === 1 && (p.billing_scheme ?? 'per_unit') === 'per_unit' && dollarsFromCents(String(p.unit_amount_decimal ?? p.unit_amount ?? '')) !== null && products.has(idOf(p.product)) && !nativeProducts.has(String(idOf(p.product)).toLowerCase()) && (p.recurring?.usage_type !== 'metered' || meters.has(p.recurring?.meter))
  for (const p of [...lists.prices].sort((a, b) => (a.created ?? 0) - (b.created ?? 0) || String(a.id).localeCompare(String(b.id)))) {
    if (!priceOk(p)) continue
    const product = idOf(p.product), version = (versions.get(product) ?? 0) + 1
    versions.set(product, version); priceVersion.set(p.id, version)
  }
  const customerTarget = (stripeId: string) => {
    const native = nativeCustomers.get(stripeId)
    if (native && native.origin === 'native') return native.id
    return lists.customers.some(c => c.id === stripeId && !c.deleted) ? targetIds.customer(stripeId) : null
  }
  const historyContext = { customers: lists.customers, invoices: lists.invoices ?? [], subscriptions: lists.subscriptions, subscriptionEvents: lists.subscription_events ?? [], payments: lists.payments ?? [], prices: lists.prices, customerTarget, zone }
  const mappedSubscriptions = new Set<string>(), mappedInvoices = new Set<string>()
  const discountOwners = new Map<string, string>()

  const context = importContext(env, actor)
  const plan = await planD1Import({ artifacts, records, diagnostics: [] }, {
    version: mappingVersion,
    map(source) {
      const o = source.payload as any
      if (source.kind === 'pending_item') {
        const value = pendingItemValue(o, { subscriptions: lists.subscriptions, zone, customerTarget,
          subscriptionTarget: targetIds.subscription, mappedSubscriptions })
        const id = hex(`nectar:stripe:pending-item:${o.id}`)
        if (conflict('pending_item', id, source)) return reject(source, 'already imported earlier with different values')
        if (!existing.has(`pending_item:${id}`)) create.pending_item++
        return { effects: [effect('pending_item', id, value)] }
      }
      if (['payment','refund','dispute','subscription_event'].includes(source.kind)) {
        const captured = stripeHistoryValue(source.kind as HistorySourceKind, o, historyContext)
        if (captured.reason !== undefined) return reject(source, captured.reason)
        const id = hex(`nectar:stripe:history:${source.kind}:${o.id}`)
        if (conflict('history', id, source)) return reject(source, 'already imported earlier with different values')
        if (!existing.has(`history:${id}`)) create.history++
        return { effects: [effect('history', id, { ...captured.value })] }
      }
      if (source.kind === 'meter') {
        if (typeof o.event_name !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,59}$/i.test(o.event_name)) return reject(source, 'meter has no usable event_name')
        const code = o.event_name.toLowerCase()
        if (nativeMeters.get(code)?.origin === 'native') { note(source, `uses the existing Nectar meter "${code}"`); return { effects: [], unmapped: [{ reason: 'existing native meter' }] } }
        const id = targetIds.meter(o.id)
        if (conflict('meter', id, source)) return reject(source, 'already imported earlier with different values')
        if (o.default_aggregation?.formula && o.default_aggregation.formula !== 'sum') note(source, `aggregation "${o.default_aggregation.formula}" is not sum; Nectar sums event quantities`)
        if (!existing.has(`meter:${id}`)) create.meter++
        return { effects: [effect('meter', id, { code, name: String(o.display_name ?? code).slice(0, 120), unitLabel: String(o.display_name ?? 'units').slice(0, 40), providerRef: o.id })] }
      }
      if (source.kind === 'product') {
        const code = String(o.id).toLowerCase()
        if (nativeProducts.has(code)) return reject(source, `a Nectar product with code ${code} already exists`)
        const id = targetIds.product(o.id)
        if (conflict('product', id, source)) return reject(source, 'already imported earlier with different values')
        if (o.active === false) note(source, 'inactive in Stripe; imported so history keeps its name')
        if (!existing.has(`product:${id}`)) create.product++
        return { effects: [effect('product', id, { code, name: String(o.name ?? code).slice(0, 120), description: String(o.description ?? '').slice(0, 500), providerRef: o.id })] }
      }
      if (source.kind === 'price') {
        if (o.currency !== 'usd') return reject(source, `currency ${o.currency} is not USD; the first release bills in USD only`)
        if (o.type === 'one_time' || !o.recurring) return reject(source, 'one-time prices are not subscription prices')
        if (o.recurring.interval !== 'month' || (o.recurring.interval_count ?? 1) !== 1) return reject(source, `billed every ${o.recurring.interval_count ?? 1} ${o.recurring.interval}; the first release bills monthly`)
        if ((o.billing_scheme ?? 'per_unit') !== 'per_unit') return reject(source, 'tiered pricing is not in the first release')
        const amount = dollarsFromCents(String(o.unit_amount_decimal ?? o.unit_amount ?? ''))
        if (amount === null) return reject(source, 'unit amount is missing or finer than a millionth of a dollar')
        const product = idOf(o.product)
        if (!products.has(product)) return reject(source, `product ${product} is not in products.json`)
        if (nativeProducts.has(product.toLowerCase())) return reject(source, 'its product was not imported')
        const metered = o.recurring.usage_type === 'metered'
        if (metered && !meters.has(o.recurring.meter)) return reject(source, 'metered price without a meter in meters.json')
        const id = targetIds.price(o.id)
        if (conflict('price', id, source)) return reject(source, 'already imported earlier with different values')
        const kind = metered ? 'unit' : o.metadata?.nectar_kind === 'flat' || o.metadata?.nectar_kind === 'seat' ? o.metadata.nectar_kind : quantityOver1.has(o.id) ? 'seat' : 'flat'
        if (o.tax_behavior && o.tax_behavior !== 'unspecified') note(source, `Stripe tax behavior "${o.tax_behavior}"; Nectar applies its own declared tax policy`)
        if (!existing.has(`price:${id}`)) create.price++
        return { effects: [effect('price', id, { productId: targetIds.product(product), version: priceVersion.get(o.id)!, kind, unitAmount: amount, meterId: metered ? meters.get(o.recurring.meter)!.id : null, taxable: 1, nickname: String(o.nickname ?? o.lookup_key ?? '').slice(0, 80), providerRef: o.id })] }
      }
      if (source.kind === 'customer') {
        const native = nativeCustomers.get(o.id)
        if (native && native.origin === 'native') { note(source, 'already in Nectar with this external id; history attaches to it'); return { effects: [], unmapped: [{ reason: 'existing native customer' }] } }
        if (o.deleted) return reject(source, 'deleted in Stripe')
        const id = targetIds.customer(o.id)
        if (conflict('customer', id, source)) return reject(source, 'already imported earlier with different values')
        const email = String(o.email ?? '').toLowerCase()
        if (!email) note(source, 'no email in Stripe; add a billing email before issuing invoices')
        const address = o.address ? [o.address.line1, o.address.line2, o.address.city, o.address.state, o.address.postal_code, o.address.country].filter(Boolean).join(', ') : ''
        const exempt = o.tax_exempt === 'exempt' || o.tax_exempt === 'reverse'
        const invoiceSettings = importedTaxFields(o)
        if (exempt) note(source, `Stripe tax_exempt "${o.tax_exempt}" imported as an exemption; keep the certificate on file`)
        if (!existing.has(`customer:${id}`)) create.customer++
        return { effects: [effect('customer', id, { externalId: o.id, name: String(o.name ?? o.description ?? o.id).slice(0, 160), billingEmail: email, address: address.slice(0, 400), taxExempt: exempt ? 1 : 0, taxExemptRef: exempt ? `stripe:${o.tax_exempt}` : '', providerRef: o.id, ...(invoiceSettings ? { invoiceSettings } : {}) })] }
      }
      if (source.kind === 'subscription') {
        if (['incomplete', 'incomplete_expired', 'paused'].includes(o.status)) return reject(source, `status "${o.status}" has no billing to move; resolve it in Stripe first`)
        const customerId = customerTarget(idOf(o.customer))
        if (!customerId) return reject(source, `customer ${idOf(o.customer)} is not in customers.json`)
        const anchor = dateOf(o.billing_cycle_anchor), start = dateOf(o.start_date)
        if (!anchor || !start) return reject(source, 'missing start_date or billing_cycle_anchor')
        const anchorDay = Number(anchor.slice(8))
        if (anchorDay > 28) return reject(source, `billing day ${anchorDay}: the first release supports billing days 1–28; move the anchor in Stripe first`)
        const items = o.items?.data ?? []
        if (!items.length || items.length > MAX_ITEMS) return reject(source, `has ${items.length} items; the kit moves 1–${MAX_ITEMS} items per subscription`)
        const mapped = []
        for (const item of items) {
          const priceId = idOf(item.price)
          if (!priceVersion.has(priceId)) return reject(source, `price ${priceId} was not imported; historical evidence is retained but unsupported billing terms are not installed`)
          mapped.push({ id: targetIds.item(item.id), priceId: targetIds.price(priceId), quantity: item.quantity ?? 1, from: start, to: null, providerRef: item.id })
        }
        const end = importedCancellation(o, zone)
        const trialEnd = o.trial_end && dateOf(o.trial_end)! > start ? dateOf(o.trial_end) : null
        const amendments = []
        const { discounts, amounts } = importedAmountDiscounts(o, { zone, anchorDay, prices: lists.prices, supportedPrice: priceOk,
          priceId: targetIds.price, identity: id => hex(`nectar:stripe:amount-discount:${id}`) })
        for (const discount of discounts) {
          insist(!discountOwners.has(discount.id) || discountOwners.get(discount.id) === o.id, 'unsupported_imported_discount', 400, { reason: 'one discount identity cannot belong to different subscriptions' })
          discountOwners.set(discount.id, o.id)
          const coupon = discount.coupon ?? discount.source?.coupon
          if (coupon?.percent_off && (coupon.duration === 'forever' || coupon.duration === 'repeating' || coupon.duration === 'once')) {
            const from = dateOf(discount.start) ?? start
            const to = discount.end ? dateOf(discount.end) : coupon.duration === 'once' ? periodContaining(anchorDay, from).end : null
            amendments.push({ id: targetIds.amendment(discount.id ?? `${o.id}:${coupon.id}`), kind: 'discount_percent', value: decimalText(micros(String(coupon.percent_off))), from, to, note: `Stripe coupon ${coupon.name ?? coupon.id}`, status: 'approved' })
          } else if (coupon?.amount_off == null && coupon) note(source, `coupon ${coupon.id} (${coupon.amount_off ? 'fixed amount' : 'unsupported'}) is not moved; record it as a contract exception in Nectar`)
        }
        const scheduled = importedSchedule(o, mapped, { zone, anchorDay, prices: lists.prices, supportedPrice: priceOk,
          priceId: targetIds.price, identity: id => hex(`nectar:stripe:schedule-item:${id}`), endDate: end })
        if (typeof o.schedule === 'string') note(source, `Stripe subscription schedule ${o.schedule} has no captured phases; future changes are not installed`)
        if (o.default_tax_rates?.length) note(source, 'Stripe tax rates are not moved; Nectar applies its declared tax policy')
        const id = targetIds.subscription(o.id)
        if (conflict('subscription', id, source)) return reject(source, 'already imported earlier with different values')
        if (!existing.has(`subscription:${id}`)) create.subscription++
        mappedSubscriptions.add(o.id)
        return { effects: [effect('subscription', id, { customerId, externalId: o.id, anchorDay, startDate: start, trialEnd, endDate: scheduled.endDate && scheduled.endDate > start ? scheduled.endDate : null, providerRef: o.id, scheduleRef: o.schedule ? idOf(o.schedule) : null, collection: String(o.collection_method ?? ''), ...(amounts.length ? { amountCoupons: amounts } : {}), items: scheduled.items.sort((a, b) => a.id.localeCompare(b.id)), amendments: amendments.sort((a, b) => a.id.localeCompare(b.id)) })] }
      }
      // Credit notes retain exact source numbers and amounts as read-only custody.
      // They never create a Nectar credit or change native/imported balances.
      if (source.kind === 'credit_note') {
        const customerId = customerTarget(idOf(o.customer))
        const invoice = (lists.invoices ?? []).find(i => i.id === idOf(o.invoice) && i.status !== 'draft' && idOf(i.customer) === idOf(o.customer))
        if (!customerId || !invoice || !mappedInvoices.has(invoice.id) && !existing.has(`invoice:${targetIds.invoice(invoice.id)}`)) return reject(source, 'credit note needs its captured invoice and matching customer')
        if (!['issued','void'].includes(o.status) || typeof o.number !== 'string' || !o.number || !Number.isSafeInteger(o.total) || o.total < 0 || o.currency !== 'usd') return reject(source, 'unsupported credit-note status, number, currency or amount')
        const evidence = stripeCreditEvidence(o, zone)
        if (evidence.reason !== undefined) return reject(source, evidence.reason)
        const id = hex(`nectar:stripe:credit_note:${o.id}`)
        if (conflict('credit_note', id, source)) return reject(source, 'already imported earlier with different values')
        if (!existing.has(`credit_note:${id}`)) create.credit_note++
        return { effects: [effect('credit_note', id, { provider:'stripe', providerRef:o.id, customerId, subscriptionId:null, number:o.number, status:o.status, periodStart:dateOf(o.created), periodEnd:null, totalCents:o.total, paidCents:0, remainingCents:0, lines:JSON.stringify({ invoice:idOf(o.invoice) }), ...evidence.value })] }
      }
      // Invoices: read-only history for shadow comparison.
      if (o.status === 'draft') return reject(source, 'draft invoices are not history; they are skipped')
      const customerId = customerTarget(idOf(o.customer))
      if (!customerId) return reject(source, `customer ${idOf(o.customer)} is not in customers.json`)
      const subscriptionStripe = idOf(o.subscription ?? o.parent?.subscription_details?.subscription)
      const capturedSubscription = lists.subscriptions.find(s => s.id === subscriptionStripe)
      if (capturedSubscription && idOf(capturedSubscription.customer) !== idOf(o.customer)) return reject(source, 'invoice subscription belongs to a different captured customer')
      const subscriptionId = subscriptionStripe && (mappedSubscriptions.has(subscriptionStripe) || existing.has(`subscription:${targetIds.subscription(subscriptionStripe)}`)) ? targetIds.subscription(subscriptionStripe) : null
      const evidence = stripeInvoiceEvidence(o, lists.prices, zone)
      if (evidence.reason !== undefined) return reject(source, evidence.reason)
      const { lines, discountCents: discount, ...original } = evidence.value
      // Stripe reports discounts on the invoice, not as lines: keep them as one discount line for comparison.
      if (discount && lines.length) lines.push({ description: 'Discounts', amount_cents: -discount, quantity: null, price_ref: null, kind: 'discount', period_start: lines[0].period_start, period_end: lines[0].period_end, proration: false })
      const id = targetIds.invoice(o.id)
      if (conflict('invoice', id, source)) return reject(source, 'already imported earlier with different values')
      if (!existing.has(`invoice:${id}`)) create.invoice++
      mappedInvoices.add(o.id)
      return { effects: [effect('invoice', id, { provider: 'stripe', providerRef: o.id, customerId, subscriptionId, number: String(o.number ?? ''), status: String(o.status), periodStart: dateOf(o.period_start), periodEnd: dateOf(o.period_end), totalCents: Number(o.total ?? 0), paidCents: Number(o.amount_paid ?? 0), remainingCents: Number(o.amount_remaining ?? 0), lines: JSON.stringify(lines), ...original })] }
    },
  }, context)

  const preview: Preview = {
    fingerprint: plan.fingerprint, counts: plan.counts as unknown as Json, create, rejected, attention, coverage,
    gaps: [
      'Stripe keeps card details; they are not part of this move. Payment collection stays with Stripe until a payment adapter exists.',
      'Moved-in subscriptions are in shadow: Nectar rates them and compares with Stripe, but issues nothing until the owner adopts each one at a cutover date.',
      ...(lists.invoices ? [] : ['No invoices.json: without Stripe invoices there is nothing to compare shadow drafts against.']),
      ...(lists.credit_notes ? [] : ['No credit_notes.json: imported credit-note numbering is not captured.']),
      ...HISTORY_FILES.filter(name => !lists[name]).map(name => `No ${name}.json: that historical record kind is not captured.`),
      'Keep billing in Stripe until a shadow bill run agrees with Stripe for a full period.',
    ],
    carry,
  }
  return { plan, preview, context }
}

/** Import authority is checked in SQL on every batch: an active session of the owner or a finance operator. */
function importContext(env: Bindings, actor: Actor): D1ImportContext {
  const predicate = () => ({ sql: `EXISTS(SELECT 1 FROM oa_sessions s JOIN oa_operators o ON o.id = s.operator_id WHERE s.id = ? AND s.revoked_at IS NULL AND s.expires_at > CAST(strftime('%s','now') AS INTEGER) * 1000 AND o.version = s.operator_version AND o.status = 'active'
    AND EXISTS(SELECT 1 FROM nc_members m WHERE m.id = ? AND lower(o.email) = m.email AND m.status = 'active' AND (o.role = 'owner' OR m.role = 'finance')))`, params: [actor.sessionId, actor.id] })
  return { destination, namespace, mappingVersion, storage: { database: env.DB as never, targets: auditedNectarTargets(actorLabel(actor)) }, authorization: { principalId: actor.id, predicate }, batchSize: 25 }
}

export async function previewImport(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'records')
  return (await build(env, actor, input)).preview
}

export async function applyImport(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'records')
  const reviewed = input.text('fingerprint', { max: 100 })
  const { plan, context } = await build(env, actor, input)
  insist(plan.fingerprint === reviewed, 'reviewed_fingerprint_changed', 409)
  // A repeated apply of the same preview returns its job; after an undo, applying it again is a new job.
  const undone = (await one<{ n: number }>(env, "SELECT COUNT(*) AS n FROM ik_jobs WHERE destination = ? AND fingerprint = ? AND state IN ('undone', 'rolled_back')", destination, reviewed))!.n
  const reviewedContext = { ...context, reviewedFingerprint: reviewed, ...(undone ? { operationKey: `${reviewed}:${undone}` } : {}) }
  const job = await createD1ImportJob(plan, reviewedContext)
  const result = await applyD1ImportBatches(job.id, reviewedContext).catch(error => {
    // Retiring source custody invalidates its saved review. A replay is a
    // conflict for the operator; it never gains a fresh import authority.
    if (error instanceof Error && error.message === 'REVIEW_FINGERPRINT_MISMATCH') throw new NectarError('reviewed_fingerprint_changed', 409)
    throw error
  })
  await commit(env, [], { actor: actorLabel(actor), action: 'import.apply', subject: job.id, detail: { kit: 'stripe', fingerprint: reviewed, counts: plan.counts } })
  return { job: job.id, state: result.state }
}

/** Every imported entity that has since been edited or built on: undo is refused until each is reversed. */
export async function undoBlockers(env: Bindings, jobId: string) {
  const rows = await all(env, 'SELECT target_kind, target_id, record_json FROM ik_provenance WHERE job_id = ? AND reversed = 0', jobId)
  const blockers: { kind: string; target: string; reason: string }[] = []
  for (const row of rows) {
    const recorded = JSON.parse(row.record_json)
    const current = await KINDS[row.target_kind].read(env.DB as never, row.target_id)
    if (!current) blockers.push({ kind: row.target_kind, target: row.target_id, reason: 'removed since import' })
    else if ('dependents' in current.value) blockers.push({ kind: row.target_kind, target: row.target_id, reason: `${current.value.dependents} later record(s) depend on it` })
    else if (current.revision !== recorded.appliedRevision || sha256(canonicalJson(current.value as Json)) !== recorded.valueHash) blockers.push({ kind: row.target_kind, target: row.target_id, reason: 'edited since import' })
  }
  return blockers
}

export async function importAction(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'records')
  const job = input.text('job', { max: 100 }), action = input.text('action', { max: 10 })
  const context = importContext(env, actor)
  if (action === 'resume') return await resumeD1Import(job, context)
  insist(action === 'undo', 'invalid_action')
  const blockers = await undoBlockers(env, job)
  insist(!blockers.length, 'undo_blocked', 409, { blockers })
  const result = await undoD1Import(job, context)
  await commit(env, [], { actor: actorLabel(actor), action: 'import.undo', subject: job, detail: { state: result.state } })
  return { job, state: result.state }
}

export async function importJobs(env: Bindings, actor: Actor) {
  requireMember(actor, 'records')
  const jobs = await all<{ id: string; at: number; detail: string; state: string; total: number }>(env,
    `SELECT j.id, a.at, a.detail, j.state, j.total FROM ik_jobs j JOIN nc_audit a ON a.seq=(SELECT MIN(seq) FROM nc_audit WHERE action='import.apply' AND subject=j.id)
     WHERE a.action = 'import.apply' AND j.destination = ? AND j.namespace = ? AND j.mapping_version = ? ORDER BY a.at DESC`, destination, namespace, mappingVersion)
  const result = []
  for (const job of jobs) result.push({ originalFiles:actor.kind==='member'&&actor.role==='owner'?await importOriginalFiles(env,actor,job.id):[],id: job.id, appliedAt: job.at, state: job.state, counts: JSON.parse(job.detail).counts, effects: job.total, blockers: job.state === 'completed' ? await undoBlockers(env, job.id) : [] })
  return result
}

/** Moved-in subscriptions still in shadow, with the last period Stripe billed and the first period Nectar may bill. */
export async function shadowSubscriptions(env: Bindings, actor: Actor) {
  requireMember(actor, 'read')
  const subs = await all(env, "SELECT s.id, s.anchor_day, s.start_date, s.provider_ref, c.name AS customer_name FROM nc_subscriptions s JOIN nc_customers c ON c.id = s.customer_id WHERE s.billing_mode = 'shadow' ORDER BY c.name")
  const result: Row[] = []
  for (const sub of subs) {
    const lines = (await all(env, "SELECT lines_json FROM nc_incumbent_invoices WHERE document_kind='invoice' AND subscription_id = ?", sub.id)).flatMap(row => parseJson<Row[]>(row.lines_json, []))
    const lastBilled = lines.map(line => line.period_start).filter(isDate).sort().pop() ?? null
    const earliest = lastBilled ? periodContaining(sub.anchor_day, lastBilled).end : periodContaining(sub.anchor_day, sub.start_date).start
    const reconciled = (await all(env, "SELECT comparison_json FROM nc_invoices WHERE subscription_id = ? AND status = 'shadow'", sub.id)).some(row => parseJson<Row>(row.comparison_json, {}).incumbent?.reconciled === true)
    result.push({ ...sub, lastBilledPeriodStart: lastBilled, earliestCutover: earliest, reconciled })
  }
  return result
}

/** The owner adopts a shadow subscription: Nectar bills from the cutover period on, never a period Stripe already billed. */
export async function adopt(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor)
  await requireFreshFactor(env, actor)
  const sub = (await shadowSubscriptions(env, actor)).find(row => row.id === input.text('subscription', { max: 100 }))
  insist(sub, 'subscription_not_in_shadow', 404)
  const cutover = input.text('cutover_start', { max: 10 })
  insist(isDate(cutover) && Number(cutover.slice(8)) === sub.anchor_day, 'cutover_must_start_a_period')
  insist(cutover >= sub.earliestCutover, 'cutover_overlaps_previous_biller', 409, { earliest: sub.earliestCutover })
  const pending = await all(env, "SELECT effective_date FROM nc_charges WHERE subscription_id=? AND origin='import' AND invoice_id IS NULL", sub.id)
  insist(pending.every(item => item.effective_date === cutover), 'pending_items_cutover_changed', 409)
  insist(sub.reconciled || input.flag('acknowledge_unreconciled'), 'shadow_not_reconciled', 409)
  const current = await one(env, 'SELECT revision FROM nc_subscriptions WHERE id = ?', sub.id)
  await commit(env, [
    guard(env, 'stale', "EXISTS(SELECT 1 FROM nc_subscriptions WHERE id = ? AND billing_mode = 'shadow' AND revision = ?)", sub.id, current!.revision),
    stmt(env, "UPDATE nc_subscriptions SET billing_mode = 'live', cutover_start = ?, revision = ?, updated_at = ? WHERE id = ?", cutover, newId(), now(), sub.id),
  ], { actor: actorLabel(actor), action: 'subscription.adopt', subject: sub.id, detail: { cutover, lastBilledByStripe: sub.lastBilledPeriodStart, reconciled: sub.reconciled } })
  return { id: sub.id, cutover }
}
