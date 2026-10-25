import type { Bindings } from '../auth.server'
import { customerHostedSetups } from './hosted-setup'
import { customerText } from './locale'
import type { CustomerSession } from './portal-session'
import { h } from './ui/html'
import { parseJson, type Row } from './core'

export async function hostedSetupPage(env: Bindings, session: CustomerSession, link: (path:string)=>string) {
  const L=customerText(session.language,session.currency),rows=await customerHostedSetups(env,session.customer)
  return h`<header><h1>${L.t('checkout.heading')}</h1><p>${L.t('checkout.explain')}</p><a href="${link('/portal')}">${L.t('portal.back')}</a></header>
    ${rows.length?rows.map(row=>{const method=parseJson<Row>(row.method_json,{});return h`<section class="card"><h2>${L.t(row.method==='card'?'checkout.card':'checkout.ach')}</h2>
    <p>${L.t(`checkout.status.${row.status}`)}</p>
    ${row.status==='complete'?h`<p>${method.brand??method.bankName} · ${L.t('checkout.ending',{last4:method.last4})}</p>${method.mandateRef?h`<p>${L.t('checkout.mandate')}</p>`:''}`:''}
    ${['prepared','open'].includes(row.status)?h`<form method="post" action="${link(row.status==='prepared'?'/portal/payment-methods.start':'/portal/payment-methods.finish')}"><input type="hidden" name="setup" value="${row.id}"><p><label><input type="checkbox" name="confirm" required> ${L.t(row.status==='prepared'?'checkout.consent':'checkout.default')}</label></p><button>${L.t(row.status==='prepared'?'checkout.continue':'checkout.finish')}</button></form>`:''}</section>`}):h`<p>${L.t('checkout.empty')}</p>`}`
}
