import type { Bindings } from '../auth.server'
import type { Actor } from './actor'
import { clockInstant } from './clock'
import { fingerprint, guard, insist, one, type Row } from './core'
import { collectionAuthority, collectionOwner } from './movein/collection-state'
import { STEP_UP_MS } from './mfa'
import type { CustomerSession } from './portal-session'

export async function setupOwner(env: Bindings, actor: Actor) {
  await collectionOwner(env, actor)
  const at=clockInstant(env)
  const factor=await one(env,"SELECT verified_at,method FROM nc_mfa_sessions WHERE session_id=? AND member_id=? AND method IN ('totp','passkey') AND verified_at BETWEEN ? AND ?",actor.sessionId,actor.id,at-STEP_UP_MS,at)
  insist(factor,'mfa_step_up_required',403)
  return {verifiedAt:factor.verified_at,reference:await fingerprint([actor.id,actor.sessionId,factor.verified_at,factor.method])}
}
export function setupOwnerFence(env: Bindings, actor: Actor) {
  const at=clockInstant(env)
  return [collectionAuthority(env,actor),guard(env,'mfa_step_up_required',"EXISTS(SELECT 1 FROM nc_mfa_sessions WHERE session_id=? AND member_id=? AND method IN ('totp','passkey') AND verified_at BETWEEN ? AND ?)",actor.sessionId,actor.id,at-STEP_UP_MS,at)]
}
export function setupSessionFence(env: Bindings, session: CustomerSession, row: Row, status: string) {
  const at=clockInstant(env)
  return guard(env, 'hosted_setup_source_changed', `EXISTS(SELECT 1 FROM nc_hosted_setups s JOIN nc_customers c ON c.id=s.customer_id
    JOIN nc_stripe_customer_bindings b ON b.id=s.binding_id AND b.revision=s.binding_revision
    JOIN nc_portal_sessions p ON p.customer_id=c.id JOIN nc_portal_policy policy ON policy.singleton=1 AND policy.revision=p.policy_revision
    WHERE s.id=? AND s.status=? AND s.customer_id=? AND c.revision=s.customer_revision AND b.account_ref=s.account_ref AND b.stripe_customer_ref=s.customer_ref
    AND s.livemode=0 AND c.erased_at IS NULL AND c.status='active' AND p.id=? AND p.revoked_at IS NULL AND p.expires_at>?
    AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN (s.id,c.id,b.id))
    AND s.factor_verified_at BETWEEN ? AND ?
    AND EXISTS(SELECT 1 FROM oa_sessions os JOIN oa_operators oo ON oo.id=os.operator_id JOIN nc_members om ON om.email=lower(oo.email)
      JOIN nc_mfa_sessions factor ON factor.session_id=os.id AND factor.member_id=om.id
      WHERE os.id=s.owner_session_id AND om.id=s.created_by AND om.role='owner' AND om.status='active'
      AND oo.role='owner' AND oo.status='active' AND oo.version=os.operator_version AND os.revoked_at IS NULL
      AND os.expires_at>CAST(strftime('%s','now') AS INTEGER)*1000 AND factor.method IN ('totp','passkey')
      AND factor.verified_at>=s.factor_verified_at AND factor.verified_at BETWEEN ? AND ?))`, row.id,status,session.customer,session.jti,at,at-STEP_UP_MS,at,at-STEP_UP_MS,at)
}
