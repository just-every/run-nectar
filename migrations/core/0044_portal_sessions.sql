-- PORT-005: public customer sessions are separate from operator auth. Runtime
-- sessions are deliberately excluded from installation archives.
CREATE TABLE nc_portal_policy (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 hosts_json TEXT NOT NULL,
 parents_json TEXT NOT NULL,
 revision TEXT NOT NULL
);
CREATE TABLE nc_portal_sessions (
 id TEXT PRIMARY KEY,
 customer_id TEXT NOT NULL,
 token_hash TEXT NOT NULL UNIQUE,
 origin TEXT NOT NULL,
 audience TEXT NOT NULL CHECK(audience IN ('embedded','hosted')),
 parent_origin TEXT NOT NULL,
 policy_revision TEXT NOT NULL,
 issued_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 revoked_at INTEGER
);
CREATE INDEX nc_portal_customer ON nc_portal_sessions(customer_id);
