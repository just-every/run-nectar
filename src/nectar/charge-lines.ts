// Pure line construction shared by both invoice types.
import { addDays } from './dates'
import type { Row } from './core'
import type { Line } from './rating'

export const CHARGE_RATING_VERSION = 'nectar-rating-3'
export interface ChargeIn { id: string; description: string; quantity: string; unitAmount: string; amountCents: number; taxable: boolean; priceId: string | null; date: string; evidence: Row }

export const chargeLines = (charges: ChargeIn[]): Line[] => charges.map(c => ({ kind: 'one_time', description: c.description, quantity: c.quantity, unitAmount: c.unitAmount, amountCents: c.amountCents, taxable: c.taxable, priceId: c.priceId, meterId: null, periodStart: c.date, periodEnd: addDays(c.date, 1), evidence: { ...c.evidence, charge: c.id, rule: 'immutable one-time charge, consumed once on invoice issue' } }))

