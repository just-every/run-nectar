CREATE TABLE nc_lifecycle_policy (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 credit_unused INTEGER NOT NULL CHECK(credit_unused IN (0,1)),
 reactivation_days INTEGER NOT NULL CHECK(reactivation_days BETWEEN 0 AND 3650),
 revision INTEGER NOT NULL, changed_by TEXT NOT NULL, changed_at INTEGER NOT NULL
);
ALTER TABLE nc_subscription_lifecycle ADD COLUMN policy_json TEXT NOT NULL DEFAULT '{}';
-- Preserve the policy journal while extending its named policy families.
CREATE TABLE nc_policy_changes_next (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('credit','certificate','tax','lifecycle')),
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
