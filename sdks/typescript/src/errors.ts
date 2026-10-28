/** An HTTP refusal retains the actual response, including non-JSON bodies. */
export class NectarApiError extends Error {
  readonly status: number
  readonly body: unknown
  readonly version: string | null
  readonly headers: Headers
  readonly code: string | undefined

  constructor(response: Response, body: unknown) {
    const code = body !== null && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ? body.error : undefined
    super(code ? `Nectar HTTP ${response.status}: ${code}` : `Nectar HTTP ${response.status}`)
    this.name = 'NectarApiError'
    this.status = response.status
    this.body = body
    this.version = response.headers.get('Nectar-Version')
    this.headers = new Headers(response.headers)
    this.code = code
  }
}
