-- Dated instructions carry no background execution authority. The current
-- owner must explicitly submit the accepted instruction on its exact date.
ALTER TABLE nc_invoice_partial_payments ADD COLUMN payment_kind TEXT NOT NULL DEFAULT 'card' CHECK(payment_kind IN ('card','scheduled_ach'));
CREATE TABLE nc_invoice_schedule_authority (
 id TEXT PRIMARY KEY REFERENCES nc_invoice_partial_payments(id),
 customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 portal_session_id TEXT NOT NULL REFERENCES nc_portal_sessions(id),
 basis_hash TEXT NOT NULL, accepted_at INTEGER NOT NULL
);
CREATE TRIGGER nc_invoice_schedule_kind_immutable BEFORE UPDATE ON nc_invoice_partial_payments
WHEN OLD.payment_kind IS NOT NEW.payment_kind
 AND NOT EXISTS(SELECT 1 FROM nc_privacy_context)
 AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
