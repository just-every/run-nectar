-- A durable refund claim precedes the processor write. Issued cash and invoice
-- evidence stay immutable; an uncertain claim permits provider reads only.
CREATE TABLE nc_invoice_refunds(
 id TEXT PRIMARY KEY,invoice_id TEXT NOT NULL REFERENCES nc_invoices(id),customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 payment_id TEXT NOT NULL REFERENCES nc_payments(id),amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
 destination TEXT NOT NULL CHECK(destination IN ('original','balance')),
 basis_hash TEXT NOT NULL,quote_json TEXT NOT NULL CHECK(json_valid(quote_json)),reason TEXT NOT NULL,
 prepared_by_id TEXT NOT NULL REFERENCES nc_members(id),prepared_at INTEGER NOT NULL,
 approved_by_id TEXT REFERENCES nc_members(id),approved_at INTEGER,
 status TEXT NOT NULL CHECK(status IN ('pending','claimed','uncertain','completed','failed','stopped')),
 intent_key TEXT NOT NULL UNIQUE,revision TEXT NOT NULL,claimed_at INTEGER,refund_ref TEXT,
 proof_json TEXT CHECK(proof_json IS NULL OR json_valid(proof_json)),credit_id TEXT REFERENCES nc_credit_notes(id),completed_at INTEGER,error_code TEXT,
 CHECK(status<>'completed' OR (credit_id IS NOT NULL AND completed_at IS NOT NULL AND (destination='balance' OR refund_ref IS NOT NULL)))
);
CREATE UNIQUE INDEX nc_invoice_refund_reserved ON nc_invoice_refunds(invoice_id) WHERE status IN ('claimed','uncertain');
ALTER TABLE nc_credit_notes ADD COLUMN invoice_refund_id TEXT REFERENCES nc_invoice_refunds(id);
CREATE UNIQUE INDEX nc_invoice_refund_credit_once ON nc_credit_notes(invoice_refund_id) WHERE invoice_refund_id IS NOT NULL;
CREATE TRIGGER nc_invoice_refunds_content BEFORE UPDATE ON nc_invoice_refunds WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
 OLD.id IS NOT NEW.id OR OLD.invoice_id IS NOT NEW.invoice_id OR OLD.customer_id IS NOT NEW.customer_id OR OLD.payment_id IS NOT NEW.payment_id OR OLD.amount_cents IS NOT NEW.amount_cents OR OLD.destination IS NOT NEW.destination OR OLD.basis_hash IS NOT NEW.basis_hash OR OLD.quote_json IS NOT NEW.quote_json OR OLD.reason IS NOT NEW.reason OR OLD.prepared_by_id IS NOT NEW.prepared_by_id OR OLD.prepared_at IS NOT NEW.prepared_at OR OLD.intent_key IS NOT NEW.intent_key
 OR OLD.status IN ('completed','failed','stopped') OR (OLD.refund_ref IS NOT NULL AND OLD.refund_ref IS NOT NEW.refund_ref)
 OR NOT((OLD.status='pending' AND NEW.status IN ('claimed','stopped')) OR (OLD.status IN ('claimed','uncertain') AND NEW.status IN ('uncertain','completed','failed','stopped')))
) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_invoice_refunds_keep BEFORE DELETE ON nc_invoice_refunds WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_invoice_refunds_generation_insert AFTER INSERT ON nc_invoice_refunds BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_invoice_refunds_generation_update AFTER UPDATE ON nc_invoice_refunds BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_invoice_refunds_owned_insert BEFORE INSERT ON nc_invoice_refunds WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND NOT EXISTS(SELECT 1 FROM nc_customers c JOIN nc_invoices i ON i.customer_id=c.id WHERE c.id=NEW.customer_id AND i.id=NEW.invoice_id AND c.erased_at IS NULL) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
