import type { Bindings } from '../../auth.server'
import { can, canRead, type Actor } from '../actor'
import { processorEvents } from '../processor-events'
import { openInvoices } from '../receivables'
import { all, type Row } from '../core'
import { importedCashCandidates } from '../processor-cash-imported'
import { cashReturnsSection } from './processor-cash-returns'
import { cents, check, field, form, h, hidden, page, select, table } from './html'
export async function processorEventsPage(env:Bindings,actor:Actor,url:URL) {
 const data=await processorEvents(env,actor,url.searchParams.get('customer')??undefined)
 const bindings=await all(env,'SELECT * FROM nc_stripe_customer_bindings')
 const invoices:Row[]=[...await openInvoices(env),...(await Promise.all(bindings.map(binding=>importedCashCandidates(env,binding)))).flat().map((row):Row=>({...row,currency:row.currency.toUpperCase()}))]
 const originals=actor.kind==='member'&&actor.role==='owner'?await all(env,`SELECT i.id,i.number,i.customer_id,i.remaining_cents,b.account_ref FROM nc_incumbent_invoices i JOIN nc_stripe_customer_bindings b ON b.customer_id=i.customer_id JOIN nc_customers c ON c.id=i.customer_id
  WHERE i.provider='stripe' AND i.document_kind='invoice' AND i.status='open' AND i.remaining_cents>0 AND c.erased_at IS NULL
  AND NOT EXISTS(SELECT 1 FROM nc_processor_cash_imported_takeovers t WHERE t.invoice_id=i.id) AND NOT EXISTS(SELECT 1 FROM nc_imported_collections r WHERE r.invoice_id=i.id)`):[]
 return page('Processor reconciliation',actor,h`<p class="crumbs">${canRead(actor,'customers')?h`<a href="/app/receivables">Receivables</a>`:''}${canRead(actor,'reports')?h` · <a href="/app/reports/settlements">Available settlements</a>`:''}</p>
 <h1>Processor reconciliation</h1>
 ${await cashReturnsSection(env,actor,url,data.cashBalances,data.cashReturns)}
 <section class="card processor-reconciliation"><h2>Unapplied bank transfers</h2>${data.unmatched.map(row=>{
  const choices=invoices.filter(invoice=>invoice.customer_id===row.customer_id&&invoice.currency.toLowerCase()===row.currency)
  return h`<details id="${row.id}"><summary>${cents(row.amount_cents,row.currency.toUpperCase())} · ${new Date(row.occurred_at).toISOString().slice(0,10)} · ${row.reference||'No reference'}</summary>
   <dl><dt>Age</dt><dd>${row.ageDays} days</dd><dt>Processor return limit</dt><dd>${row.daysLeft} days left · ${new Date(row.returnDeadline).toISOString().slice(0,10)}</dd><dt>Sender</dt><dd>${row.sender||'Not supplied by processor'}</dd><dt>Reference</dt><dd>${row.reference||'Not supplied by processor'}</dd></dl>
   ${can(actor,'receivables')&&actor.kind==='member'&&choices.length?form('processor.cash.allocate',`/app/processor-events?customer=${row.customer_id}`,h`${hidden('customer',row.customer_id)}${hidden('account_ref',row.account_ref)}${hidden('transfer_ref',row.transfer_ref)}${select('Invoice','invoice',choices.map(invoice=>({value:invoice.id,label:`${invoice.number} · ${cents(invoice.balance_cents)}`})),choices[0].id)}${field('Amount','amount',{value:(Math.min(row.amount_cents,choices[0].balance_cents)/100).toFixed(2)})}<label><input type="checkbox" name="confirm" required> Apply these received funds to this invoice</label>`,'Apply cash') : ''}</details>`
 })}${!data.unmatched.length?h`<p class="empty">No unapplied transfers.</p>`:''}</section>
 <section class="card processor-reconciliation" id="bank-payouts"><h2>Matched bank payouts</h2>${table(['Payout','Received','Bank deposit'],data.bankMatches.map(row=>[row.payout_ref,row.received_on,cents(row.amount_cents)]),{empty:'No bank deposits matched to processor payouts.'})}</section>
 <section class="card processor-reconciliation"><h2>Event outcomes</h2>${table(['Event','Type','Outcome','Invoice'],data.events.map(row=>[h`<span id="${row.id}">${row.event_ref}</span>`,row.event_type,`${row.status}${row.error_code?` · ${row.error_code}`:''}`,row.invoice_id?h`<a href="/app/invoices/${row.invoice_id}">Open invoice</a>`:'—']))}</section>
 <section class="card processor-reconciliation"><h2>Balance transactions</h2>${table(['Transaction','Source','Gross','Fee','Net','State','Payout'],data.transactions.map(row=>[row.transaction_ref,row.source_ref,cents(row.amount_cents,row.currency.toUpperCase()),cents(row.fee_cents,row.currency.toUpperCase()),cents(row.net_cents,row.currency.toUpperCase()),row.status,row.payout_ref??'—']))}</section>
 <section class="card processor-reconciliation"><h2>Customer cash balance</h2>${table(['Customer','Currency','Available'],data.cashBalances.map(row=>[canRead(actor,'customers')?h`<a href="/app/customers/${row.customer_id}">Open customer</a>`:row.customer_id,row.currency.toUpperCase(),cents(row.amount_cents,row.currency.toUpperCase())]))}
 ${table(['Transfer transaction','Type','Amount','Ending balance'],data.cashTransactions.map(row=>[row.transaction_ref,row.type,cents(row.amount_cents,row.currency.toUpperCase()),cents(row.ending_balance_cents,row.currency.toUpperCase())]))}
 ${table(['Application','Invoice','Amount','Outcome'],data.cashApplications.map(row=>[row.transfer_ref,h`<a href="/app/invoices/${row.invoice_id}">Open invoice</a>`,cents(row.amount_cents,row.currency.toUpperCase()),row.status]))}</section>
 <section class="card processor-reconciliation"><h2>Moved-in invoice cash</h2>
 ${originals.map(row=>h`<details><summary>Take over ${row.number} · ${cents(row.remaining_cents)}</summary>${form('processor.cash.imported.prepare',`/app/processor-events?customer=${row.customer_id}`,h`${hidden('invoice',row.id)}${hidden('account_ref',row.account_ref)}`,'Review cash collection')}</details>`)}
 ${data.importedCashTakeovers.map(row=>h`<article><h3>Original invoice · ${cents(row.amount_cents)} · ${row.status}</h3>${actor.role==='owner'&&row.prepared_by===actor.id&&row.status!=='active'?form('processor.cash.imported.confirm',`/app/processor-events?customer=${row.customer_id}`,h`${hidden('takeover',row.id)}${hidden('basis_hash',row.basis_hash)}${check('Stop automatic advancement of this original invoice','disable_auto_advance')}${check('Authorize applying this customer cash to the original invoice','confirm')}`,row.status==='disabling'?'Check collector takeover':'Confirm collector takeover'):''}</article>`)}
 ${table(['Transfer','Original invoice','Amount','Outcome'],data.importedCashApplications.map(row=>[row.transfer_ref,h`<a href="/app/customers/${row.customer_id}">Original invoice history</a>`,cents(row.amount_cents,row.currency.toUpperCase()),row.status]))}</section>
 <section class="card processor-reconciliation"><h2>Refunds, disputes and returns</h2>${table(['Reference','Kind','Amount','State','Reason'],data.objects.map(row=>[row.object_ref,row.kind,cents(row.amount_cents,row.currency.toUpperCase()),row.status,row.code??'—']))}</section>`,{current:'/app/receivables',url})
}
