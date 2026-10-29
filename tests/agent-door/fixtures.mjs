import { randomUUID } from 'node:crypto'
import { nativeClient } from './native-client.mjs'

const PERIOD = '2020-01'
const PROTECTED_ID = '123-45-6789' // Synthetic protected-content classification fixture, never a real person.
let latest
export const currentNativeFixture = () => latest

async function prepareAccount(api, owner, suffix, protectedContent) {
  const key = `door-${protectedContent ? 'id' : 'plain'}-${suffix}`
  const properties = protectedContent ? { payroll_id: PROTECTED_ID } : { region: 'west' }
  const customerName = protectedContent ? `Synthetic Cedar ${PROTECTED_ID}` : 'Synthetic Cedar Systems'
  const [customerRecord, meterRecord, productRecord] = await Promise.all([
    api('customer.create', { external_id: key, name: customerName, billing_email: `${key}@example.test` }),
    api('meter.create', { code: `${key}-events`, name: 'Synthetic service events', unit_label: 'events' }),
    api('product.create', { code: `${key}-service`, name: 'Synthetic processing service' }),
  ])
  const customer = customerRecord.id, meter = meterRecord.id, meterCode = `${key}-events`
  // Each product is fresh: its v1 price publishes through the native owner setup door.
  const price = (await api('price.create', { product: productRecord.id, kind: 'unit', meter: meterCode,
    unit_amount: '2', taxable: false, nickname: 'Synthetic event processing' })).id
  if (!price) throw new Error('Nectar fixture expected a first-version native price')
  const subscription = (await api('subscription.create', { customer, start_date: '2020-01-01', anchor_day: 1,
    price: [price], quantity: ['1'] })).id
  const originalEvent = `${key}:original`
  const original = { event_id: originalEvent, customer: key, meter: meterCode, quantity: '10',
    occurred_at: '2020-01-10T12:00:00Z', properties }
  const submitted = await api('usage.submit', { events: [original] })
  if (submitted.accepted !== 1 || submitted.rejected !== 0) throw new Error('Nectar fixture original event was not recorded')
  const metricRequest = (await api('meter.prepare', { code: `${key}-sum`, name: 'Synthetic exact sum',
    unit_label: 'events', source_meter: meterCode, definition: { aggregation: 'sum', group_by: [] } })).request
  return { customer, externalId: key, meter, meterCode, product: productRecord.id, price, subscription,
    owner, metricRequest, originalEvent, original, properties, protectedContent }
}

