import type { Bindings } from '../auth.server'
import { clockInstant } from './clock'
import { guard, insist, one } from './core'
import { PORTAL_LIFETIME, type CustomerSession } from './portal-session'

/** Rechecked inside every mutation batch and every private document query. */
export function portalProfileAuthority(env: Bindings, session: CustomerSession) {
  const at = clockInstant(env)
  insist(session.v === 1 && session.iss === env.AUTH_ORIGIN
    && session.audience === 'hosted' && session.parent === '', 'hosted_session_required', 403)
  return {
    sql: `EXISTS(SELECT 1 FROM nc_portal_sessions p
      JOIN nc_portal_policy policy ON policy.singleton=1 AND policy.revision=p.policy_revision
      JOIN nc_customers c ON c.id=p.customer_id
      WHERE p.id=? AND p.customer_id=? AND p.origin=? AND p.audience='hosted' AND p.parent_origin=''
      AND p.issued_at=? AND p.expires_at=? AND p.issued_at<=? AND p.expires_at>? AND p.expires_at-p.issued_at=?
      AND p.contact_id IS ? AND p.email_hash IS ?
      AND ((p.email_hash IS NULL AND p.contact_id IS NULL AND ? IS NULL)
        OR (p.email_hash IS NOT NULL AND ((p.contact_id IS NULL AND lower(trim(c.billing_email))=?)
          OR EXISTS(SELECT 1 FROM nc_contacts contact WHERE contact.id=p.contact_id AND contact.customer_id=c.id AND contact.role='billing' AND lower(trim(contact.email))=?))))
      AND p.revoked_at IS NULL AND c.status='active' AND c.erased_at IS NULL
      AND EXISTS(SELECT 1 FROM json_each(policy.hosts_json) WHERE value=p.origin)
      AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(p.id,c.id))
      AND NOT EXISTS(SELECT 1 FROM nc_dunning_mail_authority a JOIN nc_dunning_deliveries d ON d.id=a.id WHERE a.portal_session_id=p.id AND d.expires_at<=?)
      AND NOT EXISTS(SELECT 1 FROM nc_card_expiry_notice_authority a JOIN nc_card_expiry_notices n ON n.id=a.id WHERE a.portal_session_id=p.id AND n.expires_at<=?))`,
    params: [session.jti, session.customer, session.origin, session.iat, session.exp, at, at, PORTAL_LIFETIME,
      session.contactId, session.emailHash, session.contactEmail, session.contactEmail, session.contactEmail, at, at],
  }
}

export function portalProfileFence(env: Bindings, session: CustomerSession) {
  const { sql, params } = portalProfileAuthority(env, session)
  return guard(env, 'invalid_customer_session', sql, ...params)
}

export async function requirePortalProfileSession(env: Bindings, session: CustomerSession) {
  const { sql, params } = portalProfileAuthority(env, session)
  insist(await one(env, `SELECT 1 WHERE ${sql}`, ...params), 'invalid_customer_session', 401)
}
