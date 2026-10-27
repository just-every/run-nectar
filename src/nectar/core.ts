import { captureSubscriptionStates } from './subscription-state-capture'
// Shared primitives: typed errors, ids, D1 helpers, audited atomic commits and
// in-batch preconditions (nc_guard rows abort the whole batch when false).
import type { Bindings } from '../auth.server'

export class NectarError extends Error {
  constructor(readonly code: string, readonly status = 400, readonly detail?: unknown) {
    super(code)
  }
}

export function insist(condition: unknown, code: string, status = 400, detail?: unknown): asserts condition {
  if (!condition) throw new NectarError(code, status, detail)
}

export const newId = () => crypto.randomUUID()
export const now = () => Date.now()

export type Row = Record<string, any>

export async function one<T = Row>(env: Bindings, sql: string, ...params: unknown[]): Promise<T | null> {
  return await env.DB.prepare(sql).bind(...params).first<T>()
}

export async function all<T = Row>(env: Bindings, sql: string, ...params: unknown[]): Promise<T[]> {
  return (await env.DB.prepare(sql).bind(...params).all<T>()).results
}

export const stmt = (env: Bindings, sql: string, ...params: unknown[]) => env.DB.prepare(sql).bind(...params)

/** A precondition evaluated inside the batch: `condition` is a scalar SQL boolean. */
export const guard = (env: Bindings, code: string, condition: string, ...params: unknown[]) =>
  stmt(env, `INSERT INTO nc_guard (code, ok) SELECT ?, CASE WHEN (${condition}) THEN 1 ELSE 0 END`, code, ...params)

export interface Audit { actor: string; action: string; subject: string; detail?: unknown }

/** Runs the statements atomically with audit events in the same batch. A failed guard raises its code. */
export async function commit(env: Bindings, statements: D1PreparedStatement[], audit: Audit | Audit[]) {
  const events = Array.isArray(audit) ? audit : [audit]
  try {
    await env.DB.batch([
      ...statements,
      ...await captureSubscriptionStates(env, events),
      stmt(env, 'DELETE FROM nc_guard'),
      ...events.map(event => stmt(env, 'INSERT INTO nc_audit (at, actor, action, subject, detail) VALUES (?, ?, ?, ?, ?)', now(), event.actor, event.action, event.subject, JSON.stringify(event.detail ?? {}))),
    ])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const code = message.match(/nectar_guard_(\w+)/)?.[1]
    if (code) throw new NectarError(code === 'failed' ? 'precondition_failed' : code, 409)
    if (/nectar_immutable/.test(message)) throw new NectarError('record_is_immutable', 409)
    if (/UNIQUE constraint failed/.test(message)) throw new NectarError('already_exists', 409, message.replace(/^.*UNIQUE constraint failed: /, ''))
    throw error
  }
}

export async function sha256Hex(bytes: Uint8Array | string): Promise<string> {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Canonical JSON: object keys sorted, so equal values hash equally. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value as object).sort().filter(key => (value as Row)[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical((value as Row)[key])}`).join(',')}}`
}

export const fingerprint = (value: unknown) => sha256Hex(canonical(value))

export const parseJson = <T = unknown>(text: string | null | undefined, fallback: T): T => {
  if (!text) return fallback
  try { return JSON.parse(text) as T } catch { return fallback }
}
