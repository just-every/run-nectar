-- GOV-005. The privacy write context exists only inside the owner-approved
-- atomic erasure batch. Ordinary financial/audit writes remain immutable.
ALTER TABLE nc_customers ADD COLUMN erased_at INTEGER;
ALTER TABLE nc_invoices ADD COLUMN legal_name TEXT;
CREATE TABLE nc_erasure_requests (
 id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','verified','complete')),
 customer_revision TEXT NOT NULL, recipient TEXT NOT NULL, claimed_email TEXT NOT NULL DEFAULT '', token_hash TEXT UNIQUE,
 expires_at INTEGER NOT NULL, requested_by TEXT NOT NULL, requested_at INTEGER NOT NULL,
 mail_status TEXT NOT NULL DEFAULT 'sending', provider_ref TEXT,
 verified_at INTEGER, verified_method TEXT, verification_reason TEXT,
 evidence_name TEXT, evidence_type TEXT, evidence_base64 TEXT, evidence_sha256 TEXT, evidence_size INTEGER,
 approved_by TEXT, approved_at INTEGER, receipt_json TEXT, retain_until TEXT, purged_at INTEGER
);
CREATE TABLE nc_erased_records (record_id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES nc_erasure_requests(id));
CREATE TABLE nc_privacy_context (request_id TEXT PRIMARY KEY REFERENCES nc_erasure_requests(id));
CREATE TRIGGER nc_privacy_authorized BEFORE INSERT ON nc_privacy_context
WHEN NOT EXISTS(SELECT 1 FROM nc_erasure_requests WHERE id=NEW.request_id AND status='verified' AND approved_by IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'nectar_guard_failed'); END;
CREATE TABLE nc_erasure_financial (
 request_id TEXT NOT NULL REFERENCES nc_erasure_requests(id), kind TEXT NOT NULL, record_id TEXT NOT NULL,
 legal_name TEXT NOT NULL, amount_cents INTEGER NOT NULL, tax_cents INTEGER NOT NULL DEFAULT 0,
 document_date TEXT NOT NULL, retain_until TEXT NOT NULL, tax_json TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(kind,record_id)
);
DROP TRIGGER nc_prices_immutable;
CREATE TRIGGER nc_prices_immutable BEFORE UPDATE OF id, product_id, version, kind, unit_amount, meter_id, billing_interval, taxable, origin, created_by, created_at ON nc_prices  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_amendments_decided;
CREATE TRIGGER nc_amendments_decided BEFORE UPDATE ON nc_amendments WHEN (OLD.status <> 'proposed') AND NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_usage_immutable;
CREATE TRIGGER nc_usage_immutable BEFORE UPDATE OF id, event_id, meter_id, customer_id, quantity, occurred_at, occurred_text, received_at, batch_id, payload_hash ON nc_usage_events  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_usage_keep;
CREATE TRIGGER nc_usage_keep BEFORE DELETE ON nc_usage_events  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_invoices_issued;
CREATE TRIGGER nc_invoices_issued BEFORE UPDATE ON nc_invoices WHEN (OLD.status = 'issued') AND NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_invoices_keep;
CREATE TRIGGER nc_invoices_keep BEFORE DELETE ON nc_invoices  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_lines_immutable;
CREATE TRIGGER nc_lines_immutable BEFORE UPDATE ON nc_invoice_lines  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_lines_keep;
CREATE TRIGGER nc_lines_keep BEFORE DELETE ON nc_invoice_lines  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_credit_notes_immutable;
CREATE TRIGGER nc_credit_notes_immutable BEFORE UPDATE ON nc_credit_notes  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_credit_notes_keep;
CREATE TRIGGER nc_credit_notes_keep BEFORE DELETE ON nc_credit_notes  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_payments_immutable;
CREATE TRIGGER nc_payments_immutable BEFORE UPDATE ON nc_payments  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_payments_keep;
CREATE TRIGGER nc_payments_keep BEFORE DELETE ON nc_payments  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_allocations_immutable;
CREATE TRIGGER nc_allocations_immutable BEFORE UPDATE ON nc_allocations  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_allocations_keep;
CREATE TRIGGER nc_allocations_keep BEFORE DELETE ON nc_allocations  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_proposals_decided;
CREATE TRIGGER nc_proposals_decided BEFORE UPDATE ON nc_proposals WHEN (OLD.status <> 'pending') AND NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_audit_no_update;
CREATE TRIGGER nc_audit_no_update BEFORE UPDATE ON nc_audit  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_audit_no_delete;
CREATE TRIGGER nc_audit_no_delete BEFORE DELETE ON nc_audit  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_price_models_immutable;
CREATE TRIGGER nc_price_models_immutable BEFORE UPDATE OF pricing_model, tiers_json, package_size ON nc_prices
 WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_certificates_content;
