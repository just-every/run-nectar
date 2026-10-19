CREATE TABLE nc_policy_changes (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('credit','certificate','tax')),
 payload_json TEXT NOT NULL, base_revision INTEGER NOT NULL,
 prepared_by_id TEXT NOT NULL REFERENCES nc_members(id), prepared_by TEXT NOT NULL, prepared_at INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','applied','rejected')) DEFAULT 'pending',
 decided_by_id TEXT REFERENCES nc_members(id), decided_by TEXT, decided_at INTEGER,
 approval_mode TEXT CHECK(approval_mode IN ('two-person','single-approver'))
);
CREATE TRIGGER nc_policy_change_content BEFORE UPDATE OF kind,payload_json,base_revision,prepared_by_id,prepared_by,prepared_at ON nc_policy_changes BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
CREATE TRIGGER nc_policy_change_decided BEFORE UPDATE ON nc_policy_changes WHEN OLD.status<>'pending' BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
CREATE TRIGGER nc_policy_change_keep BEFORE DELETE ON nc_policy_changes BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
