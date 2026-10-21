import type { Bindings } from '../auth.server'
import { requireCapability, requireRead, type Actor } from './actor'
import { all } from './core'
import { csvResponse } from './report-csv'

export type RegisterKind = 'invoice' | 'credit-note'
export interface NumberRegisterEntry {
  source: string
  kind: RegisterKind
  id: string
  sourceReference: string
  customerId: string
  number: string | null
  currency: string | null
  subtotalCents: number | null
  taxCents: number | null
  totalCents: number
  paidCents: number | null
  remainingCents: number | null
  href: string
}
export interface NumberRegisterSeries {
  kind: RegisterKind
  prefix: string
  width: number
  firstSuffix: string
  lastSuffix: string
  recordedCount: number
  distinctCount: number
}
export interface NumberRegisterGap {
  kind: RegisterKind
  prefix: string
  width: number
  firstSuffix: string
  lastSuffix: string
  from: string
  to: string
  count: string
}
export interface NumberRegister {
  entries: NumberRegisterEntry[]
  series: NumberRegisterSeries[]
  gaps: NumberRegisterGap[]
  unparsed: NumberRegisterEntry[]
  duplicates: { number: string; entries: NumberRegisterEntry[] }[]
}

/** All stored imported invoices, issued native invoices, and issued credit notes.
 * No row cap or inferred missing documents: only internal numeric gaps are reported.
 * Decimal suffixes remain strings at the boundary, including beyond JS safe integers.
 */
export async function numberRegister(env: Bindings, actor: Actor): Promise<NumberRegister> {
  requireRead(actor, 'invoices')
  const rows = await all<NumberRegisterEntry & { invoiceId: string | null }>(env, `
    SELECT provider AS source,document_kind AS kind,id,provider_ref AS sourceReference,
      customer_id AS customerId,number,NULL AS currency,CASE WHEN document_kind='invoice' THEN total_cents-tax_cents END AS subtotalCents,
      CASE WHEN document_kind='invoice' THEN tax_cents END AS taxCents,total_cents AS totalCents,CASE WHEN document_kind='invoice' THEN paid_cents END AS paidCents,
      CASE WHEN document_kind='invoice' THEN remaining_cents END AS remainingCents,NULL AS invoiceId
    FROM nc_incumbent_invoices
    UNION ALL
    SELECT 'nectar','invoice',id,id,customer_id,number,currency,subtotal_cents,
      tax_cents,total_cents,NULL,NULL,id FROM nc_invoices WHERE status='issued'
    UNION ALL
    SELECT 'nectar','credit-note',c.id,c.id,c.customer_id,c.number,i.currency,c.subtotal_cents,
      c.tax_cents,c.amount_cents,NULL,NULL,c.invoice_id
    FROM nc_credit_notes c LEFT JOIN nc_invoices i ON i.id=c.invoice_id
    ORDER BY kind,number,source,id`)
  const entries: NumberRegisterEntry[] = rows.map(({ invoiceId, ...row }) => ({ ...row,
    href: invoiceId ? `/app/invoices/${encodeURIComponent(invoiceId)}${row.kind === 'credit-note' ? `#credit-${encodeURIComponent(row.id)}` : ''}`
      : `/app/customers/${encodeURIComponent(row.customerId)}#hist`,
  }))
  const unparsed: NumberRegisterEntry[] = []
  const grouped = new Map<string, { kind: RegisterKind; prefix: string; width: number; suffixes: bigint[] }>()
  const numbered = new Map<string, NumberRegisterEntry[]>()
  for (const entry of entries) {
    if (entry.number) {
      const same = numbered.get(entry.number) ?? []
      same.push(entry)
      numbered.set(entry.number, same)
    }
    const parsed = entry.number?.match(/^(.*?)(\d+)$/)
    if (!parsed) { unparsed.push(entry); continue }
    const [, prefix, suffix] = parsed
    const width = suffix.length
    const key = JSON.stringify([entry.kind, prefix, width])
    const group = grouped.get(key) ?? { kind: entry.kind, prefix, width, suffixes: [] }
    group.suffixes.push(BigInt(suffix))
    grouped.set(key, group)
  }
  const series: NumberRegisterSeries[] = []
  const gaps: NumberRegisterGap[] = []
  for (const group of grouped.values()) {
    const values = [...new Set(group.suffixes)].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
    const suffix = (value: bigint) => value.toString().padStart(group.width, '0')
    const { kind, prefix, width } = group
    series.push({ kind, prefix, width, firstSuffix: suffix(values[0]), lastSuffix: suffix(values[values.length - 1]), recordedCount: group.suffixes.length, distinctCount: values.length })
    for (let index = 1; index < values.length; index++) {
      const first = values[index - 1] + 1n, last = values[index] - 1n
      if (first > last) continue
      gaps.push({ kind, prefix, width, firstSuffix: suffix(first), lastSuffix: suffix(last), from: prefix + suffix(first), to: prefix + suffix(last), count: (last - first + 1n).toString() })
    }
  }
  return { entries, series, gaps, unparsed, duplicates: [...numbered].filter(([, matching]) => matching.length > 1).map(([number, matching]) => ({ number, entries: matching })) }
}

const cell = (value: unknown) => {
  const text = String(value ?? '')
  const safe = /^[=+\-@\t\r\n]/.test(text) ? `'${text}` : text
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
}

/** One rectangular CSV; row_type distinguishes entries, series and gap ranges.
 * Amounts are stored cents; credit amounts are positive as recorded, not netted.
 */
export function numberRegisterCsv(register: NumberRegister): string {
  const rows: unknown[][] = [['row_type','kind','source','source_id','source_reference','customer_id','number','currency','subtotal_cents','tax_cents','total_cents','paid_cents','remaining_cents','href','prefix','digit_width','first_suffix','last_suffix','missing_from','missing_to','missing_count','duplicate_number','unparsed_number','recorded_count','distinct_count']]
  const duplicates = new Set(register.duplicates.map(row => row.number))
  const unparsed = new Set(register.unparsed)
  for (const entry of register.entries) rows.push(['entry',entry.kind,entry.source,entry.id,entry.sourceReference,entry.customerId,entry.number,entry.currency,entry.subtotalCents,entry.taxCents,entry.totalCents,entry.paidCents,entry.remainingCents,entry.href,'','','','','','','',duplicates.has(entry.number ?? '') ? 'yes' : 'no',unparsed.has(entry) ? 'yes' : 'no','',''])
  for (const s of register.series) rows.push(['series',s.kind,'','','','','','','','','','','','',s.prefix,s.width,s.firstSuffix,s.lastSuffix,'','','','','',s.recordedCount,s.distinctCount])
  for (const gap of register.gaps) rows.push(['gap',gap.kind,'','','','','','','','','','','','',gap.prefix,gap.width,gap.firstSuffix,gap.lastSuffix,gap.from,gap.to,gap.count,'','','',''])
  return rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n'
}

export async function numberRegisterExport(env: Bindings, actor: Actor) {
  requireCapability(actor, 'export')
  return csvResponse(numberRegisterCsv(await numberRegister(env, actor)), 'nectar-number-register')
}
