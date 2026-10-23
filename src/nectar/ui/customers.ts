import { money } from '../decimal'
import { customerBillingRecordSection } from './customer-billing-record'
import { planChangeSection } from './plan-changes'
import { balanceSection } from './balance'
import { clockInstant } from '../clock'
import { requireBusiness } from '../business'
import { localDate } from '../dates'
import { trialCollectionSection,trialSection } from './promotions'
import { intervalLabel } from './intervals'
import { importedCollectionsSection } from './imported-collections'
import { customerInvoiceForm } from './invoice-content'
import { renewalSection } from './renewals'
// Customers, one customer (contacts, subscriptions, balance, entitlements,
// previous-biller history) and one subscription (items, contract exceptions,
// scheduled changes with their proration preview).
import type { Bindings } from '../../auth.server'
import { metadataLink } from './metadata'
import { canRead, can, type Actor } from '../actor'
import { all } from '../core'
import { customers } from '../customers'
import { languages } from '../locale'
import { addDays, formatDate, formatPeriod } from '../dates'
import { lifecycleSection } from './lifecycle'
import { subscriptionDetail } from '../subscriptions'
import { customerView } from '../views'
import { addresses, area, cents, check, details, field, form, h, hidden, page, select, table, tag, type Html } from './html'
import { personName } from './shell'
import { addonSection, chargeSection } from './charges'
import { upcomingSection } from './upcoming'
import { notesSection } from './notes'
import { certificateSection } from './certificates'
import { contractSection } from './contracts'
import { priceRate } from './pricing'

// PORT-006: the language this customer's mail and pages use; options are the complete translation files.
const languageSelect = (selected: string) => select('Customer language', 'language', languages(), selected, { hint: 'Renewal, return-offer, reminder, certificate and correction messages Nectar writes. Text you write yourself is sent as written.' })
const languageName = (tag: string) => languages().find(l => l.value === tag)?.label ?? `${tag} (translation file removed; English is used)`
const subscriptionState = (s: Record<string, any>, today: string) => s.billing_mode === 'shadow' ? 'Shadow' : s.end_date && s.end_date <= today ? 'Ended' : s.intervals?.some((i: any)=>i.from<=today && (!i.to || i.to>today)) ? 'Paused' : s.trial_end && s.trial_end > today ? 'Trial' : 'Active'

export async function customersPage(env: Bindings, actor: Actor, url: URL) {
  const rows = await customers(env, actor,url)
  const create = can(actor, 'records') ? h`<section class="card" aria-labelledby="new"><h2 id="new">Add a customer</h2>${form('customer.create', '/app/customers/{id}', h`
    ${field('Customer ID', 'external_id', { hint: 'The id your CRM or previous biller uses; usage files refer to customers by it.' })}${field('Name', 'name')}
    ${select('Billing currency','currency',['USD','CAD','EUR','GBP'].map(value=>({value,label:value})),'USD')}${field('Billing email', 'billing_email', { type: 'email' })}${field('Billing address', 'address', { required: false })}
    ${check('Tax exempt', 'tax_exempt')}${field('Exemption certificate reference', 'tax_exempt_ref', { required: false })}${languageSelect('en')}`, 'Add customer', { layout: 'columns' })}</section>` : ''
  return page('Customers', actor, h`<h1>Customers</h1>
    <section class="card">${table(['Customer', 'Customer ID', 'Billing email', 'Subscriptions$', 'Source'], rows.map(r => [h`<a href="/app/customers/${r.id}">${r.name}</a>`, r.external_id, r.billing_email || '—', r.subscriptions, r.origin === 'import' ? 'Moved in' : 'Nectar']), { empty: url.searchParams.get('search')?.trim() ? 'No customers match this search.' : 'No customers yet. Add one below, or move in from Stripe under More.', lead: true })}</section>${create}`, { current: '/app/customers', url })
}

