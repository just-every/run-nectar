-- GOV-005. A generation fences the entire inventory against concurrent writes.
-- This derived singleton is excluded from portable archives by installer policy.
CREATE TABLE nc_privacy_generation (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL CHECK(typeof(value)='integer' AND value>=0));
INSERT INTO nc_privacy_generation(id,value) VALUES(1,0);

CREATE TRIGGER nc_privacy_generation_nc_agent_keys_insert AFTER INSERT ON nc_agent_keys
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_agent_keys_update AFTER UPDATE ON nc_agent_keys
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_agent_keys_delete AFTER DELETE ON nc_agent_keys
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_allocations_insert AFTER INSERT ON nc_allocations
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_allocations_update AFTER UPDATE ON nc_allocations
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_allocations_delete AFTER DELETE ON nc_allocations
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_amendments_insert AFTER INSERT ON nc_amendments
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_amendments_update AFTER UPDATE ON nc_amendments
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_amendments_delete AFTER DELETE ON nc_amendments
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_audit_insert AFTER INSERT ON nc_audit
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_audit_update AFTER UPDATE ON nc_audit
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_audit_delete AFTER DELETE ON nc_audit
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_bill_runs_insert AFTER INSERT ON nc_bill_runs
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_bill_runs_update AFTER UPDATE ON nc_bill_runs
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_bill_runs_delete AFTER DELETE ON nc_bill_runs
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_business_insert AFTER INSERT ON nc_business
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_business_update AFTER UPDATE ON nc_business
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_business_delete AFTER DELETE ON nc_business
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_cadence_deliveries_insert AFTER INSERT ON nc_cadence_deliveries
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_cadence_deliveries_update AFTER UPDATE ON nc_cadence_deliveries
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_cadence_deliveries_delete AFTER DELETE ON nc_cadence_deliveries
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_cadence_disputes_insert AFTER INSERT ON nc_cadence_disputes
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_cadence_disputes_update AFTER UPDATE ON nc_cadence_disputes
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_cadence_disputes_delete AFTER DELETE ON nc_cadence_disputes
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_cadence_enrollments_insert AFTER INSERT ON nc_cadence_enrollments
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_cadence_enrollments_update AFTER UPDATE ON nc_cadence_enrollments
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_cadence_enrollments_delete AFTER DELETE ON nc_cadence_enrollments
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_cadence_escalations_insert AFTER INSERT ON nc_cadence_escalations
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_cadence_escalations_update AFTER UPDATE ON nc_cadence_escalations
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_cadence_escalations_delete AFTER DELETE ON nc_cadence_escalations
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_cadence_policy_insert AFTER INSERT ON nc_cadence_policy
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_cadence_policy_update AFTER UPDATE ON nc_cadence_policy
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_cadence_policy_delete AFTER DELETE ON nc_cadence_policy
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_cadence_policy_requests_insert AFTER INSERT ON nc_cadence_policy_requests
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_cadence_policy_requests_update AFTER UPDATE ON nc_cadence_policy_requests
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_cadence_policy_requests_delete AFTER DELETE ON nc_cadence_policy_requests
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_cadence_promises_insert AFTER INSERT ON nc_cadence_promises
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_cadence_promises_update AFTER UPDATE ON nc_cadence_promises
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_cadence_promises_delete AFTER DELETE ON nc_cadence_promises
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_certificate_policy_insert AFTER INSERT ON nc_certificate_policy
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_certificate_policy_update AFTER UPDATE ON nc_certificate_policy
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_certificate_policy_delete AFTER DELETE ON nc_certificate_policy
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_certificate_reminders_insert AFTER INSERT ON nc_certificate_reminders
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_certificate_reminders_update AFTER UPDATE ON nc_certificate_reminders
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_certificate_reminders_delete AFTER DELETE ON nc_certificate_reminders
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_certificates_insert AFTER INSERT ON nc_certificates
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_certificates_update AFTER UPDATE ON nc_certificates
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_certificates_delete AFTER DELETE ON nc_certificates
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_changes_insert AFTER INSERT ON nc_changes
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_changes_update AFTER UPDATE ON nc_changes
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_changes_delete AFTER DELETE ON nc_changes
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_charges_insert AFTER INSERT ON nc_charges
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_charges_update AFTER UPDATE ON nc_charges
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_charges_delete AFTER DELETE ON nc_charges
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_contacts_insert AFTER INSERT ON nc_contacts
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_contacts_update AFTER UPDATE ON nc_contacts
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_contacts_delete AFTER DELETE ON nc_contacts
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_contracts_insert AFTER INSERT ON nc_contracts
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_contracts_update AFTER UPDATE ON nc_contracts
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_contracts_delete AFTER DELETE ON nc_contracts
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_credit_correction_mail_insert AFTER INSERT ON nc_credit_correction_mail
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_credit_correction_mail_update AFTER UPDATE ON nc_credit_correction_mail
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_credit_correction_mail_delete AFTER DELETE ON nc_credit_correction_mail
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_credit_correction_requests_insert AFTER INSERT ON nc_credit_correction_requests
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_credit_correction_requests_update AFTER UPDATE ON nc_credit_correction_requests
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_credit_correction_requests_delete AFTER DELETE ON nc_credit_correction_requests
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_credit_notes_insert AFTER INSERT ON nc_credit_notes
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_credit_notes_update AFTER UPDATE ON nc_credit_notes
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_credit_notes_delete AFTER DELETE ON nc_credit_notes
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_credit_policy_insert AFTER INSERT ON nc_credit_policy
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_credit_policy_update AFTER UPDATE ON nc_credit_policy
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_credit_policy_delete AFTER DELETE ON nc_credit_policy
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_credit_requests_insert AFTER INSERT ON nc_credit_requests
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_credit_requests_update AFTER UPDATE ON nc_credit_requests
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_credit_requests_delete AFTER DELETE ON nc_credit_requests
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_customers_insert AFTER INSERT ON nc_customers
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_customers_update AFTER UPDATE ON nc_customers
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_customers_delete AFTER DELETE ON nc_customers
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_draft_correction_mail_insert AFTER INSERT ON nc_draft_correction_mail
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_draft_correction_mail_update AFTER UPDATE ON nc_draft_correction_mail
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_draft_correction_mail_delete AFTER DELETE ON nc_draft_correction_mail
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_exemption_claims_insert AFTER INSERT ON nc_exemption_claims
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_exemption_claims_update AFTER UPDATE ON nc_exemption_claims
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_exemption_claims_delete AFTER DELETE ON nc_exemption_claims
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_features_insert AFTER INSERT ON nc_features
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_features_update AFTER UPDATE ON nc_features
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_features_delete AFTER DELETE ON nc_features
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_incumbent_invoices_insert AFTER INSERT ON nc_incumbent_invoices
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_incumbent_invoices_update AFTER UPDATE ON nc_incumbent_invoices
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_incumbent_invoices_delete AFTER DELETE ON nc_incumbent_invoices
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_invoice_lines_insert AFTER INSERT ON nc_invoice_lines
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_invoice_lines_update AFTER UPDATE ON nc_invoice_lines
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_invoice_lines_delete AFTER DELETE ON nc_invoice_lines
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_invoices_insert AFTER INSERT ON nc_invoices
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_invoices_update AFTER UPDATE ON nc_invoices
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_invoices_delete AFTER DELETE ON nc_invoices
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_items_insert AFTER INSERT ON nc_items
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_items_update AFTER UPDATE ON nc_items
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_items_delete AFTER DELETE ON nc_items
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_lifecycle_policy_insert AFTER INSERT ON nc_lifecycle_policy
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_lifecycle_policy_update AFTER UPDATE ON nc_lifecycle_policy
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_lifecycle_policy_delete AFTER DELETE ON nc_lifecycle_policy
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_metadata_revisions_insert AFTER INSERT ON nc_metadata_revisions
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_metadata_revisions_update AFTER UPDATE ON nc_metadata_revisions
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_metadata_revisions_delete AFTER DELETE ON nc_metadata_revisions
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_meters_insert AFTER INSERT ON nc_meters
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_meters_update AFTER UPDATE ON nc_meters
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_meters_delete AFTER DELETE ON nc_meters
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_metric_previews_insert AFTER INSERT ON nc_metric_previews
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_metric_previews_update AFTER UPDATE ON nc_metric_previews
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_metric_previews_delete AFTER DELETE ON nc_metric_previews
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_metric_requests_insert AFTER INSERT ON nc_metric_requests
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_metric_requests_update AFTER UPDATE ON nc_metric_requests
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_metric_requests_delete AFTER DELETE ON nc_metric_requests
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_note_mentions_insert AFTER INSERT ON nc_note_mentions
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_note_mentions_update AFTER UPDATE ON nc_note_mentions
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_note_mentions_delete AFTER DELETE ON nc_note_mentions
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_notes_insert AFTER INSERT ON nc_notes
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_notes_update AFTER UPDATE ON nc_notes
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_notes_delete AFTER DELETE ON nc_notes
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_notices_insert AFTER INSERT ON nc_notices
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_notices_update AFTER UPDATE ON nc_notices
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_notices_delete AFTER DELETE ON nc_notices
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_notification_preferences_insert AFTER INSERT ON nc_notification_preferences
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_notification_preferences_update AFTER UPDATE ON nc_notification_preferences
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_notification_preferences_delete AFTER DELETE ON nc_notification_preferences
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_notifications_insert AFTER INSERT ON nc_notifications
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_notifications_update AFTER UPDATE ON nc_notifications
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_notifications_delete AFTER DELETE ON nc_notifications
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_payments_insert AFTER INSERT ON nc_payments
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_payments_update AFTER UPDATE ON nc_payments
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_payments_delete AFTER DELETE ON nc_payments
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_policy_changes_insert AFTER INSERT ON nc_policy_changes
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_policy_changes_update AFTER UPDATE ON nc_policy_changes
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_policy_changes_delete AFTER DELETE ON nc_policy_changes
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_price_requests_insert AFTER INSERT ON nc_price_requests
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_price_requests_update AFTER UPDATE ON nc_price_requests
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_price_requests_delete AFTER DELETE ON nc_price_requests
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_prices_insert AFTER INSERT ON nc_prices
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_prices_update AFTER UPDATE ON nc_prices
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_prices_delete AFTER DELETE ON nc_prices
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_products_insert AFTER INSERT ON nc_products
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_products_update AFTER UPDATE ON nc_products
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_products_delete AFTER DELETE ON nc_products
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_proposals_insert AFTER INSERT ON nc_proposals
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_proposals_update AFTER UPDATE ON nc_proposals
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_proposals_delete AFTER DELETE ON nc_proposals
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_renewal_events_insert AFTER INSERT ON nc_renewal_events
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_renewal_events_update AFTER UPDATE ON nc_renewal_events
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_renewal_events_delete AFTER DELETE ON nc_renewal_events
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_renewal_notices_insert AFTER INSERT ON nc_renewal_notices
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_renewal_notices_update AFTER UPDATE ON nc_renewal_notices
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_renewal_notices_delete AFTER DELETE ON nc_renewal_notices
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_renewal_terms_insert AFTER INSERT ON nc_renewal_terms
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_renewal_terms_update AFTER UPDATE ON nc_renewal_terms
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_renewal_terms_delete AFTER DELETE ON nc_renewal_terms
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_report_deliveries_insert AFTER INSERT ON nc_report_deliveries
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_report_deliveries_update AFTER UPDATE ON nc_report_deliveries
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_report_deliveries_delete AFTER DELETE ON nc_report_deliveries
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_report_schedules_insert AFTER INSERT ON nc_report_schedules
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_report_schedules_update AFTER UPDATE ON nc_report_schedules
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_report_schedules_delete AFTER DELETE ON nc_report_schedules
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_retention_offers_insert AFTER INSERT ON nc_retention_offers
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_retention_offers_update AFTER UPDATE ON nc_retention_offers
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_retention_offers_delete AFTER DELETE ON nc_retention_offers
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_retention_policies_insert AFTER INSERT ON nc_retention_policies
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_retention_policies_update AFTER UPDATE ON nc_retention_policies
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_retention_policies_delete AFTER DELETE ON nc_retention_policies
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_subscription_lifecycle_insert AFTER INSERT ON nc_subscription_lifecycle
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_subscription_lifecycle_update AFTER UPDATE ON nc_subscription_lifecycle
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_subscription_lifecycle_delete AFTER DELETE ON nc_subscription_lifecycle
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_subscriptions_insert AFTER INSERT ON nc_subscriptions
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_subscriptions_update AFTER UPDATE ON nc_subscriptions
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_subscriptions_delete AFTER DELETE ON nc_subscriptions
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_tasks_insert AFTER INSERT ON nc_tasks
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_tasks_update AFTER UPDATE ON nc_tasks
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_tasks_delete AFTER DELETE ON nc_tasks
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_usage_batches_insert AFTER INSERT ON nc_usage_batches
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_usage_batches_update AFTER UPDATE ON nc_usage_batches
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_usage_batches_delete AFTER DELETE ON nc_usage_batches
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_usage_controls_insert AFTER INSERT ON nc_usage_controls
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_usage_controls_update AFTER UPDATE ON nc_usage_controls
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_usage_controls_delete AFTER DELETE ON nc_usage_controls
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_usage_events_insert AFTER INSERT ON nc_usage_events
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_usage_events_update AFTER UPDATE ON nc_usage_events
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_usage_events_delete AFTER DELETE ON nc_usage_events
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;

