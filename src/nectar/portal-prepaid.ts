import { portalRefundSection } from './portal-prepaid-refunds'
import { portalTopupLinks } from './portal-prepaid-topups'
// Customer-session projections only. No operator Actor, request payload,
// payment-provider reference or authorization narrative crosses this boundary.
import type { Bindings } from '../auth.server'
import { requireBusiness } from './business'
import { clockInstant } from './clock'
import { all, insist, one } from './core'
import { today } from './dates'
import { decimalText, plainMoney } from './decimal'
import { prepaidFinancialSources } from './financial-prepaid'
import { customerText } from './locale'
import { lotStates } from './prepaid-math'
import { prepaidSnapshot } from './prepaid-records'
import type { PrepaidEntry } from './prepaid-types'
import type { CustomerSession } from './portal-session'
import { h } from './ui/html'

export interface PortalPrepaidLot {
  id: string; subscription: string; kind: 'money' | 'units'; source: 'purchase' | 'promotion'
  meterCode: string | null; unitLabel: string | null; effectiveDate: string; expiresDate: string | null
  remainingN: number; availableN: number; liabilityCents: number; remainingQuantity: string | null; availableQuantity: string | null
  href: string; purchaseInvoice: { id: string; number: string; href: string } | null
  entries: { id: string; kind: PrepaidEntry['kind']; date: string; amountN: number; liabilityCents: number; recognitionCents: number }[]
}
const path = (id: string) => `/portal/prepaid/${encodeURIComponent(id)}`

export async function portalPrepaidData(env: Bindings, session: CustomerSession) {
  insist(await one(env, 'SELECT id FROM nc_customers WHERE id=? AND erased_at IS NULL', session.customer), 'invalid_customer_session', 401)
  const subscriptions = await all(env, `SELECT s.id FROM nc_subscriptions s JOIN nc_customers c ON c.id=s.customer_id
    WHERE s.customer_id=? AND s.billing_mode='live' AND c.erased_at IS NULL ORDER BY s.id`, session.customer)
  const business = await requireBusiness(env), date = today(business.timezone, clockInstant(env))
  const reports = await prepaidFinancialSources(env, date, session.customer, path)
  const snapshots = await Promise.all(subscriptions.map(sub => prepaidSnapshot(env, sub.id)))
  const grants = snapshots.flatMap(snapshot => snapshot ? lotStates({ ...snapshot, grants: snapshot.grants.filter(grant => grant.effectiveDate <= date),
    entries: snapshot.entries.filter(entry => entry.serviceDate <= date) }).map(lot => ({ ...lot, entries: snapshot.entries.filter(entry => entry.grantId === lot.grant.id && entry.serviceDate <= date) })) : [])
  const invoices = await all(env, "SELECT id,number FROM nc_invoices WHERE customer_id=? AND status='issued'", session.customer)
  const meters = await all(env, `SELECT DISTINCT m.id,m.code,m.unit_label FROM nc_meters m JOIN nc_prepaid_grants g ON g.meter_id=m.id
    JOIN nc_subscriptions s ON s.id=g.subscription_id WHERE s.customer_id=? AND s.billing_mode='live'`, session.customer)
  const lots: PortalPrepaidLot[] = grants.map(lot => {
    const grant = lot.grant, id = `prepaid-${grant.id}`, report = reports.get(id)?.prepaid
    // Retain exhausted sources in the customer's ledger after their report
    // contribution reaches zero. Never substitute a conflicting live snapshot.
    insist(report ? report.remainingN === lot.remainingN && report.liabilityCents === lot.liabilityCents : lot.remainingN === 0 && lot.liabilityCents === 0, 'prepaid_balance_changed', 409)
    const availableN = report?.availableN ?? (grant.expiresDate && grant.expiresDate <= date ? 0 : lot.remainingN)
    const invoice = grant.purchaseInvoice ? invoices.find(invoice => invoice.id === grant.purchaseInvoice) : null
    insist(!grant.purchaseInvoice || invoice, 'not_found', 404)
    const meter = meters.find(meter => meter.id === grant.meterId)
    return { id, subscription: grant.subscription, kind: grant.kind, source: grant.source, meterCode: meter?.code ?? null, unitLabel: meter?.unit_label ?? null,
      effectiveDate: grant.effectiveDate, expiresDate: grant.expiresDate, remainingN: lot.remainingN, availableN, liabilityCents: lot.liabilityCents,
      remainingQuantity: grant.kind === 'units' ? decimalText(BigInt(lot.remainingN)) : null,
      availableQuantity: grant.kind === 'units' ? decimalText(BigInt(availableN)) : null, href: path(id),
      purchaseInvoice: invoice ? { id: invoice.id, number: invoice.number, href: `/portal/invoices/${encodeURIComponent(invoice.id)}` } : null,
      entries: lot.entries.map(entry => ({ id: entry.id, kind: entry.kind, date: entry.serviceDate, amountN: entry.amountN,
        liabilityCents: entry.liabilityCents, recognitionCents: entry.recognitionCents })) }
  })
  insist(await one(env, 'SELECT id FROM nc_customers WHERE id=? AND erased_at IS NULL', session.customer), 'invalid_customer_session', 401)
  return { date, currency: 'USD' as const, lots }
}

