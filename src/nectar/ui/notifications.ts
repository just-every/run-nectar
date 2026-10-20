import type { Bindings } from '../../auth.server'
import type { Actor } from '../actor'
import { notifications } from '../notifications'
import { ALERT_LABELS } from '../notification-mail'
import { check, form, h, table } from './html'

export async function notificationSection(env: Bindings, actor: Actor) {
  if (actor.kind !== 'member') return ''
  const { preferences: p, deliveries } = await notifications(env,actor)
  return h`<section class="card" aria-labelledby="notifications"><h2 id="notifications">Your email notifications</h2>
    <p class="hint">Choose emails for your own account. Alerts require your current access. New alert emails contain an event and a signed-in link; mention emails include the note. Provider acceptance does not confirm mailbox delivery.</p>
    ${form('notification.preferences','/app/more',h`${check('@-mentions','mentions',{checked:p.mentions})}${check('Payments that do not match an invoice balance','payment_mismatch',{checked:p.payment_mismatch})}${check('Bill-run exceptions waiting','billrun_exceptions',{checked:p.billrun_exceptions})}${check('Proposals awaiting approval','proposals',{checked:p.proposals})}`, 'Save email preferences')}
    <p class="hint">Payment alerts reach members who can read payments and record them; bill-run and proposal alerts reach members who can read them and approve. Dispute and webhook-failure alerts become available with those features.</p>
    <h3>Your recent alert emails</h3>${table(['Event','Outcome'],deliveries.map(d=>[h`<a href="${d.href}">${ALERT_LABELS[d.event as keyof typeof ALERT_LABELS]}</a>`,d.status === 'accepted' ? 'Email accepted by provider' : d.status === 'sending' ? 'Outcome unknown; not retried' : d.status === 'suppressed' ? 'Email suppressed' : `Email ${d.status}`]),{empty:'No alert emails recorded.'})}</section>`
}
