-- Several source identities may name one immutable received-funds receipt.
ALTER TABLE nc_remittance_source_keys RENAME TO nc_remittance_source_keys_previous;
CREATE TABLE nc_remittance_source_keys (source_key_hash TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, record_id TEXT NOT NULL);
INSERT INTO nc_remittance_source_keys SELECT * FROM nc_remittance_source_keys_previous;
DROP TABLE nc_remittance_source_keys_previous;
CREATE TABLE nc_remittance_origins (
 source_key_hash TEXT PRIMARY KEY, receipt_id TEXT NOT NULL REFERENCES nc_remittances(id), customer_id TEXT REFERENCES nc_customers(id),
 kind TEXT NOT NULL CHECK(kind IN('bank_deposit','ordinary_remittance')),
 source_reference TEXT NOT NULL, confirmed_at INTEGER, confirmed_by TEXT, confirmation_hash TEXT
);
INSERT INTO nc_remittance_origins
 SELECT source_key_hash,id,customer_id,'ordinary_remittance',COALESCE(json_extract(source_json,'$.receiptId'),''),confirmed_at,confirmed_by,confirmation_hash
 FROM nc_remittances WHERE status<>'erased';
CREATE TRIGGER nc_remittance_origins_immutable BEFORE UPDATE ON nc_remittance_origins
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND (OLD.confirmed_at IS NOT NULL OR NEW.confirmed_at IS NULL OR NEW.source_key_hash<>OLD.source_key_hash OR NEW.receipt_id<>OLD.receipt_id OR NEW.kind<>OLD.kind OR NEW.source_reference<>OLD.source_reference)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_remittance_origins_delete BEFORE DELETE ON nc_remittance_origins
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_remittance_origins_generation_insert AFTER INSERT ON nc_remittance_origins BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_remittance_origins_generation_update AFTER UPDATE ON nc_remittance_origins BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_remittance_origins_generation_delete AFTER DELETE ON nc_remittance_origins BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
