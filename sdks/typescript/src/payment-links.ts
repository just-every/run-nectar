import type { CallOptions, NectarTransport, WriteOptions } from './transport.js'

interface PaymentLinkCreateBase {
  name: string
  max_uses?: number
  confirm: true
}
export interface SubscriptionPaymentLinkCreate extends PaymentLinkCreateBase {
  kind?: 'subscription'
  price: readonly string[]
  quantity?: readonly string[]
  trial_days?: number
  promotion_code?: string
  months: number
  auto_renew: boolean
  notice_days: number
  uplift_percent: string
  /** Explicit second confirmation when native sole-owner approval requires it. */
  confirm_single?: true
}
export interface OneTimePaymentLinkCreate extends PaymentLinkCreateBase {
  kind: 'one_time'
  description: string
  /** Exact decimal amount text. */
  amount: string
  taxable: boolean
}
export type PaymentLinkCreate = SubscriptionPaymentLinkCreate | OneTimePaymentLinkCreate
export interface PaymentLinkCreated { id: string; path: string; revision: string }
export interface PaymentLinkItem {
  price: string
  product: string
  description: string
  quantity: number
  unitAmount: string
  taxable: boolean
  timing: 'advance' | 'arrears'
  amountCents: number
}
export interface PaymentLinkTerms {
  v: 1
  kind: 'subscription' | 'one_time'
  merchant: string
  timezone: string
  currency: 'USD'
  items: PaymentLinkItem[]
  oneTime: { description: string; amountCents: number; taxable: boolean } | null
  trialDays: number
  renewal: { months: number; auto_renew: 0 | 1; notice_days: number; uplift_percent: string } | null
  promotionCode: string | null
  promotion: Record<string, unknown> | null
  tax: { mode: string; rate: string; jurisdiction: string; reviewedAt: number }
  subtotalCents: number
  taxCents: number
  totalCents: number
  debitAuthority: false
}
export interface PaymentLink extends PaymentLinkCreated {
  name: string
  status: 'active' | 'inactive'
  approvalStatus: 'pending' | 'approved' | 'rejected'
  preparedBy: string
  approvedBy: string | null
  approvalMode: 'single-approver' | 'two-person' | 'owner-policy' | null
  basis: string
  activated: boolean
  maxUses: number | null
  uses: number
  reserved: number
  terms: PaymentLinkTerms
}

export class PaymentLinksResource {
  constructor(private readonly transport: NectarTransport) {}

  /** Native management read; this does not open or accept customer checkout. */
  list(options: CallOptions = {}): Promise<PaymentLink[]> {
    return this.transport.request({ ...options, method: 'GET', path: 'payment-links' })
  }

  /** Existing owner action; native approval and fresh-factor checks still apply. */
  create(input: PaymentLinkCreate, options: WriteOptions): Promise<PaymentLinkCreated> {
    return this.transport.request({ ...options, method: 'POST', path: 'payment_link.create', body: input })
  }
}
