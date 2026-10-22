// DEV-001 endpoints: registering, narrowing, disabling and re-enabling an
// endpoint, rotating its signing secret with an overlap window, replaying one
// delivery, and the read doors. A secret is shown once, when made, and is kept
// sealed under MFA_KEY (its own HKDF purpose); the delivery log keeps outcomes
// and status codes, never response bodies. The developer role and the owner
// administer endpoints (GOV-001 credentials); replaying needs records or
// credentials; reading the log and payloads needs full read.
import type { Bindings } from '../auth.server'
import { actorLabel, can, requireCapability, requireMember, type Actor } from './actor'
import { all, commit, guard, insist, newId, now, one, parseJson, stmt, type Row } from './core'
import { clockInstant } from './clock'
import type { Input } from './input'
import { b64url, seal } from './mfa-crypto'
import { EVENT_KINDS, STRIPE_MAP, isEventKind } from './webhook-catalog'
import { BACKOFF_MINUTES, SEALING_PURPOSE } from './webhook-delivery'

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/** HTTPS to a public host name (no credentials, address literals or local names);
 * a local installation may also post plain HTTP to its own loopback receiver. */
export function endpointUrl(env: Bindings, text: string) {
  let url: URL | null = null
  try { url = new URL(text) } catch { url = null }
  insist(url && !url.username && !url.password && !url.hash, 'invalid_webhook_url')
  const host = url.hostname.toLowerCase()
  if (env.AUTH_LOCAL === 'true' && url.protocol === 'http:' && LOOPBACK.has(host)) return url.href
  insist(url.protocol === 'https:' && (url.port === '' || url.port === '443') && host.includes('.') && !host.startsWith('[') && !/^[\d.]+$/.test(host)
    && !/(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/.test(host), 'invalid_webhook_url')
  return url.href
}

function eventFilter(input: Input) {
  const chosen = [...new Set(input.list('events'))]
  if (!chosen.length || chosen.includes('*')) return ['*']
  for (const kind of chosen) insist(isEventKind(kind), 'invalid_webhook_event')
  return chosen.sort()
}

async function newSecret(env: Bindings, endpoint: string, actor: Actor, at: number) {
  insist(env.MFA_KEY, 'signing_key_missing', 409)
  const id = newId(), secret = `nwh_${b64url(crypto.getRandomValues(new Uint8Array(32)))}`
  const sealed = await seal(env.MFA_KEY, new TextEncoder().encode(secret), `webhook:${id}`, SEALING_PURPOSE)
  return { id, secret, statement: stmt(env, 'INSERT INTO nc_webhook_secrets(id,endpoint_id,sealed,created_by,created_at,expires_at) VALUES(?,?,?,?,?,NULL)', id, endpoint, sealed, actorLabel(actor), at) }
}

async function endpointOf(env: Bindings, id: string) {
  const endpoint = await one(env, 'SELECT * FROM nc_webhook_endpoints WHERE id=?', id)
  insist(endpoint, 'webhook_not_found', 404)
  return endpoint
}

export async function createWebhook(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'credentials')
  input.only(['url', 'events', 'description', 'returnTo'])
  const url = endpointUrl(env, input.text('url', { max: 500 })), events = eventFilter(input), description = input.text('description', { max: 200, optional: true })
  const id = newId(), at = clockInstant(env), minted = await newSecret(env, id, actor, at)
  await commit(env, [
    guard(env, 'webhook_endpoint_exists', "NOT EXISTS(SELECT 1 FROM nc_webhook_endpoints WHERE url=? AND status='active')", url),
    stmt(env, "INSERT INTO nc_webhook_endpoints(id,url,description,events_json,status,failure_open,revision,created_by,created_at,updated_at) VALUES(?,?,?,?,'active',0,1,?,?,?)", id, url, description, JSON.stringify(events), actorLabel(actor), now(), now()),
    minted.statement,
  ], { actor: actorLabel(actor), action: 'webhook.create', subject: id, detail: { url, events, description, secret: minted.id } })
  return { id, url, events, secret: minted.secret, secret_id: minted.id }
}

