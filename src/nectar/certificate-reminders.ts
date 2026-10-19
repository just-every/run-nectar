// Daily expiry/remediation notices through the installation's configured mail.
import type { Bindings } from '../auth.server'
import { operatorMail } from '../mail.server.mjs'
import { actorLabel, requireMember, requireOwner, type Actor } from './actor'
import { preparePolicyChange } from './policy-changes'
import { business } from './business'
import { all, commit, now, one, stmt } from './core'
import { esc } from './ui/html'
import { addDays, localDate } from './dates'

export async function sendCertificateReminders(env: Bindings, instant = Date.now(), who = 'system:certificate-reminders') {
  const policy = await one(env, 'SELECT enabled,revision FROM nc_certificate_policy WHERE singleton=1')
  if (!policy?.enabled) return { sent: 0, disabled: true }
  const b = await business(env)
  if (!b) return { sent: 0 }
  const day = localDate(instant, b.timezone)
  const rows = await all(env, `SELECT cl.customer_id,cl.state,c.name,c.billing_email,
    ce.id AS certificate_id,ce.expires_on FROM nc_exemption_claims cl JOIN nc_customers c ON c.id=cl.customer_id
    LEFT JOIN nc_certificates ce ON ce.id=(SELECT id FROM nc_certificates WHERE customer_id=cl.customer_id AND state=cl.state AND status='validated' AND valid_from<=? ORDER BY expires_on DESC,id LIMIT 1)
    WHERE c.status='active'`, day)
  let sent = 0
  for (const row of rows) {
    if (row.expires_on && row.expires_on > addDays(day, 30)) continue
    const kind = !row.certificate_id ? 'missing' : row.expires_on < day ? 'expired' : 'expiring'
    const delivery = `certificate-${row.certificate_id ?? `${row.customer_id}-${row.state}`}-${kind}`
    await env.DB.prepare("INSERT OR IGNORE INTO nc_certificate_reminders (delivery_id,customer_id,state,certificate_id,kind,status,created_at) VALUES (?,?,?,?,?,'pending',?)")
      .bind(delivery, row.customer_id, row.state, row.certificate_id, kind, now()).run()
    // Atomic claim prevents overlapping cron/manual deliveries. An uncertain send is
    // kept for operator investigation, never silently retried after provider acceptance.
    const claimed = await env.DB.prepare("UPDATE nc_certificate_reminders SET status='sending' WHERE delivery_id=? AND status='pending' RETURNING delivery_id").bind(delivery).first()
    if (!claimed) continue
    const mail = operatorMail(env)
    if (!mail || !env.MAIL_FROM) {
      await env.DB.prepare("UPDATE nc_certificate_reminders SET status='failed' WHERE delivery_id=?").bind(delivery).run()
      continue
    }
    const body = `${row.name}: your ${row.state} exemption certificate is ${kind}${row.expires_on ? ` (expires ${row.expires_on})` : ''}. Please send a current certificate to ${b.billing_email || env.MAIL_FROM}. Billing cannot use an exemption without validated coverage for the service period.`
    let status = 'uncertain', provider = null
    try {
      const result = await mail.send({ deliveryId: delivery, from: env.MAIL_FROM, to: [row.billing_email], subject: `${row.state} exemption certificate ${kind}`, text: body, html: `<p>${esc(body)}</p>`, headers: { 'Auto-Submitted': 'auto-generated' } })
      status = result.status === 'accepted' ? 'accepted' : result.status === 'development' ? 'suppressed' : result.status
      provider = result.providerMessageId ?? null
    } catch { status = 'uncertain' }
    await commit(env, [stmt(env, 'UPDATE nc_certificate_reminders SET status=?,provider_ref=?,sent_at=? WHERE delivery_id=?', status, provider, now(), delivery)],
      { actor: who, action: 'certificate.remind', subject: row.customer_id, detail: { policyRevision: policy.revision, delivery, state: row.state, kind, status } })
    if (status === 'accepted') sent++
  }
  return { sent }
}

export async function remindCertificates(env: Bindings, actor: Actor) {
  requireMember(actor, 'records')
  const result = await sendCertificateReminders(env, Date.now(), actorLabel(actor))
  return result
}


export async function configureCertificatePolicy(env: Bindings, actor: Actor, input: import('./input').Input) {
  requireOwner(actor)
  const enabled = input.flag('enabled')
  return await preparePolicyChange(env, actor, 'certificate', { enabled })
}