CREATE TRIGGER nc_certificates_content BEFORE UPDATE OF customer_id,state,reference,valid_from,expires_on,filename,media_type,content_base64,sha256,collected_by,collected_at ON nc_certificates  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_certificates_review;
CREATE TRIGGER nc_certificates_review BEFORE UPDATE ON nc_certificates WHEN (OLD.status != 'pending') AND NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_certificates_keep;
CREATE TRIGGER nc_certificates_keep BEFORE DELETE ON nc_certificates  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_credit_request_content;
CREATE TRIGGER nc_credit_request_content BEFORE UPDATE OF invoice_id,amount_cents,reason,prepared_by,prepared_name,prepared_at,basis,policy_revision,balance_cents ON nc_credit_requests  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_credit_request_issued;
CREATE TRIGGER nc_credit_request_issued BEFORE UPDATE ON nc_credit_requests WHEN (OLD.status='issued') AND NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_credit_request_keep;
CREATE TRIGGER nc_credit_request_keep BEFORE DELETE ON nc_credit_requests  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_charge_content;
CREATE TRIGGER nc_charge_content BEFORE UPDATE OF customer_id,subscription_id,price_id,description,quantity,unit_amount,amount_cents,taxable,effective_date,pricing_evidence_json,created_by,created_at ON nc_charges  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
DROP TRIGGER nc_charge_consumed;
CREATE TRIGGER nc_charge_consumed BEFORE UPDATE ON nc_charges WHEN (OLD.invoice_id IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
DROP TRIGGER nc_charge_keep;
CREATE TRIGGER nc_charge_keep BEFORE DELETE ON nc_charges  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
DROP TRIGGER nc_proposal_content;
CREATE TRIGGER nc_proposal_content BEFORE UPDATE OF kind,title,payload_json,evidence_json,impact_json,basis_json,created_by,created_by_kind,created_at,prepared_by_id ON nc_proposals  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_amendment_preparer;
CREATE TRIGGER nc_amendment_preparer BEFORE UPDATE OF prepared_by_id ON nc_amendments  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_change_preparer;
CREATE TRIGGER nc_change_preparer BEFORE UPDATE OF prepared_by_id ON nc_changes  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_policy_change_content;
CREATE TRIGGER nc_policy_change_content BEFORE UPDATE OF kind,payload_json,base_revision,prepared_by_id,prepared_by,prepared_at ON nc_policy_changes  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_policy_change_decided;
CREATE TRIGGER nc_policy_change_decided BEFORE UPDATE ON nc_policy_changes WHEN (OLD.status<>'pending') AND NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_policy_change_keep;
CREATE TRIGGER nc_policy_change_keep BEFORE DELETE ON nc_policy_changes  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_price_request_content;
CREATE TRIGGER nc_price_request_content BEFORE UPDATE OF product_id,version,meter_id,payload_json,prepared_by_id,prepared_by,prepared_at ON nc_price_requests  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_price_request_decided;
CREATE TRIGGER nc_price_request_decided BEFORE UPDATE ON nc_price_requests WHEN (OLD.status<>'pending') AND NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_price_request_keep;
CREATE TRIGGER nc_price_request_keep BEFORE DELETE ON nc_price_requests  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_notes_immutable;
CREATE TRIGGER nc_notes_immutable BEFORE UPDATE ON nc_notes  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_notes_keep;
CREATE TRIGGER nc_notes_keep BEFORE DELETE ON nc_notes  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_note_mentions_content;
CREATE TRIGGER nc_note_mentions_content BEFORE UPDATE OF note_id,member_id,email ON nc_note_mentions  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_note_mentions_keep;
CREATE TRIGGER nc_note_mentions_keep BEFORE DELETE ON nc_note_mentions  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_notifications_content;
CREATE TRIGGER nc_notifications_content BEFORE UPDATE OF event,subject,href,member_id,email ON nc_notifications  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_notifications_keep;
CREATE TRIGGER nc_notifications_keep BEFORE DELETE ON nc_notifications  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_metadata_immutable;
CREATE TRIGGER nc_metadata_immutable BEFORE UPDATE ON nc_metadata_revisions
 WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_metadata_keep;
CREATE TRIGGER nc_metadata_keep BEFORE DELETE ON nc_metadata_revisions
 WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_lifecycle_immutable;
CREATE TRIGGER nc_lifecycle_immutable BEFORE UPDATE ON nc_subscription_lifecycle
 WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_lifecycle_keep;
CREATE TRIGGER nc_lifecycle_keep BEFORE DELETE ON nc_subscription_lifecycle
 WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_contracts_no_delete;
CREATE TRIGGER nc_contracts_no_delete BEFORE DELETE ON nc_contracts  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
DROP TRIGGER nc_contracts_no_rewrite;
CREATE TRIGGER nc_contracts_no_rewrite BEFORE UPDATE ON nc_contracts
WHEN (OLD.status <> 'proposed' OR NEW.id <> OLD.id OR NEW.subscription_id <> OLD.subscription_id OR NEW.subscription_revision <> OLD.subscription_revision OR NEW.clause <> OLD.clause OR NEW.terms_json <> OLD.terms_json OR NEW.prepared_by_id <> OLD.prepared_by_id OR NEW.prepared_by <> OLD.prepared_by OR NEW.created_at <> OLD.created_at) AND NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
DROP TRIGGER nc_metric_previews_no_update;
CREATE TRIGGER nc_metric_previews_no_update BEFORE UPDATE ON nc_metric_previews  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
DROP TRIGGER nc_metric_previews_no_delete;
CREATE TRIGGER nc_metric_previews_no_delete BEFORE DELETE ON nc_metric_previews  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
DROP TRIGGER nc_metric_requests_no_delete;
CREATE TRIGGER nc_metric_requests_no_delete BEFORE DELETE ON nc_metric_requests  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
DROP TRIGGER nc_metric_requests_no_rewrite;
CREATE TRIGGER nc_metric_requests_no_rewrite BEFORE UPDATE ON nc_metric_requests WHEN (OLD.status='active' OR NEW.id<>OLD.id OR NEW.code<>OLD.code OR NEW.name<>OLD.name OR NEW.unit_label<>OLD.unit_label OR NEW.source_meter_id<>OLD.source_meter_id OR NEW.plan_json<>OLD.plan_json OR NEW.sql_text<>OLD.sql_text OR NEW.version<>OLD.version OR NEW.prepared_by<>OLD.prepared_by OR NEW.prepared_at<>OLD.prepared_at) AND NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
DROP TRIGGER nc_usage_properties_immutable;
CREATE TRIGGER nc_usage_properties_immutable BEFORE UPDATE ON nc_usage_events WHEN (NEW.properties_json<>OLD.properties_json) AND NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
DROP TRIGGER nc_price_dimensions_immutable;
CREATE TRIGGER nc_price_dimensions_immutable BEFORE UPDATE ON nc_prices WHEN (NEW.dimensions_json<>OLD.dimensions_json) AND NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
DROP TRIGGER nc_metric_definition_immutable;
CREATE TRIGGER nc_metric_definition_immutable BEFORE UPDATE ON nc_meters WHEN (NEW.source_meter_id IS NOT OLD.source_meter_id OR NEW.metric_plan_json IS NOT OLD.metric_plan_json OR NEW.metric_key IS NOT OLD.metric_key OR NEW.metric_version IS NOT OLD.metric_version) AND NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
DROP TRIGGER nc_report_snapshot_immutable;
CREATE TRIGGER nc_report_snapshot_immutable BEFORE UPDATE OF reports_json,sources_json,csv,member_id,period,generated_at ON nc_report_deliveries
WHEN (OLD.reports_json IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
DROP TRIGGER nc_credit_correction_request_immutable;
CREATE TRIGGER nc_credit_correction_request_immutable BEFORE UPDATE ON nc_credit_correction_requests  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
DROP TRIGGER nc_credit_correction_request_keep;
CREATE TRIGGER nc_credit_correction_request_keep BEFORE DELETE ON nc_credit_correction_requests  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
DROP TRIGGER nc_credit_correction_mail_content;
CREATE TRIGGER nc_credit_correction_mail_content BEFORE UPDATE OF proposal_id,credit_id,customer_id,recipient,subject,body,explanation,citations_json,created_at ON nc_credit_correction_mail  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
DROP TRIGGER nc_credit_correction_mail_keep;
CREATE TRIGGER nc_credit_correction_mail_keep BEFORE DELETE ON nc_credit_correction_mail  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
DROP TRIGGER nc_credit_correction_mail_outcome;
CREATE TRIGGER nc_credit_correction_mail_outcome BEFORE UPDATE ON nc_credit_correction_mail WHEN (NOT ((OLD.status='pending' AND NEW.status='sending') OR (OLD.status='sending' AND NEW.status IN ('accepted','failed','uncertain','suppressed')))) AND NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
DROP TRIGGER nc_draft_correction_mail_content;
CREATE TRIGGER nc_draft_correction_mail_content BEFORE UPDATE OF proposal_id,customer_id,proposal_kind,recipient,subject,body,citations_json,created_at
 ON nc_draft_correction_mail  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
DROP TRIGGER nc_draft_correction_mail_keep;
CREATE TRIGGER nc_draft_correction_mail_keep BEFORE DELETE ON nc_draft_correction_mail  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
DROP TRIGGER nc_draft_correction_mail_insert;
CREATE TRIGGER nc_draft_correction_mail_insert BEFORE INSERT ON nc_draft_correction_mail
 WHEN (NEW.status<>'pending' OR NEW.provider_ref IS NOT NULL OR NEW.outcome_code IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM nc_proposals WHERE id=NEW.proposal_id AND kind=NEW.proposal_kind AND status IN ('pending','approved'))) AND NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
DROP TRIGGER nc_draft_correction_mail_outcome;
CREATE TRIGGER nc_draft_correction_mail_outcome BEFORE UPDATE ON nc_draft_correction_mail
 WHEN (NOT ((OLD.status='pending' AND NEW.status='sending' AND NEW.provider_ref IS NULL AND NEW.outcome_code IS NULL
   AND EXISTS(SELECT 1 FROM nc_proposals WHERE id=NEW.proposal_id AND status='approved'))
 OR (OLD.status='sending' AND NEW.status IN ('accepted','failed','rejected','uncertain','suppressed')))) AND NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
DROP TRIGGER nc_renewal_events_immutable;
CREATE TRIGGER nc_renewal_events_immutable BEFORE UPDATE ON nc_renewal_events  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
DROP TRIGGER nc_renewal_events_keep;
CREATE TRIGGER nc_renewal_events_keep BEFORE DELETE ON nc_renewal_events  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
DROP TRIGGER nc_retention_policy_content;
CREATE TRIGGER nc_retention_policy_content BEFORE UPDATE OF id,payload_json,base_revision,prepared_by_id,prepared_by,prepared_at ON nc_retention_policies  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
DROP TRIGGER nc_retention_policy_decided;
CREATE TRIGGER nc_retention_policy_decided BEFORE UPDATE ON nc_retention_policies WHEN (OLD.status<>'pending') AND NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
DROP TRIGGER nc_retention_policy_keep;
CREATE TRIGGER nc_retention_policy_keep BEFORE DELETE ON nc_retention_policies  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
DROP TRIGGER nc_cadence_enrollments_content;
CREATE TRIGGER nc_cadence_enrollments_content BEFORE UPDATE ON nc_cadence_enrollments  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
DROP TRIGGER nc_cadence_enrollments_keep;
CREATE TRIGGER nc_cadence_enrollments_keep BEFORE DELETE ON nc_cadence_enrollments  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
DROP TRIGGER nc_cadence_promises_content;
CREATE TRIGGER nc_cadence_promises_content BEFORE UPDATE ON nc_cadence_promises  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
DROP TRIGGER nc_cadence_promises_keep;
CREATE TRIGGER nc_cadence_promises_keep BEFORE DELETE ON nc_cadence_promises  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
DROP TRIGGER nc_cadence_disputes_content;
CREATE TRIGGER nc_cadence_disputes_content BEFORE UPDATE OF invoice_id,line_id,amount_cents,reason,recorded_by,recorded_at ON nc_cadence_disputes  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
DROP TRIGGER nc_cadence_disputes_resolved;
CREATE TRIGGER nc_cadence_disputes_resolved BEFORE UPDATE ON nc_cadence_disputes WHEN (OLD.resolved_at IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
DROP TRIGGER nc_cadence_disputes_keep;
CREATE TRIGGER nc_cadence_disputes_keep BEFORE DELETE ON nc_cadence_disputes  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
DROP TRIGGER nc_cadence_policy_requests_content;
CREATE TRIGGER nc_cadence_policy_requests_content BEFORE UPDATE OF payload_json,base_revision,prepared_by_id,prepared_by,prepared_at ON nc_cadence_policy_requests  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
DROP TRIGGER nc_cadence_policy_requests_decided;
CREATE TRIGGER nc_cadence_policy_requests_decided BEFORE UPDATE ON nc_cadence_policy_requests WHEN (OLD.status<>'pending') AND NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
DROP TRIGGER nc_cadence_policy_requests_keep;
CREATE TRIGGER nc_cadence_policy_requests_keep BEFORE DELETE ON nc_cadence_policy_requests  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
DROP TRIGGER nc_cadence_delivery_content;
CREATE TRIGGER nc_cadence_delivery_content BEFORE UPDATE OF invoice_id,stage,basis_json,basis_key,policy_revision,recipient,subject,body,collectible_cents,approved_by,approved_at,approval_mode,reserved_at ON nc_cadence_deliveries WHEN (OLD.claimed_at IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
DROP TRIGGER nc_cadence_delivery_terminal;
CREATE TRIGGER nc_cadence_delivery_terminal BEFORE UPDATE ON nc_cadence_deliveries WHEN (OLD.status IN ('accepted','suppressed','rejected','rate_limited','uncertain','failed','superseded')) AND NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
DROP TRIGGER nc_cadence_delivery_keep;
CREATE TRIGGER nc_cadence_delivery_keep BEFORE DELETE ON nc_cadence_deliveries  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;

-- Import retirement writes its journal after the native changes in the same
-- batch. Bind the exact custody receipt before withdrawing the private context.
CREATE TRIGGER nc_erasure_import_receipt AFTER INSERT ON ik_d1_erasure_journal
WHEN EXISTS(SELECT 1 FROM nc_privacy_context)
BEGIN
 UPDATE nc_erasure_requests SET receipt_json=json_set(receipt_json,'$.importCustody',json_object('receiptId',NEW.id,'recordsErased',NEW.records_erased,'jobsRetired',NEW.jobs_retired,'streamsRetired',NEW.streams_retired,'fields','all selected original/source payload fields withdrawn','stores',json(NEW.stores_json))) WHERE id IN (SELECT request_id FROM nc_privacy_context);
 DELETE FROM nc_privacy_context;
END;