async function finishAccount(api, account, invoice) {
  await api('invoice.approve', { invoice, acknowledge: true })
  const issued = await api('invoice.finalise', { invoice, issue_date: '2020-02-01' })
  if (issued.refused?.length) throw new Error('Nectar fixture invoice was refused')
  const saved = await api(`invoices/${invoice}`)
  if (saved.status !== 'issued') throw new Error('Nectar fixture invoice was not issued')

  const lateEvent = `${account.externalId}:late`
  const late = { event_id: lateEvent, customer: account.externalId, meter: account.meterCode,
    quantity: '2', occurred_at: '2020-01-20T12:00:00Z', properties: account.properties }
  const events = [late]
  // Separate scan months let the plain scan omit protected source controls.
  // The protected account retains its January invoice and correction chain.
  const controlDay = account.protectedContent ? '2020-02-10' : '2020-01-10'
  if (account.protectedContent) events.push({ event_id: `${account.externalId}:control-source`,
    customer: account.externalId, meter: account.meterCode, quantity: '10',
    occurred_at: `${controlDay}T12:00:00Z`, properties: account.properties })
  const submitted = await api('usage.submit', { events })
  if (submitted.accepted !== events.length || submitted.rejected !== 0) throw new Error('Nectar fixture late/control events were not recorded')
  // Record discrepancies after issue: unresolved source controls correctly block native invoice approval.
  const control = await api('usage.control', { customer: account.customer, meter: account.meterCode,
    day: controlDay, expected_count: 2, expected_quantity: '12' })
  const scanPeriod = controlDay.slice(0, 7)
  const scan = await api('assurance.scan', { period: scanPeriod, owner: account.owner })
  const cases = await api('assurance-cases')
  const sourceCase = cases.find(row => row.source_id === control.id)
  if (!sourceCase || sourceCase.status !== 'open') throw new Error('Nectar fixture source-control case was not opened')
  const inspection = await api(`usage/inspect?period=${scanPeriod}`)
  const comparison = inspection.controls.find(row => row.id === control.id)
  if (!comparison?.mismatch || comparison.expectedCount !== 2 || comparison.actualCount !== 1) {
    throw new Error('Nectar fixture source-control discrepancy differs from its native events')
  }
  const event = { event_id: `${account.externalId}:journey`, customer: account.externalId,
    meter: account.meterCode, quantity: '3', occurred_at: '2020-02-15T12:00:00Z', properties: account.properties }
  const answer = { customer: account.customer, invoice, question: 'What is the invoice total?', topic: 'total' }
  const correction = { subscription: account.subscription, from_period: PERIOD, through_period: PERIOD,
    void_event_ids: [], add_event_ids: [lateEvent] }
  return { ...account, invoice, lateEvent, late, event, control: control.id,
    controlBasis: comparison.basis, controlDay, scanPeriod, period: PERIOD, case: sourceCase.id,
    caseBasis: sourceCase.basis_hash, invoiceFingerprint: saved.source_fingerprint,
    measures: { usage: 1, control: 1, scan: scan.compared, recheck: 1, answer: 1,
      answerProposal: 1, correction: 1, correctionPrepare: 1, meterPreview: 2 },
    args: {
      usage: { events: [event] },
      control: { customer: account.customer, meter: account.meterCode, day: controlDay,
        expected_count: 3, expected_quantity: '15' },
      scan: { period: scanPeriod, owner: account.owner },
      recheck: { case: sourceCase.id },
      answer,
      answerProposal: { ...answer, credit_amount: '1', reason: 'billing adjustment' },
      correction,
      correctionPrepare: { ...correction, reason: 'Late source event',
        explanation: 'A recorded event adds two processing units to the January service period.' },
      meterPreview: { request: account.metricRequest, customer: account.customer, period: PERIOD },
    },
  }
}

/** Every conformance phase receives fresh native HTTP records, including refusal-only phases. */
export default async function prepareFixtures({ phase, request, origin, cookie }) {
  const api = nativeClient({ request, origin, cookie })
  const owner = await api('me')
  if (owner.kind !== 'member' || owner.role !== 'owner') throw new Error('Nectar fixtures require the initialized native owner session')
  const business = await api('business')
  if (!business || business.timezone !== 'UTC' || business.tax_mode !== 'no_tax' || !business.tax_reviewed_at) {
    throw new Error('Nectar fixtures require the initialized UTC business and reviewed no-tax policy')
  }
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16)
  const [plainAccount, protectedAccount] = await Promise.all([
    prepareAccount(api, owner.id, suffix, false), prepareAccount(api, owner.id, suffix, true),
  ])
  const run = await api('billrun.prepare', { period: PERIOD })
  const detail = await api(`runs/${run.id}`)
  const invoiceFor = account => {
    const invoice = detail.invoices.find(row => row.subscription_id === account.subscription)
    if (!invoice) throw new Error('Nectar fixture subscription has no native January draft')
    return invoice.id
  }
  // Financial issue and assurance sequence guards are intentionally serialized.
  const plain = await finishAccount(api, plainAccount, invoiceFor(plainAccount))
  const protectedFixture = await finishAccount(api, protectedAccount, invoiceFor(protectedAccount))
  const sender = await api('credential.issue', { name: 'Cedar usage sender', scopes: ['usage'] })
  const localUsage = { events: [{ ...plain.event, event_id: `${plain.externalId}:local-journey` }] }
  latest = { sender: sender.id, answer: plain.args.answer, localUsage }
  return { values: { phase, owner: owner.id, plain, protected: protectedFixture, localUsage },
    clients: { sender: { token: sender.key, clientId: sender.id,
      agent: { id: sender.id, name: sender.name, specialist: 'billing-controller' } } } }
}