/** Narrow the events, describe, disable or re-enable; a disabled endpoint keeps its pending deliveries until it is enabled again. */
export async function updateWebhook(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'credentials')
  input.only(['endpoint', 'revision', 'status', 'events', 'description', 'returnTo'])
  const endpoint = await endpointOf(env, input.text('endpoint', { max: 100 }))
  const revision = input.integer('revision', { min: 1, max: Number.MAX_SAFE_INTEGER - 1 })
  const status = input.text('status', { max: 10, optional: true }) || endpoint.status
  insist(status === 'active' || status === 'disabled', 'invalid_webhook_status')
  const events = input.has('events') ? eventFilter(input) : parseJson<string[]>(endpoint.events_json, ['*'])
  const description = input.has('description') ? input.text('description', { max: 200 }) : endpoint.description
  await commit(env, [
    guard(env, 'stale', 'EXISTS(SELECT 1 FROM nc_webhook_endpoints WHERE id=? AND revision=?)', endpoint.id, revision),
    ...(status === 'active' && endpoint.status !== 'active' ? [guard(env, 'webhook_endpoint_exists', "NOT EXISTS(SELECT 1 FROM nc_webhook_endpoints WHERE url=? AND status='active')", endpoint.url)] : []),
    stmt(env, 'UPDATE nc_webhook_endpoints SET status=?,events_json=?,description=?,revision=revision+1,updated_at=? WHERE id=?', status, JSON.stringify(events), description, now(), endpoint.id),
  ], { actor: actorLabel(actor), action: 'webhook.update', subject: endpoint.id, detail: { status, events, description } })
  return { id: endpoint.id, status, events, revision: Number(revision) + 1 }
}

/** The new secret signs from now on; the earlier ones also sign until the overlap window ends, so a receiver can switch without dropping a delivery. */
export async function rotateWebhook(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'credentials')
  input.only(['endpoint', 'overlap_hours', 'returnTo'])
  const endpoint = await endpointOf(env, input.text('endpoint', { max: 100 }))
  const hours = input.integer('overlap_hours', { min: 0, max: 168, optional: true }) ?? 24
  const at = clockInstant(env), until = at + hours * 3_600_000, minted = await newSecret(env, endpoint.id, actor, at)
  await commit(env, [
    stmt(env, 'UPDATE nc_webhook_secrets SET expires_at=? WHERE endpoint_id=? AND (expires_at IS NULL OR expires_at>?)', until, endpoint.id, until),
    minted.statement,
  ], { actor: actorLabel(actor), action: 'webhook.rotate', subject: endpoint.id, detail: { overlapHours: hours, secret: minted.id, previousValidUntil: until } })
  return { id: endpoint.id, secret: minted.secret, secret_id: minted.id, previous_secrets_valid_until: new Date(until).toISOString() }
}

/** A replay sends the stored event again, byte for byte, as a new delivery due at once. */
export async function replayWebhook(env: Bindings, actor: Actor, input: Input) {
  insist(can(actor, 'records') || can(actor, 'credentials'), 'forbidden', 403)
  insist(actor.kind === 'member', 'person_required', 403)
  input.only(['delivery', 'returnTo'])
  const delivery = await one(env, 'SELECT * FROM nc_webhook_deliveries WHERE id=?', input.text('delivery', { max: 100 }))
  insist(delivery, 'webhook_delivery_not_found', 404)
  const endpoint = await endpointOf(env, delivery.endpoint_id)
  insist(endpoint.status === 'active', 'webhook_disabled', 409)
  const id = `whd_${newId().replaceAll('-', '').slice(0, 24)}`, original = delivery.replay_of ?? delivery.id
  await commit(env, [stmt(env, "INSERT INTO nc_webhook_deliveries(id,event_id,endpoint_id,replay_of,requested_by,status,attempts,next_attempt_at,created_at) VALUES(?,?,?,?,?,'pending',0,0,?)",
    id, delivery.event_id, delivery.endpoint_id, original, actorLabel(actor), now())],
    { actor: actorLabel(actor), action: 'webhook.replay', subject: id, detail: { event: delivery.event_id, endpoint: delivery.endpoint_id, replayOf: original } })
  return { id, event: delivery.event_id, replay_of: original }
}

