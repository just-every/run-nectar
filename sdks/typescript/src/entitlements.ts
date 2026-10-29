import type { CallOptions, NectarTransport } from './transport.js'

export interface EntitlementCheck { customer: string; feature: string; date?: string }
export interface EntitlementQuota {
  meter: string
  used: string
  limit: string
  remaining: string
  policy: 'soft' | 'hard' | 'overage'
  exhausted: boolean
  period: { start: string; end: string }
  eventIds: string[]
}
export interface EntitlementPayment {
  restricted: boolean
  graceDays: number | null
  invoices: { id: string; number: string; dueDate: string; balanceCents: number }[]
}
export interface ProductDecision {
  product: string
  allowed: boolean
  warning: boolean
  quota: EntitlementQuota | null
  numericLimit: string | null
  payment: EntitlementPayment
  steps: string[]
}
export interface EntitlementState {
  lifecycle: 'scheduled' | 'ended' | 'canceled' | 'paused' | 'trialing' | 'active'
  suspended: boolean
  payment?: {
    status: 'unpaid' | 'past_due' | 'uncertain' | 'current'
    invoices?: { id: string; dueDate: string; balanceCents: number }[]
    failures?: { id: string; invoice: string; status: string }[]
  }
}
export interface EntitlementPath {
  subscription: string | null
  granted: boolean
  steps: string[]
  state?: EntitlementState
  decisions?: ProductDecision[]
  numericLimit?: string | null
  quota?: EntitlementQuota | null
  payment?: EntitlementPayment
  warning?: boolean
}
export interface EntitlementDecision {
  customer: { id: string; name: string; externalId: string }
  feature: string
  date: string
  allowed: boolean
  paths: EntitlementPath[]
}

export class EntitlementsResource {
  constructor(private readonly transport: NectarTransport) {}

  check(input: EntitlementCheck, options: CallOptions = {}): Promise<EntitlementDecision> {
    if (!input.feature) throw new TypeError('A feature is required for a single entitlement decision')
    if (input.date !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)
      || !Number.isFinite(Date.parse(input.date)) || new Date(input.date).toISOString().slice(0, 10) !== input.date)) {
      throw new TypeError('date must be a valid YYYY-MM-DD date')
    }
    return this.transport.request({ ...options, method: 'GET', path: `entitlements/${encodeURIComponent(input.customer)}`,
      query: { feature: input.feature, date: input.date } })
  }
}
