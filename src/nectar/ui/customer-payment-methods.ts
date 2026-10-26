import { cardExpiryNoticesSection } from './card-expiry-notices'
import { readCardLifecycle } from '../card-lifecycle'
import { customerHostedSetups } from '../hosted-setup'
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
    ? await all(env, 'SELECT id,account_ref FROM nc_stripe_customer_bindings WHERE customer_id=?', customer.id) : []
  const lifecycle=await readCardLifecycle(env,actor,customer.id)
  const completed=bindings.length?(await all(env,"SELECT id,binding_id,method_json FROM nc_hosted_setups WHERE customer_id=? AND status='complete'",customer.id)):[]
  const methods=completed.length?await customerHostedSetups(env,customer.id):[]
  if(!snapshots.length&&!bindings.length&&!lifecycle.length)return ''
  return h`<section class="card" id="saved-payment-methods"><h2>Saved payment methods</h2>
    <p>Historical provider snapshots, including restored copies. These observations do not authorize a debit, establish a mandate or confirm payer authorization.</p>
    ${bindings.length ? h`<details><summary>Prepare test checkout</summary><p>The customer confirms capture and the default method in their hosted portal. No charge is made.</p>${form('checkout.setup.prepare', `/app/customers/${customer.id}`, h`${hidden('customer',customer.id)}<label>Processor account<select name="binding">${bindings.map(binding=>h`<option value="${binding.id}">${binding.account_ref}</option>`)}</select></label><label>Method<select name="method"><option value="card">Card</option><option value="us_bank_account">ACH</option></select></label><label><input type="checkbox" name="confirm" required> Prepare for this customer</label>`, 'Prepare checkout')}</details>` : ''}
    ${bindings.length ? form('customer.payment_methods.refresh', `/app/customers/${customer.id}`, hidden('customer', customer.id), 'Refresh saved methods', { secondary: true }) : ''}
    ${completed.length?h`<details><summary>Manage a saved method</summary><p>Prepare a choice for the customer to confirm. Choose a replacement before removing the current default. Pending collection authority must be resolved before removal.</p>${completed.map(row=>{const method=methods.find(item=>item.id===row.id)?.paymentMethod;return method?form('portal.method.prepare',`/app/customers/${customer.id}`,h`${hidden('customer',customer.id)}${hidden('binding',row.binding_id)}${hidden('setup',row.id)}<p>${method.brand??method.bankName} · Ending ${method.last4}</p><label>Choice<select name="operation"><option value="default">Choose default</option><option value="remove">Remove method</option></select></label><label><input type="checkbox" name="confirm" required> Prepare this exact choice for the customer</label>`,'Prepare choice'):''})}</details>`:''}
    ${lifecycle.length?h`<h3>Card lifecycle</h3>${lifecycle.map(row=>h`<article data-card-lifecycle="${row.id}"><p>${row.card?`${row.card.brand} · Ending ${row.card.last4} · Expires ${row.card.expMonth}/${row.card.expYear}`:row.methodRef}</p><p>${row.usable?'Usable for separately authorized collection':`Unusable · ${row.unusableReason} · Waiting for a new method`}</p></article>`)}`:''}
    ${bindings.length?h`<details><summary>Reconcile a card updater event</summary>${form('card.lifecycle.consume',`/app/customers/${customer.id}`,h`<label>Processor account<select name="binding">${bindings.map(binding=>h`<option value="${binding.id}">${binding.account_ref}</option>`)}</select></label><label>Provider event reference<input name="event_ref" required maxlength="255"></label><label><input type="checkbox" name="confirm" required> Read this event from the processor and reconcile this customer's card</label>`,'Reconcile updater')}</details>`:''}
    ${snapshots.length ? snapshots.map(snapshot => h`<article><h3>Verified at ${new Date(snapshot.fetchedAt).toISOString()}</h3>
      <p>Processor account ${snapshot.accountRef} · Customer ${snapshot.customerRef}</p>
      ${snapshot.methods.length ? h`<ul>${snapshot.methods.map(method => h`<li>${method.type === 'card'
        ? `${method.brand} card ending ${method.last4} · Expires ${method.expMonth}/${method.expYear}`
        : `ACH · ${method.bankName} · ${method.accountType} account ending ${method.last4}`}</li>`)}</ul>` : h`<p>No saved card or ACH methods were found at this verification.</p>`}</article>`)
      : h`<p>No verified saved-method snapshot. Refresh from a held Stripe customer association to inspect saved cards and ACH accounts.</p>`}
    ${await cardExpiryNoticesSection(env,actor,customer)}
  </section>`
}
