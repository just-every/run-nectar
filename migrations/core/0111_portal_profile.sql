-- Customer declarations do not establish tax validation or an exemption.
ALTER TABLE nc_contacts ADD COLUMN revision TEXT NOT NULL DEFAULT '1';
CREATE TABLE nc_customer_tax_ids (
 id TEXT PRIMARY KEY,
 customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 type TEXT NOT NULL,
 value TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'unverified' CHECK(status='unverified'),
 created_at INTEGER NOT NULL,
 UNIQUE(customer_id,type,value)
);
CREATE INDEX nc_customer_tax_ids_customer ON nc_customer_tax_ids(customer_id);
CREATE TRIGGER nc_customer_tax_ids_insert BEFORE INSERT ON nc_customer_tax_ids
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND (NOT EXISTS(SELECT 1 FROM nc_customers WHERE id=NEW.customer_id AND erased_at IS NULL AND status='active')
 OR EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(NEW.id,NEW.customer_id)))
BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_customer_tax_ids_update BEFORE UPDATE ON nc_customer_tax_ids
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_customer_tax_ids_generation_insert AFTER INSERT ON nc_customer_tax_ids BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_customer_tax_ids_generation_update AFTER UPDATE ON nc_customer_tax_ids BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_customer_tax_ids_generation_delete AFTER DELETE ON nc_customer_tax_ids BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;

-- The owner's supplied document, explicitly approved for customer sharing.
CREATE TABLE nc_merchant_w9 (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 filename TEXT NOT NULL,
 media_type TEXT NOT NULL CHECK(media_type='application/pdf'),
 content_base64 TEXT NOT NULL,
 sha256 TEXT NOT NULL,
 revision TEXT NOT NULL,
 shared_by TEXT NOT NULL,
 shared_at INTEGER NOT NULL
);
