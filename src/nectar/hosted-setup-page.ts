import type { Bindings } from '../auth.server'
import { customerHostedSetups } from './hosted-setup'
import { customerText } from './locale'
import type { CustomerSession } from './portal-session'
import { setupConsent } from './hosted-setup-consent'
import { h } from './ui/html'

export async function hostedSetupPage(env: Bindings, session: CustomerSession, link: (path:string)=>string, setup?: string) {
  const L=customerText(session.language,session.currency),rows=(await customerHostedSetups(env,session.customer)).filter(row=>!setup||row.id===setup)
  const consent=await setupConsent(env,session,rows.find(row=>row.status==='prepared')?.method??'card')
  return h`<header><h1>${L.t('checkout.heading')}</h1><p>${L.t('checkout.explain')}</p>${setup?'':h`<a href="${link('/portal')}">${L.t('portal.back')}</a>`}<p>${consent.wording.merchant}</p></header>
    ${rows.length?await Promise.all(rows.map(async row=>{const method=row.paymentMethod,terms=await setupConsent(env,session,row.method);return h`<section class="card"><h2>${L.t(row.method==='card'?'checkout.card':'checkout.ach')}</h2>
    <p>${L.t(`checkout.status.${row.status}`)}</p>
    ${row.historical?h`<p>${L.t('checkout.historical')}</p>`:''}${row.status==='complete'?h`<p>${method?.brand??method?.bankName} · ${L.t('checkout.ending',{last4:method?.last4})}</p>${method?.mandateRef?h`<p>${L.t('checkout.mandate')}</p>`:''}`:''}
    ${['prepared','open','creating','updating'].includes(row.status)&&!row.historical?h`<form method="post" action="${link(row.status==='prepared'?'/portal/payment-methods.start':['creating','updating'].includes(row.status)?'/portal/payment-methods.reconcile':'/portal/payment-methods.finish')}"><input type="hidden" name="setup" value="${row.id}">${row.status==='prepared'?h`<input type="hidden" name="consent_hash" value="${terms.hash}">`:""}<p><label><input type="checkbox" name="confirm" required> ${L.t(row.status==='prepared'?'checkout.consent':'checkout.verify')}</label></p>${row.status==='prepared'?h`<p><label><input type="checkbox" name="make_default"> ${L.t('checkout.default')}</label></p>`:''}<button>${L.t(row.status==='prepared'?'checkout.continue':['creating','updating'].includes(row.status)?'checkout.reconcile':'checkout.finish')}</button></form>`:''}</section>`})):h`<p>${L.t('checkout.empty')}</p>`}`
}
