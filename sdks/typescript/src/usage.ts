import type { NectarTransport, WriteOptions } from './transport.js'

export type EventProperty = string | number | boolean | null
export interface UsageEvent {
  /** Caller-owned stable identifier; reuse unchanged when resubmitting the same event. */
  event_id: string
  /** Customer external ID. */
  customer: string
  /** Source-stream meter code. */
  meter: string
  /** Exact decimal text, never a floating point number. */
  quantity: string
  /** ISO 8601 instant with an explicit offset. */
  occurred_at: string
  properties?: Record<string, EventProperty>
}
export interface UsageSubmission { events: readonly UsageEvent[] }
export interface UsageReportRow {
  row: number
  eventId: string
  status: 'duplicate' | 'rejected'
  reason?: string
}
export interface UsageSubmissionResult {
  batch: string
  accepted: number
  duplicates: number
  rejected: number
  report: UsageReportRow[]
}

export class UsageResource {
  constructor(private readonly transport: NectarTransport) {}

  submit(input: UsageSubmission, options: WriteOptions): Promise<UsageSubmissionResult> {
    if (!Array.isArray(input.events) || input.events.some(event => typeof event.quantity !== 'string')) {
      throw new TypeError('Usage events require exact string quantities')
    }
    return this.transport.request({ ...options, method: 'POST', path: 'usage.submit', body: input })
  }
}
