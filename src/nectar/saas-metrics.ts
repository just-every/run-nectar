// Customer movements use the same retained month-end subscription contributions
// as normalized MRR. Invoice cash and credit adjustments never become growth.
import { insist } from './core'
import { roundHalfAway } from './decimal'
import type { ReportEntry } from './reports'

export const SAAS_DEFINITION = 'All monetary analytics use normalized MRR, including on the ARR page. A paying customer has positive month-end MRR summed across its selected subscriptions. Movements compare that customer with the preceding calendar month: first positive MRR is new, positive after an earlier positive month and a zero month is reactivation, a positive-to-zero change is churn, and changes between positive balances are expansion or contraction. New plus expansion plus reactivation less contraction and churn reconciles opening to closing MRR. Logo churn divides lost paying customers by opening paying customers. Revenue churn divides contraction plus churn MRR by opening MRR; net retention includes expansion of opening customers, while gross retention excludes it. New and reactivated customers never enter the opening-customer retention numerator. ARPA divides closing MRR by paying customers, rounded once to cents. Undefined rates and ARPA have no value, rather than zero. Customer cohorts start in their first positive selected month; each later cell shows current paying members and their MRR against the original count and MRR, including reactivation. Trial cohorts start in the first captured trial month per subscription and convert on the first positive month; month-end snapshots cannot observe a trial entirely between snapshots. All trial rates are cumulative through the selected month. Plan filters select subscriptions containing that exact native or original source price at each month end and include the whole selected subscription. Segment filters match the customer’s current exact segment metadata; entity filters match its current billing entity. These current memberships apply to the whole history and do not imply historical segment or entity assignments. Filtered movements and cohorts are computed within that selected population. Erased customers and their contract operands are excluded; no anonymous historical retention is claimed.'

export interface MetricRatio { numerator: number; denominator: number; value: number | null }
export interface MetricMonth { period: string; entries: ReportEntry[]; trials: string[] }
export interface CustomerMovement {
  kind: 'new' | 'expansion' | 'contraction' | 'churn' | 'reactivation'
  customerId: string; customerName: string; beforeMrrCents: number; afterMrrCents: number; amountCents: number
  before: ReportEntry[]; after: ReportEntry[]
}
export interface SaasMonth {
  period: string; openingMrrCents: number; closingMrrCents: number; openingCustomers: number; payingCustomers: number
  movements: CustomerMovement[]; newMrrCents: number; expansionMrrCents: number; contractionMrrCents: number; churnMrrCents: number; reactivationMrrCents: number
  logoChurn: MetricRatio; revenueChurn: MetricRatio; netRetention: MetricRatio; grossRetention: MetricRatio; arpaCents: number | null; openingSources: ReportEntry[]; closingSources: ReportEntry[]
}
export interface CohortCell { period: string; payingCustomers: number; mrrCents: number; customerRetention: MetricRatio; netRevenueRetention: MetricRatio; grossRevenueRetention: MetricRatio; sources: ReportEntry[] }
export interface SaasCohort { period: string; customers: number; startingMrrCents: number; startingSources: ReportEntry[]; months: CohortCell[] }
export interface TrialCohort { period: string; trials: number; converted: number; conversion: MetricRatio; sources: ReportEntry[]; members: { subscriptionId: string; trial: ReportEntry; converted: ReportEntry | null }[] }
export interface SaasMetrics { definition: string; months: SaasMonth[]; cohorts: SaasCohort[]; trialCohorts: TrialCohort[] }
const ratio = (numerator: number, denominator: number): MetricRatio => ({ numerator, denominator, value: denominator ? numerator / denominator : null })
const sum = (values: number[]) => { const result = values.reduce((a,b) => a + BigInt(b), 0n), n = Number(result); insist(Number.isSafeInteger(n), 'normalized_amount_out_of_range', 409); return n }
const amounts = (entries: ReportEntry[]) => {
  const result = new Map<string, { amount: number; entries: ReportEntry[] }>()
  for (const entry of entries) {
    const value = result.get(entry.customerId) ?? { amount: 0, entries: [] }
    value.amount = sum([value.amount, entry.amountCents]); value.entries.push(entry); result.set(entry.customerId, value)
  }
  return result
}

