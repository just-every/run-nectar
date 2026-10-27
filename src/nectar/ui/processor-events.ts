import type { Bindings } from '../../auth.server'
import type { Actor } from '../actor'
import { processorEvents } from '../processor-events'
import { cents, h, page, table } from './html'
export async function processorEventsPage(env:Bindings,actor:Actor,url:URL) {
 const data=await processorEvents(env,actor,url.searchParams.get('customer')??undefined)
 return page('Processor reconciliation',actor,h`<p class="crumbs"><a href="/app/receivables">Receivables</a> · <a href="/app/reports/settlements">Available settlements</a></p>
 <h1>Processor reconciliation</h1>
 <section class="card"><h2>Event outcomes</h2>${table(['Event','Type','Outcome','Invoice'],data.events.map(row=>[h`<span id="${row.id}">${row.event_ref}</span>`,row.event_type,`${row.status}${row.error_code?` · ${row.error_code}`:''}`,row.invoice_id?h`<a href="/app/invoices/${row.invoice_id}">Open invoice</a>`:'—']))}</section>
 <section class="card"><h2>Balance transactions</h2>${table(['Transaction','Source','Gross','Fee','Net','State','Payout'],data.transactions.map(row=>[row.transaction_ref,row.source_ref,cents(row.amount_cents,row.currency.toUpperCase()),cents(row.fee_cents,row.currency.toUpperCase()),cents(row.net_cents,row.currency.toUpperCase()),row.status,row.payout_ref??'—']))}</section>
 <section class="card"><h2>Customer cash balance</h2>${table(['Customer','Currency','Available'],data.cashBalances.map(row=>[h`<a href="/app/customers/${row.customer_id}">Open customer</a>`,row.currency.toUpperCase(),cents(row.amount_cents,row.currency.toUpperCase())]))}
 ${table(['Transfer transaction','Type','Amount','Ending balance'],data.cashTransactions.map(row=>[row.transaction_ref,row.type,cents(row.amount_cents,row.currency.toUpperCase()),cents(row.ending_balance_cents,row.currency.toUpperCase())]))}
 ${table(['Application','Invoice','Amount','Outcome'],data.cashApplications.map(row=>[row.transfer_ref,h`<a href="/app/invoices/${row.invoice_id}">Open invoice</a>`,cents(row.amount_cents,row.currency.toUpperCase()),row.status]))}</section>
 <section class="card"><h2>Refunds, disputes and returns</h2>${table(['Reference','Kind','Amount','State','Reason'],data.objects.map(row=>[row.object_ref,row.kind,cents(row.amount_cents,row.currency.toUpperCase()),row.status,row.code??'—']))}</section>`,{current:'/app/receivables',url})
}
