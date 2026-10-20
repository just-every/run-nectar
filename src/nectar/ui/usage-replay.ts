import type { Bindings } from '../../auth.server'
import type { Actor } from '../actor'
import { requireCapability } from '../actor'
import { NectarError } from '../core'
import { money } from '../decimal'
import { Input } from '../input'
import { previewUsageCorrection } from '../usage-replay'
import { field, h, hidden, page, table } from './html'

export async function usageReplayPage(env: Bindings, actor: Actor, url: URL, input?: Input) {
  requireCapability(actor, 'read')
  const subscription = input?.text('subscription', { optional: true }) || url.searchParams.get('subscription') || ''
  const from = input?.text('from_period', { optional: true }) || url.searchParams.get('period') || ''
  const through = input?.text('through_period', { optional: true }) || from
  const voidText = input?.text('void_ids', { optional: true, max: 1500000 }) || ''
  const addText = input?.text('add_ids', { optional: true, max: 1500000 }) || ''
  let result: Awaited<ReturnType<typeof previewUsageCorrection>> | undefined, error = '', status = 200
  if (input) {
    try {
      result = await previewUsageCorrection(env, actor, Input.of({ subscription, from_period: from, through_period: through, void_event_ids: voidText.split(/\s+/).filter(Boolean), add_event_ids: addText.split(/\s+/).filter(Boolean) }))
    } catch (failure) {
      if (!(failure instanceof NectarError) || failure.status >= 500) throw failure
      error = failure.code.replaceAll('_', ' '); status = failure.status
    }
  }
  return page('Historical usage replay', actor, h`<p class="crumbs"><a href="/app/subscriptions/${subscription}">Subscription</a> · <a href="/app/usage">Usage</a></p><h1>Historical usage replay</h1>
    <p>Compare a proposed usage correction with saved issued invoices. Original prices, metric versions, tax and service windows stay fixed.</p>
    <section class="card"><h2>Choose the issued range</h2><form method="post" action="/app/usage/replay">${hidden('subscription', subscription)}
      ${field('First period (YYYY-MM)', 'from_period', { value: from })}${field('Last period (inclusive)', 'through_period', { value: through })}
      <label>Event IDs to void (separated by whitespace)<textarea name="void_ids" rows="4">${voidText}</textarea></label>
      <label>Recorded late event IDs to include (separated by whitespace)<textarea name="add_ids" rows="4">${addText}</textarea></label><button type="submit">Preview correction</button></form>
      <p class="hint">Up to 10,000 event IDs per list and 36 issued periods. Ingest additions through the ordinary usage door first. Empty lists reproduce the originals.</p></section>
    ${error ? h`<section class="card" role="alert"><h2>Preview unavailable</h2><p>${error}</p></section>` : ''}
    ${result ? h`<section class="card"><h2>Unresolved correction preview</h2><p>${result.warning}</p>
      ${table(['Invoice', 'Original total', 'Replayed total', 'Tax change', 'Total change'], result.periods.map(p => [h`<a href="${p.source}">${p.number}</a>`, money(p.before.totalCents), money(p.after.totalCents), money(p.deltaTaxCents), money(p.deltaTotalCents)]))}
      <p>Total change across this range: ${money(result.delta.totalCents)}.</p>
      ${result.periods.map(p => h`<details><summary>${p.number} calculation and event evidence</summary><p>Period ${p.period.start} to ${p.period.end}; rating ${p.version}; original fingerprint ${p.originalFingerprint}.</p><h3>Replayed charges</h3>${table(['Charge', 'Amount'], p.after.lines.map(l => [l.description, money(l.amountCents)]))}<p>Event IDs: ${p.eventIds.join(', ') || 'None'}</p><p>Replay fingerprint: ${p.fingerprint}</p></details>`)}</section>` : ''}`, { current: '/app/usage', url, status })
}
