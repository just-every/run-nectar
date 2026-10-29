-- A posted deposit is immutable evidence, with no provider token or executable authority.
CREATE TABLE nc_plaid_deposits (
 id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL UNIQUE REFERENCES nc_remittances(id), customer_id TEXT REFERENCES nc_customers(id),
 account_ref TEXT NOT NULL, transaction_ref TEXT NOT NULL, source_hash TEXT NOT NULL,
 amount_cents INTEGER NOT NULL CHECK(amount_cents>0), currency TEXT NOT NULL CHECK(currency='USD'),
 received_on TEXT NOT NULL, captured_at INTEGER NOT NULL, captured_by TEXT NOT NULL,
 UNIQUE(account_ref,transaction_ref)
);
CREATE TRIGGER nc_plaid_deposits_update BEFORE UPDATE ON nc_plaid_deposits
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND (NOT EXISTS(SELECT 1 FROM nc_remittances r WHERE r.id=OLD.receipt_id AND r.status='confirmed' AND r.customer_id=NEW.customer_id)
 OR NEW.id<>OLD.id OR NEW.receipt_id<>OLD.receipt_id OR NEW.account_ref<>OLD.account_ref OR NEW.transaction_ref<>OLD.transaction_ref OR NEW.source_hash<>OLD.source_hash
 OR NEW.amount_cents<>OLD.amount_cents OR NEW.currency<>OLD.currency OR NEW.received_on<>OLD.received_on OR NEW.captured_at<>OLD.captured_at OR NEW.captured_by<>OLD.captured_by)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_plaid_deposits_delete BEFORE DELETE ON nc_plaid_deposits
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_plaid_deposits_generation_insert AFTER INSERT ON nc_plaid_deposits BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_plaid_deposits_generation_update AFTER UPDATE ON nc_plaid_deposits BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_plaid_deposits_generation_delete AFTER DELETE ON nc_plaid_deposits BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
