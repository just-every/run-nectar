// CUS-001 composes the existing subscription calculation without preparing bills.
import type { Bindings } from '../auth.server'
import { requireRead, type Actor } from './actor'
import { requireBusiness } from './business'
import { all, insist, NectarError } from './core'
import { isMonth, periodContaining, periodStartingIn, today } from './dates'
import { upcoming } from './upcoming'

export async function customerUpcoming(env: Bindings, actor: Actor, customer: string, month: string | null) {
  requireRead(actor, 'customers')
  requireRead(actor, 'subscriptions')
  requireRead(actor, 'invoices')
  insist(month === null || isMonth(month), 'invalid_period')
  const business = await requireBusiness(env)
  const subscriptions = await all(env, 'SELECT id, external_id, start_date, anchor_day FROM nc_subscriptions WHERE customer_id=? ORDER BY start_date,id', customer)
  return await Promise.all(subscriptions.map(async sub => {
    const period = month ? periodStartingIn(sub.anchor_day, month) : periodContaining(sub.anchor_day, today(business.timezone))
    const sourcePath = `/app/subscriptions/${sub.id}?preview_period=${period.start.slice(0, 7)}#upcoming`
    const common = { subscription: sub.id, externalId: sub.external_id, startDate: sub.start_date, period, sourcePath }
    try {
      const view = await upcoming(env, actor, sub.id, month)
      const calculation = view.calculation
      return { ...common, state: view.state, reason: null, invoiceId: view.invoiceId,
        subtotalCents: calculation.subtotalCents as number, taxCents: calculation.taxCents as number, totalCents: calculation.totalCents as number,
        remainingContractCreditCents: view.remainingContractCreditCents,
        exceptions: calculation.exceptions as { code: string; message: string }[] }
    } catch (error) {
      // Only these expected period boundaries are display states. Calculation,
      // authority and infrastructure failures must still fail the request.
      if (!(error instanceof NectarError) || !['subscription_not_in_period', 'previous_biller_period'].includes(error.code)) throw error
      return { ...common, state: 'unavailable', reason: error.code, invoiceId: null,
        subtotalCents: null, taxCents: null, totalCents: null, remainingContractCreditCents: null, exceptions: [] }
    }
  }))
}