export async function customerPage(env: Bindings, actor: Actor, id: string, url: URL) {
  const c = await customerView(env, actor, id, url)
  const cents=(value:number|null|undefined)=>value===null||value===undefined?'—':money(value,c.currency??'USD')
  if(c.erased_at) return page('Erased customer',actor,h`<h1>Erased customer</h1><section class="card"><p>Personal information has been erased. Required financial records remain until their retention date.</p><p><a href="/app/erasures">Erasure requests and receipts</a></p>${table(['Invoice','Total'],c.ledger.invoices.map((i:any)=>[h`<a href="/app/invoices/${i.id}">${i.number}</a>`,cents(i.total_cents)]))}</section>`,{url,current:'/app/customers'})
  const today = new Date().toISOString().slice(0, 10)
  const named = await all(env, "SELECT p.id,p.currency, pr.name, p.version, p.kind, p.unit_amount, p.pricing_model, p.nickname,b.interval_unit,b.interval_count,b.billing_timing, m.unit_label FROM nc_prices p JOIN nc_products pr ON pr.id = p.product_id LEFT JOIN nc_price_intervals b ON b.price_id=p.id LEFT JOIN nc_meters m ON m.id = p.meter_id WHERE p.status = 'active' ORDER BY pr.name, p.version DESC")
  const label = (p: Record<string, any>) => `${p.name}${p.nickname ? ` — ${p.nickname}` : ''} v${p.version}: ${priceRate(p)} · ${intervalLabel(p)}`
  const newSubscription = can(actor, 'records') && named.length ? h`<section class="card" aria-labelledby="new-sub"><h2 id="new-sub">Start a subscription</h2>${form('subscription.create', '/app/subscriptions/{id}', h`${hidden('customer', c.id)}
    ${field('Start date', 'start_date', { type: 'date', value: today })}
    ${field('Billing day of the month (1–28)', 'anchor_day', { type: 'number', required: false, hint: 'Each period starts on this day. Leave empty to use the start date’s day.' })}
    ${select('Contract term','term_months',[{value:'1',label:'One month'},{value:'12',label:'12 months'},{value:'24',label:'24 months'},{value:'36',label:'36 months'}],'',{required:false,blank:'Evergreen'})}${field('Full billing anchor date','billing_anchor_date',{type:'date',required:false,hint:'For nonmonthly plans and month-end anniversaries. Leave empty to use the start date.'})}
    ${field('Trial ends', 'trial_end', { type: 'date', required: false, hint: 'Fixed and seat charges start on this date.' })}
    ${select('Payment method on file for the trial', 'trial_payment', [{ value: 'card', label: 'Yes: converts to paid at the end date' }, { value: 'none', label: 'No: ends unpaid at the end date' }], '', { required: false, blank: 'Not recorded' })}
    ${field('Promotion code', 'promotion_code', { required: false, hint: 'Redeems the code for this subscription.' })}
    ${[0, 1, 2].map(index => h`<div class="pair">${select(`Price ${index + 1}`, 'price', named.map(p => ({ value: p.id, label: label(p) })), '', { required: index === 0, blank: index === 0 ? '' : 'None' })}${field('Seats (per-seat prices)', 'quantity', { type: 'number', value: '1', required: false })}</div>`)}
    <fieldset><legend>Contract exception (optional; bills only once approved)</legend>
    ${select('Kind', 'exception_kind', [{ value: 'discount_percent', label: 'Discount (%) on fixed and seat charges' }, { value: 'fixed_credit', label: 'One-time credit ($)' }], '', { required: false, blank: 'No exception' })}
    ${field('Value', 'exception_value', { required: false })}${field('From', 'exception_effective_from', { type: 'date', required: false })}${field('Until (optional)', 'exception_effective_to', { type: 'date', required: false })}
    ${field('Note', 'exception_note', { required: false })}${area('Contract clause (quote it)', 'exception_clause', '', false, 2)}</fieldset>`, 'Start subscription', { layout: 'columns' })}</section>` : ''
  const ledger = c.ledger, hasHistory=c.incumbentHistory.documents.length>0||c.incumbentHistory.records.length>0
  return page(c.name, actor, h`<p class="crumbs"><a href="/app/customers">Customers</a></p><h1>${c.name}</h1><p>Billing currency: ${c.currency??'USD'}.</p>${canRead(actor,'payments')&&canRead(actor,'invoices')?h`<p><a href="/app/prepaid/refunds?customer=${c.id}">Prepaid refund requests</a></p>`:''}<p>${metadataLink('customer',c.id)}</p>
    <section class="card summary"><dl class="figures">
      <div><dt>Customer ID</dt><dd>${c.external_id}</dd></div><div class="wide"><dt>Billing email</dt><dd>${addresses(c.billing_email || '—')}</dd></div>
      <div><dt>${hasHistory?'Nectar invoiced':'Invoiced'}</dt><dd>${cents(ledger.invoicedCents)}</dd></div><div><dt>${hasHistory?'Nectar credited':'Credited'}</dt><dd>${cents(ledger.creditedCents)}</dd></div><div><dt>${hasHistory?'Paid on Nectar invoices':'Paid'}</dt><dd>${cents(ledger.paidCents)}</dd></div>
      <div><dt>${hasHistory?'Owed on Nectar invoices':'Owed now'}</dt><dd>${cents(ledger.balanceCents)}</dd></div><div><dt>Unallocated payments</dt><dd>${cents(ledger.unallocatedCents)}</dd></div>
      <div><dt>Tax</dt><dd>${c.tax_exempt ? `Exempt (${c.tax_exempt_ref})` : 'Taxable'}</dd></div><div><dt>Customer language</dt><dd>${languageName(c.language)}</dd></div></dl>
      ${details({ 'Internal id': c.id, Source: c.origin, 'Provider reference': c.provider_ref ?? '—', Revision: c.revision })}</section>
    <section class="card" aria-labelledby="subs"><h2 id="subs">Subscriptions</h2>${table(['Subscription', 'Started', 'Billing day$', 'Status'], c.subscriptions.map((s: any) => [canRead(actor, 'subscriptions') ? h`<a href="/app/subscriptions/${s.id}">${s.external_id || `Subscription from ${formatDate(s.start_date)}`}</a>` : (s.external_id || `Subscription from ${formatDate(s.start_date)}`), formatDate(s.start_date), s.anchor_day, tag(subscriptionState(s, today))]), { empty: 'No subscriptions yet.' })}</section>
    ${c.upcoming ? h`<section class="card" aria-labelledby="customer-upcoming"><h2 id="customer-upcoming">Upcoming invoices</h2>
      <p class="hint">Each subscription keeps its own billing period. Preview totals use recorded usage and full-period fixed charges; future usage is not forecast. Issued rows keep their saved calculation. Reading this list prepares no invoices.</p>
      <form method="get" class="row-form">${field('Preview month', 'preview_period', { type: 'month', value: url.searchParams.get('preview_period') ?? '', required: false, hint: 'Leave empty to use each subscription’s current billing period.' })}<button class="secondary" type="submit">Show previews</button></form>
      ${table(['Subscription', 'Period', 'State', 'Subtotal$', 'Tax$', 'Total$', 'Review'], c.upcoming.map((row: any) => [h`<a href="${row.sourcePath}">${row.externalId || `Subscription from ${formatDate(row.startDate)}`}</a>`, formatPeriod(row.period.start, row.period.end), tag(row.state === 'unavailable' ? 'Unavailable' : row.state === 'issued' ? 'Issued' : row.state === 'shadow' ? 'Shadow' : 'Preview'), row.subtotalCents === null ? '—' : cents(row.subtotalCents), row.taxCents === null ? '—' : cents(row.taxCents), row.totalCents === null ? '—' : cents(row.totalCents), row.reason === 'previous_biller_period' ? 'Previous biller owns this period.' : row.reason === 'subscription_not_in_period' ? 'Outside service dates.' : row.exceptions.map((e: any) => e.message).join(' · ') || 'No calculation exceptions.']), { empty: 'No subscriptions to preview.' })}
    </section>` : ''}
    ${customerBillingRecordSection(c,actor)}${newSubscription}
    ${await notesSection(env,actor,c.id,'customer',c.id,`/app/customers/${c.id}#notes`)}
    ${certificateSection(c, actor)}
    ${chargeSection(c, named, actor, today)}
    <section class="card" aria-labelledby="money"><h2 id="money">Invoices and payments</h2>
      ${table(['Invoice', 'Issued', 'Due', 'Total$', 'Credited$', 'Paid$', 'Written off$', 'Owed$'], ledger.invoices.map((i: any) => [canRead(actor, 'invoices') ? h`<a href="/app/invoices/${i.id}">${i.number}</a>` : i.number, formatDate(i.issue_date), formatDate(i.due_date), cents(i.total_cents), cents(i.credited_cents), cents(i.paid_cents), cents(i.written_off_cents), cents(i.balance_cents)]), { empty: 'No issued invoices yet.' })}
      ${ledger.payments.length ? table(['Payment', 'Received', 'Amount$', 'Unallocated$'], ledger.payments.map((p: any) => [h`<span id="payment-${p.id}">${p.reference}</span> ${canRead(actor, 'payments') ? metadataLink('payment',p.id) : ''}`, formatDate(p.received_on), cents(p.amount_cents), cents(p.unallocated_cents)])) : ''}</section>
    ${await balanceSection(env, actor, id)}
    <section class="card" aria-labelledby="credits"><h2 id="credits">Credit notes</h2><p>Carried historical correction credit available: ${cents(ledger.carriedUsageCredits.reduce((n:number,c:any)=>n+c.availableCents,0))}. It applies to later invoices; no cash refund is recorded.</p>${table(['Credit note', 'Invoice', 'Amount$', 'Reason'], ledger.credits.map((credit: any) => [credit.number, canRead(actor, 'invoices') ? h`<a href="/app/invoices/${credit.invoice_id}">${ledger.invoices.find((invoice: any) => invoice.id === credit.invoice_id)?.number}</a>` : ledger.invoices.find((invoice: any) => invoice.id === credit.invoice_id)?.number, cents(credit.amount_cents), credit.reason]), { empty: 'No credit notes.' })}</section>
    <section class="card" aria-labelledby="ents"><h2 id="ents">Entitlements</h2>${c.entitlements.length ? h`<ul class="explain">${c.entitlements.map((e: any) => h`<li>${tag(e.allowed ? 'Allowed' : 'Denied')} <strong>${e.feature}</strong><ul>${e.paths.flatMap((path: any) => path.steps).map((step: string) => h`<li>${step}</li>`)}</ul></li>`)}</ul>` : h`<p class="empty">No features granted. Products grant features in the Catalog.</p>`}</section>
    <section class="card" aria-labelledby="contacts"><h2 id="contacts">Billing contacts</h2>${table(['Name', 'Email', 'Role'], c.contacts.map((x: any) => [x.name, x.email, x.role]), { empty: 'No extra contacts.' })}
      ${can(actor, 'records') ? form('contact.add', `/app/customers/${c.id}`, h`${hidden('customer', c.id)}${field('Name', 'name')}${field('Email', 'email', { type: 'email' })}${field('Role', 'role', { value: 'billing', required: false })}`, 'Add contact', { layout: 'columns', secondary: true }) : ''}</section>
    ${c.incumbentHistory.documents.length || c.incumbentHistory.records.length ? h`<section class="card" aria-labelledby="hist"><h2 id="hist">History from Stripe</h2><p class="hint">Original references and amounts from the previous biller. This history is read-only; it cannot be approved or issued.</p>
      <dl class="figures"><div><dt>Stripe invoiced</dt><dd>${cents(c.incumbentHistory.totals.invoicedCents)}</dd></div><div><dt>Stripe credits</dt><dd>${cents(c.incumbentHistory.totals.creditedCents)}</dd></div><div><dt>Stripe payments</dt><dd>${cents(c.incumbentHistory.totals.paymentsCents)}</dd></div><div><dt>Stripe refunds</dt><dd>${cents(c.incumbentHistory.totals.refundsCents)}</dd></div><div><dt>Stripe remaining</dt><dd>${cents(c.incumbentHistory.totals.remainingCents)}</dd></div></dl>
      ${c.incumbentHistory.documents.map((i:any)=>h`<article id="history-${i.id}"><h3>${i.document_kind==='credit-note'?'Credit note':'Invoice'} ${i.number||i.provider_ref}</h3><p>${i.provider} · ${i.provider_ref} · ${i.status} · ${cents(i.total_cents)} · remaining at capture ${cents(i.remaining_cents)}</p><p>${i.issue_date?formatDate(i.issue_date):'Finalization date not captured'} · ${formatPeriod(i.period_start,i.period_end)}</p>${details({lines:i.lines},'Typed source facts')}</article>`)}
      ${c.incumbentHistory.records.map((r:any)=>h`<article id="history-${r.id}"><h3>${r.kind.replaceAll('-',' ')} · ${r.provider_ref}</h3><p>${r.provider} · ${formatDate(r.occurred_on)} · ${r.status}${r.amount_cents===null?'':h` · ${cents(r.amount_cents)}`}</p>${r.timeline?details(r.timeline,'Subscription timeline'):''}</article>`)}
    </section>` : ''}
    ${importedCollectionsSection(c,actor)}
    ${can(actor, 'records') ? h`<section class="card" aria-labelledby="edit"><h2 id="edit">Edit details</h2>${form('customer.update', `/app/customers/${c.id}`, h`${hidden('customer', c.id)}${hidden('revision', c.revision)}${field('Name', 'name', { value: c.name })}${field('Billing email', 'billing_email', { type: 'email', value: c.billing_email })}${field('Billing address', 'address', { value: c.address, required: false })}${check('Tax exempt', 'tax_exempt', { checked: !!c.tax_exempt })}${field('Exemption certificate reference', 'tax_exempt_ref', { value: c.tax_exempt_ref, required: false })}${languageSelect(c.language)}${customerInvoiceForm(c)}`, 'Save details', { layout: 'columns', secondary: true })}</section>` : ''}`, { current: '/app/customers', url })
}

const previewTable = (lines: any[]): Html => table(['Charge', 'From', 'To', 'Amount$'], lines.map(line => [line.description, formatDate(line.periodStart), formatDate(line.periodEnd ? addDays(line.periodEnd, -1) : null), cents(line.amountCents)]), { empty: 'No fixed or seat charges.' })

export async function subscriptionPage(env: Bindings, actor: Actor, id: string, url: URL) {
  const s = await subscriptionDetail(env, actor, id)
  const today = new Date().toISOString().slice(0, 10)
  const approver = actor.kind === 'member' && can(actor, 'approve'), records = can(actor, 'records')
  const trialDay = localDate(clockInstant(env), (await requireBusiness(env)).timezone)
  const open = s.items.filter((i: any) => !i.effective_to)
  const prices = records || can(actor,'draft')&&canRead(actor,'catalog') ? await all(env, "SELECT p.id,p.currency, pr.name, p.version, p.kind, p.unit_amount, p.pricing_model, p.nickname,b.interval_unit,b.interval_count,b.billing_timing FROM nc_prices p JOIN nc_products pr ON pr.id = p.product_id LEFT JOIN nc_price_intervals b ON b.price_id=p.id WHERE p.status = 'active' AND p.kind <> 'unit' ORDER BY pr.name, p.version DESC") : []
  return page('Subscription', actor, h`<p class="crumbs"><a href="/app/customers/${s.customer_id}">${s.customer_name}</a></p><h1>Subscription ${s.external_id ? h`<span>${s.external_id}</span>` : ''}</h1><p>${metadataLink('subscription',s.id)}${canRead(actor,'invoices')?h` · <a href="/app/prepaid/${s.id}">Prepaid credits</a>`:''}</p>
    <section class="card summary"><dl class="figures"><div><dt>Status</dt><dd>${tag(subscriptionState(s, today))}</dd></div><div><dt>Started</dt><dd>${formatDate(s.start_date)}</dd></div>
      <div><dt>Billing day</dt><dd>${s.anchor_day}</dd></div><div><dt>Trial ends</dt><dd>${formatDate(s.trial_end)}</dd></div><div><dt>Ends</dt><dd>${formatDate(s.end_date)}</dd></div><div><dt>Contract term</dt><dd>${s.contract_term_months?`${s.contract_term_months} months`:'Evergreen'}</dd></div><div><dt>Anniversary anchor</dt><dd>${formatDate(s.billing_anchor_date)}</dd></div>
      ${s.cutover_start ? h`<div><dt>Billed by Nectar from</dt><dd>${formatDate(s.cutover_start)}</dd></div>` : ''}</dl>
      ${s.billing_mode === 'shadow' ? h`<p class="hint">Moved in from Stripe. Nectar rates it in shadow for comparison and issues nothing until the owner adopts it under Move in.</p>` : ''}
      ${details({ 'Internal id': s.id, Revision: s.revision, 'Provider reference': s.provider_ref ?? '—', 'Provider schedule': s.provider_schedule_ref ?? '—', 'Provider collection': s.provider_collection ?? '—' })}</section>
    ${trialSection(s, actor, trialDay)}
    ${await trialCollectionSection(env,actor,s)}
    <section class="card" aria-labelledby="items"><h2 id="items">Plan</h2>${table(['Price', 'Quantity$', 'From', 'Until'], s.items.map((i: any) => [`${i.product_name}${i.nickname ? ` — ${i.nickname}` : ''} v${i.version} (${priceRate(i)} · ${intervalLabel(i)})`, i.quantity, formatDate(i.effective_from), formatDate(i.effective_to)]))}</section>
    ${await upcomingSection(env,actor,s,url)}
    ${addonSection(s, prices, actor)}
    ${lifecycleSection(s, actor)}
    ${renewalSection(s,actor)}
    ${contractSection(s,actor,await all(env,"SELECT p.*,pr.name AS product_name FROM nc_prices p JOIN nc_products pr ON pr.id=p.product_id WHERE p.status='active' ORDER BY pr.name,p.version"))}
    <section class="card" aria-labelledby="exceptions"><h2 id="exceptions">Contract exceptions</h2>
      ${table(['Exception', 'From', 'Until', 'Status', ''], s.amendments.map((a: any) => [h`${a.kind === 'discount_percent' ? `${a.value}% discount` : a.kind === 'fixed_credit' ? `$${a.value} one-time credit` : `Contract price $${a.value}`}${a.note ? ` — ${a.note}` : ''}${a.clause ? details({ Clause: a.clause }, 'Clause') : ''}`, formatDate(a.effective_from), formatDate(a.effective_to), tag(a.status === 'proposed' ? 'Proposed' : a.status === 'approved' ? 'Approved' : 'Rejected'),
        a.status === 'proposed' && approver ? h`<div class="actions">${a.kind === 'price_override' && (!a.prepared_by_id || a.prepared_by_id === actor.id) ? h`<p class="hint">${!a.prepared_by_id ? 'This older contract price has no saved preparer identity. Reject it and propose it again.' : 'Another approver must approve this contract price. You prepared it.'}</p>` : form('amendment.decide', `/app/subscriptions/${s.id}`, h`${hidden('amendment', a.id)}${hidden('decision', 'approved')}`, 'Approve')}${form('amendment.decide', `/app/subscriptions/${s.id}`, h`${hidden('amendment', a.id)}${hidden('decision', 'rejected')}`, 'Reject', { secondary: true })}</div>` : '']), { empty: 'No contract exceptions.' })}
      ${records ? form('amendment.propose', `/app/subscriptions/${s.id}`, h`${hidden('subscription', s.id)}${select('Kind', 'kind', [{ value: 'discount_percent', label: 'Discount (%) on fixed and seat charges' }, { value: 'fixed_credit', label: 'One-time credit ($)' }, { value: 'price_override', label: 'Contract price for one plan price' }], 'discount_percent')}
        ${select('Plan price (contract price only)', 'price', s.items.map((i: any) => ({ value: i.price_id, label: `${i.product_name} v${i.version}` })), '', { required: false, blank: '—' })}${field('Value', 'value')}${field('From', 'effective_from', { type: 'date' })}${field('Until (optional)', 'effective_to', { type: 'date', required: false })}${field('Note', 'note', { required: false })}${area('Contract clause', 'clause', '', false, 2)}`, 'Propose exception', { layout: 'columns', secondary: true }) : ''}</section>
    ${planChangeSection(s,actor,open,prices)}
    <section class="card" aria-labelledby="changes"><h2 id="changes">Plan and quantity changes</h2>
      ${s.changes.length ? s.changes.map((c: any) => h`<article class="change"><h3>${c.status === 'draft' ? 'Prepared change' : c.status === 'approved' ? 'Approved change' : 'Discarded change'} effective ${formatDate(c.effective_date)} ${tag(c.status === 'draft' ? 'Draft' : c.status === 'approved' ? 'Approved' : 'Rejected')}</h3>
        <div class="compare"><div><h4>Period ${formatPeriod(c.preview.period?.start, c.preview.period?.end)}, as it is: ${cents(c.preview.before?.cents)}</h4>${previewTable(c.preview.before?.lines ?? [])}</div>
        <div><h4>With this change: ${cents(c.preview.after?.cents)}</h4>${previewTable(c.preview.after?.lines ?? [])}</div></div>
        <p>Next full period from ${formatDate(c.preview.nextPeriod?.period?.start)}: ${cents(c.preview.nextPeriod?.cents)}</p>
        ${c.status === 'draft' && approver ? h`<div class="actions">${s.items.find((i: any) => i.id === c.item_id)?.price_id !== c.new_price_id && (!c.prepared_by_id || c.prepared_by_id === actor.id) ? h`<p class="hint">${!c.prepared_by_id ? 'This older price switch has no saved preparer identity. Discard it and preview it again.' : 'Another approver must approve this price switch. You prepared it.'}</p>` : form('change.decide', `/app/subscriptions/${s.id}`, h`${hidden('change', c.id)}${hidden('decision', 'approved')}`, 'Approve this preview')}${form('change.decide', `/app/subscriptions/${s.id}`, h`${hidden('change', c.id)}${hidden('decision', 'discarded')}`, 'Discard', { secondary: true })}</div>` : ''}
        ${details({ Change: c.id, 'Prepared by': personName(actor, c.created_by), 'Decided by': personName(actor, c.decided_by), 'Subscription revision': c.subscription_revision })}</article>`) : h`<p class="empty">No changes prepared.</p>`}
      ${records && open.length && prices.length ? form('change.prepare', `/app/subscriptions/${s.id}`, h`${hidden('subscription', s.id)}${select('Change', 'item', open.map((i: any) => ({ value: i.id, label: `${i.product_name} v${i.version} × ${i.quantity}` })), open[0].id)}
        ${select('New price', 'price', prices.map((p: any) => ({ value: p.id, label: `${p.name}${p.nickname ? ` — ${p.nickname}` : ''} v${p.version}: ${priceRate(p)}` })), open[0].price_id)}${field('Seats', 'quantity', { type: 'number', value: open[0].quantity })}${field('Effective date', 'effective_date', { type: 'date' })}`, 'Preview change', { layout: 'columns' }) : ''}
      ${approver && !s.end_date ? form('subscription.end', `/app/subscriptions/${s.id}`, h`${hidden('subscription', s.id)}${field('End the subscription on', 'end_date', { type: 'date' })}`, 'End subscription', { layout: 'columns', secondary: true }) : ''}</section>
    <section class="card" aria-labelledby="invoices"><h2 id="invoices">Invoices</h2>${table(['Invoice', 'Period', 'Status', 'Total$'], s.invoices.map((i: any) => [canRead(actor, 'invoices') ? h`<a href="/app/invoices/${i.id}">${i.number ?? 'Draft'}</a>` : (i.number ?? 'Draft'), formatPeriod(i.period_start, i.period_end), tag(i.status === 'issued' ? 'Issued' : i.status === 'approved' ? 'Approved' : i.status === 'shadow' ? 'Shadow' : 'Draft'), cents(i.total_cents)]), { empty: 'No invoices yet.' })}</section>`, { current: '/app/customers', url })
}
