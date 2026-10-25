-- Operational investigations never adjust a financial or source record.
CREATE TABLE nc_assurance_cases (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES nc_customers(id),
  source_id TEXT NOT NULL UNIQUE REFERENCES nc_usage_controls(id),
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
CREATE TABLE nc_assurance_observations (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES nc_customers(id),
  case_id TEXT NOT NULL,
  basis_hash TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX nc_assurance_observations_case ON nc_assurance_observations(case_id,created_at);
CREATE TRIGGER nc_assurance_cases_generation_insert AFTER INSERT ON nc_assurance_cases BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_assurance_cases_generation_update AFTER UPDATE ON nc_assurance_cases BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_assurance_cases_generation_delete AFTER DELETE ON nc_assurance_cases BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_assurance_cases_owned_insert BEFORE INSERT ON nc_assurance_cases WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND NOT EXISTS(SELECT 1 FROM nc_customers WHERE id=NEW.customer_id AND erased_at IS NULL) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_assurance_cases_owned_update BEFORE UPDATE ON nc_assurance_cases WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND NOT EXISTS(SELECT 1 FROM nc_customers WHERE id=NEW.customer_id AND erased_at IS NULL) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_assurance_observations_generation_insert AFTER INSERT ON nc_assurance_observations BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_assurance_observations_generation_update AFTER UPDATE ON nc_assurance_observations BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_assurance_observations_generation_delete AFTER DELETE ON nc_assurance_observations BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_assurance_observations_owned_insert BEFORE INSERT ON nc_assurance_observations WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND NOT EXISTS(SELECT 1 FROM nc_customers WHERE id=NEW.customer_id AND erased_at IS NULL) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_assurance_observations_owned_update BEFORE UPDATE ON nc_assurance_observations WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND NOT EXISTS(SELECT 1 FROM nc_customers WHERE id=NEW.customer_id AND erased_at IS NULL) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_assurance_observation_keep BEFORE DELETE ON nc_assurance_observations WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_assurance_observation_content BEFORE UPDATE ON nc_assurance_observations WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
