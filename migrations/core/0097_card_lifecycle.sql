-- Card lifecycle observations and prohibitions grant no collection authority.
-- Retain prohibitions in archives: restoring history must not revive a card.
CREATE TABLE nc_card_lifecycle (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES nc_customers(id),
  binding_id TEXT NOT NULL REFERENCES nc_stripe_customer_bindings(id),
  account_ref TEXT NOT NULL,
  stripe_customer_ref TEXT NOT NULL,
  payment_method_ref TEXT NOT NULL,
  brand TEXT,
  last4 TEXT,
  exp_month INTEGER,
  exp_year INTEGER,
  source_event_ref TEXT,
  source_created_at INTEGER,
  observed_at INTEGER,
  unusable_reason TEXT,
  unusable_at INTEGER,
  source_request_ref TEXT,
  revision TEXT NOT NULL,
  UNIQUE(account_ref,stripe_customer_ref,payment_method_ref)
);
CREATE INDEX nc_card_lifecycle_customer ON nc_card_lifecycle(customer_id);
CREATE TABLE nc_card_lifecycle_events (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES nc_customers(id),
  binding_id TEXT NOT NULL REFERENCES nc_stripe_customer_bindings(id),
  account_ref TEXT NOT NULL,
  stripe_customer_ref TEXT NOT NULL,
  event_ref TEXT,
  payment_method_ref TEXT NOT NULL,
  provider_created_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  UNIQUE(account_ref,event_ref)
);
CREATE INDEX nc_card_lifecycle_events_customer ON nc_card_lifecycle_events(customer_id);
CREATE TRIGGER nc_card_lifecycle_generation_insert AFTER INSERT ON nc_card_lifecycle BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_card_lifecycle_generation_update AFTER UPDATE ON nc_card_lifecycle BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_card_lifecycle_generation_delete AFTER DELETE ON nc_card_lifecycle BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_card_lifecycle_events_generation_insert AFTER INSERT ON nc_card_lifecycle_events BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_card_lifecycle_events_generation_update AFTER UPDATE ON nc_card_lifecycle_events BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_card_lifecycle_events_generation_delete AFTER DELETE ON nc_card_lifecycle_events BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