export async function portalPrepaidSource(env: Bindings, session: CustomerSession, id: string) {
  const match = /^prepaid-([\w-]{1,100})$/.exec(id)
  insist(match && await one(env, `SELECT g.id FROM nc_prepaid_grants g JOIN nc_subscriptions s ON s.id=g.subscription_id JOIN nc_customers c ON c.id=s.customer_id
    WHERE g.id=? AND g.customer_id=? AND s.customer_id=? AND s.billing_mode='live' AND c.erased_at IS NULL`, match[1], session.customer, session.customer), 'not_found', 404)
  const data = await portalPrepaidData(env, session), lot = data.lots.find(lot => lot.id === id)
  insist(lot, 'not_found', 404)
  return { date: data.date, currency: data.currency, lot }
}

function lotCard(session: CustomerSession, lot: PortalPrepaidLot, link: (path: string) => string) {
  const L = customerText(session.language,session.currency)
  const quantity = (n: number) => lot.kind === 'money' ? L.money(n) : `${L.percent(decimalText(BigInt(n)))} ${lot.unitLabel ?? L.t('portal.prepaid.units')}`
  return h`<section class="card"><h2>${L.t(`portal.prepaid.${lot.source}`)} · ${L.t(`portal.prepaid.${lot.kind}`)}</h2>
    <p>${lot.meterCode ?? L.t('portal.prepaid.allMeters')}</p><dl>
    <dt>${L.t('portal.prepaid.remaining')}</dt><dd>${quantity(lot.remainingN)}</dd>
    <dt>${L.t('portal.prepaid.available')}</dt><dd>${quantity(lot.availableN)}</dd>
    <dt>${L.t('portal.prepaid.liability')}</dt><dd>${L.money(lot.liabilityCents)}</dd>
    <dt>${L.t('portal.prepaid.effective')}</dt><dd>${L.day(lot.effectiveDate)}</dd>
    <dt>${L.t('portal.prepaid.expires')}</dt><dd>${lot.expiresDate ? L.day(lot.expiresDate) : L.t('portal.prepaid.noExpiry')}</dd></dl>
    <a href="${link(lot.href)}">${L.t('portal.prepaid.source')}</a>
    ${lot.purchaseInvoice ? h`<p><a href="${link(lot.purchaseInvoice.href)}">${L.t('portal.prepaid.purchaseInvoice')} · ${lot.purchaseInvoice.number}</a></p>` : ''}</section>`
}

export async function portalPrepaidPage(env: Bindings, session: CustomerSession, link: (path: string) => string) {
  const L = customerText(session.language,session.currency), data = await portalPrepaidData(env, session)
  return h`<h1>${L.t('portal.prepaid.heading')}</h1><p><a href="${link('/portal')}">${L.t('portal.back')}</a></p>
    <p>${L.t('portal.prepaid.asOf', { date: L.day(data.date) })}</p>
    ${await portalTopupLinks(env,session,link)}
    ${await portalRefundSection(env,session,data.lots,link)}
    ${data.lots.length ? data.lots.map(lot => lotCard(session, lot, link)) : h`<p>${L.t('portal.prepaid.empty')}</p>`}
    <p><a href="${link('/portal/prepaid.csv')}">${L.t('portal.prepaid.csv')}</a></p>`
}

export async function portalPrepaidSourcePage(env: Bindings, session: CustomerSession, id: string, link: (path: string) => string) {
  const L = customerText(session.language,session.currency), data = await portalPrepaidSource(env, session, id)
  const amount = (n: number) => data.lot.kind === 'money' ? L.money(n) : L.percent(decimalText(BigInt(n)))
  return h`<h1>${L.t('portal.prepaid.ledger')}</h1><p><a href="${link('/portal/prepaid')}">${L.t('portal.back')}</a></p>
    <p>${L.t('portal.prepaid.asOf', { date: L.day(data.date) })}</p>${lotCard(session, data.lot, link)}
    ${data.lot.entries.map(entry => h`<section class="card"><h2>${L.t(`portal.prepaid.entry.${entry.kind}`)}</h2><p>${L.day(entry.date)}</p><dl>
      <dt>${L.t('portal.prepaid.change')}</dt><dd>${amount(entry.amountN)}</dd>
      <dt>${L.t('portal.prepaid.liability')}</dt><dd>${L.money(entry.liabilityCents)}</dd>
      <dt>${L.t('portal.prepaid.recognized')}</dt><dd>${L.money(entry.recognitionCents)}</dd></dl></section>`)}`
}

export async function portalPrepaidCsv(env: Bindings, session: CustomerSession) {
  const data = await portalPrepaidData(env, session)
  const rows: unknown[][] = [['source_id', 'denomination', 'source', 'meter', 'entry_kind', 'service_date', 'quantity_change', 'liability_change', 'recognized', 'remaining', 'available', 'source_path']]
  for (const lot of data.lots) for (const entry of lot.entries) {
    const amount = (n: number) => lot.kind === 'money' ? plainMoney(n) : decimalText(BigInt(n))
    rows.push([lot.id, lot.kind, lot.source, lot.meterCode, entry.kind, entry.date, amount(entry.amountN), plainMoney(entry.liabilityCents),
      plainMoney(entry.recognitionCents), amount(lot.remainingN), amount(lot.availableN), lot.href])
  }
  const cell = (value: unknown) => { const text = String(value ?? ''), safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text; return `"${safe.replaceAll('"', '""')}"` }
  return rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n'
}
