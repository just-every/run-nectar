// Member-owned email choices and durable delivery custody. Events are queued
// in the originating domain transaction, before any network request.
import type { Bindings } from '../auth.server'
import { memberCapabilities, requirePerson, actorLabel, type Actor, type Capability, type Role } from './actor'
import { all, commit, insist, now, one, stmt } from './core'
import type { Input } from './input'

export const NOTIFICATION_EVENTS = ['mentions', 'payment_mismatch', 'billrun_exceptions', 'proposals', 'webhook_failure'] as const
export type NotificationEvent = typeof NOTIFICATION_EVENTS[number]
export type AlertEvent = Exclude<NotificationEvent, 'mentions'>
const defaults = { mentions: true, payment_mismatch: false, billrun_exceptions: false, proposals: false, webhook_failure: false }

export async function memberPreferences(env: Bindings, member: string) {
  const row = await one(env, 'SELECT * FROM nc_notification_preferences WHERE member_id=?', member)
  return Object.fromEntries(NOTIFICATION_EVENTS.map(event => [event, row ? !!row[event] : defaults[event]])) as Record<NotificationEvent, boolean>
}

export async function notifications(env: Bindings, actor: Actor) {
  requirePerson(actor)
  return { preferences: await memberPreferences(env, actor.id), deliveries: await all(env,
    'SELECT event,subject,href,status,provider_ref,updated_at FROM nc_notifications WHERE member_id=? ORDER BY updated_at DESC,event,subject LIMIT 100', actor.id) }
}

export async function setNotificationPreferences(env: Bindings, actor: Actor, input: Input) {
  requirePerson(actor)
  input.only([...NOTIFICATION_EVENTS, 'returnTo'])
  const values = NOTIFICATION_EVENTS.map(event => input.flag(event) ? 1 : 0)
  await commit(env, [stmt(env, `INSERT INTO nc_notification_preferences(member_id,mentions,payment_mismatch,billrun_exceptions,proposals,webhook_failure)
    VALUES (?,?,?,?,?,?) ON CONFLICT(member_id) DO UPDATE SET mentions=excluded.mentions,payment_mismatch=excluded.payment_mismatch,billrun_exceptions=excluded.billrun_exceptions,proposals=excluded.proposals,webhook_failure=excluded.webhook_failure`, actor.id,...values)],
    { actor: actorLabel(actor), action: 'notification.preferences', subject: actor.id, detail: Object.fromEntries(NOTIFICATION_EVENTS.map((e,i) => [e,!!values[i]])) })
  return { preferences: await memberPreferences(env,actor.id) }
}

// GOV-001/INT-003: an alert needs the member's current authority to read the
// record and act on it, never a role name alone; opting in grants nothing.
const ALERT_AUTHORITY: Record<AlertEvent, { read: Capability[]; act: Capability[] }> = {
  webhook_failure: { read: ['read'], act: ['credentials','approve'] },
  payment_mismatch: { read: ['read', 'read.payments'], act: ['receivables'] },
  billrun_exceptions: { read: ['read', 'read.invoices'], act: ['approve'] },
  proposals: { read: ['read'], act: ['approve'] },
}
const ALERT_SQL = (event: AlertEvent, member = '') => `SELECT m.id,m.email,m.role,r.capabilities AS custom FROM nc_members m JOIN nc_notification_preferences p ON p.member_id=m.id
    LEFT JOIN nc_roles r ON r.id=m.custom_role_id WHERE m.status='active' AND p.${event}=1${member}`
const authorized = (event: AlertEvent, row: { role: Role; custom: string | null }) => {
  const held = memberCapabilities(row.role, row.custom), need = ALERT_AUTHORITY[event]
  return need.read.some(c => held.has(c)) && need.act.some(c => held.has(c))
}

export async function alertStatements(env: Bindings, event: AlertEvent, subject: string, href: string, kind?: 'processor') {
  insist(href.startsWith('/app/'), 'invalid_notification_link')
  const recipients = (await all<{ id: string; email: string; role: Role; custom: string | null }>(env, ALERT_SQL(event))).filter(m => authorized(event, m) && (kind!=='processor'||['owner','finance'].includes(m.role)))
  return recipients.map(m => stmt(env, `INSERT OR IGNORE INTO nc_notifications(event,subject,href,member_id,email,status,updated_at) VALUES (?,?,?,?,?,'pending',?)`, event,subject,href,m.id,m.email,now()))
}

/** Rechecked just before each send, so removed authority stops the next one. */
export async function eligibleRecipient(env: Bindings, event: AlertEvent, id: string, email: string, subject?: string) {
  const row = await one<{ id: string; email: string; role: Role; custom: string | null }>(env, ALERT_SQL(event, ' AND m.id=? AND m.email=?'), id, email)
  const processor=subject&&event==='webhook_failure'?await one(env,'SELECT 1 FROM nc_processor_events WHERE id=?',subject):null
  return row && authorized(event, row) && (!processor||['owner','finance'].includes(row.role)) ? { id: row.id } : null
}
