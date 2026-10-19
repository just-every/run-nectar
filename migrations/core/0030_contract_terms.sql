CREATE TABLE nc_contracts (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES nc_subscriptions(id),
  subscription_revision TEXT NOT NULL,
  clause TEXT NOT NULL,
  terms_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('proposed','approved','rejected')),
  prepared_by_id TEXT NOT NULL,
  prepared_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  decided_by TEXT,
  decided_at INTEGER
);
CREATE INDEX nc_contracts_subscription ON nc_contracts(subscription_id,status);
CREATE TRIGGER nc_contracts_no_delete BEFORE DELETE ON nc_contracts BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_contracts_no_rewrite BEFORE UPDATE ON nc_contracts
WHEN OLD.status <> 'proposed' OR NEW.id <> OLD.id OR NEW.subscription_id <> OLD.subscription_id OR NEW.subscription_revision <> OLD.subscription_revision OR NEW.clause <> OLD.clause OR NEW.terms_json <> OLD.terms_json OR NEW.prepared_by_id <> OLD.prepared_by_id OR NEW.prepared_by <> OLD.prepared_by OR NEW.created_at <> OLD.created_at
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
