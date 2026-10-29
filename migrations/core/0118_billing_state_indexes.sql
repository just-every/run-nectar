-- State capture follows the exact referenced subscription and financial rows.
-- Index those existing predicates without changing which facts are observed.
CREATE INDEX nc_invoices_subscription_status ON nc_invoices(subscription_id,status,issue_date);
CREATE INDEX nc_automatic_collections_invoice_status ON nc_automatic_collections(invoice_id,status);
CREATE INDEX nc_native_collections_invoice_status ON nc_native_collections(invoice_id,status);
CREATE INDEX nc_allocations_invoice ON nc_allocations(invoice_id);
CREATE INDEX nc_allocations_payment ON nc_allocations(payment_id);
CREATE INDEX nc_subscription_states_batch ON nc_subscription_states(json_extract(cause_json,'$.sourceBatch'));
