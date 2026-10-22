// DEV-001 delivery: each stored event goes to each subscribed endpoint as a POST
// of its exact stored bytes, signed `Nectar-Signature: t=<unix seconds>,v1=<hex
// HMAC-SHA256 of "t.body">` with one v1 per secret still signing (the rotation
// overlap). A non-2xx answer, a redirect, a timeout or a network failure retries
// on BACKOFF_MINUTES, which spans more than three days, and then the delivery
// stays failed until a person replays it. The first failed attempt after a
// healthy spell queues one INT-003 alert, linked to that delivery, for the
// endpoint's outage; a delivered attempt closes the outage.
import type { Bindings } from '../auth.server'
import { all, commit, one, stmt, type Row } from './core'
import { unseal } from './mfa-crypto'
import { deliverAlerts } from './notification-mail'
import { alertStatements } from './notifications'

export const SEALING_PURPOSE = 'webhook-signing-v1'
/** Minutes before each retry: twelve retries, the last 4,536 minutes (3.15 days) after the first attempt. */
export const BACKOFF_MINUTES = [1, 5, 30, 60, 120, 240, 480, 720, 720, 720, 720, 720]
const TIMEOUT_MS = 10_000, LEASE_MS = 120_000, PARALLEL = 5

const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
async function hmac(secret: string, text: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)))
}

export async function signatureHeader(secrets: string[], seconds: number, body: string) {
  return [`t=${seconds}`, ...await Promise.all(secrets.map(async secret => `v1=${await hmac(secret, `${seconds}.${body}`)}`))].join(',')
}

async function signingSecrets(env: Bindings, endpoint: string, at: number) {
  const rows = await all(env, 'SELECT id,sealed FROM nc_webhook_secrets WHERE endpoint_id=? AND (expires_at IS NULL OR expires_at>?) ORDER BY created_at DESC,id', endpoint, at)
  const secrets: string[] = []
  for (const row of rows) {
    const bytes = await unseal(env.MFA_KEY, row.sealed, `webhook:${row.id}`, SEALING_PURPOSE)
    if (bytes) secrets.push(new TextDecoder().decode(bytes))
  }
  return secrets
}

async function send(url: string, event: Row, delivery: Row, secrets: string[]) {
  if (!secrets.length) return { outcome: 'no_signing_secret', status: null }
  try {
    // The signature time is the real send time: receivers check it against their own clock.
    const response = await fetch(url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), body: event.payload_json, headers: {
      'content-type': 'application/json', 'user-agent': 'Nectar-Webhooks/1', 'nectar-event-id': event.id, 'nectar-event-type': event.kind, 'nectar-delivery-id': delivery.id,
      'nectar-signature': await signatureHeader(secrets, Math.floor(Date.now() / 1000), event.payload_json) } })
    await response.body?.cancel()
    return { outcome: response.status >= 200 && response.status < 300 ? 'delivered' : 'http_error', status: response.status }
  } catch { return { outcome: 'network_error', status: null } }
}

async function attempt(env: Bindings, delivery: Row, at: number) {
  const claimed = await env.DB.prepare("UPDATE nc_webhook_deliveries SET next_attempt_at=? WHERE id=? AND status='pending' AND attempts=? AND next_attempt_at<=? RETURNING id")
    .bind(at + LEASE_MS, delivery.id, delivery.attempts, at).first()
  if (!claimed) return
  const event = (await one(env, 'SELECT id,kind,payload_json FROM nc_webhook_events WHERE id=?', delivery.event_id))!
  const endpoint = (await one(env, 'SELECT id,url FROM nc_webhook_endpoints WHERE id=?', delivery.endpoint_id))!
  const started = Date.now(), { outcome, status } = await send(endpoint.url, event, delivery, await signingSecrets(env, endpoint.id, at))
  const number = delivery.attempts + 1, delivered = outcome === 'delivered', retry = BACKOFF_MINUTES[number - 1]
  const state = delivered ? 'delivered' : retry === undefined ? 'failed' : 'pending'
  // The outage alert is queued only by the attempt that opens it, inside the same batch.
  const alerts = delivered ? [] : await alertStatements(env, 'webhook_failures', delivery.id, `/app/webhooks/deliveries/${delivery.id}`,
    { sql: 'EXISTS(SELECT 1 FROM nc_webhook_endpoints WHERE id=? AND failure_open=0)', params: [endpoint.id] })
  await commit(env, [
    stmt(env, 'INSERT INTO nc_webhook_attempts(delivery_id,attempt,at,outcome,http_status,duration_ms) VALUES(?,?,?,?,?,?)', delivery.id, number, at, outcome, status, Date.now() - started),
    stmt(env, 'UPDATE nc_webhook_deliveries SET status=?,attempts=?,next_attempt_at=?,last_status=?,last_outcome=?,delivered_at=? WHERE id=?',
      state, number, retry === undefined ? at : at + retry * 60_000, status, outcome, delivered ? at : null, delivery.id),
    ...alerts,
    stmt(env, 'UPDATE nc_webhook_endpoints SET failure_open=? WHERE id=?', delivered ? 0 : 1, endpoint.id),
  ], delivered ? [] : { actor: 'system:webhooks', action: 'webhook.delivery_failed', subject: delivery.id, detail: { endpoint: endpoint.id, event: event.id, attempt: number, outcome, status, final: state === 'failed' } })
  if (alerts.length) await deliverAlerts(env, 'webhook_failures', delivery.id, 'system:webhooks')
}

/** Sends every due delivery of an active endpoint. Safe from any door or tick: each attempt is claimed first. */
export async function deliverDueWebhooks(env: Bindings, at: number, limit = 50) {
  const due = await all(env, `SELECT d.id,d.event_id,d.endpoint_id,d.attempts FROM nc_webhook_deliveries d JOIN nc_webhook_endpoints e ON e.id=d.endpoint_id
    WHERE d.status='pending' AND d.next_attempt_at<=? AND e.status='active' ORDER BY d.next_attempt_at,d.seq LIMIT ?`, at, limit)
  for (let start = 0; start < due.length; start += PARALLEL) await Promise.all(due.slice(start, start + PARALLEL).map(delivery => attempt(env, delivery, at)))
  return due.length
}
