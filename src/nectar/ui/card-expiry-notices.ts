import type { Bindings } from '../../auth.server'
import type { Actor } from '../actor'
import { all, type Row } from '../core'
import { readCardExpiryNotices } from '../card-expiry-notices'
import { form, h, hidden } from './html'

export async function cardExpiryNoticesSection(env:Bindings,actor:Actor,customer:Row) {
  const notices=await readCardExpiryNotices(env,actor,customer.id)
  const canPrepare=actor.kind==='member'&&actor.role==='owner'&&customer.status==='active'
  const subscriptions=canPrepare?await all(env,"SELECT s.id,s.external_id,t.end_date FROM nc_subscriptions s JOIN nc_renewal_terms t ON t.subscription_id=s.id WHERE s.customer_id=? AND s.billing_mode='live' AND t.status='active' AND t.auto_renew=1 AND t.cancelled_at IS NULL",customer.id):[]
  const setups=canPrepare?await all(env,"SELECT id FROM nc_hosted_setups WHERE customer_id=? AND method='card' AND status='prepared'",customer.id):[]
  if(!notices.length&&!subscriptions.length)return ''
  return h`<details id="card-expiry-notices"><summary>Card expiry notices</summary><p>Review an exact warning on the day fourteen calendar days before renewal. The private update link lasts at most fifteen minutes; sending needs a separate confirmation. Provider acceptance is recorded.</p>
    ${subscriptions.length&&setups.length?form('card.expiry.prepare',`/app/customers/${customer.id}`,h`${hidden('customer',customer.id)}<label>Renewal<select name="subscription">${subscriptions.map(sub=>h`<option value="${sub.id}">${sub.external_id||sub.id} · ${sub.end_date}</option>`)}</select></label><label>Prepared card replacement<select name="setup">${setups.map(setup=>h`<option value="${setup.id}">${setup.id}</option>`)}</select></label><label><input type="checkbox" name="confirm" required> Prepare this exact expiry warning for review</label>`,'Prepare expiry notice'):''}
    ${notices.map(notice=>h`<article data-expiry-notice="${notice.id}"><h3>Renewal ${notice.renewalDate}</h3><p>${notice.recipient} · Card ending ${notice.last4} · ${notice.status}</p>${notice.errorCode?h`<p>${notice.errorCode}</p>`:''}${notice.preview?h`<p>${notice.preview.subject}</p><pre class="card-expiry-message">${notice.preview.text}</pre>${form('card.expiry.send',`/app/customers/${customer.id}`,h`${hidden('notice',notice.id)}${hidden('basis_hash',notice.basis)}<label><input type="checkbox" name="confirm" required> Send this exact notice once</label>`,'Send expiry notice')}`:''}</article>`)}
  </details>`
}
