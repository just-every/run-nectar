import type { CustomerText } from './locale'
import type { NormalizedCorrection } from './normalized-metrics'

export function normalizedCorrectionText(value: NormalizedCorrection, L: CustomerText) {
  return [L.t('correction.mrr.heading', { policy: value.policyVersion }), ...value.periods.map(effect =>
    !effect.before.supported || !effect.after.supported ? L.t('correction.mrr.unsupported') : L.t('correction.mrr.period', {
      date: L.day(effect.before.asOf), before: L.money(effect.before.mrrCents), after: L.money(effect.after.mrrCents), change: L.money(effect.deltaMrrCents),
      arrBefore: L.money(effect.before.arrCents), arrAfter: L.money(effect.after.arrCents), arrChange: L.money(effect.deltaArrCents),
    }))].join('\n')
}
