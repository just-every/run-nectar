-- Owner-authorized, setup-only native subscription signup. No debit authority.
CREATE TABLE nc_payment_links (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','inactive')),
  terms_json TEXT NOT NULL CHECK(json_valid(terms_json)),
  basis_hash TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  max_uses INTEGER CHECK(max_uses IS NULL OR max_uses BETWEEN 1 AND 1000000),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK(used_count>=0),
  reserved_count INTEGER NOT NULL DEFAULT 0 CHECK(reserved_count>=0),
  created_by TEXT NOT NULL,
  approval_status TEXT NOT NULL CHECK(approval_status IN ('pending','approved','rejected')),
  approved_by TEXT,
  approved_at INTEGER,
  approval_mode TEXT,
  created_at INTEGER NOT NULL,
  deactivated_at INTEGER,
  revision TEXT NOT NULL
);
-- Operational consent to publish this link; excluded from archives. Restored
-- configuration is historical until a current owner explicitly activates it.
CREATE TABLE nc_payment_link_activations (
  id TEXT PRIMARY KEY,
  link_id TEXT NOT NULL UNIQUE REFERENCES nc_payment_links(id),
  created_by TEXT NOT NULL,
  factor_ref TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE nc_payment_link_attempts (
  id TEXT PRIMARY KEY,
  link_id TEXT NOT NULL REFERENCES nc_payment_links(id),
  customer_id TEXT REFERENCES nc_customers(id),
  subscription_id TEXT REFERENCES nc_subscriptions(id),
  invoice_id TEXT,
  payment_id TEXT REFERENCES nc_payments(id),
  status TEXT NOT NULL CHECK(status IN ('creating_customer','customer_ready','creating_checkout','open','updating_default','captured','recording_invoice','complete','expired')),
  name TEXT NOT NULL,
  billing_email TEXT NOT NULL,
  address TEXT NOT NULL,
  language TEXT NOT NULL,
  consent_json TEXT NOT NULL CHECK(json_valid(consent_json)),
  consent_hash TEXT NOT NULL,
  token_hash TEXT UNIQUE,
  expires_at INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  trial_end TEXT,
  default_choice INTEGER NOT NULL CHECK(default_choice IN (0,1)),
  customer_ref TEXT,
  session_ref TEXT,
  method_json TEXT CHECK(method_json IS NULL OR json_valid(method_json)),
  proof_json TEXT CHECK(proof_json IS NULL OR json_valid(proof_json)),
  payment_intent_ref TEXT,
  charge_ref TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  revision TEXT NOT NULL,
  UNIQUE(customer_id),
  UNIQUE(subscription_id)
);
CREATE INDEX nc_payment_link_attempts_link ON nc_payment_link_attempts(link_id,created_at,id);
CREATE INDEX nc_payment_link_attempts_customer ON nc_payment_link_attempts(customer_id);
CREATE UNIQUE INDEX nc_payment_link_attempts_session ON nc_payment_link_attempts(session_ref) WHERE session_ref IS NOT NULL;
-- Keep native provenance separately from operational bearer capabilities.
CREATE TABLE nc_payment_link_attributions (
  id TEXT PRIMARY KEY,
  link_id TEXT NOT NULL REFERENCES nc_payment_links(id),
  customer_id TEXT NOT NULL REFERENCES nc_customers(id),
  subscription_id TEXT UNIQUE REFERENCES nc_subscriptions(id),
  invoice_id TEXT REFERENCES nc_invoices(id),
  payment_id TEXT REFERENCES nc_payments(id),
  status TEXT NOT NULL DEFAULT 'complete' CHECK(status IN ('captured','complete')),
  account_ref TEXT NOT NULL,
  customer_ref TEXT NOT NULL,
  session_ref TEXT NOT NULL,
  payment_intent_ref TEXT,
  charge_ref TEXT,
  method_json TEXT CHECK(method_json IS NULL OR json_valid(method_json)),
  consent_hash TEXT NOT NULL,
  default_choice INTEGER NOT NULL CHECK(default_choice IN (0,1)),
  created_at INTEGER NOT NULL
);
CREATE INDEX nc_payment_link_attributions_customer ON nc_payment_link_attributions(customer_id);
CREATE UNIQUE INDEX nc_payment_link_attributions_session ON nc_payment_link_attributions(account_ref,session_ref);
CREATE TRIGGER nc_payment_link_attempts_generation_insert AFTER INSERT ON nc_payment_link_attempts BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_payment_link_attempts_generation_update AFTER UPDATE ON nc_payment_link_attempts BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_payment_link_attempts_generation_delete AFTER DELETE ON nc_payment_link_attempts BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_payment_link_attributions_generation_insert AFTER INSERT ON nc_payment_link_attributions BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_payment_link_attributions_generation_update AFTER UPDATE ON nc_payment_link_attributions BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_payment_link_attributions_generation_delete AFTER DELETE ON nc_payment_link_attributions BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
