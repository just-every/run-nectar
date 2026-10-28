-- Verified provider tax evidence never changes the issued invoice.
CREATE TABLE nc_invoice_tax (
  invoice_id TEXT PRIMARY KEY REFERENCES nc_invoices(id),
  customer_id TEXT NOT NULL REFERENCES nc_customers(id),
  account_ref TEXT NOT NULL,
  livemode INTEGER NOT NULL CHECK(livemode IN (0,1)),
  transaction_ref TEXT NOT NULL UNIQUE,
  lines_json TEXT NOT NULL,
  bound_by TEXT NOT NULL,
  bound_at INTEGER NOT NULL
);
ALTER TABLE nc_invoice_refunds ADD COLUMN tax_claimed_at INTEGER;
ALTER TABLE nc_invoice_refunds ADD COLUMN tax_ref TEXT;
-- Installation-local consent is excluded from archives; financial facts remain.
CREATE TABLE nc_invoice_refund_authority (
  refund_id TEXT PRIMARY KEY REFERENCES nc_invoice_refunds(id)
);
INSERT INTO nc_invoice_refund_authority(refund_id) SELECT id FROM nc_invoice_refunds;
ALTER TABLE nc_lifecycle_policy ADD COLUMN refund_original INTEGER NOT NULL DEFAULT 0 CHECK(refund_original IN (0,1));
ALTER TABLE nc_invoice_refunds ADD COLUMN cancellation_credit_id TEXT REFERENCES nc_credit_notes(id);
CREATE UNIQUE INDEX nc_cancellation_refund_once ON nc_invoice_refunds(cancellation_credit_id) WHERE cancellation_credit_id IS NOT NULL AND status IN ('pending','claimed','uncertain','completed');
CREATE TRIGGER nc_invoice_tax_fixed BEFORE UPDATE ON nc_invoice_tax WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_invoice_tax_keep BEFORE DELETE ON nc_invoice_tax WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_invoice_refund_tax_fixed BEFORE UPDATE ON nc_invoice_refunds WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (OLD.cancellation_credit_id IS NOT NEW.cancellation_credit_id OR (OLD.tax_ref IS NOT NULL AND OLD.tax_ref IS NOT NEW.tax_ref) OR (OLD.tax_claimed_at IS NOT NULL AND OLD.tax_claimed_at IS NOT NEW.tax_claimed_at)) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
