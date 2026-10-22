import type { Bindings } from '../../auth.server'
import { can, type Actor } from '../actor'
import { insist, type Row } from '../core'
import { decimalText } from '../decimal'
import { readPrepaidRefunds } from '../prepaid-refund-records'
import { cents, check, details, field, form, h, hidden, page } from './html'

function refundCard(actor: Actor,row:Row,back:string){
  const q=row.quote,approver=actor.kind==='member'&&can(actor,'approve')
  return h`<article id="refund-${row.id}"><h3>Unused paid credit refund · ${row.status}</h3><p>${q.kind==='money'?cents(q.amountN):`${decimalText(BigInt(q.amountN))} units`} · ${cents(q.amountCents)} back to the original captured card. Purchased liability reverses by this amount; recognized revenue is unchanged. No future invoice credit is created.</p><p><a href="/app/invoices/${q.invoice}">Original purchase</a> · <a href="${row.source}">Exact refund source</a></p>${details({quote:q,preparedBy:row.preparedBy,approvedBy:row.approvedBy,proof:row.proof},'Exact refund and processor evidence')}
  ${approver&&row.status==='pending'?h`${form('prepaid.refund.decide',back,h`${hidden('refund',row.id)}${hidden('basis_hash',row.basis)}${hidden('decision','approved')}${actor.role==='owner'?check('I am the sole active owner/finance approver and explicitly confirm this exact refund.','confirm_single'):''}`,'Approve one refund',{primary:true})}${form('prepaid.refund.decide',back,h`${hidden('refund',row.id)}${hidden('decision','rejected')}`,'Reject refund',{secondary:true})}`:''}
  ${approver&&['claimed','uncertain'].includes(row.status)?form('prepaid.refund.reconcile',back,hidden('refund',row.id),'Check existing refund',{secondary:true}):''}
  ${row.refundRef?h`<p>Processor refund ${row.refundRef}. ${row.status==='refunded'?'Confirmed cash returned and liability reversed.':'Refund remains unconfirmed; the unused lot stays reserved.'}</p>`:''}</article>`
}
export async function prepaidRefundsSection(env:Bindings,actor:Actor,subscription:string,state:Row){
  if(actor.kind!=='member'||!can(actor,'approve'))return ''
  const rows=await readPrepaidRefunds(env,actor,subscription),back=`/app/prepaid/${subscription}`
  return h`<section class="card"><h2>Refund unused paid credit</h2><p>The owner prepares the complete unused part of a verified card-funded purchase. Independent approval reserves that lot before one refund attempt. An unknown outcome keeps it reserved and is checked without another refund. Pending usage or changed purchase evidence refuses preparation.</p>${rows.map(row=>refundCard(actor,row,back))}
  ${actor.role==='owner'?state.grants.filter((grant:Row)=>grant.source==='purchase'&&grant.remainingN>0&&!grant.refundPending).map((grant:Row)=>form('prepaid.refund.prepare',back,h`${hidden('grant',grant.id)}<p>Unused purchased ${grant.kind==='money'?cents(grant.remainingN):`${decimalText(BigInt(grant.remainingN))} units`}; paid liability ${cents(grant.liabilityCents)}.</p>${field('Refund reason','reason')}`,'Review unused card refund',{secondary:true})):''}</section>`
}
export async function prepaidRefundSourcePage(env:Bindings,actor:Actor,id:string,url:URL){
  const row=(await readPrepaidRefunds(env,actor)).find(row=>row.id===id);insist(row,'prepaid_refund_not_found',404)
  return page('Prepaid refund',actor,h`<h1>Prepaid refund</h1><p><a href="/app/prepaid/${row.quote.subscription}">Prepaid ledger</a></p><section class="card">${refundCard(actor,row,`/app/prepaid/${row.quote.subscription}`)}</section>`,{url,current:'/app/customers'})
}
