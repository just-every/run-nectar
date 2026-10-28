import { canRead, type Actor } from '../actor'
import type { ReportInvoice } from '../reports'
import type { NormalizedCorrection } from '../normalized-metrics'
import { cents, details, h, table } from './html'

export function normalizedEffectBody(value: NormalizedCorrection) {
  return h`<h3>Normalized subscription run rate</h3><p>${value.policyVersion} · month-end fixed and seat terms. Metered usage and one-time credits have no effect.</p>
    ${table(['As of','MRR before$','MRR after$','MRR change$','ARR before$','ARR after$'],value.periods.map(effect=>[
      effect.before.asOf, cents(effect.before.mrrCents), cents(effect.after.mrrCents), cents(effect.deltaMrrCents), cents(effect.before.arrCents), cents(effect.after.arrCents)]))}
    ${value.periods.some(effect=>!effect.before.supported||!effect.after.supported)?h`<p>These instruments are outside the supported USD simple fixed and seat definition. No normalized metric is claimed.</p>`:''}`
}

export function normalizedSourceBody(value: NonNullable<ReportInvoice['normalized']>, actor: Actor) {
  const snapshot = value.snapshot
  return h`<section class="card"><h2>Month-end contract evidence</h2><p>As of ${snapshot.asOf} · ${value.policyVersion} · ${value.source.provider}.</p>
    <p>${snapshot.active?'The contract is active at month end.':'The contract is in trial, paused, canceled or outside its service dates at month end.'}</p>
    <p>MRR ${cents(snapshot.mrrCents)} · ARR ${cents(snapshot.arrCents)}.</p>
    ${table(['Item','Contract price$','Quantity','Interval','Discounts','Exact monthly cents'],snapshot.components.map(component=>[
      component.priceId, component.unitAmount, component.quantity, `${component.interval.count} ${component.interval.unit}`,
      component.discounts.map(d=>`${d.percent}%`).join(' + ')||'None',`${component.exactMrrCents.numerator} ÷ ${component.exactMrrCents.denominator}`]))}
    ${canRead(actor,'customers')&&canRead(actor,'subscriptions')?h`<p><a href="${value.source.href}">Retained contract source</a></p>`:''}
    ${details({fingerprint:snapshot.fingerprint,exactMrrCents:snapshot.exactMrrCents,components:snapshot.components},'Exact normalized operands')}
    </section>`
}