export function saasMetrics(history: MetricMonth[]): SaasMetrics {
  const months: SaasMonth[] = [], cohorts: SaasCohort[] = [], trialCohorts: TrialCohort[] = []
  const seen = new Set<string>(), initial = new Map<string, { period: string; mrr: number }>()
  const trials = new Map<string, { period: string; trial: ReportEntry; converted: ReportEntry | null; source?: ReportEntry }>()
  let previous = amounts([])
  for (const month of history) {
    const current = amounts(month.entries), movements: CustomerMovement[] = []
    for (const id of new Set([...previous.keys(), ...current.keys()])) {
      const before = previous.get(id), after = current.get(id), a = before?.amount ?? 0, b = after?.amount ?? 0
      if (a !== b) {
        const kind = a === 0 ? seen.has(id) ? 'reactivation' : 'new' : b === 0 ? 'churn' : b > a ? 'expansion' : 'contraction'
        movements.push({ kind, customerId: id, customerName: (after?.entries[0] ?? before!.entries[0]).customerName,
          beforeMrrCents: a, afterMrrCents: b, amountCents: b-a, before: before?.entries ?? [], after: after?.entries ?? [] })
      }
      if (b > 0 && !seen.has(id)) { seen.add(id); initial.set(id, { period: month.period, mrr: b }) }
    }
    const total = (kind: CustomerMovement['kind']) => sum(movements.filter(row => row.kind === kind).map(row => row.amountCents))
    const openingMrrCents = sum([...previous.values()].map(row => row.amount)), closingMrrCents = sum([...current.values()].map(row => row.amount))
    const openingCustomers = [...previous.values()].filter(row => row.amount > 0).length, payingCustomers = [...current.values()].filter(row => row.amount > 0).length
    const lostMrr = -sum([total('contraction'), total('churn')])
    months.push({ period: month.period, openingMrrCents, closingMrrCents, openingCustomers, payingCustomers, movements,
      newMrrCents: total('new'), expansionMrrCents: total('expansion'), contractionMrrCents: total('contraction'), churnMrrCents: total('churn'), reactivationMrrCents: total('reactivation'),
      logoChurn: ratio(movements.filter(row => row.kind === 'churn').length, openingCustomers), revenueChurn: ratio(lostMrr, openingMrrCents),
      netRetention: ratio(sum([openingMrrCents, -lostMrr, total('expansion')]), openingMrrCents), grossRetention: ratio(openingMrrCents-lostMrr, openingMrrCents),
      arpaCents: payingCustomers ? Number(roundHalfAway(BigInt(closingMrrCents), BigInt(payingCustomers))) : null, openingSources: [...previous.values()].flatMap(row=>row.entries), closingSources: month.entries })
    for (const period of new Set([...initial.values()].map(row => row.period))) {
      const members = [...initial].filter(([,row]) => row.period === period)
      let cohort = cohorts.find(row => row.period === period)
      if (!cohort) { cohort = { period, customers: members.length, startingMrrCents: sum(members.map(([,row]) => row.mrr)), startingSources: members.flatMap(([id])=>current.get(id)?.entries ?? []), months: [] }; cohorts.push(cohort) }
      const mrrCents = sum(members.map(([id]) => current.get(id)?.amount ?? 0))
      const count = members.filter(([id]) => (current.get(id)?.amount ?? 0) > 0).length
      cohort.months.push({ period: month.period, payingCustomers: count, mrrCents, customerRetention: ratio(count, cohort.customers),
        netRevenueRetention: ratio(mrrCents, cohort.startingMrrCents), grossRevenueRetention: ratio(sum(members.map(([id,row]) => Math.min(row.mrr, current.get(id)?.amount ?? 0))), cohort.startingMrrCents),
        sources: members.flatMap(([id]) => current.get(id)?.entries ?? []) })
    }
    for (const id of month.trials) if (!trials.has(id)) trials.set(id, { period: month.period, trial: month.entries.find(row=>row.invoiceId===id)!, converted: null })
    for (const [id, trial] of trials) {
      const source = month.entries.find(row => row.invoiceId === id)
      if (source) { trial.source = source; if (source.amountCents > 0 && !trial.converted) trial.converted = source }
    }
    previous = current
  }
  for (const period of new Set([...trials.values()].map(row => row.period))) {
    const selected = [...trials].filter(([,row]) => row.period === period), members = selected.map(([,row])=>row), converted = members.filter(row => row.converted).length
    trialCohorts.push({ period, trials: members.length, converted, conversion: ratio(converted, members.length), sources: members.flatMap(row => [row.trial, ...(row.converted ? [row.converted] : []), ...(row.source ? [row.source] : [])]), members: selected.map(([subscriptionId,row])=>({subscriptionId,trial:row.trial,converted:row.converted})) })
  }
  return { definition: SAAS_DEFINITION, months, cohorts, trialCohorts }
}
