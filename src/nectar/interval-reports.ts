// Interval recurring figures use immutable issued service allocations. The
// original annual fee is never presented as twelve times its monthly amount.
import type { Bindings } from '../auth.server'
import { all } from './core'
export async function intervalRecurringEntries(env:Bindings,period:string,customer:string|null,invoice:string|null=null) {
  return all(env,`SELECT i.id AS invoice_id,i.number,i.customer_id,c.name AS customer_name,l.id AS line_id,l.kind,l.description,
      substr(e.recognition_date,1,7) AS period,SUM(e.amount_cents) AS amount_cents
    FROM nc_invoices i JOIN nc_customers c ON c.id=i.customer_id JOIN nc_revenue_entries e ON e.invoice_id=i.id
      JOIN nc_invoice_lines l ON l.id=e.line_id
    WHERE i.status='issued' AND i.invoice_kind='recurring' AND i.billing_key<>'legacy-monthly-arrears'
      AND l.kind IN ('flat','seat','usage','overage','metric_usage','discount','cancellation_credit')
      AND substr(e.recognition_date,1,7)=? AND (? IS NULL OR i.customer_id=?) AND (? IS NULL OR i.id=?)
    GROUP BY i.id,l.id,substr(e.recognition_date,1,7) ORDER BY i.id,l.seq`,period,customer,customer,invoice,invoice)
}
export async function intervalRecurringSeries(env:Bindings,through:string,customer:string|null) {
  return all(env,`SELECT i.id AS invoice_id,substr(e.recognition_date,1,7) AS period,SUM(e.amount_cents) AS amount_cents
    FROM nc_invoices i JOIN nc_revenue_entries e ON e.invoice_id=i.id JOIN nc_invoice_lines l ON l.id=e.line_id
    WHERE i.status='issued' AND i.invoice_kind='recurring' AND i.billing_key<>'legacy-monthly-arrears'
      AND l.kind IN ('flat','seat','usage','overage','metric_usage','discount','cancellation_credit')
      AND substr(e.recognition_date,1,7)<=? AND (? IS NULL OR i.customer_id=?)
    GROUP BY i.id,substr(e.recognition_date,1,7) ORDER BY period,i.id`,through,customer,customer)
}
