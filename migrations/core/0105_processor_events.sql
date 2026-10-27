-- Typed processor observations contain no raw payload or executable authority.
CREATE TABLE nc_processor_events(
 id TEXT PRIMARY KEY,account_ref TEXT NOT NULL,event_ref TEXT NOT NULL,event_type TEXT NOT NULL,object_ref TEXT NOT NULL,
 customer_id TEXT REFERENCES nc_customers(id),invoice_id TEXT REFERENCES nc_invoices(id),status TEXT NOT NULL CHECK(status IN ('applied','failed')),
 occurred_at INTEGER NOT NULL,received_at INTEGER NOT NULL,error_code TEXT,UNIQUE(account_ref,event_ref));
CREATE TABLE nc_processor_transactions(
 id TEXT PRIMARY KEY,account_ref TEXT NOT NULL,transaction_ref TEXT NOT NULL,type TEXT NOT NULL,source_ref TEXT NOT NULL,
 customer_id TEXT REFERENCES nc_customers(id),invoice_id TEXT REFERENCES nc_invoices(id),payment_id TEXT REFERENCES nc_payments(id),
 amount_cents INTEGER NOT NULL,fee_cents INTEGER NOT NULL,net_cents INTEGER NOT NULL,currency TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','available')),occurred_at INTEGER NOT NULL,available_at INTEGER NOT NULL,payout_ref TEXT,
 CHECK(net_cents=amount_cents-fee_cents),UNIQUE(account_ref,transaction_ref));
CREATE TABLE nc_processor_objects(
 account_ref TEXT NOT NULL,object_ref TEXT NOT NULL,kind TEXT NOT NULL,customer_id TEXT REFERENCES nc_customers(id),invoice_id TEXT REFERENCES nc_invoices(id),
 status TEXT NOT NULL,amount_cents INTEGER NOT NULL,currency TEXT NOT NULL,code TEXT,observed_at INTEGER NOT NULL,
 PRIMARY KEY(account_ref,object_ref));
CREATE TABLE nc_processor_reversals(
 id TEXT PRIMARY KEY,account_ref TEXT NOT NULL,source_ref TEXT NOT NULL,allocation_id TEXT NOT NULL REFERENCES nc_allocations(id),
 invoice_id TEXT NOT NULL REFERENCES nc_invoices(id),customer_id TEXT NOT NULL REFERENCES nc_customers(id),amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
 occurred_at INTEGER NOT NULL,UNIQUE(account_ref,source_ref,allocation_id));
CREATE TRIGGER nc_processor_reversals_immutable BEFORE UPDATE ON nc_processor_reversals WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_processor_reversals_keep BEFORE DELETE ON nc_processor_reversals WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TABLE nc_processor_failures(
 id TEXT PRIMARY KEY,account_ref TEXT NOT NULL,intent_ref TEXT NOT NULL,invoice_id TEXT NOT NULL REFERENCES nc_invoices(id),customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 attempted_at INTEGER NOT NULL,amount_cents INTEGER NOT NULL CHECK(amount_cents>0),decline_code TEXT NOT NULL);
CREATE TRIGGER nc_processor_failures_immutable BEFORE UPDATE ON nc_processor_failures WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_processor_failures_keep BEFORE DELETE ON nc_processor_failures WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TABLE nc_processor_cash_balances(
 account_ref TEXT NOT NULL,customer_id TEXT NOT NULL REFERENCES nc_customers(id),currency TEXT NOT NULL,amount_cents INTEGER NOT NULL CHECK(amount_cents>=0),observed_at INTEGER NOT NULL,
 PRIMARY KEY(account_ref,customer_id,currency));
CREATE TABLE nc_processor_cash_transactions(
 id TEXT PRIMARY KEY,account_ref TEXT NOT NULL,transaction_ref TEXT NOT NULL,customer_id TEXT NOT NULL REFERENCES nc_customers(id),type TEXT NOT NULL,
 amount_cents INTEGER NOT NULL,ending_balance_cents INTEGER NOT NULL,currency TEXT NOT NULL,occurred_at INTEGER NOT NULL,intent_ref TEXT,
 UNIQUE(account_ref,transaction_ref));
CREATE TRIGGER nc_processor_events_generation_insert AFTER INSERT ON nc_processor_events BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_processor_events_generation_update AFTER UPDATE ON nc_processor_events BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_processor_events_generation_delete AFTER DELETE ON nc_processor_events BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_processor_transactions_generation_insert AFTER INSERT ON nc_processor_transactions BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_processor_transactions_generation_update AFTER UPDATE ON nc_processor_transactions BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_processor_transactions_generation_delete AFTER DELETE ON nc_processor_transactions BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_processor_objects_generation_insert AFTER INSERT ON nc_processor_objects BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_processor_objects_generation_update AFTER UPDATE ON nc_processor_objects BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_processor_objects_generation_delete AFTER DELETE ON nc_processor_objects BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_processor_reversals_generation_insert AFTER INSERT ON nc_processor_reversals BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_processor_reversals_generation_update AFTER UPDATE ON nc_processor_reversals BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_processor_reversals_generation_delete AFTER DELETE ON nc_processor_reversals BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_processor_failures_generation_insert AFTER INSERT ON nc_processor_failures BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_processor_failures_generation_update AFTER UPDATE ON nc_processor_failures BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_processor_failures_generation_delete AFTER DELETE ON nc_processor_failures BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_processor_cash_balances_generation_insert AFTER INSERT ON nc_processor_cash_balances BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_processor_cash_balances_generation_update AFTER UPDATE ON nc_processor_cash_balances BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_processor_cash_balances_generation_delete AFTER DELETE ON nc_processor_cash_balances BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_processor_cash_transactions_generation_insert AFTER INSERT ON nc_processor_cash_transactions BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_processor_cash_transactions_generation_update AFTER UPDATE ON nc_processor_cash_transactions BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_processor_cash_transactions_generation_delete AFTER DELETE ON nc_processor_cash_transactions BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
