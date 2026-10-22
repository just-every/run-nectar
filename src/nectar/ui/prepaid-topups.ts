import type { Bindings } from '../../auth.server'
import { can, type Actor } from '../actor'
import { all, insist, type Row } from '../core'
import { decimalText } from '../decimal'
import { readPrepaidTopupAuthorizations, readPrepaidTopupClaims } from '../prepaid-topup-records'
import { cents, check, details, field, form, h, hidden, page, select, table } from './html'

function authorizationCard(actor: Actor, row: Row, back: string) {
  const q=row.quote, owner=actor.role==='owner'
  const quantity=(n:number)=>q.terms.kind==='money'?cents(n):`${decimalText(BigInt(n))} units`
  return h`<article id="topup-${row.id}"><h3>Automatic top-up · ${row.status}</h3>
    <p>At ${quantity(q.thresholdN)}, purchase ${quantity(q.terms.amountN)} for ${cents(q.amountCents)}. Maximum ${cents(q.periodCapCents)} per calendar month in ${q.timezone}, including unknown attempts.</p>
    <p>${q.card.brand} ending ${q.card.last4} · ${q.startDate} through ${q.endDate} (end exclusive). Grant starts on the captured payment date; its quoted expiry remains ${q.terms.expiresDate??'none'}.</p>
    <p>Account <code style="overflow-wrap:anywhere">${q.accountRef}</code> · Customer <code style="overflow-wrap:anywhere">${q.customerRef}</code>.</p>
    <p>${row.acceptance?`Customer accepted these exact terms at ${new Date(row.acceptedAt).toISOString()}.`:'Waiting for customer acceptance in their signed-in portal.'}</p>
    ${row.source?h`<p><a href="${row.source}">Accepted source and exact quote</a></p>`:''}
    ${details({quote:q,acceptance:row.acceptance,basis:row.basis},'Exact authorization and source')}
    ${row.status==='pending'?h`${form('prepaid.topup.decide',back,h`${hidden('authorization',row.id)}${hidden('basis_hash',row.basis)}${hidden('decision','approved')}${owner?check('I am the sole active owner/finance approver and explicitly confirm this exact customer authorization.','confirm_single'):''}`,'Approve customer-authorized policy',{primary:true})}
      ${form('prepaid.topup.decide',back,h`${hidden('authorization',row.id)}${hidden('basis_hash',row.basis)}${hidden('decision','rejected')}`,'Reject policy',{secondary:true})}`:''}
    ${owner&&['awaiting_customer','pending','active'].includes(row.status)?form('prepaid.topup.revoke',back,hidden('authorization',row.id),'Stop automatic top-ups',{secondary:true}):''}
    ${owner&&row.status==='active'?form('prepaid.topup.run',back,hidden('authorization',row.id),'Evaluate approved balance threshold',{secondary:true}):''}
  </article>`
}

export async function prepaidTopupsSection(env: Bindings, actor: Actor, subscription: string, state: Row) {
  if(actor.kind!=='member'||!can(actor,'approve'))return ''
  const owner=actor.role==='owner',back=`/app/prepaid/${subscription}`
  const rows=await readPrepaidTopupAuthorizations(env,actor,subscription)
  const bindings=owner?await all(env,'SELECT b.account_ref FROM nc_stripe_customer_bindings b JOIN nc_subscriptions s ON s.customer_id=b.customer_id WHERE s.id=? ORDER BY b.account_ref',subscription):[]
  const claims=owner?await readPrepaidTopupClaims(env,actor,subscription):[]
  return h`<section class="card"><h2>Customer-authorized automatic top-ups</h2>
    <p>Customer acceptance and independent human approval must match the same card, account, amount, threshold and monthly cap. The daily job evaluates active policies. Revocation or card replacement ends authorization. Unknown payments are checked without another charge.</p>
    ${rows.map(row=>authorizationCard(actor,row,back))}
    ${owner&&bindings.length&&state.consents.some((row:Row)=>row.status==='active')?form('prepaid.topup.prepare',back,h`
      ${select('Approved purchase request policy','consent',state.consents.filter((row:Row)=>row.status==='active').map((row:Row)=>({value:row.id,label:`${row.terms.kind} · ${cents(row.terms.valueCents)} purchase`})))}
      ${select('Processor account','account_ref',bindings.map(row=>({value:row.account_ref,label:row.account_ref})))}
      ${field('Maximum USD per business calendar month','period_cap')}${field('Authorization starts','start_date',{type:'date',value:state.date})}${field('Authorization ends (exclusive)','end_date',{type:'date'})}
      <p>Preparation creates a quote for the customer to accept in their portal. It creates no payment and activates no automatic policy.</p>`,'Prepare customer authorization',{secondary:true,layout:'columns'}):owner?h`<p>First approve a low-balance purchase request policy and associate this customer with the correct processor account.</p>`:''}
    ${claims.length?h`<h3>Automatic purchase outcomes</h3>${table(['Period','Amount$','Outcome','Purchase'],claims.map(row=>[row.period,cents(row.amount_cents),row.status,row.invoice_id?h`<a href="/app/invoices/${row.invoice_id}">Purchase invoice</a>`:'Reserved']))}
      ${claims.filter(row=>['claimed','uncertain'].includes(row.status)).map(row=>form('prepaid.topup.reconcile',back,hidden('claim',row.id),'Check existing automatic payment',{secondary:true}))}`:''}
  </section>`
}

export async function prepaidTopupSourcePage(env: Bindings, actor: Actor, id: string, url: URL) {
  const row=(await readPrepaidTopupAuthorizations(env,actor)).find(row=>row.id===id)
  insist(row,'topup_authorization_not_found',404)
  return page('Top-up authorization',actor,h`<h1>Top-up authorization</h1><p><a href="/app/prepaid/${row.quote.subscription}">Prepaid credits</a></p><section class="card">${authorizationCard(actor,row,`/app/prepaid/${row.quote.subscription}`)}</section>`,{url,current:'/app/customers'})
}
