// DEV-002: explicit relationships; legacy scalar fields stay available to clients.
import type { Bindings } from '../auth.server'
import type { Actor } from './actor'
import { invoiceDetail } from './billruns'
import { all, insist, one, type Row } from './core'

export async function invoiceView(env: Bindings, actor: Actor, id: string, url: URL) {
  const invoice = await invoiceDetail(env, actor, id)
  const raw = url.searchParams.get('expand')
  const expand = new Set(raw === null || raw === '' ? [] : raw.split(',').map(path => path.trim()))
  insist([...expand].every(path => path === 'customer' || path === 'lines.price'), 'unknown_expansion')
  const customer = expand.has('customer') ? await one(env, 'SELECT * FROM nc_customers WHERE id=?', invoice.customer_id) : invoice.customer_id
  const priceIds = [...new Set((invoice.lines as Row[]).flatMap(line => line.price_id ? [line.price_id] : []))]
  const prices = expand.has('lines.price') && priceIds.length
    ? await all(env, `SELECT * FROM nc_prices WHERE id IN (${priceIds.map(() => '?').join(',')})`, ...priceIds) : []
  return { ...invoice, customer,
    lines: (invoice.lines as Row[]).map(line => ({ ...line, price: expand.has('lines.price') ? prices.find(price => price.id === line.price_id) ?? null : line.price_id })) }
}
