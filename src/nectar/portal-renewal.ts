import { portalRetentionActive, portalRetentionGuard } from './portal-retention-authority'
import type { Bindings } from '../auth.server'
import { requireBusiness } from './business'
import { clockInstant } from './clock'
import { all, fingerprint, guard, insist, now, one, parseJson, stmt, type Row } from './core'
import { micros } from './decimal'
import { addDays, localDate } from './dates'
import type { Input } from './input'
import { customerText } from './locale'
import { portalChangePolicy } from './portal-change-policy'
import { customerSessionGuard, type CustomerSession } from './portal-session'
import { retentionPolicy } from './retention-policy'
import { retentionTerms } from './retention-terms'
import { acceptSave, savedOffer } from './retention-offers'
import { cancelRenewal, renewalManagement } from './renewal-management'
import { h } from './ui/html'

async function renewalBasis(env: Bindings, session: CustomerSession, subscription: string) {
  const sub=await one(env,`SELECT s.* FROM nc_subscriptions s JOIN nc_customers c ON c.id=s.customer_id WHERE s.id=? AND s.customer_id=? AND s.billing_mode='live' AND c.erased_at IS NULL`,subscription,session.customer)
  insist(sub,'not_found',404)
  const term=await one(env,"SELECT * FROM nc_renewal_terms WHERE subscription_id=? AND status='active'",sub.id)
  const day=localDate(clockInstant(env),(await requireBusiness(env)).timezone)
  insist(term&&term.start_date<=day&&term.end_date>day,'renewal_unavailable',409)
  const policy=await portalChangePolicy(env)
  const basis=await fingerprint({subscription:sub.id,revision:sub.revision,term:term.id,termRevision:term.revision,end:term.end_date,policy})
  return {sub,term,day,policy,basis}
}

// Reading a portal never issues a link, creates an offer or sends a message.
async function optionalSave(env: Bindings, data: Awaited<ReturnType<typeof renewalBasis>>) {
  if(!data.term.auto_renew||data.term.cancelled_at)return null
  const policy=await retentionPolicy(env)
  if(!policy.enabled||!policy.id||!await portalRetentionActive(env,policy.id))return null
  if(policy.save_kind==='pause'&&!data.policy.pauseAllowed)return null
  let terms:Row
  try { terms=await retentionTerms(env,data.sub.id,'save') }
  catch(error) { if(error instanceof Error&&['discount_already_applies','downgrade_price_unavailable','downgrade_not_compatible','downgrade_must_not_increase_charges','retention_price_required_for_mixed_intervals','retention_price_not_on_subscription','retention_duration_exceeds_service','retention_periods_must_be_contiguous'].includes(error.message))return null;throw error }
  if(terms.kind==='downgrade') {
    if(!data.policy.prices.includes(terms.target))return null
    const target=await one(env,"SELECT kind,unit_amount FROM nc_prices WHERE id=? AND status='active'",terms.target)
    if(!target||terms.selectedItems.length!==1)return null
    if(target.kind==='seat'&&terms.selectedItems[0].quantity<data.policy.minimumSeats)return null
    // Signed minimums are never waived by a retention offer. The ordinary
    // pending request remains available for a person's review instead.
    const contracts=await all(env,"SELECT terms_json FROM nc_contracts WHERE subscription_id=? AND status='approved'",data.sub.id)
    for(const contract of contracts)for(const window of parseJson<Row>(contract.terms_json,{}).commitments??[]) {
      if(window.from>data.day||window.to<=data.day)continue
      const months=(Number(window.to.slice(0,4))-Number(window.from.slice(0,4)))*12+Number(window.to.slice(5,7))-Number(window.from.slice(5,7))
      if(micros(target.unit_amount)*BigInt(terms.selectedItems[0].quantity)*BigInt(months)<micros(window.minimum))return null
    }
  }
  if(terms.kind==='pause') {
    const contracts=await all(env,"SELECT terms_json FROM nc_contracts WHERE subscription_id=? AND status='approved'",data.sub.id)
    if(contracts.some(contract=>(parseJson<Row>(contract.terms_json,{}).commitments??[]).some((window:Row)=>window.from<terms.to&&window.to>terms.from)))return null
  }
  const prior=await savedOffer(env,data.term)
  if(prior&&prior.source_revision===terms.basis&&prior.to_date>=data.day)return {offer:prior,prepared:false}
  return {offer:{id:terms.basis,policy_id:policy.id,source_revision:terms.basis,terms_json:JSON.stringify(terms),from_date:terms.from,to_date:addDays(data.day,30)},prepared:true}
}

