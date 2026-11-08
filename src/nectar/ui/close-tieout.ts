import type { Bindings } from '../../auth.server'
import { can, type Actor } from '../actor'
import { assuranceCases } from '../assurance'
import { requireBusiness } from '../business'
import { clockInstant } from '../clock'
import { closeTieout } from '../close-tieout'
import { all } from '../core'
import { localDate } from '../dates'
import { cents, details, field, form, h, hidden, page, select, table, tag } from './html'

export async function closeTieoutPage(env: Bindings, actor: Actor, url: URL) {
  const business = await requireBusiness(env)
  const packet = await closeTieout(env, actor, url.searchParams.get('period') ?? localDate(clockInstant(env), business.timezone).slice(0, 7))
  const cases = await assuranceCases(env, actor)
  const owners = await all(env, "SELECT id,name FROM nc_members WHERE status='active' AND role IN ('owner','finance') ORDER BY name,id")
  const prepare = can(actor, 'propose'), approve = can(actor, 'approve') && actor.kind === 'member'
  const returnTo = `/app/close-tieout?period=${packet.period}`
  const { debt, cash, credit, revenue } = packet.totals
  const items = packet.proofs.filter(proof => proof.mismatch || cases.some(row => row.source_id === proof.source))
  return page('Close preparation', actor, h`<p class="crumbs"><a href="/app/revenue">Revenue schedules and period close</a></p>
    <h1>Close preparation</h1><p class="lede">Native USD · ${packet.period}</p>
    <section class="card"><h2>Preparation basis</h2><p>${packet.definition}</p>
      <form method="get">${field('Month', 'period', { type: 'month', value: packet.period })}<button type="submit">Show packet</button></form>
      ${details({ fingerprint: packet.basis }, 'Source fingerprint')}
      ${prepare ? form('close.scan', returnTo, h`${hidden('period', packet.period)}${hidden('basis', packet.basis)}${select('Case owner', 'owner', owners.map(row => ({ value: row.id, label: row.name })), actor.id)}`, 'Scan for review items', { secondary: true }) : ''}
    </section>
    <section class="card"><h2>Invoice debt</h2><p>Issued ${cents(debt.issuedCents)} − credits ${cents(debt.creditNotesCents)} − cash allocations ${cents(debt.allocatedCents)} − carried credit ${cents(debt.carriedAppliedCents)} − goodwill ${cents(debt.goodwillAppliedCents)} − write-offs ${cents(debt.writeOffCents)} + recoveries ${cents(debt.recoveryCents)} + reversals ${cents(debt.reversedCents)}.</p>
      <p>Computed debt <strong>${cents(debt.computedCents)}</strong> · recorded debt ${cents(debt.reportedCents)} · difference ${cents(debt.differenceCents)}.</p></section>
    <section class="card"><h2>Received cash and customer credit</h2><p>Recorded received cash ${cents(cash.receivedCents)} − allocations ${cents(cash.allocatedCents)} − recorded returns ${cents(cash.returnedCents)} = unapplied <strong>${cents(cash.computedUnappliedCents)}</strong>. Difference ${cents(cash.differenceCents)}.</p>
      <p>Goodwill grants ${cents(credit.grantedCents)} − applications ${cents(credit.appliedCents)} = available <strong>${cents(credit.computedGoodwillCents)}</strong>. Difference ${cents(credit.differenceCents)}. Separate available carried correction credit ${cents(credit.carriedCents)}.</p></section>
    <section class="card"><h2>Revenue roll-forward</h2><p>Opening ${cents(revenue.openingCents)} + net billings ${cents(revenue.netBillingsCents)} − recognition ${cents(revenue.recognizedCents)} = closing <strong>${cents(revenue.closingCents)}</strong>. Report difference ${cents(revenue.differenceCents)}; roll-forward difference ${cents(revenue.rollforwardDifferenceCents)}.</p>
      <p><a href="/app/revenue?period=${packet.period}">Inspect revenue schedules and journals</a></p></section>
    <section class="card"><h2>Coverage</h2>${table(['Area', 'State', 'Boundary'], packet.coverage.map(row => [row.area, tag(row.state.replaceAll('_', ' ')), row.detail]))}</section>
    <section class="card"><h2>Review items and synchronization failures</h2><p>A successful comparison does not close a case. After an ordinary authorized fix, a person confirms the exact current basis; a fresh recheck then resolves it.</p>
      ${items.length ? items.map(proof => {
        const saved = cases.find(row => row.source_id === proof.source)
        return h`<article class="card" id="case-${saved?.id ?? proof.source}"><h3>${proof.category === 'review' ? 'Unapplied received cash' : 'Bad-debt synchronization failure'}</h3>
          <p>${tag(saved?.status ?? 'not scanned')} · ${proof.mismatch ? 'Needs review' : 'Current source agrees'} · ${cents(proof.unappliedCents ?? proof.amountCents)}</p><p>${proof.cause}</p><p>${proof.proposedFix}</p>
          <p><a href="${proof.href}">Exact financial source</a> · <a href="${proof.fixHref}">Open ordinary review door</a></p>
          ${details({ ...proof, case: saved?.id, owner: saved?.owner_id }, 'Current evidence and basis')}
          ${saved && prepare ? form('assurance.recheck', returnTo, hidden('case', saved.id), 'Recheck this case', { secondary: true }) : ''}
          ${saved && approve && !proof.mismatch && saved.status === 'open' ? form('assurance.approve', returnTo, h`${hidden('case', saved.id)}${hidden('basis', proof.basis)}`, 'Confirm current agreement', { secondary: true }) : ''}
          ${saved && approve ? form('assurance.assign', returnTo, h`${hidden('case', saved.id)}${select('Case owner', 'owner', owners.map(row => ({ value: row.id, label: row.name })), saved.owner_id)}`, 'Assign case', { secondary: true }) : ''}
        </article>`
      }) : h`<p>No supported review item is present in these native sources. Uncovered areas remain unqualified.</p>`}
    </section>
    <section class="card"><h2>Source register</h2>
      ${table(['Issued invoice', 'Issued total$', 'Current debt$'], packet.sources.invoices.map(row => [h`<a href="/app/invoices/${row.id}">${row.number}</a>`, cents(row.total_cents), cents(row.balance_cents)]))}
      ${table(['Received payment', 'Received$', 'Unapplied$'], packet.sources.payments.map(row => [h`<a href="/app/payments/${row.id}/receipt">${row.id}</a>`, cents(row.amount_cents), cents(row.unallocated_cents)]))}
      ${details(packet.sources, 'Exact source records')}
    </section>`, { current: '/app/billing', url })
}
