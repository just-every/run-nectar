// RPT-002: a read-only lot/ledger snapshot. Quantities never become USD.
import type { Bindings } from '../auth.server'
import { insist, stmt, type Row } from './core'
import { decimalText } from './decimal'
import { lotStates } from './prepaid-math'
import { PREPAID_VERSION, type PrepaidEntry, type PrepaidGrant } from './prepaid-types'
import type { ReportComponent } from './reports'

export interface PrepaidReportBalance {
  grantId: string
  subscriptionId: string
  kind: 'money' | 'units'
  source: 'purchase' | 'promotion'
  asOf: string
  meterId: string | null
  meterCode: string | null
  unitLabel: string | null
  remainingN: number
  availableN: number
  remainingQuantity: string | null
  availableQuantity: string | null
  liabilityCents: number
  expiryPending: boolean
  ledgerHref: string | null
  purchaseHref: string | null
  entries: { id: string; kind: PrepaidEntry['kind']; serviceDate: string; amountN: number; liabilityCents: number; recognitionCents: number; href: string | null }[]
}

export async function prepaidFinancialSources(env: Bindings, date: string, customer: string | null, href: (id: string) => string) {
  const selected = 'g.effective_date<=? AND (? IS NULL OR g.customer_id=?)'
  const [grantResult, ledgerResult] = await env.DB.batch<Row>([
    stmt(env, `SELECT g.*,CASE WHEN c.erased_at IS NULL THEN c.name ELSE 'Erased customer' END AS customer_name,
      c.erased_at,m.code AS meter_code,m.unit_label FROM nc_prepaid_grants g JOIN nc_customers c ON c.id=g.customer_id
      LEFT JOIN nc_meters m ON m.id=g.meter_id WHERE ${selected} ORDER BY g.effective_date,g.id`, date, customer, customer),
    stmt(env, `SELECT l.* FROM nc_prepaid_ledger l JOIN nc_prepaid_grants g ON g.id=l.grant_id
      WHERE ${selected} AND l.service_date<=? ORDER BY l.service_date,l.created_at,l.id`, date, customer, customer, date),
  ])
  const sources = new Map<string, { entry: { invoiceId: string; number: string; customerId: string; customerName: string; amountCents: number; sourceKind: 'prepaid_grant'; grantId: string; href: string; prepaid: PrepaidReportBalance }; components: ReportComponent[]; prepaid: PrepaidReportBalance }>()
  for (const row of grantResult.results) {
    const grant: PrepaidGrant = { id: row.id, subscription: row.subscription_id, customer: row.customer_id, kind: row.kind, source: row.source,
      amountN: row.amount_n, valueCents: row.value_cents, meterId: row.meter_id, effectiveDate: row.effective_date, expiresDate: row.expires_date,
      priority: row.priority, rolloverMonths: row.rollover_months, rolloverPercent: row.rollover_percent, rolloverCapN: row.rollover_cap_n,
      expiryConsent: !!row.expiry_consent, purchaseInvoice: row.purchase_invoice_id, purchaseLine: row.purchase_line_id }
    const ledger: PrepaidEntry[] = ledgerResult.results.filter(entry => entry.grant_id === row.id).map(entry => ({ id: entry.id, grantId: entry.grant_id, kind: entry.kind,
      amountN: entry.amount_n, liabilityCents: entry.liability_cents, recognitionCents: entry.recognition_cents, serviceDate: entry.service_date,
      invoiceId: entry.invoice_id, lineIndex: entry.line_index, purchaseInvoice: entry.purchase_invoice_id, purchaseLine: entry.purchase_line_id }))
    const lot = lotStates({ version: PREPAID_VERSION, subscription: grant.subscription, customer: grant.customer, revision: 0, grants: [grant], entries: ledger })[0]
    const expired = !!grant.expiresDate && grant.expiresDate <= date
    const availableN = expired ? 0 : lot.remainingN
    const amountCents = grant.kind === 'money' ? availableN : lot.liabilityCents
    if (!lot.remainingN && !amountCents) continue
    const ledgerLink = (id: string) => row.erased_at ? null : `/app/prepaid/${grant.subscription}/entries/${encodeURIComponent(id)}`
    const remainingQuantity = grant.kind === 'units' ? decimalText(BigInt(lot.remainingN)) : null
    const availableQuantity = grant.kind === 'units' ? decimalText(BigInt(availableN)) : null
    const prepaid: PrepaidReportBalance = { grantId: grant.id, subscriptionId: grant.subscription, kind: grant.kind, source: grant.source, asOf: date,
      meterId: grant.meterId, meterCode: row.meter_code, unitLabel: row.unit_label, remainingN: lot.remainingN, availableN,
      remainingQuantity, availableQuantity, liabilityCents: lot.liabilityCents, expiryPending: expired && lot.remainingN > 0,
      ledgerHref: ledger.find(entry => entry.kind === 'grant') ? ledgerLink(ledger.find(entry => entry.kind === 'grant')!.id) : null,
      purchaseHref: grant.purchaseInvoice ? `/app/invoices/${grant.purchaseInvoice}${grant.purchaseLine ? `/lines/${grant.purchaseLine}` : ''}` : null,
      entries: ledger.map(entry => ({ id: entry.id, kind: entry.kind, serviceDate: entry.serviceDate, amountN: entry.amountN,
        liabilityCents: entry.liabilityCents, recognitionCents: entry.recognitionCents, href: ledgerLink(entry.id) })) }
    const components: ReportComponent[] = ledger.map(entry => ({ kind: `prepaid_${entry.kind}`, label: `${grant.kind === 'money' ? 'USD credit' : 'Unit consideration'} · ${entry.kind} · ${entry.serviceDate}`,
      amountCents: grant.kind === 'money' ? entry.amountN : entry.liabilityCents, ...(ledgerLink(entry.id) ? { href: ledgerLink(entry.id)! } : {}) }))
    if (grant.kind === 'money' && expired && lot.remainingN) components.push({ kind: 'prepaid_unavailable', label: 'Expired credit unavailable; expiry settlement has not been recorded', amountCents: -lot.remainingN })
    insist(components.reduce((sum, component) => sum + BigInt(component.amountCents), 0n) === BigInt(amountCents), 'prepaid_report_source_changed', 409)
    const id = `prepaid-${grant.id}`
    sources.set(id, { entry: { invoiceId: id, grantId: grant.id, number: `Prepaid ${grant.source} ${grant.kind}${grant.kind === 'units' ? ` · ${availableQuantity} ${row.unit_label ?? 'units'} available` : ''}`,
      customerId: grant.customer, customerName: row.customer_name, amountCents, sourceKind: 'prepaid_grant', href: href(id), prepaid }, components, prepaid })
  }
  return sources
}
