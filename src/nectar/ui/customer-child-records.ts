import { canRead, type Actor } from '../actor'
import type { Row } from '../core'
import { formatDate, formatPeriod } from '../dates'
import { customerBillingRecordSection } from './customer-billing-record'
import { cents, h, table } from './html'

const subscriptionState = (s: Row, today: string) => s.billing_mode === 'shadow' ? 'Shadow' : s.end_date && s.end_date <= today ? 'Ended' : s.intervals?.some((i: Row) => i.from <= today && (!i.to || i.to > today)) ? 'Paused' : s.trial_end && s.trial_end > today ? 'Trial' : 'Active'

export function customerChildRecordsSection(customer: Row, actor: Actor) {
  if (!customer.childAccounts?.length) return ''
  const today = new Date().toISOString().slice(0, 10)
  const subscriptions = canRead(actor, 'subscriptions'), invoices = canRead(actor, 'invoices')
  return h`<section class="card"><h2>Child accounts</h2>
    ${customer.childAccounts.map(({ relationship, record: child }: Row) => {
      const ledger = child.ledger, history = child.incumbentHistory
      const amount = (value: number | null | undefined) => cents(value, child.currency)
      const invoice = (id: string, label: string) => invoices ? h`<a href="/app/invoices/${id}">${label}</a>` : label
      return h`<article><h3><a href="/app/customers/${child.id}">${child.name}</a></h3>
        <p>Billing currency: ${child.currency}. Billing mode: ${relationship.billingMode}.</p>
        <p>These totals and records belong to ${child.name}. Each account keeps its own ledger.</p>
        <dl class="figures">
          ${[['Invoiced', ledger.invoicedCents], ['Paid', ledger.paidCents], ['Credited', ledger.creditedCents], ['Owed now', ledger.balanceCents], ['Written off', ledger.writtenOffCents], ['Unallocated payments', ledger.unallocatedCents]].map(([label, value]) => h`<div><dt>${label}</dt><dd>${amount(value as number)}</dd></div>`)}
        </dl>
        <h4>Subscriptions</h4>
        ${table(['Subscription', 'Started', 'Billing day', 'State'], child.subscriptions.map((s: Row) => [subscriptions ? h`<a href="/app/subscriptions/${s.id}">${s.external_id || `Subscription from ${formatDate(s.start_date)}`}</a>` : s.external_id || `Subscription from ${formatDate(s.start_date)}`, formatDate(s.start_date), s.anchor_day, subscriptionState(s, today)]), { empty: 'No subscriptions.' })}
        ${child.upcoming ? h`<h4>Upcoming invoices</h4><p>Preview totals use recorded usage and full-period fixed charges; future usage is not forecast.</p>
          ${table(['Subscription', 'Period', 'State', 'Subtotal', 'Tax', 'Total', 'Review'], child.upcoming.map((r: Row) => [subscriptions ? h`<a href="${r.sourcePath}">${r.externalId || `Subscription from ${formatDate(r.startDate)}`}</a>` : r.externalId || `Subscription from ${formatDate(r.startDate)}`, formatPeriod(r.period.start, r.period.end), r.state, amount(r.subtotalCents), amount(r.taxCents), amount(r.totalCents), r.reason === 'previous_biller_period' ? 'Previous biller owns this period.' : r.reason === 'subscription_not_in_period' ? 'Outside service dates.' : r.exceptions.map((e: Row) => e.message).join(' · ') || 'No calculation exceptions.']), { empty: 'No subscriptions to preview.' })}` : ''}
        <h4>Invoices</h4>
        ${table(['Invoice', 'Issued', 'Due', 'Total', 'Credited', 'Paid', 'Written off', 'Owed'], ledger.invoices.map((i: Row) => [invoice(i.id, i.number), formatDate(i.issue_date), formatDate(i.due_date), amount(i.total_cents), amount(i.credited_cents), amount(i.paid_cents), amount(i.written_off_cents), amount(i.balance_cents)]), { empty: 'No issued invoices.' })}
        <h4>Payments</h4>
        ${table(['Reference', 'Received', 'Amount', 'Unallocated'], ledger.payments.map((p: Row) => [p.reference, formatDate(p.received_on), amount(p.amount_cents), amount(p.unallocated_cents)]), { empty: 'No payments.' })}
        <h4>Credit notes</h4>
        ${table(['Credit note', 'Invoice', 'Amount', 'Reason'], ledger.credits.map((c: Row) => [c.number, invoice(c.invoice_id, ledger.invoices.find((i: Row) => i.id === c.invoice_id)?.number || c.invoice_id), amount(c.amount_cents), c.reason]), { empty: 'No credit notes.' })}
        ${customerBillingRecordSection(child, actor)}
        <h4>Billing contacts</h4>
        ${table(['Name', 'Email', 'Role'], child.contacts.map((c: Row) => [c.name, c.email, c.role]), { empty: 'No extra contacts.' })}
        <h4>Notes</h4>
        ${table(['Record', 'Author', 'When', 'Note'], child.notes.map((n: Row) => [n.record_label, n.author, n.created_at, n.body]), { empty: 'No notes.' })}
        <h4>Moved history</h4><p>Read-only records from the previous biller, separate from Nectar ledger totals.</p>
        ${table(['Document', 'Provider', 'Reference', 'Status', 'Issued', 'Total', 'Remaining at capture'], history.documents.map((d: Row) => [d.number || d.document_kind, d.provider, d.provider_ref, d.status, formatDate(d.issue_date), amount(d.total_cents), amount(d.remaining_cents)]), { empty: 'No moved documents.' })}
        ${table(['Kind', 'Provider', 'Reference', 'Status', 'When', 'Amount'], history.records.map((r: Row) => [r.kind, r.provider, r.provider_ref, r.status, formatDate(r.occurred_on), amount(r.amount_cents)]), { empty: 'No moved records.' })}
      </article>`
    })}
  </section>`
}