-- Erased financial parents remain for custody; ordinary writes cannot add
-- personal data to them or move an erased child to another customer.
CREATE TRIGGER nc_privacy_owned_nc_allocations_insert BEFORE INSERT ON nc_allocations
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_invoices p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.invoice_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_payments p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.payment_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_allocations_update BEFORE UPDATE ON nc_allocations
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_invoices p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.invoice_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_payments p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.payment_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_invoices p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=OLD.invoice_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_payments p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=OLD.payment_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_amendments_insert BEFORE INSERT ON nc_amendments
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_subscriptions p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.subscription_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_amendments_update BEFORE UPDATE ON nc_amendments
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_subscriptions p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.subscription_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_subscriptions p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=OLD.subscription_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_cadence_deliveries_insert BEFORE INSERT ON nc_cadence_deliveries
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_invoices p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.invoice_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_cadence_deliveries_update BEFORE UPDATE ON nc_cadence_deliveries
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_invoices p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.invoice_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_invoices p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=OLD.invoice_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_cadence_disputes_insert BEFORE INSERT ON nc_cadence_disputes
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_invoices p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.invoice_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_invoice_lines p0 JOIN nc_invoices p1 ON p1.id=p0.invoice_id JOIN nc_customers p2 ON p2.id=p1.customer_id WHERE p0.id=NEW.line_id AND p2.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_cadence_disputes_update BEFORE UPDATE ON nc_cadence_disputes
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_invoices p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.invoice_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_invoice_lines p0 JOIN nc_invoices p1 ON p1.id=p0.invoice_id JOIN nc_customers p2 ON p2.id=p1.customer_id WHERE p0.id=NEW.line_id AND p2.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_invoices p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=OLD.invoice_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_invoice_lines p0 JOIN nc_invoices p1 ON p1.id=p0.invoice_id JOIN nc_customers p2 ON p2.id=p1.customer_id WHERE p0.id=OLD.line_id AND p2.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_cadence_enrollments_insert BEFORE INSERT ON nc_cadence_enrollments
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_invoices p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.invoice_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_cadence_enrollments_update BEFORE UPDATE ON nc_cadence_enrollments
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_invoices p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.invoice_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_invoices p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=OLD.invoice_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_cadence_escalations_insert BEFORE INSERT ON nc_cadence_escalations
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_invoices p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.invoice_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_tasks p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.task_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_cadence_escalations_update BEFORE UPDATE ON nc_cadence_escalations
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_invoices p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.invoice_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_tasks p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.task_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_invoices p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=OLD.invoice_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_tasks p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=OLD.task_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_cadence_promises_insert BEFORE INSERT ON nc_cadence_promises
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_invoices p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.invoice_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_cadence_promises_update BEFORE UPDATE ON nc_cadence_promises
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_invoices p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.invoice_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_invoices p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=OLD.invoice_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_certificate_reminders_insert BEFORE INSERT ON nc_certificate_reminders
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=NEW.customer_id AND p0.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_certificate_reminders_update BEFORE UPDATE ON nc_certificate_reminders
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=NEW.customer_id AND p0.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=OLD.customer_id AND p0.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_certificates_insert BEFORE INSERT ON nc_certificates
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=NEW.customer_id AND p0.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_certificates_update BEFORE UPDATE ON nc_certificates
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=NEW.customer_id AND p0.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=OLD.customer_id AND p0.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_changes_insert BEFORE INSERT ON nc_changes
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_items p0 JOIN nc_subscriptions p1 ON p1.id=p0.subscription_id JOIN nc_customers p2 ON p2.id=p1.customer_id WHERE p0.id=NEW.item_id AND p2.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_subscriptions p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.subscription_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_changes_update BEFORE UPDATE ON nc_changes
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_items p0 JOIN nc_subscriptions p1 ON p1.id=p0.subscription_id JOIN nc_customers p2 ON p2.id=p1.customer_id WHERE p0.id=NEW.item_id AND p2.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_subscriptions p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.subscription_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_items p0 JOIN nc_subscriptions p1 ON p1.id=p0.subscription_id JOIN nc_customers p2 ON p2.id=p1.customer_id WHERE p0.id=OLD.item_id AND p2.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_subscriptions p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=OLD.subscription_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_charges_insert BEFORE INSERT ON nc_charges
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=NEW.customer_id AND p0.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_invoices p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.invoice_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_subscriptions p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.subscription_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_charges_update BEFORE UPDATE ON nc_charges
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=NEW.customer_id AND p0.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_invoices p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.invoice_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_subscriptions p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.subscription_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=OLD.customer_id AND p0.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_invoices p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=OLD.invoice_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_subscriptions p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=OLD.subscription_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_contacts_insert BEFORE INSERT ON nc_contacts
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=NEW.customer_id AND p0.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_contacts_update BEFORE UPDATE ON nc_contacts
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=NEW.customer_id AND p0.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=OLD.customer_id AND p0.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_contracts_insert BEFORE INSERT ON nc_contracts
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_subscriptions p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.subscription_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_contracts_update BEFORE UPDATE ON nc_contracts
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_subscriptions p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.subscription_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_subscriptions p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=OLD.subscription_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_credit_correction_mail_insert BEFORE INSERT ON nc_credit_correction_mail
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_credit_notes p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.credit_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=NEW.customer_id AND p0.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_credit_correction_mail_update BEFORE UPDATE ON nc_credit_correction_mail
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_credit_notes p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.credit_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=NEW.customer_id AND p0.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_credit_notes p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=OLD.credit_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=OLD.customer_id AND p0.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_credit_correction_requests_insert BEFORE INSERT ON nc_credit_correction_requests
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_credit_requests p0 JOIN nc_credit_notes p1 ON p1.id=p0.credit_id JOIN nc_customers p2 ON p2.id=p1.customer_id WHERE p0.id=NEW.request_id AND p2.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_credit_correction_requests_update BEFORE UPDATE ON nc_credit_correction_requests
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_credit_requests p0 JOIN nc_credit_notes p1 ON p1.id=p0.credit_id JOIN nc_customers p2 ON p2.id=p1.customer_id WHERE p0.id=NEW.request_id AND p2.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_credit_requests p0 JOIN nc_credit_notes p1 ON p1.id=p0.credit_id JOIN nc_customers p2 ON p2.id=p1.customer_id WHERE p0.id=OLD.request_id AND p2.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_credit_notes_insert BEFORE INSERT ON nc_credit_notes
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=NEW.customer_id AND p0.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_invoices p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.invoice_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_credit_notes_update BEFORE UPDATE ON nc_credit_notes
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=NEW.customer_id AND p0.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_invoices p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.invoice_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=OLD.customer_id AND p0.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_invoices p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=OLD.invoice_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_credit_requests_insert BEFORE INSERT ON nc_credit_requests
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_credit_notes p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.credit_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_invoices p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.invoice_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_credit_requests_update BEFORE UPDATE ON nc_credit_requests
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_credit_notes p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.credit_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_invoices p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.invoice_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_credit_notes p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=OLD.credit_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_invoices p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=OLD.invoice_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_customers_insert BEFORE INSERT ON nc_customers
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_customers c WHERE c.id=NEW.id AND c.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_customers_update BEFORE UPDATE ON nc_customers
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  OLD.erased_at IS NOT NULL
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_draft_correction_mail_insert BEFORE INSERT ON nc_draft_correction_mail
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=NEW.customer_id AND p0.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_draft_correction_mail_update BEFORE UPDATE ON nc_draft_correction_mail
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=NEW.customer_id AND p0.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=OLD.customer_id AND p0.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_exemption_claims_insert BEFORE INSERT ON nc_exemption_claims
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=NEW.customer_id AND p0.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_exemption_claims_update BEFORE UPDATE ON nc_exemption_claims
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=NEW.customer_id AND p0.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=OLD.customer_id AND p0.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_incumbent_invoices_insert BEFORE INSERT ON nc_incumbent_invoices
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=NEW.customer_id AND p0.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_subscriptions p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.subscription_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_incumbent_invoices_update BEFORE UPDATE ON nc_incumbent_invoices
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=NEW.customer_id AND p0.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_subscriptions p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.subscription_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=OLD.customer_id AND p0.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_subscriptions p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=OLD.subscription_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_invoice_lines_insert BEFORE INSERT ON nc_invoice_lines
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_invoices p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.invoice_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_invoice_lines_update BEFORE UPDATE ON nc_invoice_lines
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_invoices p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.invoice_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_invoices p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=OLD.invoice_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_invoices_insert BEFORE INSERT ON nc_invoices
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=NEW.customer_id AND p0.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_subscriptions p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.subscription_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_invoices_update BEFORE UPDATE ON nc_invoices
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=NEW.customer_id AND p0.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_subscriptions p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.subscription_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=OLD.customer_id AND p0.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_subscriptions p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=OLD.subscription_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_items_insert BEFORE INSERT ON nc_items
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_subscriptions p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.subscription_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_items_update BEFORE UPDATE ON nc_items
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_subscriptions p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.subscription_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_subscriptions p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=OLD.subscription_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_metric_previews_insert BEFORE INSERT ON nc_metric_previews
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=NEW.customer_id AND p0.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_metric_previews_update BEFORE UPDATE ON nc_metric_previews
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=NEW.customer_id AND p0.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=OLD.customer_id AND p0.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_note_mentions_insert BEFORE INSERT ON nc_note_mentions
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_notes p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.note_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_note_mentions_update BEFORE UPDATE ON nc_note_mentions
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_notes p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.note_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_notes p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=OLD.note_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_notes_insert BEFORE INSERT ON nc_notes
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=NEW.customer_id AND p0.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_notes_update BEFORE UPDATE ON nc_notes
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=NEW.customer_id AND p0.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=OLD.customer_id AND p0.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_notices_insert BEFORE INSERT ON nc_notices
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=NEW.customer_id AND p0.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_notices_update BEFORE UPDATE ON nc_notices
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=NEW.customer_id AND p0.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=OLD.customer_id AND p0.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_payments_insert BEFORE INSERT ON nc_payments
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=NEW.customer_id AND p0.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_payments_update BEFORE UPDATE ON nc_payments
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=NEW.customer_id AND p0.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=OLD.customer_id AND p0.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_renewal_events_insert BEFORE INSERT ON nc_renewal_events
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_subscriptions p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.subscription_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_renewal_terms p0 JOIN nc_subscriptions p1 ON p1.id=p0.subscription_id JOIN nc_customers p2 ON p2.id=p1.customer_id WHERE p0.id=NEW.term_id AND p2.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_renewal_events_update BEFORE UPDATE ON nc_renewal_events
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_subscriptions p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.subscription_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_renewal_terms p0 JOIN nc_subscriptions p1 ON p1.id=p0.subscription_id JOIN nc_customers p2 ON p2.id=p1.customer_id WHERE p0.id=NEW.term_id AND p2.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_subscriptions p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=OLD.subscription_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_renewal_terms p0 JOIN nc_subscriptions p1 ON p1.id=p0.subscription_id JOIN nc_customers p2 ON p2.id=p1.customer_id WHERE p0.id=OLD.term_id AND p2.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_renewal_notices_insert BEFORE INSERT ON nc_renewal_notices
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_renewal_terms p0 JOIN nc_subscriptions p1 ON p1.id=p0.subscription_id JOIN nc_customers p2 ON p2.id=p1.customer_id WHERE p0.id=NEW.term_id AND p2.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_renewal_notices_update BEFORE UPDATE ON nc_renewal_notices
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_renewal_terms p0 JOIN nc_subscriptions p1 ON p1.id=p0.subscription_id JOIN nc_customers p2 ON p2.id=p1.customer_id WHERE p0.id=NEW.term_id AND p2.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_renewal_terms p0 JOIN nc_subscriptions p1 ON p1.id=p0.subscription_id JOIN nc_customers p2 ON p2.id=p1.customer_id WHERE p0.id=OLD.term_id AND p2.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_renewal_terms_insert BEFORE INSERT ON nc_renewal_terms
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_subscriptions p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.subscription_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_renewal_terms_update BEFORE UPDATE ON nc_renewal_terms
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_subscriptions p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.subscription_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_subscriptions p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=OLD.subscription_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_retention_offers_insert BEFORE INSERT ON nc_retention_offers
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_subscriptions p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.subscription_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_retention_offers_update BEFORE UPDATE ON nc_retention_offers
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_subscriptions p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.subscription_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_subscriptions p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=OLD.subscription_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_subscription_lifecycle_insert BEFORE INSERT ON nc_subscription_lifecycle
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_subscription_lifecycle p0 JOIN nc_subscriptions p1 ON p1.id=p0.subscription_id JOIN nc_customers p2 ON p2.id=p1.customer_id WHERE p0.id=NEW.related_id AND p2.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_subscriptions p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.subscription_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_subscription_lifecycle_update BEFORE UPDATE ON nc_subscription_lifecycle
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_subscription_lifecycle p0 JOIN nc_subscriptions p1 ON p1.id=p0.subscription_id JOIN nc_customers p2 ON p2.id=p1.customer_id WHERE p0.id=NEW.related_id AND p2.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_subscriptions p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.subscription_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_subscription_lifecycle p0 JOIN nc_subscriptions p1 ON p1.id=p0.subscription_id JOIN nc_customers p2 ON p2.id=p1.customer_id WHERE p0.id=OLD.related_id AND p2.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_subscriptions p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=OLD.subscription_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_subscriptions_insert BEFORE INSERT ON nc_subscriptions
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=NEW.customer_id AND p0.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_subscriptions_update BEFORE UPDATE ON nc_subscriptions
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=NEW.customer_id AND p0.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=OLD.customer_id AND p0.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_tasks_insert BEFORE INSERT ON nc_tasks
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=NEW.customer_id AND p0.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_invoices p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.invoice_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_tasks_update BEFORE UPDATE ON nc_tasks
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=NEW.customer_id AND p0.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_invoices p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.invoice_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=OLD.customer_id AND p0.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_invoices p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=OLD.invoice_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_usage_controls_insert BEFORE INSERT ON nc_usage_controls
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=NEW.customer_id AND p0.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_usage_controls_update BEFORE UPDATE ON nc_usage_controls
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=NEW.customer_id AND p0.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=OLD.customer_id AND p0.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_usage_events_insert BEFORE INSERT ON nc_usage_events
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=NEW.customer_id AND p0.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_invoices p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.invoice_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_usage_events_update BEFORE UPDATE ON nc_usage_events
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=NEW.customer_id AND p0.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_invoices p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=NEW.invoice_id AND p1.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_customers p0 WHERE p0.id=OLD.customer_id AND p0.erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM nc_invoices p0 JOIN nc_customers p1 ON p1.id=p0.customer_id WHERE p0.id=OLD.invoice_id AND p1.erased_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_metadata_insert BEFORE INSERT ON nc_metadata_revisions
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  (NEW.kind='customer' AND EXISTS(SELECT 1 FROM nc_customers c WHERE c.id=NEW.record_id AND c.erased_at IS NOT NULL))
  OR (NEW.kind='subscription' AND EXISTS(SELECT 1 FROM nc_subscriptions r JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=NEW.record_id AND c.erased_at IS NOT NULL))
  OR (NEW.kind='invoice' AND EXISTS(SELECT 1 FROM nc_invoices r JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=NEW.record_id AND c.erased_at IS NOT NULL))
  OR (NEW.kind='payment' AND EXISTS(SELECT 1 FROM nc_payments r JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=NEW.record_id AND c.erased_at IS NOT NULL))
  OR (NEW.kind='credit-note' AND EXISTS(SELECT 1 FROM nc_credit_notes r JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=NEW.record_id AND c.erased_at IS NOT NULL))
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_metadata_update BEFORE UPDATE ON nc_metadata_revisions
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  (NEW.kind='customer' AND EXISTS(SELECT 1 FROM nc_customers c WHERE c.id=NEW.record_id AND c.erased_at IS NOT NULL))
  OR (NEW.kind='subscription' AND EXISTS(SELECT 1 FROM nc_subscriptions r JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=NEW.record_id AND c.erased_at IS NOT NULL))
  OR (NEW.kind='invoice' AND EXISTS(SELECT 1 FROM nc_invoices r JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=NEW.record_id AND c.erased_at IS NOT NULL))
  OR (NEW.kind='payment' AND EXISTS(SELECT 1 FROM nc_payments r JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=NEW.record_id AND c.erased_at IS NOT NULL))
  OR (NEW.kind='credit-note' AND EXISTS(SELECT 1 FROM nc_credit_notes r JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=NEW.record_id AND c.erased_at IS NOT NULL))
  OR (OLD.kind='customer' AND EXISTS(SELECT 1 FROM nc_customers c WHERE c.id=OLD.record_id AND c.erased_at IS NOT NULL))
  OR (OLD.kind='subscription' AND EXISTS(SELECT 1 FROM nc_subscriptions r JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=OLD.record_id AND c.erased_at IS NOT NULL))
  OR (OLD.kind='invoice' AND EXISTS(SELECT 1 FROM nc_invoices r JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=OLD.record_id AND c.erased_at IS NOT NULL))
  OR (OLD.kind='payment' AND EXISTS(SELECT 1 FROM nc_payments r JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=OLD.record_id AND c.erased_at IS NOT NULL))
  OR (OLD.kind='credit-note' AND EXISTS(SELECT 1 FROM nc_credit_notes r JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=OLD.record_id AND c.erased_at IS NOT NULL))
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_proposal_insert BEFORE INSERT ON nc_proposals
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM (SELECT value FROM json_tree(NEW.payload_json) WHERE type='text' UNION ALL SELECT value FROM json_tree(NEW.evidence_json) WHERE type='text' UNION ALL SELECT value FROM json_tree(NEW.impact_json) WHERE type='text' UNION ALL SELECT value FROM json_tree(NEW.basis_json) WHERE type='text' UNION ALL SELECT value FROM json_tree(NEW.result_json) WHERE type='text') j WHERE EXISTS(SELECT 1 FROM nc_customers c WHERE c.erased_at IS NOT NULL AND (c.id=j.value OR c.external_id=j.value OR c.provider_ref=j.value)) OR EXISTS(SELECT 1 FROM nc_subscriptions r JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=j.value AND c.erased_at IS NOT NULL) OR EXISTS(SELECT 1 FROM nc_invoices r JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=j.value AND c.erased_at IS NOT NULL) OR EXISTS(SELECT 1 FROM nc_payments r JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=j.value AND c.erased_at IS NOT NULL) OR EXISTS(SELECT 1 FROM nc_credit_notes r JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=j.value AND c.erased_at IS NOT NULL))
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_proposal_update BEFORE UPDATE ON nc_proposals
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
  EXISTS(SELECT 1 FROM (SELECT value FROM json_tree(NEW.payload_json) WHERE type='text' UNION ALL SELECT value FROM json_tree(NEW.evidence_json) WHERE type='text' UNION ALL SELECT value FROM json_tree(NEW.impact_json) WHERE type='text' UNION ALL SELECT value FROM json_tree(NEW.basis_json) WHERE type='text' UNION ALL SELECT value FROM json_tree(NEW.result_json) WHERE type='text') j WHERE EXISTS(SELECT 1 FROM nc_customers c WHERE c.erased_at IS NOT NULL AND (c.id=j.value OR c.external_id=j.value OR c.provider_ref=j.value)) OR EXISTS(SELECT 1 FROM nc_subscriptions r JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=j.value AND c.erased_at IS NOT NULL) OR EXISTS(SELECT 1 FROM nc_invoices r JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=j.value AND c.erased_at IS NOT NULL) OR EXISTS(SELECT 1 FROM nc_payments r JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=j.value AND c.erased_at IS NOT NULL) OR EXISTS(SELECT 1 FROM nc_credit_notes r JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=j.value AND c.erased_at IS NOT NULL))
  OR EXISTS(SELECT 1 FROM (SELECT value FROM json_tree(OLD.payload_json) WHERE type='text' UNION ALL SELECT value FROM json_tree(OLD.evidence_json) WHERE type='text' UNION ALL SELECT value FROM json_tree(OLD.impact_json) WHERE type='text' UNION ALL SELECT value FROM json_tree(OLD.basis_json) WHERE type='text' UNION ALL SELECT value FROM json_tree(OLD.result_json) WHERE type='text') j WHERE EXISTS(SELECT 1 FROM nc_customers c WHERE c.erased_at IS NOT NULL AND (c.id=j.value OR c.external_id=j.value OR c.provider_ref=j.value)) OR EXISTS(SELECT 1 FROM nc_subscriptions r JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=j.value AND c.erased_at IS NOT NULL) OR EXISTS(SELECT 1 FROM nc_invoices r JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=j.value AND c.erased_at IS NOT NULL) OR EXISTS(SELECT 1 FROM nc_payments r JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=j.value AND c.erased_at IS NOT NULL) OR EXISTS(SELECT 1 FROM nc_credit_notes r JOIN nc_customers c ON c.id=r.customer_id WHERE r.id=j.value AND c.erased_at IS NOT NULL))
) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
