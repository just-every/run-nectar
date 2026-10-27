import type { Bindings } from '../../auth.server'
import type { Actor } from '../actor'
import { Input } from '../input'
import { previewProcessorCashReturn } from '../processor-cash-return'
import { cents, check, field, form, h, hidden, type Html } from './html'
import type { Row } from '../core'

export async function cashReturnsSection(env:Bindings,actor:Actor,url:URL,balances:Row[],returns:Row[]):Promise<Html> {
 const owner=actor.kind==='member'&&actor.role==='owner',approver=actor.kind==='member'&&['owner','finance'].includes(actor.role??'')
 let quote:Row|null=null
 if(owner&&url.searchParams.has('return_amount'))quote=await previewProcessorCashReturn(env,actor,Input.of({
  customer:url.searchParams.get('return_customer'),account_ref:url.searchParams.get('return_account'),
  currency:url.searchParams.get('return_currency'),amount:url.searchParams.get('return_amount'),
 }))
 return h`<section class="card processor-reconciliation"><h2>Return cash to the sender</h2>
 ${owner?balances.filter(row=>row.amount_cents>0).map(row=>h`<form method="get" action="/app/processor-events">
  ${hidden('customer',row.customer_id)}${hidden('return_customer',row.customer_id)}${hidden('return_account',row.account_ref)}${hidden('return_currency',row.currency)}
  ${field(`Return amount (${row.currency.toUpperCase()})`,'return_amount',{value:(row.amount_cents/100).toFixed(2)})}<button type="submit">Review return</button></form>`):''}
 ${quote?form('processor.cash.return.prepare',`/app/processor-events?customer=${quote.customer}`,h`
  <p>Return ${cents(quote.amountCents,quote.currency.toUpperCase())} from the customer's received cash. ${quote.needsSecondApprover?'A different finance approver must authorize this return.':'One owner approval is required.'}</p>
  ${hidden('customer',quote.customer)}${hidden('account_ref',quote.accountRef)}${hidden('currency',quote.currency)}${hidden('amount',(quote.amountCents/100).toFixed(2))}${hidden('basis',quote.basis)}
  ${check('Save this exact return for approval','confirm')}`,'Save reviewed return'):''}
 ${returns.map(row=>h`<article><h3>${cents(row.amountCents,row.currency.toUpperCase())} · ${row.status}</h3>
  <p>${row.refundRef?`Processor reference: ${row.refundRef}`:'No processor refund has been requested.'}</p>
  ${approver&&row.status==='prepared'?form('processor.cash.return.execute',`/app/processor-events?customer=${row.customer}`,h`${hidden('request',row.id)}${hidden('basis',row.basis)}${check('Authorize this reviewed return through the processor','confirm')}`,'Approve return'):''}
  ${approver&&!['prepared','superseded','stopped'].includes(row.status)?form('processor.cash.return.reconcile',`/app/processor-events?customer=${row.customer}`,hidden('request',row.id),'Check processor result',{secondary:true}):''}</article>`)}
 ${!returns.length&&!balances.some(row=>row.amount_cents>0)?h`<p class="empty">No cash is awaiting a return.</p>`:''}</section>`
}
