import { portalRetentionActive, portalRetentionGuard } from './portal-retention-authority'
import type { Bindings } from '../auth.server'
import { requireBusiness } from './business'
import { clockInstant } from './clock'
import { guard, insist, one, parseJson, type Row } from './core'
import { localDate } from './dates'
import type { Input } from './input'
import { customerText } from './locale'
import { customerSessionGuard, type CustomerSession } from './portal-session'
import { retentionPolicy } from './retention-policy'
import { acceptWinback } from './retention-winback'
import { h } from './ui/html'

async function ownWinback(env: Bindings, session: CustomerSession, subscription: string) {
  const offer=await one(env,`SELECT o.* FROM nc_retention_offers o JOIN nc_subscriptions s ON s.id=o.subscription_id JOIN nc_customers c ON c.id=s.customer_id
    WHERE s.id=? AND s.customer_id=? AND c.erased_at IS NULL AND s.billing_mode='live' AND o.kind='winback' AND o.status='offered' AND o.token_hash IS NOT NULL`,subscription,session.customer)
  insist(offer,'not_found',404)
  const policy=await retentionPolicy(env),day=localDate(clockInstant(env),(await requireBusiness(env)).timezone)
  insist(policy.enabled&&policy.winback_enabled&&offer.policy_id===policy.id&&day<=offer.to_date&&!!await portalRetentionActive(env,offer.policy_id),'offer_expired',409)
  return offer
}
export async function portalWinbackData(env: Bindings, session: CustomerSession, subscription: string) {
  const offer=await ownWinback(env,session,subscription),terms=parseJson<Row>(offer.terms_json,{})
  return {subscription,id:offer.id,percent:terms.percent,periods:terms.months,expires:offer.to_date}
}
export async function portalWinbackPage(env: Bindings, session: CustomerSession, subscription: string, link:(path:string)=>string) {
  const offer=await ownWinback(env,session,subscription),terms=parseJson<Row>(offer.terms_json,{}),L=customerText(session.language,session.currency)
  return h`<p><a href="${link('/portal/changes')}">${L.t('portal.change.heading')}</a></p><h1>${L.t('return.offer.title')}</h1><section class="card"><p>${L.t(terms.billing?'return.offer.body_periods':'return.offer.body',{percent:L.percent(terms.percent),months:terms.months})}</p><p>${L.t('return.offer.expires',{date:L.day(offer.to_date)})}</p><form method="post" action="${link(`/portal/return/${subscription}`)}"><input type="hidden" name="offer" value="${offer.id}"><button name="confirm" value="accept">${L.t('return.offer.accept')}</button></form></section>`
}
export async function operatePortalWinback(env: Bindings, request: Request, session: CustomerSession, subscription: string, input: Input) {
  insist(request.headers.get('origin')===session.origin,'forbidden',403)
  input.only(['offer','confirm'])
  insist(input.text('confirm',{max:10})==='accept','confirmation_required')
  const offer=await ownWinback(env,session,subscription)
  insist(input.text('offer',{max:100})===offer.id,'offer_stale',409)
  const result=await acceptWinback(env,offer,[customerSessionGuard(env,session),portalRetentionGuard(env,offer.policy_id),guard(env,'offer_stale',"EXISTS(SELECT 1 FROM nc_retention_offers WHERE id=? AND token_hash=? AND status='offered')",offer.id,offer.token_hash)])
  return {subscription,status:'continued',...result}
}
