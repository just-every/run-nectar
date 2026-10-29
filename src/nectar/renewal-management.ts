import type { Bindings } from '../auth.server'
import { commit, guard, newId, now, stmt, parseJson, type Row } from './core'
import { savedOffer, declineSaveStatements } from './retention-offers'
import { customerText } from './locale'
import { h, type Html } from './ui/html'

// Both customer doors use the same single confirmation and optional save.
export async function renewalManagement(env: Bindings, term: Row, action: string, L: ReturnType<typeof customerText>, hidden: Html = h``, selected?: Row | null) {
  const offer=selected === undefined ? await savedOffer(env,term) : selected,save=offer?parseJson<Row>(offer.terms_json,{}):null
  const saveText=save?(save.kind==='discount'?L.t(save.billing?'renewal.save.discount_periods':'renewal.save.discount',{percent:L.percent(save.percent),months:save.months}):save.kind==='pause'?L.t('renewal.save.pause',{to:L.day(save.to)}):L.t('renewal.save.downgrade',{target:save.targetLabel})):''
  return h`<h1>${L.t('renewal.manage.heading')}</h1><section class="card"><h2>${L.t('renewal.manage.section')}</h2><p>${L.t('renewal.manage.ends',{date:L.day(term.end_date)})} ${term.auto_renew?L.t('renewal.manage.renews'):L.t('renewal.manage.ending')}</p><p>${L.t('renewal.manage.uplift',{percent:L.percent(term.uplift_percent)})}</p><form method="post" action="${action}">${hidden}${save?h`<input type="hidden" name="offer" value="${offer!.id}"><p>${L.t('renewal.save.optional',{offer:saveText})} ${save.kind==='downgrade'?L.t('renewal.save.from',{from:L.day(save.from)}):L.t('renewal.save.window',{from:L.day(save.from),to:L.day(save.to)})} ${L.t('renewal.save.usage')}</p>`:''}<label>${L.t('renewal.reason')}<input name="reason" maxlength="500"></label><button type="submit" name="confirm" value="cancel">${L.t('renewal.cancel')}</button>${save?h`<button class="secondary" type="submit" name="confirm" value="save">${L.t('renewal.accept_save')}</button>`:''}</form><p>${L.t('renewal.manage.no_steps')}</p></section>`
}

export async function cancelRenewal(env: Bindings, term: Row, reason: string, guards: D1PreparedStatement[] = [], actor = 'customer:renewal-link') {
  await commit(env, [...guards, ...await declineSaveStatements(env,term,reason),
    guard(env,'stale',"EXISTS(SELECT 1 FROM nc_renewal_terms WHERE id=? AND token_hash IS ? AND revision=? AND status='active' AND cancelled_at IS NULL)",term.id,term.token_hash,term.revision),
    stmt(env,'UPDATE nc_renewal_terms SET auto_renew=0,cancelled_at=?,token_hash=NULL,revision=? WHERE id=?',now(),newId(),term.id)],
    {actor,action:'subscription.renewal.cancel',subject:term.subscription_id,detail:{term:term.id,end:term.end_date,reason}})
}
