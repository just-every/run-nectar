// Invoice composition changes document custody, never service calendars.
import { insist } from './core'
import type { BillingWindow } from './billing-calendar'

export function billingServiceWindows(window: BillingWindow): BillingWindow[] {
  return window.serviceWindows ? window.serviceWindows.flatMap(billingServiceWindows) : [window]
}

const order = (a: BillingWindow, b: BillingWindow) => a.dueDate.localeCompare(b.dueDate) || a.key.localeCompare(b.key)

/** One subscription invoice per due date. Single-service invoices retain their
 * existing shape and identity; composed identity binds every selected claim. */
export function composeBillingWindows(windows: BillingWindow[]): BillingWindow[] {
  const groups = new Map<string, BillingWindow[]>()
  for (const window of windows.flatMap(billingServiceWindows)) {
    insist(window.components.length > 0, 'billing_window_changed', 409)
    const group = groups.get(window.dueDate) ?? []
    group.push(window); groups.set(window.dueDate, group)
  }
  return [...groups.values()].map(group => {
    const parts = group.sort(order)
    if (parts.length === 1) return parts[0]
    const components = parts.flatMap(part => part.components).sort((a, b) => a.key.localeCompare(b.key))
    insist(new Set(components.map(component => component.key)).size === components.length, 'billing_component_duplicate', 409)
    // The representative preserves existing optional envelope metadata. Mixed
    // consumers must read serviceWindows for actual cadence and service spans.
    const representative = parts.filter(part => part.terms.timing === 'arrears').at(-1) ?? parts.at(-1)!
    const dueDate = representative.dueDate
    const key = `composed:${dueDate}:${parts.map(part => `${part.key}[${part.components.map(component => component.key).sort().join(',')}]`).join('|')}`
    return { key, dueDate, terms: representative.terms, nominalStart: representative.nominalStart, nominalEnd: representative.nominalEnd,
      period: { start: components.map(component => component.from).sort()[0], end: components.map(component => component.to).sort().at(-1)! },
      components, mixed: true as const, serviceWindows: parts }
  }).sort(order)
}

/** Preserve each original service key while selecting unissued or saved claims. */
export function selectBillingComponents(window: BillingWindow, keys: Set<string>): BillingWindow | undefined {
  const parts = billingServiceWindows(window).flatMap(part => {
    const components = part.components.filter(component => keys.has(component.key))
    return components.length ? [{ ...part, components,
      period: { start: components.map(component => component.from).sort()[0], end: components.map(component => component.to).sort().at(-1)! } }] : []
  })
  return composeBillingWindows(parts)[0]
}
