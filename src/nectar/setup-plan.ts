import type { Bindings } from '../auth.server'
import type { Business } from './business'
import { all, insist, newId, one, parseJson, type Row } from './core'
import { canonicalDecimal, cents, micros } from './decimal'
import { addMonthsClamped, addMonths, requireDate } from './dates'
import { Input } from './input'
import { renewalSettings } from './renewal-terms'
import { contractBasis } from './contract-terms'
import { setupCatalog, setupOwnership } from './setup-catalog'
import { setupAnchor, setupIntervalAmbiguities } from './setup-intervals'
import { billingRoute, requireBillingEntity } from './billing-entities'
import { setupPreview } from './setup-preview'
import { invoiceSettings, contentForSettings } from './invoice-content'
import { fields, flag, object, quoted, rows, setupAmbiguities, setupSource } from './setup-source'

const quantity = (row: Row, price: Row) => {
  const q = row.quantity === undefined ? 1 : Input.of(row).integer('quantity', { min: price.kind === 'seat' && price.pricing ? 0 : 1, max: price.pricing ? 1000000000 : 1000000 })!
  insist(price.kind === 'seat' || q === 1, 'invalid_quantity')
  return q
}
const overlap = (a: Row, b: Row) => a.from < (b.to ?? '9999-12-31') && b.from < (a.to ?? '9999-12-31')
const setupDate = (value: string, field: string) => { const date = requireDate(value, field); insist(Number(date.slice(0, 4)) >= 1, `invalid_${field}`); return date }
const periodCount = (from: string, to: string) => {
  const [fy, fm, fd] = from.split('-').map(Number), [ty, tm, td] = to.split('-').map(Number)
  const count = (ty - fy) * 12 + tm - fm + (td > fd ? 1 : 0)
  insist(count > 0, 'invalid_subscription_end')
  setupDate(addMonthsClamped(from, count), 'preview_end')
  return count
}

