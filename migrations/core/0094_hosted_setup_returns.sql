-- Ephemeral setup-return custody. Installation archives must exclude this table.
-- id contains only the SHA-256 hash of a random opaque capability.
CREATE TABLE nc_hosted_setup_returns (
  id TEXT PRIMARY KEY,
  setup_id TEXT NOT NULL REFERENCES nc_hosted_setups(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES nc_customers(id) ON DELETE CASCADE,
  portal_session_id TEXT NOT NULL REFERENCES nc_portal_sessions(id) ON DELETE CASCADE,
  account_ref TEXT NOT NULL,
  livemode INTEGER NOT NULL CHECK(livemode IN (0,1)),
  purpose TEXT NOT NULL DEFAULT 'hosted-setup' CHECK(purpose='hosted-setup'),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX nc_hosted_setup_returns_customer ON nc_hosted_setup_returns(customer_id);
CREATE INDEX nc_hosted_setup_returns_session ON nc_hosted_setup_returns(portal_session_id);
CREATE TRIGGER nc_hosted_setup_returns_generation_insert AFTER INSERT ON nc_hosted_setup_returns
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_hosted_setup_returns_generation_update AFTER UPDATE ON nc_hosted_setup_returns
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_hosted_setup_returns_generation_delete AFTER DELETE ON nc_hosted_setup_returns
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
