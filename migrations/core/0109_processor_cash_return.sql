-- Explicit governed returns of unapplied provider cash, never invoice credits.
CREATE TABLE nc_processor_cash_returns(
 id TEXT PRIMARY KEY,customer_id TEXT NOT NULL REFERENCES nc_customers(id),account_ref TEXT NOT NULL,stripe_customer_ref TEXT NOT NULL,
 amount_cents INTEGER NOT NULL CHECK(amount_cents>0),currency TEXT NOT NULL,basis_hash TEXT NOT NULL,source_hash TEXT NOT NULL,quote_json TEXT NOT NULL,
 policy_revision INTEGER NOT NULL,needs_second INTEGER NOT NULL CHECK(needs_second IN(0,1)),prepared_by_id TEXT NOT NULL REFERENCES nc_members(id),prepared_at INTEGER NOT NULL,
 approved_by_id TEXT REFERENCES nc_members(id),approved_at INTEGER,claimed_at INTEGER,intent_key TEXT NOT NULL UNIQUE,revision TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN('prepared','superseded','claimed','uncertain','stopped','requires_action','pending','succeeded','failed','canceled')),
 refund_ref TEXT,error_code TEXT,observed_at INTEGER,provider_created_at INTEGER,completed_at INTEGER,
 CHECK(status NOT IN('prepared','superseded') OR (approved_by_id IS NULL AND claimed_at IS NULL)),
 CHECK(status IN('prepared','superseded') OR (approved_by_id IS NOT NULL AND approved_at IS NOT NULL AND claimed_at IS NOT NULL)),
 CHECK(needs_second=0 OR approved_by_id IS NULL OR approved_by_id<>prepared_by_id));
CREATE UNIQUE INDEX nc_processor_cash_return_refund ON nc_processor_cash_returns(account_ref,refund_ref) WHERE refund_ref IS NOT NULL;
CREATE UNIQUE INDEX nc_processor_cash_return_open ON nc_processor_cash_returns(account_ref,stripe_customer_ref) WHERE status IN('prepared','claimed','uncertain','requires_action','pending');
CREATE TRIGGER nc_processor_cash_return_insert BEFORE INSERT ON nc_processor_cash_returns
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND (NEW.status<>'prepared' OR NOT EXISTS(SELECT 1 FROM nc_members m JOIN oa_operators o ON o.email=m.email WHERE m.id=NEW.prepared_by_id AND m.role='owner' AND m.status='active' AND o.role='owner' AND o.status='active')
 OR NOT EXISTS(SELECT 1 FROM nc_stripe_customer_bindings b JOIN nc_customers c ON c.id=b.customer_id WHERE b.customer_id=NEW.customer_id AND b.account_ref=NEW.account_ref AND b.stripe_customer_ref=NEW.stripe_customer_ref AND c.status='active' AND c.erased_at IS NULL)
 OR EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id=NEW.customer_id))
BEGIN SELECT RAISE(ABORT,'nectar_guard_processor_cash_return_authority'); END;
CREATE TRIGGER nc_processor_cash_return_update BEFORE UPDATE ON nc_processor_cash_returns
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND (OLD.id IS NOT NEW.id OR OLD.customer_id IS NOT NEW.customer_id OR OLD.account_ref IS NOT NEW.account_ref OR OLD.stripe_customer_ref IS NOT NEW.stripe_customer_ref
 OR OLD.amount_cents IS NOT NEW.amount_cents OR OLD.currency IS NOT NEW.currency OR OLD.basis_hash IS NOT NEW.basis_hash OR OLD.source_hash IS NOT NEW.source_hash OR OLD.quote_json IS NOT NEW.quote_json
 OR OLD.policy_revision IS NOT NEW.policy_revision OR OLD.needs_second IS NOT NEW.needs_second OR OLD.prepared_by_id IS NOT NEW.prepared_by_id OR OLD.prepared_at IS NOT NEW.prepared_at OR OLD.intent_key IS NOT NEW.intent_key
 OR (OLD.claimed_at IS NOT NULL AND (OLD.claimed_at IS NOT NEW.claimed_at OR OLD.approved_by_id IS NOT NEW.approved_by_id OR OLD.approved_at IS NOT NEW.approved_at))
 OR (OLD.refund_ref IS NOT NULL AND OLD.refund_ref IS NOT NEW.refund_ref)
 OR (OLD.status='prepared' AND NEW.status NOT IN('claimed','superseded'))
 OR (OLD.status='prepared' AND NEW.status='claimed' AND NOT EXISTS(SELECT 1 FROM nc_members a JOIN oa_operators o ON o.email=a.email WHERE a.id=NEW.approved_by_id AND a.status='active' AND a.role IN('owner','finance') AND o.status='active' AND (a.role<>'owner' OR o.role='owner')))
 OR (OLD.status<>'prepared' AND NEW.status IN('prepared','claimed','superseded')))
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_processor_cash_return_keep BEFORE DELETE ON nc_processor_cash_returns
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_processor_cash_return_generation_insert AFTER INSERT ON nc_processor_cash_returns BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_processor_cash_return_generation_update AFTER UPDATE ON nc_processor_cash_returns BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_processor_cash_return_generation_delete AFTER DELETE ON nc_processor_cash_returns BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
