-- REV-002 period close. A close is an immutable record of what a month held:
-- the exact contribution keys, roll-forward, reports packet and the journals
-- posted to the connected ledger. Contributions that arrive for a closed month
-- afterwards are reported in the earliest open month; closed evidence is never
-- rewritten. Ledger postings become generic: bad-debt facts and period closes.
CREATE TABLE nc_period_closes(
 id TEXT PRIMARY KEY,period TEXT NOT NULL UNIQUE CHECK(period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
 closed_by_id TEXT NOT NULL REFERENCES nc_members(id),closed_by TEXT NOT NULL,closed_at INTEGER NOT NULL,
 keys_json TEXT NOT NULL CHECK(json_valid(keys_json)),keys_hash TEXT NOT NULL,
 packet_json TEXT NOT NULL CHECK(json_valid(packet_json)),packet_hash TEXT NOT NULL);
CREATE TRIGGER nc_period_closes_immutable BEFORE UPDATE ON nc_period_closes WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_period_closes_keep BEFORE DELETE ON nc_period_closes WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_period_closes_generation_insert AFTER INSERT ON nc_period_closes BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_period_closes_generation_update AFTER UPDATE ON nc_period_closes BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_period_closes_generation_delete AFTER DELETE ON nc_period_closes BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;

DROP TRIGGER nc_ledger_postings_update;
DROP TRIGGER nc_ledger_postings_keep;
DROP TRIGGER nc_ledger_postings_generation_insert;
DROP TRIGGER nc_ledger_postings_generation_update;
DROP TRIGGER nc_ledger_postings_generation_delete;
DROP TRIGGER nc_ledger_postings_owned_insert;
ALTER TABLE nc_ledger_postings RENAME TO nc_ledger_postings_old;
CREATE TABLE nc_ledger_postings(
 id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('bad_debt','bad_debt_recovery','period_close')),source_id TEXT NOT NULL UNIQUE,
 write_off_id TEXT REFERENCES nc_write_offs(id),invoice_id TEXT REFERENCES nc_invoices(id),customer_id TEXT REFERENCES nc_customers(id),period TEXT,
 entity_id TEXT,company_ref TEXT,amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents>0),
 entries_json TEXT NOT NULL CHECK(json_valid(entries_json)),doc_number TEXT NOT NULL UNIQUE,txn_date TEXT,
 status TEXT NOT NULL CHECK(status IN ('pending','posted')),external_ref TEXT UNIQUE,attempts INTEGER NOT NULL DEFAULT 0,error_code TEXT,
 created_at INTEGER NOT NULL,posted_at INTEGER,
 CHECK(status='pending' OR (external_ref IS NOT NULL AND posted_at IS NOT NULL)),
 CHECK((kind='period_close' AND period IS NOT NULL AND write_off_id IS NULL AND invoice_id IS NULL AND customer_id IS NULL) OR (kind<>'period_close' AND write_off_id IS NOT NULL AND invoice_id IS NOT NULL AND customer_id IS NOT NULL)));
INSERT INTO nc_ledger_postings(id,kind,source_id,write_off_id,invoice_id,customer_id,period,entity_id,company_ref,amount_cents,entries_json,doc_number,txn_date,status,external_ref,attempts,error_code,created_at,posted_at)
 SELECT id,kind,source_id,write_off_id,invoice_id,customer_id,NULL,entity_id,company_ref,amount_cents,entries_json,doc_number,NULL,status,external_ref,attempts,error_code,created_at,posted_at FROM nc_ledger_postings_old;
DROP TABLE nc_ledger_postings_old;
CREATE INDEX nc_ledger_postings_status ON nc_ledger_postings(status,created_at);
CREATE TRIGGER nc_ledger_postings_update BEFORE UPDATE ON nc_ledger_postings WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (OLD.status='posted' OR OLD.id IS NOT NEW.id OR OLD.kind IS NOT NEW.kind OR OLD.source_id IS NOT NEW.source_id OR OLD.write_off_id IS NOT NEW.write_off_id OR OLD.invoice_id IS NOT NEW.invoice_id OR OLD.customer_id IS NOT NEW.customer_id OR OLD.period IS NOT NEW.period OR OLD.entity_id IS NOT NEW.entity_id OR OLD.company_ref IS NOT NEW.company_ref OR OLD.amount_cents IS NOT NEW.amount_cents OR OLD.entries_json IS NOT NEW.entries_json OR OLD.doc_number IS NOT NEW.doc_number OR OLD.txn_date IS NOT NEW.txn_date OR OLD.created_at IS NOT NEW.created_at) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_ledger_postings_keep BEFORE DELETE ON nc_ledger_postings WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_ledger_postings_generation_insert AFTER INSERT ON nc_ledger_postings BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_ledger_postings_generation_update AFTER UPDATE ON nc_ledger_postings BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_ledger_postings_generation_delete AFTER DELETE ON nc_ledger_postings BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_ledger_postings_owned_insert BEFORE INSERT ON nc_ledger_postings WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND EXISTS(SELECT 1 FROM nc_customers WHERE id IN (NEW.customer_id) AND erased_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