/** Re-normalizes saved input against current records while retaining generated identities. No writes. */
export async function setupPlan(env: Bindings, business: Business, payload: Row, saved = false): Promise<{ normalized: Row; impact: Row; basis: Row }> {
  const input = saved ? object(payload.input, 'saved_setup_input') : payload
  insist(input.setup === true, 'invalid_setup')
  const prior = saved ? object(payload.plan, 'saved_setup_plan') : {}
  const source = await setupSource(input), quotes: Row[] = []
  const basis: Row = { sourceSha256: source.sha256, business, customer: null, products: [], prices: [], meters: [], productVersions: [], newProducts: [], ownership: [] }
  const c = object(input.customer, 'customer'); fields(c, ['id', 'external_id', 'name', 'billing_email', 'address', 'tax_exempt', 'tax_exempt_ref', 'quote']); quoted(source, c, 'customer', quotes)
  let customer: Row
  if (c.id) {
    fields(c, ['id', 'quote'])
    const found = await one(env, 'SELECT * FROM nc_customers WHERE id=?', Input.of(c).text('id', { max: 100 }))
    insist(found && found.status === 'active', 'customer_not_found', 404)
    basis.customer = found
    customer = { id: found.id, create: false, externalId: found.external_id, name: found.name, billingEmail: found.billing_email, address: found.address, taxExempt: !!found.tax_exempt, taxExemptRef: found.tax_exempt_ref }
  } else {
    const reader = Input.of(c), externalId = reader.text('external_id', { max: 80 }), billingEmail = reader.text('billing_email', { max: 200 }).toLowerCase()
    insist(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(externalId), 'invalid_external_id')
    insist(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(billingEmail), 'invalid_billing_email')
    insist(!await one(env, 'SELECT 1 FROM nc_customers WHERE external_id=?', externalId), 'external_id_in_use', 409)
    const taxExempt = flag(c, 'tax_exempt'), taxExemptRef = reader.text('tax_exempt_ref', { max: 120, optional: true })
    insist(!taxExempt || taxExemptRef, 'exemption_reference_required')
    customer = { id: prior.customer?.id ?? newId(), create: true, externalId, name: reader.text('name', { max: 160 }), billingEmail, address: reader.text('address', { max: 400, optional: true }), taxExempt, taxExemptRef: taxExempt ? taxExemptRef : '' }
    basis.customer = { externalId, absent: true }
  }
  const existingInvoiceSettings = customer.create ? {} : parseJson(basis.customer.invoice_settings_json, {})
  let settings = invoiceSettings(existingInvoiceSettings)
  if (input.invoice !== undefined) {
    const invoice = object(input.invoice, 'invoice')
    fields(invoice, ['paymentTermsDays','poRequired','poNumber','memo','customFields','quote'])
    quoted(source, invoice, 'invoice', quotes)
    const { quote: _quote, ...values } = invoice
    settings = invoiceSettings(values)
    for (const key of Object.keys(values)) quotes.push({ field: `invoice.${key}`, quote: invoice.quote })
  }
  customer.invoiceSettings = settings
  customer.billingEntityId = basis.customer.billing_entity_id ?? null
  customer.entityChanged = false
  let billingEntity: Row | null = null
  insist(!customer.billingEntityId || input.entity !== undefined, 'setup_billing_entity_quote_required', 409)
  if (input.entity !== undefined) {
    const selection = object(input.entity, 'entity')
    fields(selection, ['id', 'processor_account_ref', 'ledger_company_ref', 'quote'])
    quoted(source, selection, 'entity', quotes)
    const er = Input.of(selection), entity = await requireBillingEntity(env, er.text('id', { max: 100 }))
    insist(er.text('processor_account_ref', { max: 120 }) === entity.processor_account_ref && er.text('ledger_company_ref', { max: 120 }) === entity.ledger_company_ref, 'setup_entity_route_mismatch', 409)
    insist([entity.legal_name, entity.processor_account_ref, entity.ledger_company_ref].every(value => selection.quote.includes(value)), 'setup_entity_route_not_quoted')
    for (const setting of ['id', 'processor_account_ref', 'ledger_company_ref']) quotes.push({ field: `entity.${setting}`, quote: selection.quote })
    billingEntity = { id: entity.id, revision: entity.revision, route: billingRoute(business, entity) }
    basis.billingEntity = billingEntity
    customer.entityChanged = !customer.create && customer.billingEntityId !== entity.id
    if (customer.entityChanged) {
      insist(!await one(env, "SELECT 1 FROM nc_invoices WHERE customer_id=? AND status='issued' UNION ALL SELECT 1 FROM nc_credit_notes WHERE customer_id=? LIMIT 1", customer.id, customer.id), 'customer_entity_fixed_after_issue', 409)
    }
    customer.billingEntityId = entity.id
  }
  const invoiceContent = { ...contentForSettings(business, settings), ...(billingEntity ? { paymentTermsDays: settings.paymentTermsDays ?? billingEntity.route.paymentTermsDays, billingEntity } : {}) }
  const s = object(input.subscription, 'subscription'), sr = Input.of(s)
  quoted(source, s, 'subscription', quotes)
  let subscription: Row, originals: Row[] = [], renewal: Row | null = null
  if (s.id) {
    insist(s.renewal === undefined, 'existing_setup_renewal_changes_not_supported')
    fields(s, ['id', 'effective_date', 'months', 'quote'])
    insist(!sr.has('months') || sr.integer('months', { min: 36, max: 36 }) === 36, 'existing_subscription_horizon_is_recorded_end')
    const found = await one(env, 'SELECT * FROM nc_subscriptions WHERE id=?', sr.text('id', { max: 100 }))
    insist(found && found.customer_id === customer.id && found.billing_mode === 'live', 'subscription_not_live', 409)
    const effectiveDate = requireDate(sr.text('effective_date', { max: 10 }), 'effective_date')
    insist(effectiveDate >= (found.cutover_start ?? found.start_date) && (!found.end_date || effectiveDate < found.end_date) && Number(effectiveDate.slice(8)) === found.anchor_day, 'invalid_effective_date')
    insist(!await one(env, "SELECT 1 FROM nc_invoices WHERE subscription_id=? AND status='issued' AND period_end>?", found.id, effectiveDate), 'period_already_invoiced', 409)
    basis.subscription = found
    originals = await all(env, 'SELECT * FROM nc_items WHERE subscription_id=? ORDER BY effective_from,id', found.id)
    basis.items = originals
    subscription = { id: found.id, create: false, revision: found.revision, customerId: customer.id, externalId: found.external_id, startDate: found.start_date, anchorDay: found.anchor_day, trialEnd: found.trial_end, endDate: found.end_date, billFrom: found.cutover_start, effectiveDate, previewStart: effectiveDate, billingAnchorDate: found.billing_anchor_date, contractTermMonths: found.contract_term_months, contractEndDate: found.contract_end_date }
  } else {
    fields(s, ['external_id', 'start_date', 'anchor_day', 'trial_end', 'months', 'end_date', 'evergreen', 'renewal', 'billing_anchor_date', 'term_months', 'quote'])
    const startDate = setupDate(sr.text('start_date', { max: 10 }), 'start_date'), day = Number(startDate.slice(8))
    const requestedAnchor = sr.has('billing_anchor_date') ? setupDate(sr.text('billing_anchor_date', { max: 10 }), 'billing_anchor_date') : null
    const anchorDay = sr.integer('anchor_day', { min: 1, max: 31, optional: true }) ?? Number((requestedAnchor ?? startDate).slice(8))
    insist(anchorDay, 'anchor_day_required')
    const trialEnd = sr.text('trial_end', { max: 10, optional: true }) || null
    insist(!trialEnd || requireDate(trialEnd, 'trial_end') > startDate, 'invalid_trial_end')
    const externalId = sr.text('external_id', { max: 80, optional: true }) || null
    if (externalId) insist(!await one(env, 'SELECT 1 FROM nc_subscriptions WHERE external_id=?', externalId), 'subscription_external_id_in_use', 409)
    if (s.renewal !== undefined) {
      const r = object(s.renewal, 'renewal')
      fields(r, ['months', 'auto_renew', 'notice_days', 'uplift_percent', 'quote'])
      quoted(source, r, 'subscription.renewal', quotes)
      for (const setting of ['months', 'auto_renew', 'notice_days', 'uplift_percent']) {
        insist(r[setting] !== undefined, `missing_${setting}`)
        quotes.push({ field: `subscription.renewal.${setting}`, quote: r.quote })
      }
      flag(r, 'auto_renew')
      Input.of(r).text('uplift_percent', { max: 24 })
      const settings = renewalSettings(Input.of(r), startDate)
      renewal = { id: prior.renewal?.id ?? newId(), ...settings, end_date: addMonthsClamped(startDate, settings.months), quote: r.quote }
      insist(Number(startDate.slice(8)) === anchorDay, 'term_start_must_match_anchor')
    }
    const evergreen = flag(s, 'evergreen')
    const contractTermMonths = sr.integer('term_months', { min: 1, max: 120, optional: true }) ?? null
    const fullAnchor = requestedAnchor ?? (day > 28 || anchorDay > 28 ? startDate : contractTermMonths ? setupAnchor(startDate, anchorDay, null) : null)
    insist(!fullAnchor || fullAnchor <= startDate && Number(fullAnchor.slice(8)) === anchorDay, 'invalid_billing_anchor_date')
    const termChoices = [sr.has('end_date'), sr.has('months'), !!contractTermMonths, evergreen].filter(Boolean).length
    insist(termChoices === 1 || !!renewal && termChoices === 0, 'choose_finite_term_or_evergreen')
    const termMonths = sr.has('months') ? sr.integer('months', { min: 1, max: 119987 })! : contractTermMonths
    const declaredEnd = evergreen || (!sr.has('end_date') && !termMonths) ? null : setupDate(sr.has('end_date') ? sr.text('end_date', { max: 10 }) : addMonthsClamped(startDate, termMonths!), 'end_date')
    insist(!renewal || !declaredEnd || declaredEnd === renewal.end_date, 'renewal_initial_term_mismatch')
    insist(!renewal || !evergreen || renewal.auto_renew, 'evergreen_requires_auto_renewal')
    const endDate = renewal?.end_date ?? declaredEnd
    insist(!endDate || endDate > startDate, 'invalid_subscription_end')
    const previewStart = setupAnchor(startDate, anchorDay, fullAnchor)
    insist(!trialEnd || !endDate || trialEnd < endDate, 'invalid_trial_end')
    subscription = { id: prior.subscription?.id ?? newId(), create: true, customerId: customer.id, externalId, startDate, anchorDay, trialEnd, endDate, billFrom: null, effectiveDate: startDate, previewStart, billingAnchorDate: fullAnchor, contractTermMonths: contractTermMonths ?? termMonths, contractEndDate: endDate }
    basis.subscription = { externalId, absent: true }
  }
  for (const setting of ['billing_anchor_date', 'anchor_day', 'term_months', 'months', 'end_date']) if (s[setting] !== undefined) quotes.push({ field: `subscription.${setting}`, quote: s.quote })
  if (subscription.endDate) setupDate(subscription.endDate, 'end_date')
  subscription.evergreen = !!renewal?.auto_renew || !subscription.endDate
  const serviceEnd = subscription.evergreen ? null : subscription.endDate
  const months = serviceEnd ? periodCount(subscription.previewStart, serviceEnd) : 36
  const previewEnd = serviceEnd ?? setupDate(addMonthsClamped(subscription.previewStart, months), 'preview_end')
  subscription.previewEnd = previewEnd
  const catalog = await setupCatalog(env, input, source, prior, basis, quotes)
  const priceFor = (key: unknown) => { const p = catalog.prices.find(p => p.key === key); insist(p, 'setup_catalog_key_not_found'); return p }
  const items: Row[] = [], itemUpdates: Row[] = []
  if (subscription.create) {
    insist(input.ramps === undefined, 'ramps_require_existing_subscription')
    for (const [index, row] of rows(input.items, 'items').entries()) {
      fields(row, ['key', 'price', 'quantity', 'from', 'to', 'quote']); quoted(source, row, `items.${index}`, quotes)
      const key = Input.of(row).text('key', { max: 100 }), price = priceFor(row.price)
      const from = requireDate(row.from ?? subscription.startDate, 'item_from'), to = row.to === undefined || row.to === null ? serviceEnd : requireDate(row.to, 'item_to')
      insist(from >= subscription.startDate && (!to || to > from) && (!serviceEnd || to && to <= serviceEnd), 'invalid_item_dates')
      const previous = prior.items?.find((p: Row) => p.setupKey === key && p.from === from && p.to === to)
      insist(!items.some(i => i.setupKey === key && overlap(i, { from, to })), 'overlapping_setup_item')
      const earlier = items.find(i => i.setupKey === key)
      if (earlier) { const a = catalog.prices.find(p => p.id === earlier.priceId)!; insist(a.kind === price.kind && a.meterId === price.meterId, 'ramp_incompatible_price') }
      items.push({ id: previous?.id ?? newId(), setupKey: key, priceId: price.id, quantity: quantity(row, price), from, to, create: true })
    }
    insist(items.length > 0, 'items_required')
  } else {
    insist(input.items === undefined, 'existing_setup_use_ramps')
    const ramps = rows(input.ramps, 'ramps')
    for (const [index, ramp] of ramps.entries()) { fields(ramp, ['item', 'effective_date', 'price', 'quantity', 'quote']); quoted(source, ramp, `ramps.${index}`, quotes) }
    for (const original of originals) {
      const selected = ramps.filter(r => r.item === original.id).sort((a, b) => String(a.effective_date).localeCompare(String(b.effective_date)))
      const current = { id: original.id, priceId: original.price_id, quantity: original.quantity, from: original.effective_from, to: original.effective_to, create: false }
      if (!selected.length) { items.push(current); continue }
      for (const [index, ramp] of selected.entries()) {
        const date = requireDate(String(ramp.effective_date), 'ramp_date')
        insist(date >= subscription.effectiveDate && date >= original.effective_from && (!original.effective_to || date < original.effective_to) && (!subscription.endDate || date < subscription.endDate), 'invalid_ramp_date')
        insist(!index || date > selected[index - 1].effective_date, 'duplicate_ramp_date')
        const price = priceFor(ramp.price), firstSame = index === 0 && date === original.effective_from
        const previous = prior.items?.find((p: Row) => p.setupKey === original.id && p.from === date)
        const piece = { id: firstSame ? original.id : previous?.id ?? newId(), setupKey: original.id, priceId: price.id, quantity: quantity(ramp, price), from: date, to: selected[index + 1]?.effective_date ?? original.effective_to, create: !firstSame }
        items.push(piece)
        if (firstSame) itemUpdates.push(piece)
      }
      if (selected[0].effective_date > original.effective_from) { const closed = { ...current, to: selected[0].effective_date }; items.push(closed); itemUpdates.push(closed) }
    }
    insist(ramps.every(r => originals.some(i => i.id === r.item)), 'ramp_item_not_found')
  }
  const contractId = prior.contract?.id ?? newId()
  const window = (row: Row) => {
    const from = requireDate(String(row.from ?? ''), 'contract_from'), to = requireDate(String(row.to ?? ''), 'contract_to')
    insist(from >= subscription.effectiveDate && to > from && Number(from.slice(8)) === subscription.anchorDay && Number(to.slice(8)) === subscription.anchorDay && (!serviceEnd || to <= serviceEnd), 'contract_window_must_align')
    return { from, to }
  }
  const commitments = rows(input.commitments, 'commitments').map((r, i) => { fields(r, ['from', 'to', 'minimum', 'taxable', 'quote']); quoted(source, r, `commitments.${i}`, quotes); const minimum = canonicalDecimal(String(r.minimum)); insist(cents(minimum) > 0, 'invalid_minimum'); return { ...window(r), minimum, taxable: flag(r, 'taxable') } })
  const included = rows(input.included, 'included').map((r, i) => { fields(r, ['from', 'to', 'price', 'quantity', 'quote']); quoted(source, r, `included.${i}`, quotes); const price = priceFor(r.price), q = canonicalDecimal(String(r.quantity)); insist(price.kind === 'unit' && items.some(i => i.priceId === price.id), 'included_price_not_on_subscription'); insist(micros(q) > 0n, 'invalid_included'); return { ...window(r), price: price.id, quantity: q } })
  const existingTerms = subscription.create ? { commitments: [], included: [], invoices: [] } : await contractBasis(env, subscription.id)
  for (const [i, c] of commitments.entries()) insist(![...existingTerms.commitments, ...commitments.slice(0, i)].some(p => overlap(c, p)), 'overlapping_commitments')
  for (const [i, c] of included.entries()) insist(![...existingTerms.included, ...included.slice(0, i)].some(p => p.price === c.price && overlap(c, p)), 'overlapping_included')
  const amendments = rows(input.exceptions, 'exceptions').map((r, i) => {
    fields(r, ['kind', 'value', 'price', 'from', 'to', 'quote']); quoted(source, r, `exceptions.${i}`, quotes)
    insist(['discount_percent', 'fixed_credit', 'price_override'].includes(r.kind), 'invalid_amendment_kind')
    const value = canonicalDecimal(String(r.value)), amount = micros(value), from = requireDate(String(r.from), 'effective_from'), to = r.to ? requireDate(String(r.to), 'effective_to') : null
    insist(from >= subscription.effectiveDate && (!serviceEnd || from < serviceEnd) && (!to || to > from && (!serviceEnd || to <= serviceEnd)), 'invalid_effective_to')
    if (r.kind === 'discount_percent') insist(amount > 0n && amount <= 100000000n, 'invalid_amendment_value')
    if (r.kind === 'fixed_credit') insist(amount > 0n && amount % 10000n === 0n, 'invalid_amendment_value')
    const price = r.kind === 'price_override' ? priceFor(r.price) : null
    insist(price || r.price === undefined, 'unexpected_exception_price')
    if (price) insist(!price.pricing && items.some(item => item.priceId === price.id), 'override_price_model')
    return { id: prior.amendments?.[i]?.id ?? newId(), kind: r.kind, value, priceId: price?.id ?? null, from, to, note: '', clause: r.quote }
  })
  const previousAmendments = subscription.create ? [] : await all(env, "SELECT * FROM nc_amendments WHERE subscription_id=? AND status='approved' ORDER BY effective_from,id", subscription.id)
  basis.amendments = previousAmendments
  for (const [i, a] of amendments.entries()) insist(![...previousAmendments.map(p => ({ kind: p.kind, priceId: p.price_id, from: p.effective_from, to: p.effective_to })), ...amendments.slice(0, i)].some(p => p.kind === a.kind && p.priceId === a.priceId && (a.kind === 'fixed_credit' ? p.from === a.from : a.from < (p.to ?? '9999-12-31') && p.from < (a.to ?? '9999-12-31'))), 'overlapping_setup_exception')
  const plan: Row = { customer, invoiceContent, billingEntity, ...catalog, subscription, renewal, items, itemUpdates, insertItems: items.filter(i => i.create), amendments, contract: { id: contractId, clause: quotes.map(q => q.quote).join('\n\n'), terms: { commitments, included, ramps: [] } }, months }
  await setupOwnership(env, plan, catalog.meters, basis)
  const ambiguities = setupIntervalAmbiguities(setupAmbiguities(input, source, invoiceContent.paymentTermsDays, !!renewal, !!billingEntity), plan, source, quotes)
  if (invoiceContent.poRequired && !invoiceContent.poNumber) ambiguities.push({ issue: 'The required purchase order number is unresolved.', code: 'po_required' })
  const preview = await setupPreview(env, business, plan, input, basis, quotes, existingTerms, ambiguities)
  return { normalized: { setup: true, input, source, plan }, impact: preview, basis }
}
