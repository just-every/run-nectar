import type { Bindings } from '../../auth.server'
import type { Actor } from '../actor'
import { can, requireCapability } from '../actor'
import { usageCorrections } from '../usage-dispositions'
import { one } from '../core'
import { NectarError } from '../core'
import { money } from '../decimal'
import { Input } from '../input'
import { previewUsageCorrection } from '../usage-replay'
import { check, field, form, h, hidden, page, select, table } from './html'

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
  const corrections=subscription?await usageCorrections(env,actor,subscription):[]
  const policy=(await one(env,'SELECT disposition,revision FROM nc_usage_policy WHERE singleton=1'))!
  const back=`/app/usage/replay?subscription=${encodeURIComponent(subscription)}&period=${encodeURIComponent(from)}`
  return page('Historical usage replay', actor, h`<p class="crumbs"><a href="/app/subscriptions/${subscription}">Subscription</a> · <a href="/app/usage">Usage</a></p><h1>Historical usage replay</h1>
    <p>Compare a proposed usage correction with saved issued invoices. Original prices, metric versions, tax and service windows stay fixed.</p>
    <section class="card"><h2>Correction policy</h2><p>Current policy: <strong>${policy.disposition.replaceAll('_',' ')}</strong> (revision ${policy.revision}). Negative differences issue numbered credit notes; excess over the unpaid original is carried credit, never a cash refund or a negative invoice. Positive differences bill next period or on a separate correcting invoice.</p>
      ${actor.kind==='member'&&actor.role==='owner'?form('usage.correction.policy','/app/settings#policy-changes',select('Disposition','disposition',[{value:'next_invoice',label:'Next invoice'},{value:'correcting_invoice',label:'Correcting invoice'},{value:'credit_note',label:'Credit note / correcting debit'}],policy.disposition),'Prepare policy change',{secondary:true}):''}</section>
    <section class="card"><h2>Choose the issued range</h2><form method="post" action="/app/usage/replay">${hidden('subscription', subscription)}
      ${field('First period (YYYY-MM)', 'from_period', { value: from })}${field('Last period (inclusive)', 'through_period', { value: through })}
      <label>Event IDs to void (separated by whitespace)<textarea name="void_ids" rows="4">${voidText}</textarea></label>
      <label>Recorded late event IDs to include (separated by whitespace)<textarea name="add_ids" rows="4">${addText}</textarea></label><button type="submit">Preview correction</button></form>
      <p class="hint">Up to 10,000 event IDs per list and 36 issued periods. Ingest additions through the ordinary usage door first. Empty lists reproduce the originals.</p></section>
    ${error ? h`<section class="card" role="alert"><h2>Preview unavailable</h2><p>${error}</p></section>` : ''}
    ${result ? h`<section class="card"><h2>Unresolved correction preview</h2><p>${result.warning}</p>
      ${table(['Invoice', 'Original total', 'Replayed total', 'Tax change', 'Total change'], result.periods.map(p => [h`<a href="${p.source}">${p.number}</a>`, money(p.before.totalCents), money(p.after.totalCents), money(p.deltaTaxCents), money(p.deltaTotalCents)]))}
      <p>Total change across this range: ${money(result.delta.totalCents)}.</p>
      ${result.periods.map(p => h`<details><summary>${p.number} calculation and event evidence</summary><p>Period ${p.period.start} to ${p.period.end}; rating ${p.version}; original fingerprint <code style="overflow-wrap:anywhere">${p.originalFingerprint}</code>.</p><h3>Replayed charges</h3>${table(['Charge', 'Amount'], p.after.lines.map(l => [l.description, money(l.amountCents)]))}<p>Event IDs: <code style="overflow-wrap:anywhere">${p.eventIds.join(', ') || 'None'}</code></p><p>Replay fingerprint: <code style="overflow-wrap:anywhere">${p.fingerprint}</code></p></details>`)}</section>
      ${can(actor,'propose')?h`<section class="card"><h2>Prepare this correction</h2><p>Preparation records a proposal only and blocks new invoice issue until it is approved or rejected. Include every issued period from the first affected month through the latest issued month.</p>
        ${form('usage.correction.prepare',back,h`${hidden('subscription',subscription)}${hidden('from_period',from)}${hidden('through_period',through)}${hidden('void_ids',voidText)}${hidden('add_ids',addText)}${field('Reason','reason')}<label>Customer explanation (sent exactly as written in the customer’s language)<textarea name="explanation" rows="4" required></textarea></label>`,'Prepare governed correction')}</section>`:''}` : ''}
    ${input&&!result&&can(actor,'propose')?h`<section class="card"><h2>Prepare complete financial replay</h2><p>Financial preparation includes all issued downstream periods, even beyond the read-only preview’s 36-period bound. Review the saved before/after proposal before approving anything.</p>${form('usage.correction.prepare',back,h`${hidden('subscription',subscription)}${hidden('from_period',from)}${hidden('through_period',through)}${hidden('void_ids',voidText)}${hidden('add_ids',addText)}${field('Reason','reason')}<label>Customer explanation<textarea name="explanation" rows="4" required></textarea></label>`,'Prepare complete correction')}</section>`:''}
    ${corrections.map(c=>h`<section class="card" id="correction-${c.id}"><h2>Correction ${c.status}</h2><p>Policy ${c.plan.disposition.replaceAll('_',' ')} · ${c.plan.reason}</p><p>Subtotal change ${money(c.plan.delta.subtotalCents)} · tax change ${money(c.plan.delta.taxCents)} · total change ${money(c.plan.delta.totalCents)}.</p>
      <p>Carried credit created: ${money(c.plan.carriedCents)}. Original invoices remain unchanged.</p>
      ${table(['Original invoice','Period','Subtotal change','Tax change','Total change','Credit applied to original','Carried credit'],c.plan.periods.map((p:any)=>[h`<a href="/app/invoices/${p.invoice}">${p.number}</a>`,`${p.period.start} to ${p.period.end}`,money(p.subtotalCents),money(p.taxCents),money(p.totalCents),money(p.appliedCents),money(p.carriedCents)]))}
      ${c.documents.length?table(['Financial document','State','Face amount'],c.documents.map((d:any)=>[h`<a href="/app/invoices/${d.invoice}#recv">${d.number||'Unissued correcting invoice'}</a>`,d.status,money(d.amountCents)])):''}
      <details><summary>Frozen customer explanation and source evidence</summary><p>${c.plan.message.recipient}</p><pre class="message">${c.plan.message.body}</pre><p>Basis <code style="overflow-wrap:anywhere">${c.basis}</code></p>
        ${c.plan.periods.map((p:any)=>h`<h3>${p.number}</h3><p>Replay fingerprint <code style="overflow-wrap:anywhere">${p.fingerprint}</code></p><p>Original event IDs: <code style="overflow-wrap:anywhere">${p.eventIds.join(', ')}</code></p>${table(['Revenue month','Before','After','Delta'],p.revenue.map((r:any)=>[r.period,money(r.beforeCents),money(r.afterCents),money(r.deltaCents)]))}`)}</details>
      ${c.status==='pending'&&actor.kind==='member'&&can(actor,'approve')?h`<p>${c.plan.needsSecondApprover?'This credit exceeds the threshold. Another active owner or finance approver must approve the human-prepared correction. An agent-prepared correction first needs human credit authorization.':'A human approver must confirm the exact source-bound correction.'}</p>
        ${c.plan.needsSecondApprover&&c.needsCreditAuthorization&&!c.authorized_by_id?form('usage.correction.authorize',back,hidden('correction',c.id),'Prepare credit authorization',{secondary:true}):''}
        ${form('usage.correction.decide',back,h`${hidden('correction',c.id)}${hidden('decision','approved')}${c.plan.prepaid&&actor.role==='owner'?check('I am the sole active owner/finance approver and explicitly confirm this prepaid correction.','confirm_single'):''}`,'Approve correction and reserve message')}
        ${form('usage.correction.decide',back,h`${hidden('correction',c.id)}${hidden('decision','rejected')}`,'Reject correction',{secondary:true})}`:''}
      ${c.mail?h`<p>Customer message: ${c.mail.status}. Provider acceptance does not confirm mailbox delivery; uncertain sends are not retried.</p>`:''}
    </section>`) }
`, { current: '/app/usage', url, status })
}
