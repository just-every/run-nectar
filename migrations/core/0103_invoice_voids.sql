-- A void is a numbered credit and a link to a separately approved replacement.
-- Neither the original invoice nor its consumed source records are rewritten.
ALTER TABLE nc_credit_notes ADD COLUMN void_replacement_id TEXT REFERENCES nc_invoices(id);
CREATE UNIQUE INDEX nc_invoice_void_once ON nc_credit_notes(invoice_id) WHERE void_replacement_id IS NOT NULL;
CREATE UNIQUE INDEX nc_invoice_void_replacement_once ON nc_credit_notes(void_replacement_id) WHERE void_replacement_id IS NOT NULL;

ALTER TABLE nc_credit_requests ADD COLUMN purpose TEXT NOT NULL DEFAULT 'credit' CHECK(purpose IN ('credit','invoice-void'));
CREATE TRIGGER nc_credit_request_purpose_fixed BEFORE UPDATE OF purpose ON nc_credit_requests WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
