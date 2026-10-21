// Owner-recorded configuration/entity foundation through ordinary HTTP doors.
// This journey does not claim live Stripe settings, charges or ledger posting.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { file } from './harness.mjs'

export async function numberingEntitiesFlow(h, owner) {
  const api = (path, body, status) => h.api(path, owner, body, status)
  const revision = async () => (await api('business')).revision
  const mutate = async (path, body, status) => api(path, { revision: await revision(), ...body }, status)
  const initial = await api('business')
  await api('business.configure', { ...initial, timezone: 'UTC' })
  const captures = {}
  for (const name of ['manifest','customers','products','prices','subscriptions','invoices','meters'])
    captures[name] = JSON.parse(await readFile(new URL(`../fixtures/stripe/${name}.json`, import.meta.url), 'utf8'))
  captures.invoices.data[0].number = 'ACME-0041'
  captures.invoices.data[1].number = 'ACME-0042'
  captures.invoices.data[2].number = 'HARBOR-0009'
  const files = Object.fromEntries(Object.entries(captures).map(([name, value]) => [name, file(`${name}.json`, JSON.stringify(value), 'application/json')]))
  const preview = await api('import.preview', files)
  const imported = await api('import.apply', { ...files, fingerprint: preview.fingerprint })
  const customers = await api('customers')
  const atlas = customers.find(row => row.external_id === captures.customers.data[0].id).id
  const harbor = customers.find(row => row.external_id === captures.customers.data[1].id).id
  const identity = (number, prefix) => ({ legal_name: `Synthetic entity ${number}`, address: `${number} Synthetic Way, CA, US`, ein: `${10 + number}-3456789`, invoice_prefix: prefix, invoice_number_width: 4,
    payment_terms_days: 30, processor_account_ref: `synthetic-nectar-processor-${number}`, ledger_company_ref: `synthetic-nectar-ledger-${number}`, tax_registration: `synthetic-nectar-tax-${number}` })
  const entityA = await mutate('entity.create', identity(1, 'OPCO'))
  const entityB = await mutate('entity.create', identity(2, 'SUBCO'))
  await mutate('customer.entity', { customer: atlas, entity: entityA.id, confirm: true })
  await mutate('customer.entity', { customer: harbor, entity: entityB.id, confirm: true })
  const state = () => api('billing-entities')
  assert.equal((await state()).entities.length, 2)
  const registerBefore = await api('number-register')
  const source = registerBefore.entries.find(row => row.number === 'ACME-0042')
  const harborSource = registerBefore.entries.find(row => row.number === 'HARBOR-0009')
  const sourceBody = { entity: entityA.id, source_invoice: source.id, confirm: true, capture: {
    account_ref: 'synthetic-nectar-processor-1', numbering_mode: 'account', prefix: 'ACME-', width: 4, next_number: 43,
    observed_at: '2026-09-10T12:00:00Z', evidence: 'Synthetic owner-recorded settings capture for the public-door test.' } }
  await mutate('invoice.series.capture', { ...sourceBody, capture: { ...sourceBody.capture, next_number: 44 } }, 409)
  await mutate('invoice.series.capture', { ...sourceBody, capture: { ...sourceBody.capture, account_ref: 'synthetic-nectar-other-account' } }, 409)
  assert.equal((await state()).sources.length, 0, 'invalid captures save no configuration')
  const captured = await mutate('invoice.series.capture', sourceBody)
  assert.equal(captured.captureKind, 'owner-recorded-settings')
  assert.equal(captured.nextNumber, 'ACME-0043')
  assert.equal((await state()).entities.find(row => row.id === entityA.id).next_invoice_number, 1, 'capturing settings is inert')
  assert.equal((await api('imports')).find(row => row.id === imported.job).blockers.some(row => row.target === source.id), true, 'retained source capture protects original custody from undo')
  await mutate('invoice.series.capture-live', { customer: atlas, entity: entityA.id, source_invoice: source.id }, 409)
  assert.equal((await state()).sources.length, 1, 'missing held connection cannot synthesize a live capture')
  await mutate('invoice.series', { entity: entityB.id, mode: 'continue', source_capture: captured.id }, 404)
  assert.equal((await mutate('invoice.series', { entity: entityA.id, mode: 'continue', source_capture: captured.id })).nextNumber, 'ACME-0043')
  const draft = async (customer, description) => {
    const charge = await api('charge.add', { customer, amount: '100', description, effective_date: '2026-09-10' })
    return api('invoice.manual', { customer, charges: [charge.charge], service_date: '2026-09-10' })
  }
  const issue = async (customer, description) => {
    const invoice = await draft(customer, description)
    await api('invoice.approve', { invoice: invoice.id, acknowledge: true })
    await api('invoice.finalise', { invoice: invoice.id, issue_date: '2026-09-10' })
    return api(`invoices/${invoice.id}`)
  }
  const firstA = await issue(atlas, 'Entity A first continuation')
  const firstB = await issue(harbor, 'Entity B new series')
  const secondA = await issue(atlas, 'Entity A second continuation')
  assert.deepEqual([firstA.number, firstB.number, secondA.number], ['ACME-0043','SUBCO-0001','ACME-0044'])
  assert.equal(firstA.billing_entity_id, entityA.id)
  assert.equal(firstB.billing_entity_id, entityB.id)
  const savedRoute = JSON.parse(firstA.billing_route_json)
  assert.equal(savedRoute.processorAccountRef, 'synthetic-nectar-processor-1')
  assert.equal(savedRoute.ledgerCompanyRef, 'synthetic-nectar-ledger-1')
  assert.equal(JSON.parse(firstB.billing_route_json).processorAccountRef, 'synthetic-nectar-processor-2')
  await mutate('customer.entity', { customer: atlas, entity: entityB.id, confirm: true }, 409)
  const credit = await api('credit.issue', { invoice: firstA.id, amount: '10', reason: 'Entity sequence credit' })
  const savedCredit = (await api(`invoices/${firstA.id}`)).credits.find(row => row.id === credit.credit)
  assert.equal(savedCredit.number, 'OPCO-CN-0001')
  assert.equal(savedCredit.billing_entity_id, entityA.id)
  assert.equal(JSON.parse(savedCredit.billing_route_json).processorAccountRef, savedRoute.processorAccountRef)
  await mutate('invoice.series', { entity: entityB.id, customer: harbor, mode: 'continue', source_invoice: harborSource.id })
  assert.equal((await issue(harbor, 'Entity B independent customer sequence')).number, 'HARBOR-0010')
  const pending = await draft(atlas, 'Approval predates route change')
  await api('invoice.approve', { invoice: pending.id, acknowledge: true })
  await mutate('entity.update', { ...identity(1, 'OPCO'), entity: entityA.id, ledger_company_ref: 'synthetic-nectar-new-ledger' })
  await api('invoice.finalise', { invoice: pending.id, issue_date: '2026-09-10' }, 409)
  assert.equal((await state()).entities.find(row => row.id === entityA.id).next_invoice_number, 45, 'stale approval consumes no entity number')
  assert.deepEqual(JSON.parse((await api(`invoices/${firstA.id}`)).billing_route_json), savedRoute, 'issued route snapshot survives entity edits')
  const next = await issue(atlas, 'Fresh approval uses changed route')
  assert.equal(next.number, 'ACME-0045')
  assert.equal(JSON.parse(next.billing_route_json).ledgerCompanyRef, 'synthetic-nectar-new-ledger')
  assert.equal((await api('business')).next_invoice_number, initial.next_invoice_number, 'entity issue leaves installation sequence untouched')
  const all = await api('number-register')
  const onlyA = await api(`number-register?entity=${entityA.id}`)
  assert.equal(onlyA.entries.every(row => row.entityId === entityA.id), true)
  assert.equal(onlyA.gaps.filter(row => row.prefix === 'ACME-').length, 0)
  assert.ok(all.entries.some(row => row.entityId === entityB.id && row.number === 'SUBCO-0001'))
  assert.ok(all.series.some(row => row.entityId === entityA.id && row.prefix === 'ACME-'))
  const csv = await h.page(`/app/exports/number-register.csv?entity=${entityA.id}`, owner)
  assert.ok(csv.includes(entityA.id) && csv.includes('ACME-0045') && !csv.includes('SUBCO-0001'))
  await api('access.give', { email: 'synthetic-nectar-entity-accountant@example.test', name: 'Entity accountant', role: 'accountant' })
  const accountant = await h.signIn('synthetic-nectar-entity-accountant@example.test', { requested: true })
  await h.api('billing-entities', accountant, undefined, 403)
  await h.api('entity.create', accountant, { revision: await revision(), ...identity(3,'DENIED') }, 403)
  await h.api('customer.entity', accountant, { revision: await revision(), customer: atlas, entity: entityA.id, confirm: true }, 403)
  await h.api('invoice.series.capture', accountant, { revision: await revision(), ...sourceBody }, 403)
  assert.deepEqual(await h.api(`number-register?entity=${entityA.id}`, accountant), onlyA)
  const agent = { bearer: (await api('credential.issue', { name: 'Entity read observer', scopes: ['prepare'] })).key }
  await h.api('entity.create', agent, { revision: await revision(), ...identity(3,'DENIED') }, 403)
  await h.api('invoice.series.capture-live', agent, { revision: await revision(), entity: entityA.id, customer: atlas, source_invoice: source.id }, 403)
  assert.match(await h.page('/app/numbering', owner), /owner-recorded|owner observation/i)
  console.log('MOVE-011 owner-recorded source configuration, entity/customer sequences, route snapshots, authority, register/filter/CSV passed; live provider and SET-001 routing acceptance remain unproven')
}
