import type { Bindings } from '../../auth.server'
import { canRead, type Actor } from '../actor'
import { readCustomerPaymentMethods } from '../customer-payment-methods'
import { all, one, type Row } from '../core'
import { form, h, hidden, type Html } from './html'

export async function customerPaymentMethodsSection(env: Bindings, actor: Actor, customer: Row): Promise<Html | string> {
  if (!canRead(actor, 'payments') || !canRead(actor, 'invoices') || customer.erased_at
    || await one(env, 'SELECT 1 FROM nc_erased_records WHERE record_id=?', customer.id)) return ''
  const snapshots = await readCustomerPaymentMethods(env, actor, customer.id)
  const bindings = actor.kind === 'member' && actor.role === 'owner' && customer.status === 'active'
    ? await all(env, 'SELECT id FROM nc_stripe_customer_bindings WHERE customer_id=?', customer.id) : []
  if(!snapshots.length&&!bindings.length)return ''
  return h`<section class="card" id="saved-payment-methods"><h2>Saved payment methods</h2>
    <p>Historical provider snapshots, including restored copies. These observations do not authorize a debit, establish a mandate or confirm payer authorization.</p>
    ${bindings.length ? form('customer.payment_methods.refresh', `/app/customers/${customer.id}`, hidden('customer', customer.id), 'Refresh saved methods', { secondary: true }) : ''}
    ${snapshots.length ? snapshots.map(snapshot => h`<article><h3>Verified at ${new Date(snapshot.fetchedAt).toISOString()}</h3>
      <p>Processor account ${snapshot.accountRef} · Customer ${snapshot.customerRef}</p>
      ${snapshot.methods.length ? h`<ul>${snapshot.methods.map(method => h`<li>${method.type === 'card'
        ? `${method.brand} card ending ${method.last4} · Expires ${method.expMonth}/${method.expYear}`
        : `ACH · ${method.bankName} · ${method.accountType} account ending ${method.last4}`}</li>`)}</ul>` : h`<p>No saved card or ACH methods were found at this verification.</p>`}</article>`)
      : h`<p>No verified saved-method snapshot. Refresh from a held Stripe customer association to inspect saved cards and ACH accounts.</p>`}
  </section>`
}
