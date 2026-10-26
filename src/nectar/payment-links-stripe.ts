import type { Bindings } from '../auth.server'
import { insist } from './core'
import { stripeForAccount } from './payments/stripe'

/** Account identity alone cannot distinguish a live key from a test key. Check
 * a mode-bearing read before any signup mutation, including customer creation. */
export async function paymentLinkStripe(env:Bindings,account:string|null) {
  const selected=await stripeForAccount(env,account),balance=await selected.stripe('/balance')
  insist(balance.object==='balance'&&balance.livemode===false,'payment_link_test_mode_required',409)
  return selected
}
