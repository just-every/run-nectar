import { insist } from '../core'
import { providerReference, type StripeClient } from './stripe'

/** Safe display facts only. Observing a default never supplies debit consent. */
export async function savedCollectionMethod(stripe: StripeClient, customerRef: string, mandateRef?: string) {
  const customer = await stripe(`/customers/${encodeURIComponent(customerRef)}`)
  insist(customer.object === 'customer' && customer.id === customerRef && customer.deleted !== true && customer.livemode === false, 'automatic_collection_test_customer_required', 409)
  const paymentMethodRef = providerReference(customer.invoice_settings?.default_payment_method)
  const method = await stripe(`/payment_methods/${encodeURIComponent(paymentMethodRef)}`)
  insist(method.object === 'payment_method' && method.id === paymentMethodRef && providerReference(method.customer) === customerRef && method.livemode === false, 'automatic_collection_method_mismatch', 409)
  if (method.type === 'card') {
    const card = method.card
    insist(card && /^[a-z_]{1,40}$/.test(card.brand) && /^\d{4}$/.test(card.last4) && Number.isInteger(card.exp_month) && Number.isInteger(card.exp_year), 'automatic_collection_card_invalid', 409)
    return { customerRef, paymentMethodRef, kind: 'card' as const, summary: { brand: card.brand, last4: card.last4, expMonth: card.exp_month, expYear: card.exp_year }, mandateRef: null }
  }
  insist(method.type === 'us_bank_account' && method.us_bank_account && /^\d{4}$/.test(method.us_bank_account.last4), 'automatic_collection_method_unsupported', 409)
  insist(mandateRef, 'automatic_collection_active_mandate_required', 409)
  const mandate = await stripe(`/mandates/${encodeURIComponent(providerReference(mandateRef))}`)
  insist(mandate.object === 'mandate' && mandate.id === mandateRef && mandate.status === 'active' && mandate.type === 'multi_use'
    && mandate.livemode === false && providerReference(mandate.payment_method) === paymentMethodRef, 'automatic_collection_active_mandate_required', 409)
  return { customerRef, paymentMethodRef, kind: 'us_bank_account' as const, summary: { brand: 'ACH', last4: method.us_bank_account.last4, bankName: String(method.us_bank_account.bank_name ?? '').slice(0, 100) }, mandateRef }
}
