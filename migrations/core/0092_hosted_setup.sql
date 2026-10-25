CREATE TABLE nc_hosted_setups (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES nc_customers(id),
  binding_id TEXT NOT NULL REFERENCES nc_stripe_customer_bindings(id),
  binding_revision TEXT NOT NULL,
  method TEXT NOT NULL,
  status TEXT NOT NULL,
  livemode INTEGER NOT NULL,
  session_ref TEXT,
  method_json TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE UNIQUE INDEX nc_hosted_setup_active ON nc_hosted_setups(binding_id) WHERE status <> 'complete';
CREATE TRIGGER nc_hosted_setups_generation_insert AFTER INSERT ON nc_hosted_setups BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_hosted_setups_generation_update AFTER UPDATE ON nc_hosted_setups BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_hosted_setups_generation_delete AFTER DELETE ON nc_hosted_setups BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
