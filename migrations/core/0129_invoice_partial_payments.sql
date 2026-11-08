-- A once-only on-session checkout reserves the original invoice until the
-- provider proves either captured cash or definitive expiration without cash.
CREATE TABLE nc_invoice_partial_payments (
 id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES nc_invoices(id), customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 status TEXT NOT NULL CHECK(status IN ('prepared','approved','claimed','open','uncertain','collected','expired','revoked','withdrawn')),
 amount_cents INTEGER NOT NULL CHECK(amount_cents BETWEEN 50 AND 99999999), balance_cents INTEGER NOT NULL,
 basis_json TEXT NOT NULL CHECK(json_valid(basis_json)), basis_hash TEXT NOT NULL,
 account_ref TEXT NOT NULL, customer_ref TEXT NOT NULL, binding_id TEXT NOT NULL, binding_revision TEXT NOT NULL,
 prepared_by TEXT NOT NULL, prepared_at INTEGER NOT NULL, approved_at INTEGER, accepted_at INTEGER, claimed_at INTEGER,
 session_ref TEXT, payment_intent_ref TEXT, charge_ref TEXT, payment_id TEXT REFERENCES nc_payments(id), allocation_id TEXT REFERENCES nc_allocations(id),
 consent_json TEXT, proof_json TEXT, completed_at INTEGER, error_code TEXT, revision TEXT NOT NULL
);
CREATE UNIQUE INDEX nc_invoice_partial_session ON nc_invoice_partial_payments(account_ref,session_ref) WHERE session_ref IS NOT NULL;
CREATE UNIQUE INDEX nc_invoice_partial_intent ON nc_invoice_partial_payments(account_ref,payment_intent_ref) WHERE payment_intent_ref IS NOT NULL;
CREATE TABLE nc_invoice_partial_reservations (
 invoice_id TEXT PRIMARY KEY REFERENCES nc_invoices(id), request_id TEXT NOT NULL UNIQUE REFERENCES nc_invoice_partial_payments(id),
 customer_id TEXT NOT NULL REFERENCES nc_customers(id), created_at INTEGER NOT NULL
);
-- These two tables are installation-local authority and are never portable.
CREATE TABLE nc_invoice_partial_authority (
 id TEXT PRIMARY KEY REFERENCES nc_invoice_partial_payments(id), customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 owner_session_id TEXT NOT NULL, factor_verified_at INTEGER NOT NULL
);
CREATE TABLE nc_invoice_partial_returns (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES nc_invoice_partial_payments(id), customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 portal_session_id TEXT NOT NULL REFERENCES nc_portal_sessions(id), expires_at INTEGER NOT NULL, consumed_at INTEGER
);
CREATE TRIGGER nc_invoice_partial_immutable BEFORE UPDATE ON nc_invoice_partial_payments
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND (OLD.invoice_id IS NOT NEW.invoice_id OR OLD.customer_id IS NOT NEW.customer_id OR OLD.amount_cents IS NOT NEW.amount_cents
 OR OLD.balance_cents IS NOT NEW.balance_cents OR OLD.basis_json IS NOT NEW.basis_json OR OLD.basis_hash IS NOT NEW.basis_hash
 OR OLD.account_ref IS NOT NEW.account_ref OR OLD.customer_ref IS NOT NEW.customer_ref OR OLD.binding_id IS NOT NEW.binding_id
 OR OLD.binding_revision IS NOT NEW.binding_revision OR OLD.prepared_by IS NOT NEW.prepared_by OR OLD.prepared_at IS NOT NEW.prepared_at
 OR (OLD.session_ref IS NOT NULL AND OLD.session_ref IS NOT NEW.session_ref)
 OR (OLD.payment_intent_ref IS NOT NULL AND OLD.payment_intent_ref IS NOT NEW.payment_intent_ref)
 OR (OLD.payment_id IS NOT NULL AND OLD.payment_id IS NOT NEW.payment_id))
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;

CREATE TRIGGER nc_partial_fence_nc_native_collections_insert BEFORE INSERT ON nc_native_collections
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND EXISTS(SELECT 1 FROM nc_invoice_partial_reservations WHERE invoice_id=NEW.invoice_id)
BEGIN SELECT RAISE(ABORT,'nectar_guard_invoice_partial_reserved'); END;

