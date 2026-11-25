-- Scheduled and polled reads search by invoice and subscription instead of
-- scanning every credit note, allocation and collection ever stored, and the
-- observers remember when they last swept so an idle minute reads a few rows.
CREATE INDEX nc_invoices_subscription_status ON nc_invoices(subscription_id,status,issue_date);
CREATE INDEX nc_credit_notes_invoice ON nc_credit_notes(invoice_id);
CREATE INDEX nc_allocations_invoice ON nc_allocations(invoice_id);
CREATE INDEX nc_usage_credit_applications_invoice ON nc_usage_credit_applications(invoice_id);
CREATE INDEX nc_processor_reversals_invoice ON nc_processor_reversals(invoice_id);
CREATE INDEX nc_native_collections_invoice ON nc_native_collections(invoice_id,status);
CREATE INDEX nc_automatic_collections_invoice ON nc_automatic_collections(invoice_id,status);
CREATE INDEX nc_subscriptions_customer ON nc_subscriptions(customer_id,created_at);
CREATE INDEX nc_subscription_lifecycle_subscription ON nc_subscription_lifecycle(subscription_id,seq);
-- The collection runner reads only collections that can still act.
CREATE INDEX nc_automatic_collection_open ON nc_automatic_collections(prepared_at,id)
  WHERE status IN ('active','claimed','uncertain','pending_settlement','refused','returned');
-- clean_at/clean_marker: the last finished sweep. sweep_at/sweep_marker: the sweep in progress.
ALTER TABLE nc_subscription_state_cursor ADD COLUMN clean_at INTEGER;
ALTER TABLE nc_subscription_state_cursor ADD COLUMN clean_marker TEXT;
ALTER TABLE nc_subscription_state_cursor ADD COLUMN sweep_at INTEGER;
ALTER TABLE nc_subscription_state_cursor ADD COLUMN sweep_marker TEXT;
-- swept_at: the last full pass. audit_seq/usage_rowid: the change feed already examined.
ALTER TABLE nc_webhook_observation_cursor ADD COLUMN swept_at INTEGER;
ALTER TABLE nc_webhook_observation_cursor ADD COLUMN sweep_at INTEGER;
ALTER TABLE nc_webhook_observation_cursor ADD COLUMN audit_seq INTEGER;
ALTER TABLE nc_webhook_observation_cursor ADD COLUMN usage_rowid INTEGER;
