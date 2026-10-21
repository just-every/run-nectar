import assert from 'node:assert/strict'
import { csvRows } from './financial-reports.mjs'

// SET-001 recognition through issued source snapshots, ordinary report reads,
// source drills, selectors and CSV. This asserts no external ledger posting.
export async function entityRevenueFlow(h, owner, state) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  const { entityA, entityB, atlas, harbor, firstA, firstB, next, sourceInvoice, accountant, agent } = state
  const legacyCustomer = (await api('customer.create', { external_id: 'synthetic-nectar-entity-revenue-legacy', name: 'Synthetic legacy business customer', billing_email: 'synthetic-nectar-entity-revenue@example.test' })).id
  const charge = (await api('charge.add', { customer: legacyCustomer, amount: '25', description: 'Synthetic installation business service', taxable: false, effective_date: '2026-09-10' })).charge
  const legacyInvoice = (await api('invoice.manual', { customer: legacyCustomer, charges: [charge], service_date: '2026-09-10' })).id
  await api('invoice.approve', { invoice: legacyInvoice, acknowledge: true })
  await api('invoice.finalise', { invoice: legacyInvoice, issue_date: '2026-09-10' })
  const annualProduct = (await api('product.create', { code: 'synthetic-nectar-entity-revenue-annual', name: 'Synthetic entity annual service' })).id
  const annualPrice = (await api('price.create', { product: annualProduct, kind: 'flat', unit_amount: '1200', taxable: false, billing_interval: 'annual', billing_timing: 'advance' })).id
  const annualSubscription = (await api('subscription.create', { customer: harbor, start_date: '2026-09-01', price: [annualPrice] })).id
  const annualRun = await api('billrun.prepare', { period: '2026-09' })
  const annualDrafts = await Promise.all((await api(`runs/${annualRun.id}`)).invoices.filter(row => row.customer_id === harbor && row.status === 'draft').map(row => api(`invoices/${row.id}`)))
  const annualDraft = annualDrafts.find(row => row.calculation.inputs.subscription.id === annualSubscription)
  assert.ok(annualDraft)
  await api('invoice.approve', { invoice: annualDraft.id, acknowledge: true })
  await api('invoice.finalise', { invoice: annualDraft.id, issue_date: '2026-09-10' })
  const report = (entity, extra = '') => api(`revenue?from=2026-09&to=2026-09${entity ? `&entity=${entity}` : ''}${extra}`)
  const [a, b, business, imported, consolidated] = await Promise.all([report(entityA), report(entityB), report('business'), report('imported'), report(null)])
  for (const [scoped, billed, recognized, deferred] of [[a, 29000, 29000, 0], [b, 140000, 30000, 110000], [business, 2500, 2500, 0], [imported, 0, 0, 0], [consolidated, 171500, 61500, 110000]]) {
    assert.deepEqual([scoped.openingCents, scoped.netBillingsCents, scoped.recognizedCents, scoped.closingCents], [0, billed, recognized, deferred], 'Entity revenue preserves independent annual deferral, one-time consideration and once-only contra-revenue')
    assert.equal(scoped.months.length, 1)
  }
  for (const key of ['openingCents', 'netBillingsCents', 'recognizedCents', 'closingCents', 'accruedContractAssetCents', 'deferredLiabilityCents'])
    assert.equal(consolidated[key], a[key] + b[key] + business[key] + imported[key], `Consolidation exactly conserves ${key}`)
  assert.equal((await report('all')).recognizedCents, 61500)
  assert.ok(a.contributions.every(row => row.entityId === entityA && row.entityCustody === 'issued-entity' && !row.source))
  assert.ok(b.contributions.every(row => row.entityId === entityB && row.entityCustody === 'issued-entity'))
  const annualSource = await api(`revenue/${annualDraft.id}?period=2026-09&entity=${entityB}`)
  assert.equal(annualSource.entity.id, entityB)
  assert.deepEqual(annualSource.schedules[0].entries.map(entry => entry.amountCents), Array(12).fill(10000), 'The entity source retains its ordinary annual monthly schedule')
  assert.ok(business.contributions.every(row => row.entityId === null && row.entityCustody === 'installation-business'))
  assert.ok(business.contributions.some(row => row.invoiceId === legacyInvoice))
  const oldName = JSON.parse(firstA.billing_route_json).legalName
  assert.ok(a.contributions.filter(row => row.invoiceId === firstA.id).every(row => row.entityName === oldName), 'Old source identity is read from its immutable invoice, after entity settings change')
  assert.ok(a.contributions.filter(row => row.invoiceId === next.id).every(row => row.entityName === 'Synthetic entity 1 revised'))
  assert.equal(a.months[0].creditsCents, -1000)
  const customer = await api(`customers/${atlas}`)
  await api('customer.update', { customer: atlas, revision: customer.revision, name: `${customer.name} renamed`, billing_email: customer.billing_email, address: customer.address })
  const attribution = rows => rows.map(row => [row.invoiceId, row.kind, row.amountCents, row.entityId, row.entityName, row.entityCustody])
  assert.deepEqual(attribution((await report(entityA)).contributions), attribution(a.contributions), 'Later customer edits do not change issued entity attribution or recognition')
  await api('customer.entity', { revision: (await api('business')).revision, customer: legacyCustomer, entity: entityA, confirm: true }, 409)
  assert.equal((await report('business')).recognizedCents, 2500, 'An issued legacy invoice cannot be reassigned into an entity')
  const historical = await api('revenue?period=2026-08&entity=imported')
  assert.deepEqual([historical.netBillingsCents, historical.recognizedCents], [35910, 35910])
  assert.ok(historical.contributions.every(row => row.entityId === null && row.entityCustody === 'imported-unassigned' && row.source?.providerRef === sourceInvoice), 'Assigning the imported customer later never invents the original provider issuer')
  assert.equal((await api(`revenue?period=2026-08&entity=${entityA}`)).recognizedCents, 0)
  const importedId = historical.contributions[0].invoiceId
  assert.equal((await api(`revenue/${importedId}?period=2026-08&entity=imported`)).entity.custody, 'imported-unassigned')
  await api(`revenue/${importedId}?period=2026-08&entity=${entityA}`, undefined, 404)
  const scoped = `from=2026-09&to=2026-09&customer=${atlas}&entity=${entityA}`
  const source = await api(`revenue/${firstA.id}?${scoped}`)
  assert.deepEqual(source.entity, { id: entityA, name: oldName, custody: 'issued-entity' })
  await api(`revenue/${firstA.id}?period=2026-09&entity=${entityB}`, undefined, 404)
  await api(`revenue/${firstA.id}?period=2026-09&entity=${entityA}&customer=${harbor}`, undefined, 404)
  for (const row of (await report(entityA, `&customer=${atlas}`)).contributions) {
    const link = new URL(row.href, h.origin)
    assert.equal(link.searchParams.get('entity'), entityA)
    assert.equal(link.searchParams.get('customer'), atlas)
    assert.equal(link.searchParams.get('from'), '2026-09')
    assert.equal(link.searchParams.get('to'), '2026-09')
    assert.equal((await h.raw(link.pathname + link.search, { cookie: accountant })).status, 200)
  }
  const csv = await h.raw(`/app/exports/revenue.csv?${scoped}`, { cookie: accountant })
  assert.equal(csv.status, 200)
  const exported = csvRows(await csv.text())
  assert.deepEqual(exported.filter(row => row.row_kind === 'rollforward').map(row => [row.net_billings, row.recognized, row.entity_id]), [['290.00', '290.00', entityA]])
  const contributions = exported.filter(row => row.row_kind !== 'rollforward')
  assert.ok(contributions.every(row => row.entity_id === entityA && row.entity_custody === 'issued-entity'))
  assert.ok(contributions.some(row => row.invoice === firstA.number && row.entity_name === oldName))
  assert.ok(!contributions.some(row => row.invoice === firstB.number))
  assert.ok(contributions.every(row => new URL(row.source_path, h.origin).searchParams.get('entity') === entityA))
  const consolidatedCsv = csvRows(await (await h.raw('/app/exports/revenue.csv?period=2026-09', { cookie: owner })).text())
  assert.deepEqual([consolidatedCsv.find(row => row.row_kind === 'rollforward').net_billings, consolidatedCsv.find(row => row.row_kind === 'rollforward').recognized, consolidatedCsv.find(row => row.row_kind === 'rollforward').deferred_liabilities], ['1715.00', '615.00', '1100.00'])
  const journal = await api(`revenue-journal?${scoped}`)
  assert.equal(journal.entityId, entityA)
  assert.ok(journal.entries.every(row => new URL(row.sourcePath, h.origin).searchParams.get('entity') === entityA))
  assert.ok(journal.periods.every(row => row.debitCents === row.creditCents))
  const html = await h.page(`/app/revenue?${scoped}`, accountant)
  assert.ok(html.includes(`value="${entityA}" selected`) && html.includes('name="customer"') && html.includes(atlas), 'Native entity selector preserves the customer/date scope')
  const sourceHtml = await h.page(`/app/revenue/${firstA.id}?${scoped}`, accountant)
  assert.ok(sourceHtml.includes(oldName) && !sourceHtml.includes('Synthetic entity 1 revised'), 'Source page preserves its issued entity identity')
  for (const [suffix, status] of [['entity=', 400], ['entity=../foreign', 400], [`entity=${entityA}&entity=${entityB}`, 400], ['entity=00000000-0000-0000-0000-000000000001', 404]]) {
    await api(`revenue?period=2026-09&${suffix}`, undefined, status)
    await api(`revenue/${firstA.id}?period=2026-09&${suffix}`, undefined, status)
    const refused = await h.raw(`/app/exports/revenue.csv?period=2026-09&${suffix}`, { cookie: owner })
    assert.equal(refused.status, status)
    await refused.text()
  }
  assert.equal((await h.api(`revenue?${scoped}`, accountant)).recognizedCents, 29000)
  assert.equal((await h.api(`revenue?${scoped}`, agent)).recognizedCents, 29000)
  await h.api(`revenue?${scoped}`, undefined, undefined, 401)
  await api('access.give', { email: 'synthetic-nectar-entity-revenue-support@example.test', name: 'Synthetic entity revenue support', role: 'support' })
  const support = await h.signIn('synthetic-nectar-entity-revenue-support@example.test', { requested: true })
  await h.api(`revenue?${scoped}`, support, undefined, 403)
  await h.api(`revenue/${firstA.id}?${scoped}`, support, undefined, 403)
  assert.equal((await h.raw(`/app/exports/revenue.csv?${scoped}`, { cookie: support })).status, 403)
  await state.onState?.({label:'entity-revenue',entities:[entityA,entityB],invoices:[firstA.id,firstB.id],customers:[atlas,harbor]})
}