export async function webhooksView(env: Bindings, actor: Actor) {
  requireCapability(actor, 'read')
  const at = clockInstant(env)
  const endpoints = await all(env, `SELECT e.id,e.url,e.description,e.events_json,e.status,e.failure_open,e.revision,e.created_by,e.created_at,e.updated_at,
    (SELECT COUNT(*) FROM nc_webhook_deliveries d WHERE d.endpoint_id=e.id AND d.status='pending') AS pending,
    (SELECT COUNT(*) FROM nc_webhook_deliveries d WHERE d.endpoint_id=e.id AND d.status='failed') AS failed,
    (SELECT COUNT(*) FROM nc_webhook_deliveries d WHERE d.endpoint_id=e.id AND d.status='delivered') AS delivered
    FROM nc_webhook_endpoints e ORDER BY e.created_at,e.id`)
  const secrets = await all(env, 'SELECT id,endpoint_id,created_at,expires_at FROM nc_webhook_secrets ORDER BY created_at,id')
  return {
    endpoints: endpoints.map(({ events_json, failure_open, ...row }): Row => ({ ...row, events: parseJson<string[]>(events_json, ['*']), failing: !!failure_open,
      secrets: secrets.filter(secret => secret.endpoint_id === row.id).map(({ endpoint_id: _, ...secret }) => ({ ...secret, signing: secret.expires_at === null || secret.expires_at > at })) })),
    events: EVENT_KINDS, stripe_mapping: STRIPE_MAP, retry_minutes: BACKOFF_MINUTES,
  }
}

const DELIVERY_COLUMNS = `d.id,d.event_id,v.kind AS event_type,d.endpoint_id,d.replay_of,d.requested_by,d.status,d.attempts,d.next_attempt_at,d.last_status,d.last_outcome,d.delivered_at,d.created_at`

/** Newest first, filtered by endpoint, status or event type; the latest 1,000 deliveries page by cursor. */
export async function webhookDeliveries(env: Bindings, actor: Actor, url: URL) {
  requireCapability(actor, 'read')
  const endpoint = url.searchParams.get('endpoint'), status = url.searchParams.get('status'), type = url.searchParams.get('event')
  return await all(env, `SELECT ${DELIVERY_COLUMNS} FROM nc_webhook_deliveries d JOIN nc_webhook_events v ON v.id=d.event_id
    WHERE (?1 IS NULL OR d.endpoint_id=?1) AND (?2 IS NULL OR d.status=?2) AND (?3 IS NULL OR v.kind=?3) ORDER BY d.seq DESC LIMIT 1000`, endpoint, status, type)
}

export async function webhookDelivery(env: Bindings, actor: Actor, id: string): Promise<Row> {
  requireCapability(actor, 'read')
  const delivery = await one(env, `SELECT ${DELIVERY_COLUMNS},e.url AS endpoint_url,e.status AS endpoint_status,v.payload_json FROM nc_webhook_deliveries d
    JOIN nc_webhook_events v ON v.id=d.event_id JOIN nc_webhook_endpoints e ON e.id=d.endpoint_id WHERE d.id=?`, id)
  insist(delivery, 'webhook_delivery_not_found', 404)
  const { payload_json, ...rest } = delivery
  return { ...rest, payload: parseJson(payload_json, {}),
    attempts: await all(env, 'SELECT attempt,at,outcome,http_status,duration_ms FROM nc_webhook_attempts WHERE delivery_id=? ORDER BY attempt', id),
    replays: await all(env, 'SELECT id,status,attempts,created_at FROM nc_webhook_deliveries WHERE replay_of=? ORDER BY seq', delivery.replay_of ?? id) }
}

export async function webhookEvent(env: Bindings, actor: Actor, id: string) {
  requireCapability(actor, 'read')
  const event = await one(env, 'SELECT id,kind,created_at,payload_json FROM nc_webhook_events WHERE id=?', id)
  insist(event, 'webhook_event_not_found', 404)
  return { id: event.id, type: event.kind, created_at: event.created_at, payload: parseJson(event.payload_json, {}) }
}
