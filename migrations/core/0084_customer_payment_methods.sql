-- Historical provider observations. No mandate or authorization is represented.
-- String columns permit privacy redaction by the generic erasure inventory.
CREATE TABLE nc_customer_payment_method_snapshots (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES nc_customers(id),
  binding_id TEXT NOT NULL REFERENCES nc_stripe_customer_bindings(id),
  binding_revision TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  stripe_customer_ref TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  UNIQUE(customer_id,binding_id)
);
CREATE TABLE nc_customer_payment_methods (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES nc_customers(id),
  snapshot_id TEXT NOT NULL REFERENCES nc_customer_payment_method_snapshots(id),
  payment_method_ref TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('card','us_bank_account')),
  brand TEXT,
  last4 TEXT NOT NULL,
  exp_month INTEGER,
  exp_year INTEGER,
  bank_name TEXT,
  account_type TEXT,
  UNIQUE(snapshot_id,payment_method_ref)
);
CREATE INDEX nc_customer_payment_methods_customer ON nc_customer_payment_methods(customer_id,snapshot_id);
CREATE TRIGGER nc_customer_payment_method_snapshots_generation_insert AFTER INSERT ON nc_customer_payment_method_snapshots BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_customer_payment_method_snapshots_generation_update AFTER UPDATE ON nc_customer_payment_method_snapshots BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_customer_payment_method_snapshots_generation_delete AFTER DELETE ON nc_customer_payment_method_snapshots BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_customer_payment_methods_generation_insert AFTER INSERT ON nc_customer_payment_methods BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_customer_payment_methods_generation_update AFTER UPDATE ON nc_customer_payment_methods BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_customer_payment_methods_generation_delete AFTER DELETE ON nc_customer_payment_methods BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
