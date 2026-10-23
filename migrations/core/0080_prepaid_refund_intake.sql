-- Customer/support intake retains one lifecycle id; only a current financial member
-- can turn that intake into the immutable processor quote. No intake reserves cash.
CREATE TABLE nc_prepaid_refund_intakes(
 id TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES nc_prepaid_grants(id),
 customer_id TEXT NOT NULL REFERENCES nc_customers(id), subscription_id TEXT NOT NULL REFERENCES nc_subscriptions(id),
 requested_by_kind TEXT NOT NULL CHECK(requested_by_kind IN ('member','customer')),
 requested_by_id TEXT NOT NULL, requested_at INTEGER NOT NULL,
 amount_n INTEGER NOT NULL, amount_cents INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','prepared')),
 kind TEXT NOT NULL CHECK(kind IN ('money','units')));
CREATE UNIQUE INDEX nc_prepaid_refund_intake_pending ON nc_prepaid_refund_intakes(grant_id) WHERE status='pending';
CREATE TRIGGER nc_prepaid_refund_intakes_generation_insert AFTER INSERT ON nc_prepaid_refund_intakes BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_prepaid_refund_intakes_generation_update AFTER UPDATE ON nc_prepaid_refund_intakes BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_prepaid_refund_intakes_generation_delete AFTER DELETE ON nc_prepaid_refund_intakes BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
DROP TRIGGER nc_prepaid_refund_update;
CREATE TRIGGER nc_prepaid_refund_update BEFORE UPDATE ON nc_prepaid_refunds WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
 OLD.id IS NOT NEW.id OR OLD.grant_id IS NOT NEW.grant_id OR OLD.subscription_id IS NOT NEW.subscription_id OR OLD.customer_id IS NOT NEW.customer_id OR OLD.purchase_invoice_id IS NOT NEW.purchase_invoice_id OR OLD.payment_id IS NOT NEW.payment_id OR OLD.amount_n IS NOT NEW.amount_n OR OLD.amount_cents IS NOT NEW.amount_cents OR OLD.quote_json IS NOT NEW.quote_json OR OLD.basis_hash IS NOT NEW.basis_hash OR OLD.reason IS NOT NEW.reason OR OLD.prepared_by_id IS NOT NEW.prepared_by_id OR OLD.prepared_at IS NOT NEW.prepared_at OR OLD.intent_key IS NOT NEW.intent_key
 OR OLD.status IN ('rejected','refunded','failed','stopped') OR (OLD.refund_ref IS NOT NULL AND OLD.refund_ref IS NOT NEW.refund_ref)
 OR (OLD.approved_at IS NOT NULL AND (OLD.approved_at IS NOT NEW.approved_at OR OLD.approved_by_id IS NOT NEW.approved_by_id OR OLD.approval_mode IS NOT NEW.approval_mode))
 OR NOT((OLD.status='pending' AND NEW.status IN ('approved','rejected')) OR (OLD.status='approved' AND NEW.status IN ('claimed','stopped')) OR (OLD.status IN ('claimed','uncertain') AND NEW.status IN ('uncertain','refunded','failed','stopped')))
 OR (NEW.status='approved' AND NOT EXISTS(SELECT 1 FROM nc_members p JOIN nc_members a ON a.id=NEW.approved_by_id WHERE p.id=NEW.prepared_by_id AND p.role IN ('owner','finance') AND p.status='active' AND a.role IN ('owner','finance') AND a.status='active' AND p.id<>a.id))
 OR (NEW.status='refunded' AND NOT EXISTS(SELECT 1 FROM nc_prepaid_refund_credits x JOIN nc_prepaid_ledger l ON l.id=NEW.ledger_id WHERE x.refund_id=NEW.id AND x.credit_id=NEW.credit_id AND l.kind='refund' AND l.grant_id=NEW.grant_id AND l.amount_n=-NEW.amount_n AND l.liability_cents=-NEW.amount_cents AND l.recognition_cents=0))
) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_prepaid_refund_intake_content BEFORE UPDATE ON nc_prepaid_refund_intakes WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (
 OLD.id IS NOT NEW.id OR OLD.grant_id IS NOT NEW.grant_id OR OLD.customer_id IS NOT NEW.customer_id OR OLD.subscription_id IS NOT NEW.subscription_id OR OLD.requested_by_id IS NOT NEW.requested_by_id OR OLD.requested_by_kind IS NOT NEW.requested_by_kind OR OLD.requested_at IS NOT NEW.requested_at OR OLD.amount_n IS NOT NEW.amount_n OR OLD.amount_cents IS NOT NEW.amount_cents OR OLD.kind IS NOT NEW.kind OR OLD.status<>'pending' OR NEW.status<>'prepared'
) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_prepaid_refund_intake_keep BEFORE DELETE ON nc_prepaid_refund_intakes WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_prepaid_refund_intake_owned_insert BEFORE INSERT ON nc_prepaid_refund_intakes WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND NOT EXISTS(SELECT 1 FROM nc_prepaid_grants g JOIN nc_customers c ON c.id=g.customer_id WHERE g.id=NEW.grant_id AND g.customer_id=NEW.customer_id AND g.subscription_id=NEW.subscription_id AND c.erased_at IS NULL) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
