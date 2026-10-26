// Bounded housekeeping performs only provider reads. Anonymous data is removed
// after a definitively expired checkout, never by assuming an unknown payment
// failed. Unresolved claims keep capacity and the evidence needed to reconcile.
import type { Bindings } from '../auth.server'
import { clockInstant } from './clock'
import { all, commit, guard, newId, one, stmt } from './core'
import { linkTerms } from './payment-links'
import { expiredPaymentLinkPayment } from './payment-links-payment'
import { paymentLinkStripe } from './payment-links-stripe'
import { expiredHostedSetup } from './payments/hosted-setup'

export async function expirePaymentLinkAttempts(env:Bindings) {
  const at=clockInstant(env),expired:string[]=[],removed:string[]=[]
  const candidates=await all(env,`SELECT * FROM nc_payment_link_attempts WHERE expires_at<=? AND status='open'
    AND customer_id IS NULL AND payment_id IS NULL AND proof_json IS NULL AND session_ref IS NOT NULL ORDER BY expires_at,id LIMIT 20`,at)
  for(const row of candidates) {
    const link=await one(env,'SELECT * FROM nc_payment_links WHERE id=?',row.link_id)
    if(!link)continue
    try {
      const {stripe}=await paymentLinkStripe(env,link.account_ref)
      const definitive=linkTerms(link).kind==='one_time'?await expiredPaymentLinkPayment(stripe,link,row):await expiredHostedSetup(stripe,{id:row.id,customerRef:row.customer_ref,sessionRef:row.session_ref,method:'card'})
      if(!definitive)continue
      await commit(env,[guard(env,'payment_link_state_changed',"EXISTS(SELECT 1 FROM nc_payment_link_attempts WHERE id=? AND revision=? AND status='open' AND customer_id IS NULL AND payment_id IS NULL AND proof_json IS NULL)",row.id,row.revision),
        guard(env,'payment_link_state_changed','EXISTS(SELECT 1 FROM nc_payment_links WHERE id=? AND reserved_count>0)',link.id),
        stmt(env,"UPDATE nc_payment_link_attempts SET status='expired',name='',billing_email='',address='',consent_json='{}',token_hash=NULL,customer_ref=NULL,session_ref=NULL,method_json=NULL,revision=? WHERE id=?",newId(),row.id),
        stmt(env,'UPDATE nc_payment_links SET reserved_count=reserved_count-1 WHERE id=?',link.id)],
        {actor:'system:payment-links',action:'payment_link.expired',subject:row.id,detail:{link:link.id,providerConfirmed:true}})
      expired.push(row.id)
    } catch {
      // A read failure or concurrent financial write leaves the original claim.
    }
  }
  const terminal=await all(env,`SELECT a.id FROM nc_payment_link_attempts a WHERE a.status='expired' AND a.expires_at<=?
    AND a.customer_id IS NULL AND a.subscription_id IS NULL AND a.payment_id IS NULL AND a.proof_json IS NULL
    AND NOT EXISTS(SELECT 1 FROM nc_invoices WHERE id=a.invoice_id) ORDER BY a.expires_at,a.id LIMIT 100`,at)
  for(const row of terminal) {
    await commit(env,[stmt(env,"DELETE FROM nc_payment_link_attempts WHERE id=? AND status='expired' AND customer_id IS NULL AND payment_id IS NULL AND proof_json IS NULL",row.id)],
      {actor:'system:payment-links',action:'payment_link.expired.remove',subject:row.id})
    removed.push(row.id)
  }
  return {expired,removed}
}
