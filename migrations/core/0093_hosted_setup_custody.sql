ALTER TABLE nc_hosted_setups ADD COLUMN customer_revision TEXT;
ALTER TABLE nc_hosted_setups ADD COLUMN account_ref TEXT;
ALTER TABLE nc_hosted_setups ADD COLUMN customer_ref TEXT;
ALTER TABLE nc_hosted_setups ADD COLUMN factor_ref TEXT;
ALTER TABLE nc_hosted_setups ADD COLUMN factor_verified_at INTEGER;
ALTER TABLE nc_hosted_setups ADD COLUMN consent_json TEXT;
ALTER TABLE nc_hosted_setups ADD COLUMN consent_hash TEXT;
ALTER TABLE nc_hosted_setups ADD COLUMN accepted_at INTEGER;
ALTER TABLE nc_hosted_setups ADD COLUMN default_choice INTEGER;
ALTER TABLE nc_hosted_setups ADD COLUMN previous_default_ref TEXT;
CREATE TABLE nc_hosted_setup_history (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES nc_customers(id),
  method TEXT NOT NULL,
  method_json TEXT,
  status TEXT NOT NULL,
  consent_json TEXT,
  consent_hash TEXT,
  accepted_at INTEGER,
  default_choice INTEGER,
  previous_default_ref TEXT,
  account_ref TEXT NOT NULL,
  customer_ref TEXT NOT NULL,
  session_ref TEXT,
  completed_at INTEGER
);
-- Preserve earlier observations without inventing consent or acceptance dates.
INSERT INTO nc_hosted_setup_history(id,customer_id,method,method_json,status,account_ref,customer_ref,session_ref,completed_at)
SELECT s.id,s.customer_id,s.method,s.method_json,s.status,b.account_ref,b.stripe_customer_ref,s.session_ref,s.completed_at
FROM nc_hosted_setups s JOIN nc_stripe_customer_bindings b ON b.id=s.binding_id;
CREATE TRIGGER nc_hosted_setup_history_generation_insert AFTER INSERT ON nc_hosted_setup_history BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_hosted_setup_history_generation_update AFTER UPDATE ON nc_hosted_setup_history BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_hosted_setup_history_generation_delete AFTER DELETE ON nc_hosted_setup_history BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
