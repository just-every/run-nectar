-- CAT-009: explicit application of existing parent goodwill; no new grant or cash movement.
CREATE TABLE nc_hierarchy_credit_shares(
 id TEXT PRIMARY KEY,customer_id TEXT NOT NULL REFERENCES nc_customers(id),invoice_id TEXT NOT NULL REFERENCES nc_invoices(id),grant_id TEXT NOT NULL REFERENCES nc_balance_entries(id),
 amount_cents INTEGER NOT NULL CHECK(amount_cents>0),reason TEXT NOT NULL,basis TEXT NOT NULL,policy_revision INTEGER NOT NULL,
 prepared_by_id TEXT NOT NULL REFERENCES nc_members(id),prepared_name TEXT NOT NULL,prepared_at INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','executed')),
 approved_by_id TEXT REFERENCES nc_members(id),approved_name TEXT,approved_at INTEGER,approval_mode TEXT CHECK(approval_mode IS NULL OR approval_mode IN ('single-person','two-person')),
 entry_id TEXT UNIQUE REFERENCES nc_balance_entries(id),
 CHECK(status='pending' OR (approved_by_id IS NOT NULL AND approved_name IS NOT NULL AND approved_at IS NOT NULL AND approval_mode IS NOT NULL AND entry_id IS NOT NULL)),
 CHECK(approval_mode IS NOT 'two-person' OR approved_by_id<>prepared_by_id));
CREATE TRIGGER nc_hierarchy_credit_shares_immutable BEFORE UPDATE ON nc_hierarchy_credit_shares WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (OLD.status<>'pending' OR NEW.status<>'executed' OR OLD.id IS NOT NEW.id OR OLD.customer_id IS NOT NEW.customer_id OR OLD.invoice_id IS NOT NEW.invoice_id OR OLD.grant_id IS NOT NEW.grant_id OR OLD.amount_cents IS NOT NEW.amount_cents OR OLD.reason IS NOT NEW.reason OR OLD.basis IS NOT NEW.basis OR OLD.policy_revision IS NOT NEW.policy_revision OR OLD.prepared_by_id IS NOT NEW.prepared_by_id OR OLD.prepared_name IS NOT NEW.prepared_name OR OLD.prepared_at IS NOT NEW.prepared_at) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_hierarchy_credit_shares_keep BEFORE DELETE ON nc_hierarchy_credit_shares WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_hierarchy_credit_shares_generation_insert AFTER INSERT ON nc_hierarchy_credit_shares BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_hierarchy_credit_shares_generation_update AFTER UPDATE ON nc_hierarchy_credit_shares BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_hierarchy_credit_shares_generation_delete AFTER DELETE ON nc_hierarchy_credit_shares BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_hierarchy_credit_shares_owned BEFORE INSERT ON nc_hierarchy_credit_shares WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND EXISTS(SELECT 1 FROM nc_customers WHERE id=NEW.customer_id AND erased_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
