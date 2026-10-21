import type { Bindings } from '../auth.server'
import { all, guard, stmt } from './core'
import type { BillingTerms, BillingWindow } from './billing-calendar'

/** Called by the ordinary immutable price publisher in its existing batch. */
export function billingTermsStatements(env: Bindings, priceId: string, terms: BillingTerms) {
  return [stmt(env, 'INSERT INTO nc_price_intervals(price_id,interval_unit,interval_count,billing_timing) VALUES(?,?,?,?)', priceId, terms.unit, terms.count, terms.timing)]
}

export async function unissuedBillingWindows(env: Bindings, subscriptionId: string, windows: BillingWindow[]) {
  const claimed = new Set((await all(env, 'SELECT component_key FROM nc_billing_components WHERE subscription_id=?', subscriptionId)).map(row => row.component_key))
  return windows.flatMap(window => {
    const components = window.components.filter(component => !claimed.has(component.key))
    return components.length ? [{ ...window, components, period: { start: components.map(c => c.from).sort()[0], end: components.map(c => c.to).sort().at(-1)! } }] : []
  })
}

/** Append AFTER the invoice status changes to issued in the same atomic batch.
 * No reservation is written during previews or draft preparation. */
export function billingComponentClaimStatements(env: Bindings, subscriptionId: string, invoiceId: string, window: BillingWindow) {
  return [guard(env, 'contract_credit_already_issued', `NOT EXISTS(SELECT 1 FROM nc_invoice_lines current JOIN nc_invoice_lines previous ON previous.kind='credit' AND json_extract(previous.evidence_json,'$.amendment')=json_extract(current.evidence_json,'$.amendment') JOIN nc_invoices issued ON issued.id=previous.invoice_id WHERE current.invoice_id=? AND current.kind='credit' AND issued.status='issued' AND issued.id<>?)`, invoiceId, invoiceId), ...window.components.flatMap(component => [
    guard(env, 'billing_component_already_issued', 'NOT EXISTS(SELECT 1 FROM nc_billing_components WHERE subscription_id=? AND component_key=?)', subscriptionId, component.key),
    stmt(env, 'INSERT INTO nc_billing_components(subscription_id,component_key,invoice_id,item_id,service_start,service_end,nominal_start,nominal_end) VALUES(?,?,?,?,?,?,?,?)', subscriptionId, component.key, invoiceId, component.itemId, component.from, component.to, component.nominalStart, component.nominalEnd),
  ])]
}
