// The recovery report's definitive native failures also qualify for human
// dunning and churn attribution; a retry schedule is not required evidence.
export const FAILED_INVOICE_SQL = `(EXISTS(SELECT 1 FROM nc_retry_series r WHERE r.invoice_id=i.id)
 OR EXISTS(SELECT 1 FROM nc_native_collections n WHERE n.invoice_id=i.id AND n.status IN ('declined','customer_action_required') AND n.reconciled_at IS NOT NULL)
 OR EXISTS(SELECT 1 FROM nc_processor_failures f WHERE f.invoice_id=i.id))`
