import { subscriptionCalendar } from './billing-plan'
import { addMonths } from './dates'
import { clockInstant } from './clock'
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
  const subscriptions = await all(env, 'SELECT * FROM nc_subscriptions WHERE customer_id=? ORDER BY start_date,id', customer)
  return (await Promise.all(subscriptions.map(async sub => {
    const calendar=await subscriptionCalendar(env,sub),selected=month??today(business.timezone,clockInstant(env)).slice(0,7)
    const period = calendar.enabled?{start:`${selected}-01`,end:addMonths(`${selected}-01`,1)}:month ? periodStartingIn(sub.anchor_day, month) : periodContaining(sub.anchor_day, today(business.timezone,clockInstant(env)))
    const sourcePath = `/app/subscriptions/${sub.id}?preview_period=${period.start.slice(0, 7)}#upcoming`
    const common = { subscription: sub.id, externalId: sub.external_id, startDate: sub.start_date, period, sourcePath }
    try {
      // Freeze the selected anchor period across the engine's async reads:
      // a midnight boundary must not pair one period label with another bill.
      const view = await upcoming(env, actor, sub.id, period.start.slice(0, 7))
      return ('invoices' in view?view.invoices:[view]).map(current=>({ ...common,period:current.period,state:current.state,reason:null,invoiceId:current.invoiceId,
        subtotalCents:current.calculation.subtotalCents as number,taxCents:current.calculation.taxCents as number,totalCents:current.calculation.totalCents as number,
        remainingContractCreditCents:current.remainingContractCreditCents,exceptions:current.calculation.exceptions as {code:string;message:string}[]}))
    } catch (error) {
      // Only these expected period boundaries are display states. Calculation,
      // authority and infrastructure failures must still fail the request.
      if (!(error instanceof NectarError) || !['subscription_not_in_period', 'previous_biller_period','billing_window_not_due'].includes(error.code)) throw error
      return { ...common, state: 'unavailable', reason: error.code, invoiceId: null,
        subtotalCents: null, taxCents: null, totalCents: null, remainingContractCreditCents: null, exceptions: [] }
    }
  }))).flat()
}
