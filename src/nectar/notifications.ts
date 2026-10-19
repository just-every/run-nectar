// Member-owned email choices and durable delivery custody. Events are queued
// in the originating domain transaction, before any network request.
import type { Bindings } from '../auth.server'
import { actorLabel, requireMember, type Actor } from './actor'
import { all, commit, insist, now, one, stmt } from './core'
import type { Input } from './input'

export const NOTIFICATION_EVENTS = ['mentions', 'payment_mismatch', 'billrun_exceptions', 'proposals'] as const
export type NotificationEvent = typeof NOTIFICATION_EVENTS[number]
export type AlertEvent = Exclude<NotificationEvent, 'mentions'>
const defaults = { mentions: true, payment_mismatch: false, billrun_exceptions: false, proposals: false }

export async function memberPreferences(env: Bindings, member: string) {
  const row = await one(env, 'SELECT * FROM nc_notification_preferences WHERE member_id=?', member)
  return Object.fromEntries(NOTIFICATION_EVENTS.map(event => [event, row ? !!row[event] : defaults[event]])) as Record<NotificationEvent, boolean>
}

export async function notifications(env: Bindings, actor: Actor) {
  requireMember(actor, 'read')
  return { preferences: await memberPreferences(env, actor.id), deliveries: await all(env,
    'SELECT event,subject,href,status,provider_ref,updated_at FROM nc_notifications WHERE member_id=? ORDER BY updated_at DESC,event,subject LIMIT 100', actor.id) }
}

export async function setNotificationPreferences(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'read')
  input.only([...NOTIFICATION_EVENTS, 'returnTo'])
  const values = NOTIFICATION_EVENTS.map(event => input.flag(event) ? 1 : 0)
  await commit(env, [stmt(env, `INSERT INTO nc_notification_preferences(member_id,mentions,payment_mismatch,billrun_exceptions,proposals)
    VALUES (?,?,?,?,?) ON CONFLICT(member_id) DO UPDATE SET mentions=excluded.mentions,payment_mismatch=excluded.payment_mismatch,billrun_exceptions=excluded.billrun_exceptions,proposals=excluded.proposals`, actor.id,...values)],
    { actor: actorLabel(actor), action: 'notification.preferences', subject: actor.id, detail: Object.fromEntries(NOTIFICATION_EVENTS.map((e,i) => [e,!!values[i]])) })
  return { preferences: await memberPreferences(env,actor.id) }
}

export async function alertStatements(env: Bindings, event: AlertEvent, subject: string, href: string) {
  insist(href.startsWith('/app/'), 'invalid_notification_link')
  // All current roles can read records; only owner and finance can act on
  // receivables or approve. GOV-001 must extend this check with custom roles.
  const recipients = await all(env, `SELECT m.id,m.email FROM nc_members m JOIN nc_notification_preferences p ON p.member_id=m.id
    WHERE m.status='active' AND m.role IN ('owner','finance') AND p.${event}=1`)
  return recipients.map(m => stmt(env, `INSERT OR IGNORE INTO nc_notifications(event,subject,href,member_id,email,status,updated_at) VALUES (?,?,?,?,?,'pending',?)`, event,subject,href,m.id,m.email,now()))
}

export async function eligibleRecipient(env: Bindings, event: AlertEvent, id: string, email: string) {
  return await one(env, `SELECT m.id FROM nc_members m JOIN nc_notification_preferences p ON p.member_id=m.id
    WHERE m.id=? AND m.email=? AND m.status='active' AND m.role IN ('owner','finance') AND p.${event}=1`,id,email)
}
