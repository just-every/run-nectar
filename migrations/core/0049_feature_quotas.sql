-- Access thresholds do not change contractual prices or issued invoices.
CREATE TABLE nc_feature_policies (
  product_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  meter_id TEXT REFERENCES nc_meters(id),
  quota TEXT,
  quota_policy TEXT NOT NULL CHECK(quota_policy IN ('soft','hard','overage')),
  grace_days INTEGER,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(product_id, feature),
  FOREIGN KEY(product_id, feature) REFERENCES nc_features(product_id, feature)
);

CREATE TABLE nc_feature_policy_revision (singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL);
INSERT INTO nc_feature_policy_revision VALUES(1,0);
CREATE TABLE nc_policy_changes_next (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('credit','certificate','tax','lifecycle','feature')),
 payload_json TEXT NOT NULL, base_revision INTEGER NOT NULL,
 prepared_by_id TEXT NOT NULL REFERENCES nc_members(id), prepared_by TEXT NOT NULL, prepared_at INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','applied','rejected')) DEFAULT 'pending',
 decided_by_id TEXT REFERENCES nc_members(id), decided_by TEXT, decided_at INTEGER,
 approval_mode TEXT CHECK(approval_mode IN ('two-person','single-approver'))
);
INSERT INTO nc_policy_changes_next SELECT * FROM nc_policy_changes;
DROP TABLE nc_policy_changes;
ALTER TABLE nc_policy_changes_next RENAME TO nc_policy_changes;
CREATE TRIGGER nc_policy_change_content BEFORE UPDATE OF kind,payload_json,base_revision,prepared_by_id,prepared_by,prepared_at ON nc_policy_changes BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
CREATE TRIGGER nc_policy_change_decided BEFORE UPDATE ON nc_policy_changes WHEN OLD.status<>'pending' BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
CREATE TRIGGER nc_policy_change_keep BEFORE DELETE ON nc_policy_changes BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
