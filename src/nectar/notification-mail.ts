import type { Bindings } from '../auth.server'
import { operatorMail } from '../mail.server.mjs'
import { all, commit, now, stmt } from './core'
import { eligibleRecipient, type AlertEvent } from './notifications'
import { esc } from './ui/html'

export const ALERT_LABELS = { payment_mismatch: 'Payment does not match an invoice balance', billrun_exceptions: 'Bill-run exceptions waiting', proposals: 'Proposal awaiting approval' }

/** A sending claim is never automatically retried: an interrupted send may
 * already have reached the provider. Acceptance is not mailbox delivery. */
export async function deliverAlerts(env: Bindings, event: AlertEvent, subject: string, by: string) {
  for (const row of await all(env,"SELECT * FROM nc_notifications WHERE event=? AND subject=? AND status='pending'",event,subject)) {
    const claimed = await env.DB.prepare("UPDATE nc_notifications SET status='sending',updated_at=? WHERE event=? AND subject=? AND member_id=? AND status='pending' RETURNING member_id").bind(now(),event,subject,row.member_id).first()
    if (!claimed) continue
    let status = 'suppressed', provider: string | null = null
    if (await eligibleRecipient(env,event,row.member_id,row.email)) {
      const mail = operatorMail(env)
      status = 'failed'
      if (mail && env.MAIL_FROM) {
        const link = new URL(row.href,env.AUTH_ORIGIN).href
        status = 'uncertain'
        try {
          const result = await mail.send({ deliveryId: `notification-${event}-${subject}-${row.member_id}`, from:env.MAIL_FROM,to:[row.email],subject:ALERT_LABELS[event],
            text:`${ALERT_LABELS[event]}. Sign in to review this item:\n${link}`, html:`<p>${esc(ALERT_LABELS[event])}.</p><p><a href="${esc(link)}">Sign in to review this item</a></p>`,headers:{'Auto-Submitted':'auto-generated'} })
          status = result.status === 'accepted' ? 'accepted' : result.status === 'development' ? 'suppressed' : result.status
          provider = result.providerMessageId ?? null
        } catch { status = 'uncertain' }
      }
    }
    await commit(env,[stmt(env,'UPDATE nc_notifications SET status=?,provider_ref=?,updated_at=? WHERE event=? AND subject=? AND member_id=?',status,provider,now(),event,subject,row.member_id)],
      {actor:by,action:'notification.delivery',subject,detail:{event,member:row.member_id,status,provider}})
  }
}

/** Resume queued, never-claimed deliveries after an interrupted request. */
export async function deliverPendingAlerts(env: Bindings) {
  const pending = await all(env, "SELECT DISTINCT event,subject FROM nc_notifications WHERE status='pending' ORDER BY updated_at LIMIT 100")
  for (const row of pending) await deliverAlerts(env,row.event,row.subject,'system:notifications')
}
