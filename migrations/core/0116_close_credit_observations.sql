-- A provider read is retained evidence, never a journal or sync instruction.
CREATE TABLE nc_close_credit_observations(
 credit_id TEXT PRIMARY KEY REFERENCES nc_credit_notes(id), customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 invoice_id TEXT NOT NULL REFERENCES nc_invoices(id), company_ref TEXT NOT NULL,
 basis_hash TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('synced','missing','mismatch','unavailable')),
 external_ref TEXT, observed_cents INTEGER, currency TEXT, error_code TEXT, observed_at INTEGER NOT NULL);
CREATE TRIGGER nc_close_credit_observations_generation_insert AFTER INSERT ON nc_close_credit_observations BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_close_credit_observations_generation_update AFTER UPDATE ON nc_close_credit_observations BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_close_credit_observations_generation_delete AFTER DELETE ON nc_close_credit_observations BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_close_credit_observations_owned_insert BEFORE INSERT ON nc_close_credit_observations WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND NOT EXISTS(SELECT 1 FROM nc_customers WHERE id=NEW.customer_id AND erased_at IS NULL) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
