import { NectarClient, METADATA_KINDS, type MetadataKind, type NectarVersion } from '../../../sdks/typescript/src/index.js'
import type { MeterThenGateInput } from './meter-then-gate.js'

export type Environment = Readonly<Record<string, string | undefined>>
function required(env: Environment, key: string): string {
  const value = env[key]
  if (value === undefined || value === '') throw new Error(`Set ${key}`)
  return value
}

export function clientsFromEnvironment(env: Environment) {
  const baseUrl = required(env, 'NECTAR_BASE_URL')
  const version = env.NECTAR_VERSION
  if (version !== undefined && version !== '2026-10-01' && version !== '2026-10-20') {
    throw new Error('NECTAR_VERSION must be a supported dated API version')
  }
  const cookie = env.NECTAR_SESSION_COOKIE
  const token = env.NECTAR_BEARER_TOKEN
  if (cookie && token) throw new Error('Choose NECTAR_SESSION_COOKIE or NECTAR_BEARER_TOKEN')
  if (!cookie && !token) throw new Error('Set NECTAR_SESSION_COOKIE or NECTAR_BEARER_TOKEN')
  const headers: Record<string, string> = cookie
    ? { Cookie: cookie, Origin: required(env, 'NECTAR_ORIGIN') }
    : { Authorization: `Bearer ${token}` }
  const options = { baseUrl, version: version as NectarVersion | undefined, headers }
  const client = new NectarClient(options)
  const readClient = env.NECTAR_READ_BEARER_TOKEN
    ? new NectarClient({ ...options, headers: { Authorization: `Bearer ${env.NECTAR_READ_BEARER_TOKEN}` } })
    : client
  return { client, readClient }
}

export function eventFromEnvironment(env: Environment): MeterThenGateInput {
  return {
    event: {
      event_id: required(env, 'NECTAR_EVENT_ID'),
      customer: required(env, 'NECTAR_CUSTOMER'),
      meter: required(env, 'NECTAR_METER'),
      quantity: required(env, 'NECTAR_QUANTITY'),
      occurred_at: required(env, 'NECTAR_OCCURRED_AT'),
    },
    feature: required(env, 'NECTAR_FEATURE'),
    date: env.NECTAR_DATE,
    idempotencyKey: required(env, 'NECTAR_IDEMPOTENCY_KEY'),
  }
}

export function metadataFromEnvironment(env: Environment) {
  if (env.NECTAR_METADATA_KIND === undefined) return undefined
  const kind = env.NECTAR_METADATA_KIND as MetadataKind
  if (!METADATA_KINDS.includes(kind)) throw new Error('NECTAR_METADATA_KIND must be a supported record kind')
  // Presence checks preserve the valid empty key and empty value.
  if (env.NECTAR_METADATA_KEY === undefined || env.NECTAR_METADATA_VALUE === undefined) {
    throw new Error('Set NECTAR_METADATA_KEY and NECTAR_METADATA_VALUE; empty strings are allowed')
  }
  return {
    target: { kind, record: required(env, 'NECTAR_METADATA_RECORD') },
    filter: { key: env.NECTAR_METADATA_KEY, value: env.NECTAR_METADATA_VALUE },
  }
}
