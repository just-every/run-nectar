// Contract quantities are exact: money is cents; units are millionths.
export const PREPAID_VERSION = 'nectar-prepaid-1'
export interface PrepaidTerms {
  kind: 'money' | 'units'; source: 'purchase' | 'promotion'; amountN: number; valueCents: number
  meterId: string | null; effectiveDate: string; expiresDate: string | null; priority: number
  rolloverMonths: number; rolloverPercent: number; rolloverCapN: number | null; expiryConsent: boolean
}
export interface PrepaidGrant extends PrepaidTerms {
  id: string; subscription: string; customer: string; purchaseInvoice: string | null; purchaseLine: string | null
}
export interface PrepaidEntry {
  id: string; grantId: string; kind: 'grant' | 'drawdown' | 'expiry' | 'rollover' | 'correction' | 'refund'
  correctionKind?: 'drawdown' | 'expiry' | 'rollover'
  amountN: number; liabilityCents: number; recognitionCents: number; serviceDate: string
  invoiceId: string | null; lineIndex: number | null; purchaseInvoice: string | null; purchaseLine: string | null
}
export interface PrepaidBasis {
  version: typeof PREPAID_VERSION; subscription: string; customer: string; revision: number
  grants: PrepaidGrant[]; entries: PrepaidEntry[]
}
export interface PrepaidAllocation {
  grantId: string; amountN: number; valueCents: number; date: string; lineIndex: number
  source: 'purchase' | 'promotion'; beforeN: number; afterN: number
}
