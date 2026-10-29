ALTER TABLE nc_saml_transactions ADD COLUMN link_basis TEXT;
-- Installation-bound proofs confer no authority until exact owner approval.
CREATE TABLE nc_sso_links (
 id TEXT PRIMARY KEY, basis_json TEXT NOT NULL, subject TEXT NOT NULL,
 source_role TEXT NOT NULL, authenticated_at INTEGER NOT NULL, mfa INTEGER NOT NULL,
 expires_at INTEGER NOT NULL, fingerprint TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL CHECK(status IN('pending','approved','revoked'))
);
CREATE TRIGGER nc_sso_link_basis_fixed BEFORE UPDATE ON nc_sso_links
 WHEN NEW.id IS NOT OLD.id OR NEW.basis_json IS NOT OLD.basis_json OR NEW.subject IS NOT OLD.subject
 OR NEW.source_role IS NOT OLD.source_role OR NEW.authenticated_at IS NOT OLD.authenticated_at
 OR NEW.mfa IS NOT OLD.mfa OR NEW.expires_at IS NOT OLD.expires_at OR NEW.fingerprint IS NOT OLD.fingerprint
 OR OLD.status='revoked' AND NEW.status!='revoked'
 BEGIN SELECT RAISE(ABORT,'nectar_guard_link_basis_changed'); END;
CREATE TRIGGER nc_sso_link_member_changed AFTER UPDATE ON nc_members
 WHEN NEW.status IS NOT OLD.status OR NEW.role IS NOT OLD.role OR NEW.email IS NOT OLD.email OR NEW.updated_at IS NOT OLD.updated_at
 BEGIN
 UPDATE nc_sso_links SET status='revoked' WHERE status='pending' AND json_extract(basis_json,'$.member')=NEW.id;
 DELETE FROM nc_saml_transactions WHERE json_extract(link_basis,'$.member')=NEW.id;
 END;
CREATE TRIGGER nc_sso_link_operator_changed AFTER UPDATE ON oa_operators
 WHEN NEW.status IS NOT OLD.status OR NEW.version IS NOT OLD.version
 BEGIN
 UPDATE nc_sso_links SET status='revoked' WHERE status='pending' AND json_extract(basis_json,'$.operator')=NEW.id;
 DELETE FROM nc_saml_transactions WHERE json_extract(link_basis,'$.operator')=NEW.id;
 END;
CREATE TRIGGER nc_sso_link_configuration_changed AFTER UPDATE ON nc_sso_config
 BEGIN
 DELETE FROM nc_sso_links;
 DELETE FROM nc_saml_transactions;
 END;
