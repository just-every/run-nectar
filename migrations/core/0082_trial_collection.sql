-- Amount coupon operands are snapshotted into ordinary rating inputs.
CREATE TABLE nc_coupon_amount_terms (
  id TEXT PRIMARY KEY,
  redemption_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL REFERENCES nc_subscriptions(id),
  customer_id TEXT NOT NULL REFERENCES nc_customers(id),
  value TEXT NOT NULL,
  duration TEXT NOT NULL CHECK(duration IN ('once','repeating','forever')),
  months INTEGER,
  effective_from TEXT NOT NULL,
  price_ids_json TEXT NOT NULL,
  note TEXT NOT NULL
);
CREATE INDEX nc_coupon_amount_subscription ON nc_coupon_amount_terms(subscription_id,effective_from,id);

-- A one-date, one-invoice authority, distinct from ordinary manual collection.
-- A durable native invoice claim is still required before any processor POST.
CREATE TABLE nc_trial_collections (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES nc_subscriptions(id),
  customer_id TEXT NOT NULL REFERENCES nc_customers(id),
  trial_end TEXT NOT NULL,
  quote_json TEXT NOT NULL,
  basis_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending_owner','pending_approval','active','claimed','uncertain','collected','declined','customer_action_required','revoked','invalidated','expired','rejected')),
  prepared_by TEXT NOT NULL,
  prepared_at INTEGER NOT NULL,
  owner_confirmed_at INTEGER,
  approved_by TEXT,
  approved_at INTEGER,
  approval_mode TEXT CHECK(approval_mode IN ('single-approver','two-person')),
  invoice_id TEXT REFERENCES nc_invoices(id),
  native_request_id TEXT,
  error_code TEXT,
  ended_at INTEGER,
  revision TEXT NOT NULL
);
CREATE INDEX nc_trial_collection_due ON nc_trial_collections(status,trial_end,id);
CREATE UNIQUE INDEX nc_trial_collection_active ON nc_trial_collections(subscription_id)
  WHERE status IN ('pending_owner','pending_approval','active','claimed','uncertain');

-- New customer-scoped operands participate in the existing erasure race fence.
CREATE TRIGGER nc_trial_collections_generation_insert AFTER INSERT ON nc_trial_collections
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_trial_collections_generation_update AFTER UPDATE ON nc_trial_collections
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_trial_collections_generation_delete AFTER DELETE ON nc_trial_collections
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_coupon_amount_terms_generation_insert AFTER INSERT ON nc_coupon_amount_terms
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_coupon_amount_terms_generation_update AFTER UPDATE ON nc_coupon_amount_terms
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_coupon_amount_terms_generation_delete AFTER DELETE ON nc_coupon_amount_terms
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
