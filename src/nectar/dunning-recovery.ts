// Link identity is explicitly selected during preparation, never inferred by time.
import type { Bindings } from '../auth.server'
import { canonical, guard, insist, one, stmt, type Row } from './core'
import { clockInstant } from './clock'
import type { AutomaticQuote } from './automatic-collection-records'

export async function dunningRecoveryLink(env: Bindings,delivery: string,invoice: string,customer: string) {
 const row=await one(env,`SELECT d.*,a.portal_session_id FROM nc_dunning_deliveries d JOIN nc_dunning_mail_authority a ON a.id=d.id
 JOIN nc_dunning_series s ON s.id=d.series_id JOIN nc_dunning_authority z ON z.id=s.id JOIN nc_portal_sessions p ON p.id=a.portal_session_id
 WHERE d.id=? AND d.invoice_id=? AND d.customer_id=? AND d.status='accepted' AND s.status='active'
 AND d.expires_at>? AND p.expires_at>? AND p.revoked_at IS NULL`,delivery,invoice,customer,clockInstant(env),clockInstant(env))
 insist(row,'dunning_recovery_link_unavailable',409);return row
}
export function dunningRecoveryStatements(env: Bindings,id: string,delivery: Row) {
 return [guard(env,'dunning_recovery_link_unavailable',`EXISTS(SELECT 1 FROM nc_dunning_deliveries d JOIN nc_dunning_mail_authority a ON a.id=d.id JOIN nc_dunning_series s ON s.id=d.series_id JOIN nc_dunning_authority z ON z.id=s.id JOIN nc_portal_sessions p ON p.id=a.portal_session_id
 WHERE d.id=? AND d.status='accepted' AND s.status='active' AND d.expires_at>? AND p.expires_at>? AND p.revoked_at IS NULL)`,delivery.id,clockInstant(env),clockInstant(env)),
 stmt(env,'INSERT INTO nc_dunning_recoveries(id,customer_id,invoice_id,delivery_id) VALUES(?,?,?,?)',id,delivery.customer_id,delivery.invoice_id,delivery.id)]
}
export async function retryDunningStep(env: Bindings,collection: Row,quote: AutomaticQuote) {
 const row=await one(env,`SELECT d.id FROM nc_retry_method_recoveries r JOIN nc_retry_method_recovery_authorizations z ON z.id=r.id
 JOIN nc_dunning_recoveries link ON link.id=r.id JOIN nc_dunning_deliveries d ON d.id=link.delivery_id
 WHERE r.collection_id=? AND z.status='active' AND r.quote_json=? AND d.invoice_id=r.invoice_id AND d.customer_id=r.customer_id`,collection.id,canonical(quote))
 return row?`dunning:${row.id}`:null
}