export async function portalRenewalData(env: Bindings, session: CustomerSession, subscription: string) {
  const data=await renewalBasis(env,session,subscription),save=await optionalSave(env,data),terms=save?parseJson<Row>(save.offer.terms_json,{}):null
  return {subscription,basis:data.basis,term:{start:data.term.start_date,end:data.term.end_date,autoRenew:!!data.term.auto_renew,cancelled:!!data.term.cancelled_at,upliftPercent:data.term.uplift_percent},
    save:save&&terms?{id:save.offer.id,kind:terms.kind,percent:terms.percent,periods:terms.months,from:terms.from,to:terms.to,targetLabel:terms.targetLabel,
      preview:terms.preview.map((row:Row)=>({period:row.period,beforeCents:row.before.totalCents,afterCents:row.after.totalCents}))}:null}
}

export async function portalRenewalPage(env: Bindings, session: CustomerSession, subscription: string, link:(path:string)=>string) {
  const data=await renewalBasis(env,session,subscription),L=customerText(session.language,session.currency)
  const back=h`<p><a href="${link('/portal/changes')}">${L.t('portal.change.heading')}</a></p>`
  if(data.term.cancelled_at||!data.term.auto_renew)return h`${back}<h1>${L.t('renewal.cancelled.title')}</h1><p>${L.t('renewal.cancelled.body',{date:L.day(data.term.end_date)})}</p>`
  const save=await optionalSave(env,data)
  return h`${back}${await renewalManagement(env,data.term,link(`/portal/renewal/${subscription}`),L,h`<input type="hidden" name="basis" value="${data.basis}">`,save?.offer??null)}`
}

export async function operatePortalRenewal(env: Bindings, request: Request, session: CustomerSession, subscription: string, input: Input) {
  insist(request.headers.get('origin')===session.origin,'forbidden',403)
  input.only(['basis','confirm','reason','offer'])
  const data=await renewalBasis(env,session,subscription)
  insist(input.text('basis',{max:64})===data.basis,'portal_change_stale',409)
  insist(data.term.auto_renew&&!data.term.cancelled_at,'already_decided',409)
  const reason=input.text('reason',{max:500,optional:true}).trim()||'not supplied'
  const guards=[customerSessionGuard(env,session),
    guard(env,'portal_change_stale',"EXISTS(SELECT 1 FROM nc_subscriptions WHERE id=? AND customer_id=? AND revision=? AND billing_mode='live') AND COALESCE((SELECT revision FROM nc_portal_change_policy WHERE singleton=1),0)=?",subscription,session.customer,data.sub.revision,data.policy.revision)]
  const operation=input.text('confirm',{max:10})
  if(operation==='cancel') {
    // An optional offer read never writes; explicit cancellation records the
    // displayed offer's decline atomically, without making a save mandatory.
    const offered=input.text('offer',{max:100,optional:true}),save=offered?await optionalSave(env,data):null
    if(save?.prepared&&save.offer.id===offered)guards.push(stmt(env,"INSERT INTO nc_retention_offers(id,subscription_id,kind,policy_id,source_revision,terms_json,from_date,to_date,status,reason,created_at,decided_at) VALUES(?,?,'save',?,?,?,?,?,'declined',?,?,?)",save.offer.id,subscription,save.offer.policy_id,save.offer.source_revision,save.offer.terms_json,save.offer.from_date,save.offer.to_date,reason,now(),now()))
    await cancelRenewal(env,data.term,reason,guards,`customer:portal:${session.customer}`)
    return {subscription,status:'cancelled',end:data.term.end_date}
  }
  insist(operation==='save','confirmation_required')
  const save=await optionalSave(env,data)
  insist(save&&save.offer.id===input.text('offer',{max:100}),'offer_stale',409)
  const terms=await acceptSave(env,data.term,save.offer.id,reason,[...guards,portalRetentionGuard(env,save.offer.policy_id)],save.prepared?save.offer:undefined)
  return {subscription,status:'continued',kind:terms.kind,from:terms.from,to:terms.to}
}
