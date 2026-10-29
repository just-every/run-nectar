// Fully expanded monthly schedules become the same dated native items the
// rating engine already executes. No source write or new scheduler authority.
import { insist } from '../core'
import { localDate, zonedStart } from '../dates'

export function importedSchedule(subscription: any, items: any[], options: {
  zone: string; anchorDay: number; prices: any[]; supportedPrice: (price: any) => boolean
  priceId: (id: string) => string; identity: (id: string) => string; endDate: string | null
}): { items: any[]; endDate: string | null } {
  if (!subscription.schedule || typeof subscription.schedule === 'string') return { items, endDate: options.endDate }
  const refuse: (ok: unknown, reason: string) => asserts ok = (ok, reason) =>
    insist(ok, 'unsupported_imported_schedule', 400, { subscription: subscription.id, reason })
  const schedule = subscription.schedule, idOf = (value: any) => typeof value === 'string' ? value : value?.id
  refuse(typeof schedule === 'object' && typeof schedule.id === 'string' && schedule.status === 'active'
    && idOf(schedule.subscription) === subscription.id && idOf(schedule.customer) === idOf(subscription.customer),
  'the active schedule and its exact customer and subscription must be expanded')
  refuse(['release', 'cancel'].includes(schedule.end_behavior), 'unsupported schedule end behavior')
  refuse(!subscription.discount && !subscription.discounts?.length && !subscription.trial_end && !subscription.pause_collection,
    'scheduled discounts, trials and collection pauses need separate qualification')
  const simple = (phase: any) => !phase.discounts?.length && !phase.coupon && !phase.add_invoice_items?.length
    && !phase.trial_end && !phase.trial && !phase.billing_thresholds && !phase.application_fee_percent
    && !phase.automatic_tax?.enabled && !phase.default_tax_rates?.length && !phase.transfer_data
    && (!phase.currency || phase.currency === 'usd')
    && (!phase.invoice_settings || !Object.values(phase.invoice_settings).some(value => value != null))
    && (!phase.billing_cycle_anchor || phase.billing_cycle_anchor === 'automatic')
    && (!phase.collection_method || phase.collection_method === subscription.collection_method)
  refuse(simple(schedule.default_settings ?? {}), 'schedule defaults contain unsupported billing effects')
  const date = (instant: unknown) => {
    refuse(Number.isSafeInteger(instant) && (instant as number) > 0 && (instant as number) < 253_402_214_400,
      'each phase needs exact start and end instants')
    const day = localDate((instant as number) * 1000, options.zone)
    refuse(zonedStart(day, options.zone) === (instant as number) * 1000 && Number(day.slice(8)) === options.anchorDay,
      'phases must align with monthly business-local billing boundaries')
    return day
  }
  refuse(Array.isArray(schedule.phases) && schedule.phases.length > 0 && schedule.phases.length <= 10,
    'all schedule phases must be captured')
  const phases = schedule.phases.map((phase: any) => {
    refuse(simple(phase) && Array.isArray(phase.items) && phase.items.length > 0 && phase.items.length <= 6,
      'only monthly fixed and seat item phases are qualified')
    const from = date(phase.start_date), to = date(phase.end_date)
    refuse(to > from, 'phase dates are not increasing')
    const mapped = phase.items.map((item: any) => {
      const price = options.prices.find(price => price.id === idOf(item.price))
      refuse(options.supportedPrice(price) && price.recurring?.usage_type !== 'metered'
        && !item.discounts?.length && !item.tax_rates?.length && !item.billing_thresholds,
      'phase items require supported captured prices without extra billing effects')
      const quantity = item.quantity ?? 1
      refuse(Number.isSafeInteger(quantity) && quantity > 0 && quantity <= 1_000_000_000, 'phase quantity is unsupported')
      return { priceId: options.priceId(price.id), quantity }
    })
    return { from, to, mapped }
  })
  for (let index = 1; index < phases.length; index++) refuse(phases[index - 1].to === phases[index].from,
    'phase dates must be contiguous and ordered')
  const current = phases.findIndex((phase: any) => phase.from === date(schedule.current_phase?.start_date)
    && phase.to === date(schedule.current_phase?.end_date))
  refuse(current >= 0, 'the current phase must be captured')
  const capturedStart = date(subscription.current_period_start)
  refuse(phases[current].from <= capturedStart && phases[current].to > capturedStart,
    'the captured billing period must lie in the current phase')
  const terms = (rows: any[]) => JSON.stringify(rows.map(row => [row.priceId, String(row.quantity)]).sort())
  refuse(terms(items) === terms(phases[current].mapped), 'the current phase disagrees with subscription items')
  const future = phases.slice(current + 1), last = phases.at(-1)!
  const endDate = schedule.end_behavior === 'cancel' ? last.to : options.endDate
  refuse(!options.endDate || !endDate || options.endDate === endDate, 'schedule and subscription cancellations disagree')
  return { endDate, items: [
    ...items.map(item => ({ ...item, to: future[0]?.from ?? (schedule.end_behavior === 'cancel' ? last.to : null) })),
    ...future.flatMap((phase: any, index: number) => phase.mapped.map((item: any, part: number) => {
      const source = `${schedule.id}:${phase.from}:${part}`
      return { id: options.identity(source), priceId: item.priceId, quantity: item.quantity, from: phase.from,
        to: index === future.length - 1 && schedule.end_behavior === 'release' ? null : phase.to, providerRef: source }
    })),
  ].sort((a, b) => a.id.localeCompare(b.id)) }
}
