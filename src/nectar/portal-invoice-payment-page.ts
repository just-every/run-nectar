import type { Bindings } from '../auth.server'
import { NectarError } from './core'
import { customerText } from './locale'
import { portalInvoiceConsent, portalInvoicePayment } from './portal-invoice-payment'
import type { CustomerSession } from './portal-session'
import { h, hidden } from './ui/html'

export async function portalInvoicePaymentSection(env: Bindings,session: CustomerSession,invoice: string,link: (path:string)=>string) {
  const L=customerText(session.language,session.currency),attempt=await portalInvoicePayment(env,session,invoice)
  if(attempt&&!['expired','failed'].includes(attempt.status))return h`<section class="card"><h2>${L.t('portal.pay.heading')}</h2><p>${L.money(attempt.amountCents,attempt.currency.toUpperCase())}</p>
    <p>${L.t(`portal.pay.status.${attempt.status}`)}</p>${attempt.status!=='paid'?h`<form method="post" action="${link('/portal/pay/reconcile')}">${hidden('payment',attempt.id)}<button>${L.t('portal.pay.check')}</button></form>`:''}</section>`
  try {
    const consent=await portalInvoiceConsent(env,session,invoice)
    return h`<section class="card"><h2>${L.t('portal.pay.heading')}</h2><p>${consent.wording}</p><form method="post" action="${link('/portal/pay')}">
      ${hidden('invoice',invoice)}${hidden('consent_hash',consent.hash)}<label><input type="checkbox" name="confirm" required> ${L.t('portal.pay.accept')}</label><button>${L.t('portal.pay.continue')}</button></form></section>`
  } catch(error) {if(!(error instanceof NectarError))throw error;return h``}
}
