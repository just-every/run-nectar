import { requireUsdCurrency } from './currency'
// The ordinary engine supplies the exact first advance invoice. Legacy arrears
// trials keep their existing invoice timing and cannot authorize an early debit.
import type { Bindings } from '../auth.server'
import type { Actor } from './actor'
import { requireBusiness, taxReady } from './business'
import { draftFor } from './billruns'
import { billingWindowsForMonth } from './billing-plan'
import type { BillingWindow } from './billing-calendar'
import { canonical, insist, one } from './core'
import type { RatingInput, Rating } from './rating'

export interface TrialInvoiceQuote {
  subscription: string; customer: string; trialEnd: string; timezone: string
  subscriptionRevision: string; customerRevision: string; businessRevision: number
  window: BillingWindow; fingerprint: string; input: RatingInput; rating: Rating
}

export async function trialInvoiceQuote(env: Bindings, subscription: string): Promise<TrialInvoiceQuote> {
  const business = await requireBusiness(env)
  insist(taxReady(business), 'tax_not_reviewed', 409)
  const sub = await one(env, `SELECT s.*,c.billing_email,c.revision AS customer_revision,c.erased_at,c.status AS customer_status
    FROM nc_subscriptions s JOIN nc_customers c ON c.id=s.customer_id WHERE s.id=?`, subscription)
  insist(sub && sub.billing_mode === 'live' && sub.trial_end && sub.trial_payment === 'card' && !sub.trial_outcome
    && !sub.erased_at && sub.customer_status === 'active' && (!sub.end_date || sub.end_date > sub.trial_end), 'trial_collection_unavailable', 409)
  insist(!await one(env, 'SELECT 1 FROM nc_erased_records WHERE record_id IN (?,?)', sub.id, sub.customer_id), 'trial_collection_unavailable', 409)
  await requireUsdCurrency(env,{subscriptionId:subscription})
  const windows = await billingWindowsForMonth(env, sub, sub.trial_end.slice(0, 7))
  const due = windows?.filter(window => window.dueDate === sub.trial_end) ?? []
  insist(due.length === 1 && due[0].terms.timing === 'advance' && !due[0].mixed, 'trial_advance_invoice_required', 409)
  const draft = await draftFor(env, business, sub, due[0].period, due[0])
  const input = draft.input as RatingInput
  // An authorization never forecasts usage or silently consumes other financial
  // instruments. These subscriptions still use the ordinary manual invoice door.
  insist(!draft.exceptions.length && !input.prepaid && !input.contracts && !input.lifecycle?.length && !input.charges?.length
    && !input.usageAdjustments?.length && !input.usageCredits?.length && !input.renewals?.length
    && Object.values(input.prices).every(price => price.kind !== 'unit' && price.billing?.timing === 'advance'), 'trial_collection_terms_unsupported', 409)
  insist(!await one(env, "SELECT 1 FROM nc_customer_hierarchies WHERE customer_id=? AND billing_mode='consolidated'", sub.customer_id), 'consolidation_required', 409)
  insist(draft.rating.totalCents >= 50 && draft.rating.totalCents <= 99999999, 'native_collectible_balance_required', 409)
  return { subscription: sub.id, customer: sub.customer_id, trialEnd: sub.trial_end, timezone: business.timezone,
    subscriptionRevision: sub.revision, customerRevision: sub.customer_revision, businessRevision: business.revision,
    window: due[0], fingerprint: draft.fingerprint, input, rating: draft.rating }
}

export function matchTrialInvoice(saved: TrialInvoiceQuote, current: TrialInvoiceQuote) {
  insist(canonical(saved) === canonical(current), 'trial_collection_terms_changed', 409)
}

export const trialSystem = (id: string): Actor => ({ id: `trial-policy:${id}`, kind: 'agent' as const, name: `trial-policy:${id}`, email: '', role: null, sessionId: null, capabilities: new Set(['receivables']) })
