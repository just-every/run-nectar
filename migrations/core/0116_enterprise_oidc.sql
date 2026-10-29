ALTER TABLE nc_sso_config ADD COLUMN protocol TEXT NOT NULL DEFAULT 'saml';
CREATE TABLE nc_oidc_config (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), provider_json TEXT NOT NULL,
 pin_json TEXT NOT NULL, credential_basis TEXT NOT NULL
);
CREATE TABLE nc_oidc_transactions (
 state_hash TEXT PRIMARY KEY, binding_hash TEXT NOT NULL, config_revision INTEGER NOT NULL,
 payload TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TRIGGER nc_oidc_configuration_changed AFTER UPDATE ON nc_sso_config
 BEGIN
 DELETE FROM nc_oidc_config;
 DELETE FROM nc_oidc_transactions;
 END;
-- Ending or changing a member also withdraws every outstanding OIDC proof.
CREATE TRIGGER nc_oidc_member_changed AFTER UPDATE ON nc_members
 WHEN NEW.status IS NOT OLD.status OR NEW.role IS NOT OLD.role OR NEW.email IS NOT OLD.email OR NEW.updated_at IS NOT OLD.updated_at
 BEGIN DELETE FROM nc_oidc_transactions; END;
CREATE TRIGGER nc_oidc_scim_changed AFTER UPDATE ON nc_scim_users
 BEGIN DELETE FROM nc_oidc_transactions; END;