CREATE TRIGGER nc_partial_fence_nc_native_collections_update BEFORE UPDATE ON nc_native_collections
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND EXISTS(SELECT 1 FROM nc_invoice_partial_reservations WHERE invoice_id=NEW.invoice_id)
BEGIN SELECT RAISE(ABORT,'nectar_guard_invoice_partial_reserved'); END;

CREATE TRIGGER nc_partial_fence_nc_native_collection_claims_insert BEFORE INSERT ON nc_native_collection_claims
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND EXISTS(SELECT 1 FROM nc_invoice_partial_reservations WHERE invoice_id=NEW.invoice_id)
BEGIN SELECT RAISE(ABORT,'nectar_guard_invoice_partial_reserved'); END;

CREATE TRIGGER nc_partial_fence_nc_native_collection_claims_update BEFORE UPDATE ON nc_native_collection_claims
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND EXISTS(SELECT 1 FROM nc_invoice_partial_reservations WHERE invoice_id=NEW.invoice_id)
BEGIN SELECT RAISE(ABORT,'nectar_guard_invoice_partial_reserved'); END;

CREATE TRIGGER nc_partial_fence_nc_automatic_collections_insert BEFORE INSERT ON nc_automatic_collections
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND EXISTS(SELECT 1 FROM nc_invoice_partial_reservations WHERE invoice_id=NEW.invoice_id)
BEGIN SELECT RAISE(ABORT,'nectar_guard_invoice_partial_reserved'); END;

CREATE TRIGGER nc_partial_fence_nc_automatic_collections_update BEFORE UPDATE ON nc_automatic_collections
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND EXISTS(SELECT 1 FROM nc_invoice_partial_reservations WHERE invoice_id=NEW.invoice_id)
BEGIN SELECT RAISE(ABORT,'nectar_guard_invoice_partial_reserved'); END;

CREATE TRIGGER nc_partial_fence_nc_credit_notes_insert BEFORE INSERT ON nc_credit_notes
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND EXISTS(SELECT 1 FROM nc_invoice_partial_reservations WHERE invoice_id=NEW.invoice_id)
BEGIN SELECT RAISE(ABORT,'nectar_guard_invoice_partial_reserved'); END;

CREATE TRIGGER nc_partial_fence_nc_credit_notes_update BEFORE UPDATE ON nc_credit_notes
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND EXISTS(SELECT 1 FROM nc_invoice_partial_reservations WHERE invoice_id=NEW.invoice_id)
BEGIN SELECT RAISE(ABORT,'nectar_guard_invoice_partial_reserved'); END;

CREATE TRIGGER nc_partial_fence_nc_credit_requests_insert BEFORE INSERT ON nc_credit_requests
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND EXISTS(SELECT 1 FROM nc_invoice_partial_reservations WHERE invoice_id=NEW.invoice_id)
BEGIN SELECT RAISE(ABORT,'nectar_guard_invoice_partial_reserved'); END;

CREATE TRIGGER nc_partial_fence_nc_credit_requests_update BEFORE UPDATE ON nc_credit_requests
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND EXISTS(SELECT 1 FROM nc_invoice_partial_reservations WHERE invoice_id=NEW.invoice_id)
BEGIN SELECT RAISE(ABORT,'nectar_guard_invoice_partial_reserved'); END;

CREATE TRIGGER nc_partial_fence_nc_allocations_insert BEFORE INSERT ON nc_allocations
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND EXISTS(SELECT 1 FROM nc_invoice_partial_reservations WHERE invoice_id=NEW.invoice_id)
BEGIN SELECT RAISE(ABORT,'nectar_guard_invoice_partial_reserved'); END;

CREATE TRIGGER nc_partial_fence_nc_allocations_update BEFORE UPDATE ON nc_allocations
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND EXISTS(SELECT 1 FROM nc_invoice_partial_reservations WHERE invoice_id=NEW.invoice_id)
BEGIN SELECT RAISE(ABORT,'nectar_guard_invoice_partial_reserved'); END;

CREATE TRIGGER nc_partial_fence_nc_usage_credit_applications_insert BEFORE INSERT ON nc_usage_credit_applications
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND EXISTS(SELECT 1 FROM nc_invoice_partial_reservations WHERE invoice_id=NEW.invoice_id)
BEGIN SELECT RAISE(ABORT,'nectar_guard_invoice_partial_reserved'); END;

