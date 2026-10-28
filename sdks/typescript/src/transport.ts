import { NectarApiError } from './errors.js'

export type NectarVersion = '2026-10-01' | '2026-10-20'
export const LATEST_VERSION: NectarVersion = '2026-10-20'
export type Query = URLSearchParams | Readonly<Record<string, string | number | boolean | null | undefined>>
export interface NectarClientOptions {
  /** Installation origin, or its complete API root ending in /api/nectar. */
  baseUrl: string
  /** Omit to retain the credential's pinned version, or the member default. */
  version?: NectarVersion
  headers?: HeadersInit
  fetch?: typeof globalThis.fetch
}
export interface CallOptions {
  headers?: HeadersInit
  signal?: AbortSignal
  version?: NectarVersion
}
export interface WriteOptions extends CallOptions { idempotencyKey: string }
export interface RequestOptions extends CallOptions {
  method: 'GET' | 'POST'
  /** Relative API path, for example customer.create or customers. */
  path: string
  query?: Query
  body?: unknown
  /** Every JSON write needs an explicit caller-owned key. */
  idempotencyKey?: string
}
export interface NectarResponse<T> {
  data: T
  status: number
  version: string | null
  headers: Headers
  idempotentReplayed: boolean
}

function apiRoot(value: string) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TypeError('baseUrl must be an HTTP installation origin or API root without credentials or query')
  }
  if (url.pathname === '/') url.pathname = '/api/nectar/'
  else if (/\/api\/nectar\/?$/.test(url.pathname)) url.pathname = url.pathname.replace(/\/$/, '') + '/'
  else throw new TypeError('baseUrl must be an installation origin or API root ending in /api/nectar')
  return url
}

export class NectarTransport {
  private readonly root: URL
  private readonly headers: Headers
  private readonly version: NectarVersion | undefined
  private readonly fetcher: typeof globalThis.fetch

  constructor(options: NectarClientOptions) {
    this.root = apiRoot(options.baseUrl)
    this.headers = new Headers(options.headers)
    this.version = options.version
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  async requestResult<T>(options: RequestOptions): Promise<NectarResponse<T>> {
    if (!options.path || /^[\/\\]/.test(options.path) || /[?#\\]/.test(options.path)) {
      throw new TypeError('path must be relative to the Nectar API; supply query separately')
    }
    const url = new URL(options.path, this.root)
    if (url.origin !== this.root.origin || !url.pathname.startsWith(this.root.pathname)) {
      throw new TypeError('path must stay within the Nectar API')
    }
    if (options.query instanceof URLSearchParams) url.search = options.query.toString()
    else for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== null && value !== undefined) url.searchParams.set(key, String(value))
    }
    const headers = new Headers(this.headers)
    new Headers(options.headers).forEach((value, name) => headers.set(name, value))
    headers.set('Accept', 'application/json')
    const version = options.version ?? this.version
    if (version !== undefined) headers.set('Nectar-Version', version)
    if (options.method === 'GET' && options.body !== undefined) throw new TypeError('GET cannot carry a body')
    if (options.method === 'POST') {
      if (typeof options.idempotencyKey !== 'string' || !/^[\x20-\x7e]{1,255}$/.test(options.idempotencyKey)) {
        throw new TypeError('POST requires an explicit printable Idempotency-Key of 1 to 255 characters')
      }
      headers.set('Content-Type', 'application/json')
      headers.set('Idempotency-Key', options.idempotencyKey)
    }
    const response = await this.fetcher(url, {
      method: options.method,
      headers,
      ...(options.method === 'POST' ? { body: JSON.stringify(options.body ?? {}) } : {}),
      signal: options.signal,
      redirect: 'error',
    })
    const text = await response.text()
    if (!response.ok) {
      let body: unknown = text
      try { body = JSON.parse(text) } catch { /* Preserve an upstream non-JSON refusal verbatim. */ }
      throw new NectarApiError(response, body)
    }
    const data: T = JSON.parse(text)
    return { data, status: response.status, version: response.headers.get('Nectar-Version'),
      headers: new Headers(response.headers), idempotentReplayed: response.headers.get('Idempotent-Replayed') === 'true' }
  }

  async request<T>(options: RequestOptions): Promise<T> {
    return (await this.requestResult<T>(options)).data
  }
}
