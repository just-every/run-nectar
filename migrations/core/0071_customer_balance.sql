-- INV-006: the customer credit balance and its own ledger. Cash overpayments
-- are a payment's unallocated amount; goodwill grants, their applications to
-- invoices and returns of overpaid cash are append-only entries. Grants and
-- returns above the GOV-002 limit are saved requests approved by another person.
ALTER TABLE nc_credit_policy ADD COLUMN balance_application TEXT NOT NULL DEFAULT 'manual' CHECK(balance_application IN ('manual','automatic'));
CREATE TABLE nc_balance_requests(
 id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('goodwill','return')),customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents>0),reason TEXT NOT NULL,
 payment_id TEXT REFERENCES nc_payments(id),reference TEXT,basis TEXT NOT NULL,policy_revision INTEGER NOT NULL,available_cents INTEGER NOT NULL,
 prepared_by_id TEXT NOT NULL REFERENCES nc_members(id),prepared_name TEXT NOT NULL,prepared_at INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','executed')),
 approved_by_id TEXT REFERENCES nc_members(id),approved_name TEXT,approved_at INTEGER,approval_mode TEXT CHECK(approval_mode IS NULL OR approval_mode IN ('single-person','two-person')),
 CHECK((kind='return')=(payment_id IS NOT NULL AND reference IS NOT NULL)),
 CHECK(status='pending' OR (approved_by_id IS NOT NULL AND approved_name IS NOT NULL AND approved_at IS NOT NULL AND approval_mode IS NOT NULL)),
 CHECK(approval_mode IS NOT 'two-person' OR approved_by_id<>prepared_by_id));
CREATE TABLE nc_balance_entries(
 id TEXT PRIMARY KEY,customer_id TEXT NOT NULL REFERENCES nc_customers(id),kind TEXT NOT NULL CHECK(kind IN ('goodwill','application','return')),
 amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents>0),
 grant_id TEXT REFERENCES nc_balance_entries(id),invoice_id TEXT REFERENCES nc_invoices(id),payment_id TEXT REFERENCES nc_payments(id),request_id TEXT REFERENCES nc_balance_requests(id),
 mode TEXT,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,
 CHECK((kind='goodwill' AND request_id IS NOT NULL AND grant_id IS NULL AND invoice_id IS NULL AND payment_id IS NULL)
   OR (kind='application' AND invoice_id IS NOT NULL AND (grant_id IS NOT NULL) <> (payment_id IS NOT NULL) AND request_id IS NULL)
   OR (kind='return' AND payment_id IS NOT NULL AND request_id IS NOT NULL AND grant_id IS NULL AND invoice_id IS NULL)));
CREATE INDEX nc_balance_entries_customer ON nc_balance_entries(customer_id,kind);
CREATE INDEX nc_balance_entries_grant ON nc_balance_entries(grant_id);
CREATE INDEX nc_balance_entries_invoice ON nc_balance_entries(invoice_id);
CREATE INDEX nc_balance_entries_payment ON nc_balance_entries(payment_id);
CREATE TRIGGER nc_balance_requests_update BEFORE UPDATE ON nc_balance_requests WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (OLD.status<>'pending' OR NEW.status<>'executed' OR OLD.id IS NOT NEW.id OR OLD.kind IS NOT NEW.kind OR OLD.customer_id IS NOT NEW.customer_id OR OLD.amount_cents IS NOT NEW.amount_cents OR OLD.reason IS NOT NEW.reason OR OLD.payment_id IS NOT NEW.payment_id OR OLD.reference IS NOT NEW.reference OR OLD.basis IS NOT NEW.basis OR OLD.policy_revision IS NOT NEW.policy_revision OR OLD.available_cents IS NOT NEW.available_cents OR OLD.prepared_by_id IS NOT NEW.prepared_by_id OR OLD.prepared_at IS NOT NEW.prepared_at) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_balance_requests_keep BEFORE DELETE ON nc_balance_requests WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_balance_entries_immutable BEFORE UPDATE ON nc_balance_entries WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_balance_entries_keep BEFORE DELETE ON nc_balance_entries WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
-- A goodwill application never exceeds its grant, and a return never exceeds the payment's unallocated cash.
CREATE TRIGGER nc_balance_entries_grant_limit BEFORE INSERT ON nc_balance_entries WHEN NEW.kind='application' AND NEW.grant_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND NEW.amount_cents>(SELECT g.amount_cents FROM nc_balance_entries g WHERE g.id=NEW.grant_id AND g.kind='goodwill' AND g.customer_id=NEW.customer_id)-COALESCE((SELECT SUM(a.amount_cents) FROM nc_balance_entries a WHERE a.grant_id=NEW.grant_id),0) BEGIN SELECT RAISE(ABORT,'nectar_guard_balance_grant'); END;
CREATE TRIGGER nc_balance_requests_generation_insert AFTER insert ON nc_balance_requests BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_balance_requests_generation_update AFTER update ON nc_balance_requests BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_balance_requests_generation_delete AFTER delete ON nc_balance_requests BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_balance_requests_owned_insert BEFORE INSERT ON nc_balance_requests WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND EXISTS(SELECT 1 FROM nc_customers WHERE id IN (NEW.customer_id) AND erased_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_balance_entries_generation_insert AFTER insert ON nc_balance_entries BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_balance_entries_generation_update AFTER update ON nc_balance_entries BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_balance_entries_generation_delete AFTER delete ON nc_balance_entries BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_balance_entries_owned_insert BEFORE INSERT ON nc_balance_entries WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND EXISTS(SELECT 1 FROM nc_customers WHERE id IN (NEW.customer_id) AND erased_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