CREATE TRIGGER nc_partial_fence_nc_usage_credit_applications_update BEFORE UPDATE ON nc_usage_credit_applications
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND EXISTS(SELECT 1 FROM nc_invoice_partial_reservations WHERE invoice_id=NEW.invoice_id)
BEGIN SELECT RAISE(ABORT,'nectar_guard_invoice_partial_reserved'); END;

CREATE TRIGGER nc_partial_fence_nc_balance_entries_insert BEFORE INSERT ON nc_balance_entries
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND EXISTS(SELECT 1 FROM nc_invoice_partial_reservations WHERE invoice_id=NEW.invoice_id) AND NEW.kind='application'
BEGIN SELECT RAISE(ABORT,'nectar_guard_invoice_partial_reserved'); END;

CREATE TRIGGER nc_partial_fence_nc_balance_entries_update BEFORE UPDATE ON nc_balance_entries
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND EXISTS(SELECT 1 FROM nc_invoice_partial_reservations WHERE invoice_id=NEW.invoice_id) AND NEW.kind='application'
BEGIN SELECT RAISE(ABORT,'nectar_guard_invoice_partial_reserved'); END;

CREATE TRIGGER nc_partial_fence_nc_write_offs_insert BEFORE INSERT ON nc_write_offs
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND EXISTS(SELECT 1 FROM nc_invoice_partial_reservations WHERE invoice_id=NEW.invoice_id)
BEGIN SELECT RAISE(ABORT,'nectar_guard_invoice_partial_reserved'); END;

CREATE TRIGGER nc_partial_fence_nc_write_offs_update BEFORE UPDATE ON nc_write_offs
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND EXISTS(SELECT 1 FROM nc_invoice_partial_reservations WHERE invoice_id=NEW.invoice_id)
BEGIN SELECT RAISE(ABORT,'nectar_guard_invoice_partial_reserved'); END;

CREATE TRIGGER nc_invoice_partial_payments_insert_generation AFTER INSERT ON nc_invoice_partial_payments BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;

CREATE TRIGGER nc_invoice_partial_payments_update_generation AFTER UPDATE ON nc_invoice_partial_payments BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;

CREATE TRIGGER nc_invoice_partial_payments_delete_generation AFTER DELETE ON nc_invoice_partial_payments BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;

CREATE TRIGGER nc_invoice_partial_reservations_insert_generation AFTER INSERT ON nc_invoice_partial_reservations BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;

CREATE TRIGGER nc_invoice_partial_reservations_update_generation AFTER UPDATE ON nc_invoice_partial_reservations BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;

CREATE TRIGGER nc_invoice_partial_reservations_delete_generation AFTER DELETE ON nc_invoice_partial_reservations BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;

CREATE TRIGGER nc_invoice_partial_authority_insert_generation AFTER INSERT ON nc_invoice_partial_authority BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;

CREATE TRIGGER nc_invoice_partial_authority_update_generation AFTER UPDATE ON nc_invoice_partial_authority BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;

CREATE TRIGGER nc_invoice_partial_authority_delete_generation AFTER DELETE ON nc_invoice_partial_authority BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;

CREATE TRIGGER nc_invoice_partial_returns_insert_generation AFTER INSERT ON nc_invoice_partial_returns BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;

CREATE TRIGGER nc_invoice_partial_returns_update_generation AFTER UPDATE ON nc_invoice_partial_returns BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;

CREATE TRIGGER nc_invoice_partial_returns_delete_generation AFTER DELETE ON nc_invoice_partial_returns BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;

CREATE TRIGGER nc_partial_fence_processor_cash_insert BEFORE INSERT ON nc_processor_cash_applications
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND EXISTS(SELECT 1 FROM nc_invoice_partial_reservations WHERE invoice_id=NEW.invoice_id)
BEGIN SELECT RAISE(ABORT,'nectar_guard_invoice_partial_reserved'); END;

CREATE TRIGGER nc_partial_fence_processor_cash_update BEFORE UPDATE ON nc_processor_cash_applications
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND EXISTS(SELECT 1 FROM nc_invoice_partial_reservations WHERE invoice_id=NEW.invoice_id)
BEGIN SELECT RAISE(ABORT,'nectar_guard_invoice_partial_reserved'); END;
