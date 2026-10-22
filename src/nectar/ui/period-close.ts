// The revenue page's close controls: closed months, their frozen packets and
// the ledger postings each saved, and the form that closes the next month.
import type { Bindings } from '../../auth.server'
import { can, type Actor } from '../actor'
import { periodCloses } from '../period-close'
import { cents, field, form, h, table, who } from './html'

export async function periodCloseSection(env: Bindings, actor: Actor) {
  const state = await periodCloses(env, actor)
  const closer = can(actor, 'approve') && actor.kind === 'member'
  const posted = (rows: any[]) => rows.length ? rows.map(p => h`<span class="sub">${p.docNumber}: ${p.status === 'posted' ? `posted, ledger entry ${p.ledgerRef}` : `pending${p.error ? ` (${p.error})` : ''}`}</span>`) : '—'
  return h`<section class="card" aria-labelledby="period-close"><h2 id="period-close">Period close</h2>
    <p>Closing a month freezes its roll-forward, journals and its billings, collections and revenue reports, and posts one summarized journal per ledger company. ${state.through ? h`Closed through ${state.through}; records that arrive for a closed month are reported in ${state.open}.` : 'No month is closed yet.'}</p>
    ${table(['Month', 'Opening$', 'Net billings$', 'Recognized$', 'Closing$', 'Closed by', 'Ledger'], state.closes.map((c: any) => [c.period, cents(c.packet.rollforward.openingCents), cents(c.packet.rollforward.netBillingsCents), cents(c.packet.rollforward.recognizedCents), cents(c.packet.rollforward.closingCents), h`${who(actor, c.closedBy)} <span class="sub">${new Date(c.closedAt).toISOString().slice(0, 10)}</span>`, posted(c.postings)]), { empty: 'No closed months.' })}
    ${closer ? form('revenue.close', '/app/revenue', field('Month to close', 'period', { type: 'month', hint: state.open ? `The next month to close is ${state.open}.` : 'Close the first month, then each following month in order.' }), 'Close month', { layout: 'columns', secondary: true }) : ''}
    ${closer && state.closes.some((c: any) => c.postings.some((p: any) => p.status === 'pending')) ? form('ledger.post', '/app/revenue', '', 'Retry pending ledger postings', { secondary: true }) : ''}</section>`
}
