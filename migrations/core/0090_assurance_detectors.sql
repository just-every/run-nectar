-- Cases are keyed by one subject per detector; recorded source totals are one detector kind among several.
CREATE TABLE nc_assurance_cases_next (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES nc_customers(id),
  kind TEXT NOT NULL DEFAULT 'usage_source_control',
  source_id TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL REFERENCES nc_members(id),
  status TEXT NOT NULL CHECK(status IN ('open','resolved')),
  basis_hash TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  approved_basis TEXT,
  approved_by TEXT,
  approved_at INTEGER,
  created_at INTEGER NOT NULL,
  checked_at INTEGER NOT NULL
);
INSERT INTO nc_assurance_cases_next(id,customer_id,kind,source_id,owner_id,status,basis_hash,evidence_json,approved_basis,approved_by,approved_at,created_at,checked_at)
  SELECT id,customer_id,'usage_source_control',source_id,owner_id,status,basis_hash,evidence_json,approved_basis,approved_by,approved_at,created_at,checked_at FROM nc_assurance_cases;
DROP TABLE nc_assurance_cases;
ALTER TABLE nc_assurance_cases_next RENAME TO nc_assurance_cases;
CREATE TRIGGER nc_assurance_cases_generation_insert AFTER INSERT ON nc_assurance_cases BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_assurance_cases_generation_update AFTER UPDATE ON nc_assurance_cases BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_assurance_cases_generation_delete AFTER DELETE ON nc_assurance_cases BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_assurance_cases_owned_insert BEFORE INSERT ON nc_assurance_cases WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND NOT EXISTS(SELECT 1 FROM nc_customers WHERE id=NEW.customer_id AND erased_at IS NULL) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_assurance_cases_owned_update BEFORE UPDATE ON nc_assurance_cases WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND NOT EXISTS(SELECT 1 FROM nc_customers WHERE id=NEW.customer_id AND erased_at IS NULL) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
