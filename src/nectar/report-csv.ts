import type { Bindings } from '../auth.server'
import { requireCapability, type Actor } from './actor'
import { report, type Report } from './reports'
import { plainMoney } from './decimal'

const cell = (value: unknown) => {
  const text = String(value ?? '')
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
}
export function reportsCsv(reports: Report[]) {
  const rows: unknown[][] = [['report','period','definition','source','customer','amount','source_path']]
  for (const r of reports) {
    rows.push([r.metric,r.period,r.definition,'TOTAL','',plainMoney(r.totalCents),''])
    for (const e of r.entries) rows.push([r.metric,r.period,r.definition,e.number,e.customerName,plainMoney(e.amountCents),e.href])
  }
  return rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n'
}
export function csvResponse(csv: string, name: string) {
  return new Response(csv, { headers: { 'content-type':'text/csv; charset=utf-8', 'content-disposition':`attachment; filename="${name}.csv"`, 'cache-control':'private, no-store', 'x-content-type-options':'nosniff' } })
}
export async function reportCsv(env: Bindings, actor: Actor, metric: string, url: URL) {
  requireCapability(actor,'export')
  return csvResponse(reportsCsv([await report(env,actor,metric,url)]),`nectar-${metric}`)
}
