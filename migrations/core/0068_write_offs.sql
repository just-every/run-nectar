-- AR-004 write-offs, recoveries and the ledger posting queue. A write-off is an
-- immutable fact beside credit notes and allocations: it reduces the invoice
-- balance and keeps issued evidence untouched. A recovery pairs a recorded
-- payment allocation with the write-off it reverses.
CREATE TABLE nc_write_offs(
 id TEXT PRIMARY KEY,invoice_id TEXT NOT NULL REFERENCES nc_invoices(id),customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents>0),reason TEXT NOT NULL,
 effect_json TEXT NOT NULL CHECK(json_valid(effect_json)),balance_cents INTEGER NOT NULL CHECK(typeof(balance_cents)='integer'),
 basis TEXT NOT NULL,policy_revision INTEGER NOT NULL,
 prepared_by_id TEXT NOT NULL REFERENCES nc_members(id),prepared_name TEXT NOT NULL,prepared_at INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','executed')),
 approved_by_id TEXT REFERENCES nc_members(id),approved_name TEXT,approved_at INTEGER,approval_mode TEXT CHECK(approval_mode IS NULL OR approval_mode IN ('single-person','two-person')),
 CHECK(status='pending' OR (approved_by_id IS NOT NULL AND approved_name IS NOT NULL AND approved_at IS NOT NULL AND approval_mode IS NOT NULL)),
 CHECK(approval_mode IS NOT 'two-person' OR approved_by_id<>prepared_by_id));
CREATE INDEX nc_write_offs_invoice ON nc_write_offs(invoice_id,status);
CREATE TABLE nc_write_off_recoveries(
 id TEXT PRIMARY KEY,write_off_id TEXT NOT NULL REFERENCES nc_write_offs(id),invoice_id TEXT NOT NULL REFERENCES nc_invoices(id),customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 payment_id TEXT NOT NULL REFERENCES nc_payments(id),allocation_id TEXT NOT NULL UNIQUE REFERENCES nc_allocations(id),
 amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents>0),recorded_by TEXT NOT NULL,recorded_at INTEGER NOT NULL);
CREATE INDEX nc_write_off_recoveries_invoice ON nc_write_off_recoveries(invoice_id);
CREATE TABLE nc_ledger_postings(
 id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('bad_debt','bad_debt_recovery')),source_id TEXT NOT NULL UNIQUE,
 write_off_id TEXT NOT NULL REFERENCES nc_write_offs(id),invoice_id TEXT NOT NULL REFERENCES nc_invoices(id),customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 entity_id TEXT,company_ref TEXT,amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents>0),
 entries_json TEXT NOT NULL CHECK(json_valid(entries_json)),doc_number TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL CHECK(status IN ('pending','posted')),external_ref TEXT UNIQUE,attempts INTEGER NOT NULL DEFAULT 0,error_code TEXT,
 created_at INTEGER NOT NULL,posted_at INTEGER,
 CHECK(status='pending' OR (external_ref IS NOT NULL AND posted_at IS NOT NULL)));
CREATE INDEX nc_ledger_postings_status ON nc_ledger_postings(status,created_at);

CREATE TRIGGER nc_write_offs_insert BEFORE INSERT ON nc_write_offs WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (NEW.amount_cents>NEW.balance_cents OR NEW.amount_cents>(SELECT i.total_cents FROM nc_invoices i WHERE i.id=NEW.invoice_id) OR NOT EXISTS(SELECT 1 FROM nc_invoices i WHERE i.id=NEW.invoice_id AND i.status='issued' AND i.customer_id=NEW.customer_id)) BEGIN SELECT RAISE(ABORT,'nectar_guard_write_off_invoice'); END;
CREATE TRIGGER nc_write_offs_update BEFORE UPDATE ON nc_write_offs WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (OLD.status<>'pending' OR NEW.status<>'executed' OR OLD.id IS NOT NEW.id OR OLD.invoice_id IS NOT NEW.invoice_id OR OLD.customer_id IS NOT NEW.customer_id OR OLD.amount_cents IS NOT NEW.amount_cents OR OLD.reason IS NOT NEW.reason OR OLD.effect_json IS NOT NEW.effect_json OR OLD.balance_cents IS NOT NEW.balance_cents OR OLD.basis IS NOT NEW.basis OR OLD.policy_revision IS NOT NEW.policy_revision OR OLD.prepared_by_id IS NOT NEW.prepared_by_id OR OLD.prepared_name IS NOT NEW.prepared_name OR OLD.prepared_at IS NOT NEW.prepared_at) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_write_offs_keep BEFORE DELETE ON nc_write_offs WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_write_off_recoveries_insert BEFORE INSERT ON nc_write_off_recoveries WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (NOT EXISTS(SELECT 1 FROM nc_write_offs w WHERE w.id=NEW.write_off_id AND w.status='executed' AND w.invoice_id=NEW.invoice_id AND w.customer_id=NEW.customer_id) OR NEW.amount_cents>(SELECT w.amount_cents FROM nc_write_offs w WHERE w.id=NEW.write_off_id)-COALESCE((SELECT SUM(r.amount_cents) FROM nc_write_off_recoveries r WHERE r.write_off_id=NEW.write_off_id),0)) BEGIN SELECT RAISE(ABORT,'nectar_guard_write_off_recovery'); END;
CREATE TRIGGER nc_write_off_recoveries_content BEFORE UPDATE ON nc_write_off_recoveries WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_write_off_recoveries_keep BEFORE DELETE ON nc_write_off_recoveries WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_ledger_postings_update BEFORE UPDATE ON nc_ledger_postings WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (OLD.status='posted' OR OLD.id IS NOT NEW.id OR OLD.kind IS NOT NEW.kind OR OLD.source_id IS NOT NEW.source_id OR OLD.write_off_id IS NOT NEW.write_off_id OR OLD.invoice_id IS NOT NEW.invoice_id OR OLD.customer_id IS NOT NEW.customer_id OR OLD.entity_id IS NOT NEW.entity_id OR OLD.company_ref IS NOT NEW.company_ref OR OLD.amount_cents IS NOT NEW.amount_cents OR OLD.entries_json IS NOT NEW.entries_json OR OLD.doc_number IS NOT NEW.doc_number OR OLD.created_at IS NOT NEW.created_at) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_ledger_postings_keep BEFORE DELETE ON nc_ledger_postings WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_write_offs_generation_insert AFTER insert ON nc_write_offs BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_write_offs_generation_update AFTER update ON nc_write_offs BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_write_offs_generation_delete AFTER delete ON nc_write_offs BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_write_off_recoveries_generation_insert AFTER insert ON nc_write_off_recoveries BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_write_off_recoveries_generation_update AFTER update ON nc_write_off_recoveries BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_write_off_recoveries_generation_delete AFTER delete ON nc_write_off_recoveries BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_ledger_postings_generation_insert AFTER insert ON nc_ledger_postings BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_ledger_postings_generation_update AFTER update ON nc_ledger_postings BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_ledger_postings_generation_delete AFTER delete ON nc_ledger_postings BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_write_offs_owned_insert BEFORE INSERT ON nc_write_offs WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND EXISTS(SELECT 1 FROM nc_customers WHERE id IN (NEW.customer_id) AND erased_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_write_off_recoveries_owned_insert BEFORE INSERT ON nc_write_off_recoveries WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND EXISTS(SELECT 1 FROM nc_customers WHERE id IN (NEW.customer_id) AND erased_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_ledger_postings_owned_insert BEFORE INSERT ON nc_ledger_postings WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND EXISTS(SELECT 1 FROM nc_customers WHERE id IN (NEW.customer_id) AND erased_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
