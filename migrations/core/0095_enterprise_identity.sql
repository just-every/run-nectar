CREATE TABLE nc_sso_config (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL,
 issuer TEXT NOT NULL, entry_point TEXT NOT NULL, certificate TEXT NOT NULL,
 role_map TEXT NOT NULL, scim_hash TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE nc_scim_users (
 id TEXT PRIMARY KEY, external_id TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE,
 member_id TEXT NOT NULL UNIQUE REFERENCES nc_members(id),
 operator_id TEXT NOT NULL UNIQUE REFERENCES oa_operators(id),
 source_role TEXT NOT NULL, active INTEGER NOT NULL, revision INTEGER NOT NULL
);
CREATE TABLE nc_saml_transactions (
 state_hash TEXT PRIMARY KEY, binding_hash TEXT NOT NULL, config_revision INTEGER NOT NULL,
 request_id TEXT, request_time TEXT, expires_at INTEGER NOT NULL,
 consumed INTEGER NOT NULL DEFAULT 0, principal TEXT
);
-- Role and status changes fence both sessions and an in-flight SAML response.
CREATE TRIGGER nc_scim_end AFTER UPDATE OF status ON nc_members
 WHEN NEW.status='ended' AND OLD.status!='ended'
 BEGIN
 UPDATE oa_operators SET status='inactive' WHERE id IN (SELECT operator_id FROM nc_scim_users WHERE member_id=NEW.id);
 UPDATE nc_scim_users SET active=0, revision=revision+1 WHERE member_id=NEW.id;
 END;
