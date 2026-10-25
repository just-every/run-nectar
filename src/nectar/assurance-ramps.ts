// Signed seat and ramp terms compared with the invoices actually issued.
// A detector only reads: it never rates, prepares, issues or adjusts anything.
import type { Bindings } from '../auth.server'
import { all, fingerprint, one, parseJson, type Row } from './core'
import { SCALE, lineCents, micros, roundHalfAway } from './decimal'
import { daysBetween } from './dates'
import { rateQuantityPrice, storedQuantityPrice } from './price-model'

export const RAMP_KIND = 'seat_ramp'
const FAR = '9999-12-31'
interface Ramp { item: string; effective_date: string; price: string; quantity: number }

const later = (a: string, b: string) => a > b ? a : b
const earlier = (a: string, b: string) => a < b ? a : b

/** Money already moved by approved fixes linked to this case: catch-up charges on issued invoices and credit notes. */
async function linkedFixes(env: Bindings, caseId: string | null, source: string) {
  if (!caseId) return { chargedCents: 0, creditedCents: 0 }
  const charged = await one(env, `SELECT COALESCE(SUM(l.amount_cents),0) AS cents FROM nc_invoice_lines l JOIN nc_invoices i ON i.id=l.invoice_id
    WHERE i.status='issued' AND l.kind='one_time' AND json_extract(l.evidence_json,'$.assuranceCase')=?`, source)
  const credited = await one(env, `SELECT COALESCE(SUM(COALESCE(c.subtotal_cents,c.amount_cents)),0) AS cents FROM nc_credit_notes c JOIN nc_proposals p ON p.id=c.proposal_id
    WHERE json_extract(p.evidence_json,'$.assurance.case')=?`, caseId)
  return { chargedCents: charged!.cents as number, creditedCents: credited!.cents as number }
}

/** One evidence record per signed ramp step that has issued service in its window. */
export async function rampEvidence(env: Bindings) {
  const contracts = await all(env, `SELECT c.id,c.status,c.terms_json,s.id AS subscription,s.customer_id FROM nc_contracts c
    JOIN nc_subscriptions s ON s.id=c.subscription_id JOIN nc_customers u ON u.id=s.customer_id
    WHERE c.status IN ('proposed','approved') AND u.erased_at IS NULL ORDER BY c.created_at,c.id`)
  const found: Row[] = []
  for (const contract of contracts) {
    const ramps = parseJson<{ ramps?: Ramp[] }>(contract.terms_json, {}).ramps ?? []
    for (const ramp of ramps) {
      const item = await one(env, 'SELECT price_id FROM nc_items WHERE id=? AND subscription_id=?', ramp.item, contract.subscription)
      const price = await one(env, 'SELECT unit_amount,pricing_model,tiers_json,package_size FROM nc_prices WHERE id=?', ramp.price)
      if (!item || !price) continue
      const model = storedQuantityPrice(price as { pricing_model: string; tiers_json: string; package_size: string | null })
      const next = ramps.filter(r => r.item === ramp.item && r.effective_date > ramp.effective_date).map(r => r.effective_date).sort()[0] ?? FAR
      const lines = await all(env, `SELECT l.id,l.invoice_id,i.number,l.price_id,l.quantity,l.unit_amount,l.amount_cents,l.period_start,l.period_end,l.evidence_json
        FROM nc_invoice_lines l JOIN nc_invoices i ON i.id=l.invoice_id
        WHERE i.subscription_id=? AND i.status='issued' AND i.invoice_kind='recurring' AND l.kind IN ('seat','flat') AND l.price_id IN (?,?)
        AND l.period_end>? AND l.period_start<? ORDER BY l.period_start,i.number,l.seq`, contract.subscription, item.price_id, ramp.price, ramp.effective_date, next)
      const signedUnit = model ? 0n : micros(price.unit_amount), signedQuantity = BigInt(ramp.quantity) * SCALE
      const billed: Row[] = []
      let billedCents = 0, expectedCents = 0
      for (const line of lines) {
        const saved = parseJson<Row>(line.evidence_json, {})
        // An approved contract price is a human-approved exception, not drift from the signed step.
        if (saved.override) continue
        const lineDays = daysBetween(line.period_start, line.period_end)
        const overlapDays = daysBetween(later(line.period_start, ramp.effective_date), earlier(line.period_end, next))
        const periodDays = Number(saved.periodDays ?? lineDays)
        const billedPart = overlapDays === lineDays ? line.amount_cents : Number(roundHalfAway(BigInt(line.amount_cents) * BigInt(overlapDays), BigInt(lineDays)))
        const expectedPart = model ? rateQuantityPrice(model, signedQuantity, BigInt(overlapDays), BigInt(periodDays)).amountCents : Number(lineCents(signedUnit, signedQuantity, BigInt(overlapDays), BigInt(periodDays)))
        billedCents += billedPart; expectedCents += expectedPart
        billed.push({ invoice: line.invoice_id, number: line.number, line: line.id, price: line.price_id, unit: line.unit_amount, quantity: line.quantity,
          from: line.period_start, to: line.period_end, overlapDays, billedCents: billedPart, expectedCents: expectedPart })
      }
      if (!billed.length) continue
      const source = `ramp:${contract.id}:${ramp.item}:${ramp.effective_date}`
      const caseRow = await one(env, 'SELECT id FROM nc_assurance_cases WHERE source_id=?', source)
      const { chargedCents, creditedCents } = await linkedFixes(env, caseRow?.id ?? null, source)
      const netBilledCents = billedCents + chargedCents - creditedCents
      const differenceCents = expectedCents - netBilledCents
      const proof = { kind: RAMP_KIND, source, customer: contract.customer_id, subscription: contract.subscription, contract: contract.id, contractStatus: contract.status,
        item: ramp.item, effectiveDate: ramp.effective_date, windowEnd: next === FAR ? null : next,
        signed: { price: ramp.price, unit: price.unit_amount, quantity: ramp.quantity }, billed,
        billedCents, chargedCents, creditedCents, netBilledCents, expectedCents, differenceCents,
        direction: differenceCents > 0 ? 'under_billed' : differenceCents < 0 ? 'over_billed' : 'agrees', mismatch: differenceCents !== 0 }
      found.push({ ...proof, basis: await fingerprint(proof) })
    }
  }
  return found
}
