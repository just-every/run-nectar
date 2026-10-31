-- Test execution is isolated from issued live documents and debit authority.
CREATE TABLE nc_sandbox_processor_authority (
 customer_id TEXT PRIMARY KEY REFERENCES nc_sandbox_customers(id),
 account_ref TEXT NOT NULL, customer_ref TEXT NOT NULL UNIQUE, method_ref TEXT NOT NULL,
 created_by TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE nc_sandbox_invoices (
 id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES nc_sandbox_customers(id),
 window_key TEXT NOT NULL, due_at INTEGER NOT NULL,
 invoice_json TEXT NOT NULL CHECK(json_valid(invoice_json)),
 status TEXT NOT NULL CHECK(status IN ('open','paid','unpaid')),
 UNIQUE(customer_id,window_key)
);
CREATE TABLE nc_sandbox_attempts (
 id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES nc_sandbox_invoices(id),
 customer_id TEXT NOT NULL REFERENCES nc_sandbox_customers(id),
 attempt INTEGER NOT NULL, due_at INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('claimed','declined','paid','unconfirmed')),
 intent_ref TEXT, result_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(result_json)),
 next_at INTEGER, UNIQUE(invoice_id,attempt)
);
CREATE TABLE nc_sandbox_timeline (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 customer_id TEXT NOT NULL REFERENCES nc_sandbox_customers(id), event_key TEXT NOT NULL,
 at INTEGER NOT NULL, kind TEXT NOT NULL, detail_json TEXT NOT NULL CHECK(json_valid(detail_json)),
 UNIQUE(customer_id,event_key)
);
CREATE TRIGGER nc_sandbox_reject_live_binding BEFORE INSERT ON nc_stripe_customer_bindings
WHEN EXISTS(SELECT 1 FROM nc_sandbox_processor_authority WHERE customer_ref=NEW.stripe_customer_ref)
BEGIN SELECT RAISE(ABORT,'nectar_guard_sandbox_live_customer_refused'); END;
CREATE TRIGGER nc_sandbox_reject_live_customer BEFORE INSERT ON nc_sandbox_processor_authority
WHEN EXISTS(SELECT 1 FROM nc_stripe_customer_bindings WHERE stripe_customer_ref=NEW.customer_ref)
BEGIN SELECT RAISE(ABORT,'nectar_guard_sandbox_live_customer_refused'); END;
CREATE TRIGGER nc_sandbox_invoice_fixed BEFORE UPDATE ON nc_sandbox_invoices
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND (OLD.id IS NOT NEW.id OR OLD.customer_id IS NOT NEW.customer_id OR OLD.window_key IS NOT NEW.window_key
 OR OLD.due_at IS NOT NEW.due_at OR OLD.invoice_json IS NOT NEW.invoice_json)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_sandbox_timeline_fixed BEFORE UPDATE ON nc_sandbox_timeline
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_sandbox_invoice_generation_insert AFTER INSERT ON nc_sandbox_invoices BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_sandbox_invoice_generation_update AFTER UPDATE ON nc_sandbox_invoices BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_sandbox_invoice_generation_delete AFTER DELETE ON nc_sandbox_invoices BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_sandbox_timeline_generation_insert AFTER INSERT ON nc_sandbox_timeline BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_sandbox_timeline_generation_update AFTER UPDATE ON nc_sandbox_timeline BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_sandbox_timeline_generation_delete AFTER DELETE ON nc_sandbox_timeline BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
