import type { Bindings } from '../../auth.server'
import { recordUnusableMethod } from '../card-lifecycle'
import { refusedPayment, type PaymentIdentity, type StripeClient } from './stripe'
import type { Row } from '../core'

export async function refusedPaymentWithLifecycle(env: Bindings, stripe: StripeClient, intent: Row, identity: PaymentIdentity) {
  const refusal=await refusedPayment(stripe,intent,identity)
  if(refusal)await recordUnusableMethod(env,identity,refusal.declineCode??refusal.errorCode)
  return refusal
}
