import type { Bindings } from '../../auth.server'
import { can, canRead, type Actor } from '../actor'
import { insist, type Row } from '../core'
import { decimalText } from '../decimal'
import { readPrepaidRefunds } from '../prepaid-refund-records'
import { cents, check, details, field, form, h, hidden, page } from './html'

function refundCard(actor: Actor,row:Row,back:string){
  const q=row.quote,approver=!!q&&actor.kind==='member'&&can(actor,'approve')
  return h`<article id="refund-${row.id}"><h3>Unused paid credit refund · ${row.status}</h3><p>${row.kind==='money'?cents(row.amountN):`${decimalText(BigInt(row.amountN))} ${row.unitLabel||'units'}`} · ${cents(row.amountCents)} requested back to the original captured card.</p><p>${row.status==='refunded'?'Confirmed cash returned and purchased liability reversed. Recognized revenue is unchanged. No future invoice credit is created.':'A request does not confirm returned cash. Approved and uncertain requests reserve the unused lot until the processor outcome is known.'}</p>
    <p><a href="/app/invoices/${row.invoice}">Original purchase ${row.purchaseNumber||row.invoice}</a> · Receipt ${row.receiptReference||row.payment}${row.credit?h` · Numbered credit ${row.creditNumber||row.credit}`:''} · <a href="${row.source}">Exact refund source</a></p>
    ${details({request:row.id,reasonCategory:row.reasonCategory,preparedBy:row.preparedBy,approvedBy:row.approvedBy,approvalMode:row.approvalMode,preparedAt:row.preparedAt,approvedAt:row.approvedAt,claimedAt:row.claimedAt,refundedOn:row.refundedOn},'Refund lifecycle')}
    ${q?h`${details({quote:q,reason:row.reason},'Frozen approval quote and reason')}<p><a href="${row.source}/proof" download>Download processor proof (audited; available after a recorded outcome)</a></p>`:''}
    ${approver&&row.status==='pending'?h`${form('prepaid.refund.decide',back,h`${hidden('refund',row.id)}${hidden('basis_hash',row.basis)}${hidden('decision','approved')}${actor.role==='owner'?check('I am the sole active owner/finance approver and explicitly confirm this exact refund.','confirm_single'):''}`,'Approve one refund',{primary:true})}${form('prepaid.refund.decide',back,h`${hidden('refund',row.id)}${hidden('decision','rejected')}`,'Reject refund',{secondary:true})}`:''}
    ${approver&&['claimed','uncertain'].includes(row.status)?form('prepaid.refund.reconcile',back,hidden('refund',row.id),'Check existing refund',{secondary:true}):''}
    ${row.refundRef?h`<p>Processor refund ${row.refundRef}.</p>`:''}</article>`
}
export async function prepaidRefundsSection(env:Bindings,actor:Actor,subscription:string,state:Row){
  if(!canRead(actor,'payments')||!canRead(actor,'invoices'))return ''
  const rows=await readPrepaidRefunds(env,actor,subscription),back=`/app/prepaid/${subscription}`
  return h`<section class="card"><h2>Refund unused paid credit</h2><p>The owner prepares the complete unused part of a verified card-funded purchase. Independent approval reserves that lot before one refund attempt. An unknown outcome keeps it reserved and is checked without another refund. Pending usage or changed purchase evidence refuses preparation.</p><p><a href="/app/prepaid/refunds?subscription=${subscription}">All refund requests</a></p>${rows.map(row=>refundCard(actor,row,back))}
  ${actor.kind==='member'&&actor.role==='owner'?state.grants.filter((grant:Row)=>grant.source==='purchase'&&grant.remainingN>0&&!grant.refundPending).map((grant:Row)=>form('prepaid.refund.prepare',back,h`${hidden('grant',grant.id)}<p>Unused purchased ${grant.kind==='money'?cents(grant.remainingN):`${decimalText(BigInt(grant.remainingN))} units`}; paid liability ${cents(grant.liabilityCents)}.</p>${field('Refund reason','reason')}`,'Review unused card refund',{secondary:true})):''}</section>`
}
export async function prepaidRefundListPage(env:Bindings,actor:Actor,url:URL){
  const subscription=url.searchParams.get('subscription')??undefined,customer=url.searchParams.get('customer')
  const rows=(await readPrepaidRefunds(env,actor,subscription)).filter(row=>!customer||row.customer===customer)
  return page('Prepaid refunds',actor,h`<h1>Prepaid refunds</h1><p>Every request remains visible through its typed lifecycle. Approval narratives and processor attachments have separate custody.</p>${can(actor,'export')?h`<p><a href="/app/exports/prepaid-refunds.csv${url.search}">Export refund lifecycle CSV</a></p>`:''}<section class="card">${rows.length?rows.map(row=>refundCard(actor,row,url.pathname+url.search)):h`<p>No refund requests.</p>`}</section>`,{url,current:'/app/customers'})
}
export async function prepaidRefundSourcePage(env:Bindings,actor:Actor,id:string,url:URL){
  const row=(await readPrepaidRefunds(env,actor)).find(row=>row.id===id);insist(row,'prepaid_refund_not_found',404)
  const back=`/app/prepaid/refunds?subscription=${row.subscription}`
  return page('Prepaid refund',actor,h`<h1>Prepaid refund</h1><p><a href="${back}">All refund requests</a></p><section class="card">${refundCard(actor,row,back)}</section>`,{url,current:'/app/customers'})
}
