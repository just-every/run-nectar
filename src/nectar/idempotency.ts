// DEV-002: an Idempotency-Key on a JSON write. The key belongs to the calling
// member or credential and is reserved with a digest of the action, version and
// body before the handler runs. A repeat within 24 hours returns the stored
// successful result without running the handler again; a different request under
// the same key, or a repeat while the first is still running, is refused. A
// failed handler releases the key, so only successful results are kept.
import type { Bindings } from '../auth.server'
import type { Actor } from './actor'
import { insist, now, one, sha256Hex, stmt } from './core'

export const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000

export interface Stored { body: unknown; replayed: boolean }

export async function idempotent(env: Bindings, actor: Actor, request: Request, key: string, scope: string, run: () => Promise<unknown>): Promise<Stored> {
  insist(/^[\x21-\x7e]{1,255}$/.test(key), 'invalid_idempotency_key')
  const ref = `${actor.kind}:${actor.id}`
  const body = new Uint8Array(await request.clone().arrayBuffer())
  const hash = await sha256Hex(new Uint8Array([...new TextEncoder().encode(`${scope}\n${request.headers.get('content-type') ?? ''}\n`), ...body]))
  await stmt(env, 'DELETE FROM nc_idempotency WHERE created_at < ?', now() - IDEMPOTENCY_WINDOW_MS).run()
  const reserved = await stmt(env, "INSERT INTO nc_idempotency (actor_ref, idempotency_key, request_hash, state, created_at) VALUES (?, ?, ?, 'pending', ?) ON CONFLICT DO NOTHING", ref, key, hash, now()).run()
  if (!reserved.meta.changes) {
    const prior = await one<{ request_hash: string; state: string; response_json: string }>(env, 'SELECT request_hash, state, response_json FROM nc_idempotency WHERE actor_ref = ? AND idempotency_key = ?', ref, key)
    insist(prior, 'idempotency_in_progress', 409)
    insist(prior.request_hash === hash, 'idempotency_key_reused', 409)
    insist(prior.state === 'done', 'idempotency_in_progress', 409)
    return { body: JSON.parse(prior.response_json), replayed: true }
  }
  let result: unknown
  try {
    result = await run()
  } catch (error) {
    await stmt(env, "DELETE FROM nc_idempotency WHERE actor_ref = ? AND idempotency_key = ? AND state = 'pending'", ref, key).run()
    throw error
  }
  const stored = result === undefined ? null : result
  await stmt(env, "UPDATE nc_idempotency SET state = 'done', response_status = 200, response_json = ? WHERE actor_ref = ? AND idempotency_key = ?", JSON.stringify(stored), ref, key).run()
  return { body: stored, replayed: false }
}
