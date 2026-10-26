import type { Bindings } from '../auth.server'
import type { CustomerSession } from './portal-session'
import { customerPortalMethodActions, methodActionConsent } from './portal-method-actions'
import { customerHostedSetups } from './hosted-setup'
import { customerText } from './locale'
import { h } from './ui/html'

export async function portalMethodActionsPage(env: Bindings, session: CustomerSession, link: (path:string)=>string) {
  const L=customerText(session.language,session.currency),actions=await customerPortalMethodActions(env,session),setups=await customerHostedSetups(env,session.customer)
  return h`${await Promise.all(actions.map(async action=>{const consent=await methodActionConsent(env,session,action.operation);const method=setups.find(row=>row.id===action.setup)?.paymentMethod;return h`<section class="card" data-method-action="${action.id}"><h2>${L.t(`methods.${action.operation}`)}</h2>
    ${method?h`<p>${method.brand??method.bankName} · ${L.t('checkout.ending',{last4:method.last4})}</p>`:''}
    <p>${L.t(`methods.status.${action.status}`)}</p>
    ${action.historical?h`<p>${L.t('checkout.historical')}</p>`:['prepared','uncertain'].includes(action.status)?h`<form method="post" action="${link(action.status==='prepared'?'/portal/payment-methods/action':'/portal/payment-methods/action/reconcile')}"><input type="hidden" name="action" value="${action.id}"><input type="hidden" name="consent_hash" value="${consent.hash}"><label><input type="checkbox" name="confirm" required> ${L.t(action.operation==='default'?'methods.confirm.default':'methods.confirm.remove')}</label><button>${L.t(action.status==='uncertain'?'checkout.reconcile':`methods.${action.operation}`)}</button></form>`:''}</section>`}))}`
}
