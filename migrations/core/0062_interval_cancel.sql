-- Issued advance-service cancellation is a source-bound human credit decision.
CREATE TABLE nc_interval_cancellations (
 id TEXT PRIMARY KEY,
 subscription_id TEXT NOT NULL REFERENCES nc_subscriptions(id),
 customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 effective_date TEXT NOT NULL,
 reason TEXT NOT NULL,
 transition_id TEXT NOT NULL UNIQUE,
 plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
 basis TEXT NOT NULL,
 prepared_by TEXT NOT NULL REFERENCES nc_members(id),
 prepared_name TEXT NOT NULL,
 prepared_at INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 decided_by TEXT,
 decided_at INTEGER
);
CREATE UNIQUE INDEX nc_interval_cancel_pending ON nc_interval_cancellations(subscription_id) WHERE status='pending';
CREATE TABLE nc_interval_cancel_requests (
 request_id TEXT PRIMARY KEY REFERENCES nc_credit_requests(id),
 cancellation_id TEXT NOT NULL REFERENCES nc_interval_cancellations(id),
 invoice_id TEXT NOT NULL REFERENCES nc_invoices(id),
 customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 UNIQUE(cancellation_id,invoice_id)
);
ALTER TABLE nc_credit_notes ADD COLUMN cancellation_id TEXT REFERENCES nc_interval_cancellations(id);
CREATE UNIQUE INDEX nc_interval_cancel_credit_once ON nc_credit_notes(cancellation_id,invoice_id) WHERE cancellation_id IS NOT NULL;

CREATE TRIGGER nc_interval_cancellations_content BEFORE UPDATE OF subscription_id,customer_id,effective_date,reason,transition_id,plan_json,basis,prepared_by,prepared_name,prepared_at ON nc_interval_cancellations
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_interval_cancellations_decided BEFORE UPDATE ON nc_interval_cancellations
WHEN OLD.status<>'pending' AND NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_interval_cancellations_keep BEFORE DELETE ON nc_interval_cancellations
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_interval_cancel_requests_immutable BEFORE UPDATE ON nc_interval_cancel_requests
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_interval_cancel_requests_keep BEFORE DELETE ON nc_interval_cancel_requests
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_interval_cancel_request_source BEFORE INSERT ON nc_interval_cancel_requests
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND NOT EXISTS(
 SELECT 1 FROM nc_interval_cancellations c JOIN nc_credit_requests r ON r.id=NEW.request_id JOIN nc_invoices i ON i.id=NEW.invoice_id
 WHERE c.id=NEW.cancellation_id AND c.status='pending' AND c.customer_id=NEW.customer_id AND i.customer_id=NEW.customer_id AND i.subscription_id=c.subscription_id AND r.invoice_id=i.id AND r.prepared_by=c.prepared_by
) BEGIN SELECT RAISE(ABORT,'nectar_guard_cancellation_source_changed'); END;
CREATE TRIGGER nc_interval_cancel_credit_source BEFORE INSERT ON nc_credit_notes
WHEN NEW.cancellation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND NOT EXISTS(
 SELECT 1 FROM nc_interval_cancellations c JOIN nc_invoices i ON i.id=NEW.invoice_id JOIN nc_interval_cancel_requests r ON r.cancellation_id=c.id AND r.invoice_id=i.id
 WHERE c.id=NEW.cancellation_id AND c.status='approved' AND c.customer_id=NEW.customer_id AND i.customer_id=NEW.customer_id AND i.subscription_id=c.subscription_id
 AND NEW.subtotal_cents+NEW.tax_cents=NEW.amount_cents AND NEW.applied_cents IS NOT NULL AND NEW.correction_id IS NULL
) BEGIN SELECT RAISE(ABORT,'nectar_guard_cancellation_source_changed'); END;

CREATE TRIGGER nc_interval_cancellations_generation_insert AFTER INSERT ON nc_interval_cancellations
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;

CREATE TRIGGER nc_interval_cancellations_generation_update AFTER UPDATE ON nc_interval_cancellations
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;

CREATE TRIGGER nc_interval_cancellations_generation_delete AFTER DELETE ON nc_interval_cancellations
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;

CREATE TRIGGER nc_interval_cancellations_owned_insert BEFORE INSERT ON nc_interval_cancellations
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND EXISTS(SELECT 1 FROM nc_customers WHERE id IN (NEW.customer_id) AND erased_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;

CREATE TRIGGER nc_interval_cancellations_owned_update BEFORE UPDATE ON nc_interval_cancellations
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND EXISTS(SELECT 1 FROM nc_customers WHERE id IN (NEW.customer_id,OLD.customer_id) AND erased_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;

CREATE TRIGGER nc_interval_cancel_requests_generation_insert AFTER INSERT ON nc_interval_cancel_requests
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;

CREATE TRIGGER nc_interval_cancel_requests_generation_update AFTER UPDATE ON nc_interval_cancel_requests
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;

CREATE TRIGGER nc_interval_cancel_requests_generation_delete AFTER DELETE ON nc_interval_cancel_requests
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;

CREATE TRIGGER nc_interval_cancel_requests_owned_insert BEFORE INSERT ON nc_interval_cancel_requests
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND EXISTS(SELECT 1 FROM nc_customers WHERE id IN (NEW.customer_id) AND erased_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;

CREATE TRIGGER nc_interval_cancel_requests_owned_update BEFORE UPDATE ON nc_interval_cancel_requests
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND EXISTS(SELECT 1 FROM nc_customers WHERE id IN (NEW.customer_id,OLD.customer_id) AND erased_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
