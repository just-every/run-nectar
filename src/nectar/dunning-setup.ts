// Release only an expired dunning preparation with a definitive safe outcome.
import type { Bindings } from '../auth.server'
import { actorLabel, type Actor } from './actor'
import { all, commit, guard, insist, stmt } from './core'
import { clockInstant } from './clock'
import { setupOwnerFence } from './hosted-setup-basis'
import { expiredHostedSetup } from './payments/hosted-setup'
import { providerUnavailable, stripeForAccount } from './payments/stripe'

export async function retireExpiredDunningSetups(env: Bindings,actor: Actor,customer: string) {
 const at=clockInstant(env)
 const rows=await all(env,`SELECT h.*,d.id AS delivery,d.expires_at AS deadline FROM nc_hosted_setups h
 JOIN nc_dunning_mail_authority a ON a.setup_id=h.id JOIN nc_dunning_deliveries d ON d.id=a.id
 JOIN nc_stripe_customer_bindings b ON b.id=h.binding_id AND b.revision=h.binding_revision AND b.account_ref=h.account_ref AND b.stripe_customer_ref=h.customer_ref
 JOIN nc_customers c ON c.id=h.customer_id WHERE h.customer_id=? AND h.status NOT IN ('complete','failed') AND c.status='active' AND c.erased_at IS NULL`,customer)
 for(const row of rows) {
  insist(row.deadline<=at&&['prepared','open'].includes(row.status),'dunning_prior_setup_unresolved',409)
  const neverStarted=row.status==='prepared'&&!row.session_ref
  if(!neverStarted) {
   insist(row.status==='open'&&row.session_ref,'dunning_prior_setup_unresolved',409)
   const {stripe}=await stripeForAccount(env,row.account_ref).catch(providerUnavailable)
   insist(await expiredHostedSetup(stripe,{id:row.id,customerRef:row.customer_ref,method:row.method,sessionRef:row.session_ref}).catch(providerUnavailable),'dunning_prior_setup_unresolved',409)
  }
  await commit(env,[...setupOwnerFence(env,actor),
   guard(env,'dunning_prior_setup_changed',`EXISTS(SELECT 1 FROM nc_hosted_setups h JOIN nc_dunning_mail_authority a ON a.setup_id=h.id JOIN nc_dunning_deliveries d ON d.id=a.id
    JOIN nc_stripe_customer_bindings b ON b.id=h.binding_id AND b.revision=h.binding_revision AND b.account_ref=h.account_ref AND b.stripe_customer_ref=h.customer_ref
    JOIN nc_customers c ON c.id=h.customer_id WHERE h.id=? AND h.status=? AND h.session_ref IS ? AND d.id=? AND d.expires_at<=? AND c.status='active' AND c.erased_at IS NULL)
    AND (?=0 OR (NOT EXISTS(SELECT 1 FROM nc_hosted_setup_history WHERE id=?) AND NOT EXISTS(SELECT 1 FROM nc_hosted_setup_returns WHERE setup_id=?)))`,row.id,row.status,row.session_ref,row.delivery,clockInstant(env),neverStarted?1:0,row.id,row.id),
   stmt(env,"UPDATE nc_hosted_setups SET status='failed' WHERE id=?",row.id),
   stmt(env,`INSERT INTO nc_hosted_setup_history(id,customer_id,method,status,account_ref,customer_ref,session_ref) VALUES(?,?,?,'failed',?,?,?) ON CONFLICT(id) DO UPDATE SET status='failed'`,row.id,row.customer_id,row.method,row.account_ref,row.customer_ref,row.session_ref),
   stmt(env,'UPDATE nc_hosted_setup_returns SET consumed_at=COALESCE(consumed_at,?) WHERE setup_id=?',clockInstant(env),row.id),
   stmt(env,'UPDATE nc_portal_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE id IN(SELECT portal_session_id FROM nc_dunning_mail_authority WHERE setup_id=?)',clockInstant(env),row.id)],
   {actor:actorLabel(actor),action:'dunning.setup.retire',subject:row.id,detail:{customer,delivery:row.delivery,priorStatus:row.status,reason:neverStarted?'never-started':'provider-expired',providerSession:row.session_ref}})
 }
}
