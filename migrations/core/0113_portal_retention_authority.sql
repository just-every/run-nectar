-- Live customer execution authority is separate from retained policy evidence.
-- This operational grant is excluded from installation archives.
CREATE TABLE nc_portal_retention_authority (
 policy_id TEXT PRIMARY KEY REFERENCES nc_retention_policies(id)
);
