import type { Bindings } from '../auth.server'
import { all } from './core'
import { decimalText } from './decimal'
import { customerText } from './locale'
import type { CustomerSession } from './portal-session'
import { portalPrepaidTopupAuthorization } from './prepaid-topup-authorization'
import { h } from './ui/html'

export async function portalTopupLinks(env: Bindings, session: CustomerSession, link: (path:string)=>string) {
  const rows=await all(env,"SELECT id FROM nc_prepaid_topup_authorizations WHERE customer_id=? AND status IN ('awaiting_customer','pending','active') ORDER BY prepared_at,id",session.customer)
  const L=customerText(session.language,session.currency)
  return rows.length?h`<section class="card"><h2>${L.t('portal.topup.heading')}</h2>${rows.map(row=>h`<p><a href="${link(`/portal/prepaid-topups/${row.id}`)}">${L.t('portal.topup.review')}</a></p>`)}</section>`:''
}

export async function portalTopupPage(env: Bindings, request: Request, session: CustomerSession, id: string, link: (path:string)=>string) {
  const source=await portalPrepaidTopupAuthorization(env,request,id),q=source.quote,L=customerText(session.language,session.currency)
  const quantity=(n:number)=>q.kind==='money'?L.money(n):`${L.percent(decimalText(BigInt(n)))} ${L.t('portal.prepaid.units')}`
  const token=new URL(request.url).searchParams.get('session')!
  return h`<h1>${L.t('portal.topup.heading')}</h1><p><a href="${link('/portal/prepaid')}">${L.t('portal.back')}</a></p>
    <section class="card"><h2>${L.t(`portal.topup.status.${source.status}`)}</h2>
      <p>${L.t('portal.topup.terms',{threshold:quantity(q.thresholdN),quantity:quantity(q.grantAmountN),amount:L.money(q.amountCents),cap:L.money(q.periodCapCents),zone:q.timezone})}</p>
      <p>${L.t('portal.topup.card',{brand:q.card.brand,last4:q.card.last4,month:q.card.expMonth,year:q.card.expYear})}</p>
      <p>${L.t('portal.topup.dates',{start:L.day(q.startDate),end:L.day(q.endDate)})}</p>
      <p>${L.t('portal.topup.expiry',{expiry:q.grantTerms.expiresDate?L.day(q.grantTerms.expiresDate):L.t('portal.prepaid.noExpiry')})}</p>
      <p>${L.t('portal.topup.priority',{priority:q.grantTerms.priority,percent:q.grantTerms.rolloverPercent,months:q.grantTerms.rolloverMonths,cap:q.grantTerms.rolloverCapN===null?L.t('portal.topup.uncapped'):quantity(q.grantTerms.rolloverCapN)})}</p>
      <p>${L.t('portal.topup.account')} <code style="overflow-wrap:anywhere">${q.accountRef}</code> · <code style="overflow-wrap:anywhere">${q.customerRef}</code>.</p>
      <p>${L.t('portal.topup.revocation')}</p>
      ${source.status==='awaiting_customer'?h`<form method="post" action="${link('/portal/prepaid-topup.accept')}"><input type="hidden" name="authorization" value="${id}"><input type="hidden" name="basis_hash" value="${source.basis}"><label><input type="checkbox" name="accept" required> ${L.t('portal.topup.accept',{amount:L.money(q.amountCents),cap:L.money(q.periodCapCents)})}</label><button>${L.t('portal.topup.acceptButton')}</button></form>`:''}
      ${['awaiting_customer','pending','active'].includes(source.status)?h`<form method="post" action="/portal/prepaid-topup.revoke?session=${encodeURIComponent(token)}"><input type="hidden" name="authorization" value="${id}"><button>${L.t('portal.topup.revokeButton')}</button></form>`:''}
    </section>`
}
