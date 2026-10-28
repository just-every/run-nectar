-- Immutable uploaded receipt identity; received money shares the ordinary ledger.
CREATE TABLE nc_remittances (
 id TEXT PRIMARY KEY, source_key_hash TEXT NOT NULL UNIQUE, payload_hash TEXT NOT NULL,
 source_json TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents>0), currency TEXT NOT NULL CHECK(currency='USD'),
 received_on TEXT NOT NULL, customer_id TEXT REFERENCES nc_customers(id), payment_id TEXT UNIQUE REFERENCES nc_payments(id),
 status TEXT NOT NULL CHECK(status IN('staged','confirmed','erased')), confirmation_hash TEXT,
 created_by TEXT NOT NULL, created_at INTEGER NOT NULL, confirmed_by TEXT, confirmed_at INTEGER,
 CHECK(status<>'confirmed' OR (customer_id IS NOT NULL AND payment_id IS NOT NULL AND confirmation_hash IS NOT NULL))
);
CREATE TABLE nc_remittance_allocations (
 id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL REFERENCES nc_remittances(id), customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 payment_id TEXT NOT NULL REFERENCES nc_payments(id), invoice_id TEXT NOT NULL REFERENCES nc_invoices(id),
 allocation_id TEXT NOT NULL UNIQUE REFERENCES nc_allocations(id), amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
 basis_hash TEXT NOT NULL, UNIQUE(receipt_id,basis_hash)
);
CREATE TRIGGER nc_remittances_immutable BEFORE UPDATE ON nc_remittances
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND (OLD.status<>'staged' OR NEW.status<>'confirmed' OR NEW.id<>OLD.id OR NEW.source_key_hash<>OLD.source_key_hash OR NEW.payload_hash<>OLD.payload_hash OR NEW.source_json<>OLD.source_json OR NEW.amount_cents<>OLD.amount_cents OR NEW.currency<>OLD.currency OR NEW.received_on<>OLD.received_on OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_remittances_delete BEFORE DELETE ON nc_remittances
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_remittance_allocations_update BEFORE UPDATE ON nc_remittance_allocations
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_remittance_allocations_delete BEFORE DELETE ON nc_remittance_allocations
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_remittances_generation_insert AFTER INSERT ON nc_remittances BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_remittances_generation_update AFTER UPDATE ON nc_remittances BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_remittances_generation_delete AFTER DELETE ON nc_remittances BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_remittance_allocations_generation_insert AFTER INSERT ON nc_remittance_allocations BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_remittance_allocations_generation_update AFTER UPDATE ON nc_remittance_allocations BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_remittance_allocations_generation_delete AFTER DELETE ON nc_remittance_allocations BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
