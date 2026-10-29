-- A preparation grants no provider write. Historical evidence survives restore;
-- executable preparation authority is excluded from archives.
CREATE TABLE nc_native_reconfirmations (
 id TEXT PRIMARY KEY, collection_id TEXT NOT NULL REFERENCES nc_native_collections(id),
 invoice_id TEXT NOT NULL, customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 original_revision TEXT NOT NULL, payment_intent_ref TEXT NOT NULL,
 amount_cents INTEGER NOT NULL, first_failed_at INTEGER NOT NULL,
 failure_json TEXT NOT NULL CHECK(json_valid(failure_json)),
 basis_json TEXT NOT NULL CHECK(json_valid(basis_json)), basis_hash TEXT NOT NULL,
 hold_basis TEXT NOT NULL, policy_json TEXT NOT NULL CHECK(json_valid(policy_json)),
 prepared_by TEXT NOT NULL, prepared_at INTEGER NOT NULL, claimed_at INTEGER
);
CREATE UNIQUE INDEX nc_native_reconfirmation_once ON nc_native_reconfirmations(collection_id) WHERE claimed_at IS NOT NULL;
CREATE TABLE nc_native_reconfirmation_authority (
 id TEXT PRIMARY KEY REFERENCES nc_native_reconfirmations(id), customer_id TEXT NOT NULL,
 session_id TEXT NOT NULL, factor_reference TEXT NOT NULL
);
DROP TRIGGER nc_native_collection_basis;
CREATE TRIGGER nc_native_collection_basis BEFORE UPDATE ON nc_native_collections
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (OLD.id IS NOT NEW.id OR OLD.invoice_id IS NOT NEW.invoice_id OR OLD.customer_id IS NOT NEW.customer_id
 OR OLD.account_ref IS NOT NEW.account_ref OR OLD.stripe_customer_ref IS NOT NEW.stripe_customer_ref OR OLD.payment_method_ref IS NOT NEW.payment_method_ref
 OR OLD.basis_json IS NOT NEW.basis_json OR OLD.basis_hash IS NOT NEW.basis_hash OR OLD.amount_cents IS NOT NEW.amount_cents OR OLD.currency IS NOT NEW.currency
 OR OLD.prepared_by IS NOT NEW.prepared_by OR OLD.prepared_at IS NOT NEW.prepared_at OR (OLD.status IN ('collected','declined','customer_action_required') AND NOT (OLD.status='declined' AND NEW.status='claimed' AND EXISTS(SELECT 1 FROM nc_native_reconfirmations r JOIN nc_native_reconfirmation_authority a ON a.id=r.id WHERE r.collection_id=OLD.id AND r.original_revision=OLD.revision AND r.claimed_at IS NOT NULL AND r.payment_intent_ref=OLD.payment_intent_ref)))
 OR (OLD.payment_intent_ref IS NOT NULL AND OLD.payment_intent_ref IS NOT NEW.payment_intent_ref)
 OR (OLD.charge_ref IS NOT NULL AND OLD.charge_ref IS NOT NEW.charge_ref)
 OR NOT(OLD.status=NEW.status OR (OLD.status='declined' AND NEW.status='claimed' AND EXISTS(SELECT 1 FROM nc_native_reconfirmations r JOIN nc_native_reconfirmation_authority a ON a.id=r.id WHERE r.collection_id=OLD.id AND r.original_revision=OLD.revision AND r.claimed_at IS NOT NULL AND r.payment_intent_ref=OLD.payment_intent_ref)) OR (OLD.status='pending' AND NEW.status='claimed') OR (OLD.status IN ('claimed','uncertain') AND NEW.status IN ('uncertain','declined','customer_action_required','collected')))
 OR (NEW.status<>'pending' AND NOT EXISTS(SELECT 1 FROM nc_native_collection_claims WHERE request_id=NEW.id AND invoice_id=NEW.invoice_id)))
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;

CREATE TRIGGER nc_native_reconfirmation_immutable BEFORE UPDATE ON nc_native_reconfirmations
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND (OLD.claimed_at IS NOT NULL OR NEW.claimed_at IS NULL OR OLD.id IS NOT NEW.id OR OLD.collection_id IS NOT NEW.collection_id
 OR OLD.invoice_id IS NOT NEW.invoice_id OR OLD.customer_id IS NOT NEW.customer_id OR OLD.original_revision IS NOT NEW.original_revision
 OR OLD.payment_intent_ref IS NOT NEW.payment_intent_ref OR OLD.amount_cents IS NOT NEW.amount_cents OR OLD.first_failed_at IS NOT NEW.first_failed_at
 OR OLD.failure_json IS NOT NEW.failure_json OR OLD.basis_json IS NOT NEW.basis_json OR OLD.basis_hash IS NOT NEW.basis_hash
 OR OLD.hold_basis IS NOT NEW.hold_basis OR OLD.policy_json IS NOT NEW.policy_json OR OLD.prepared_by IS NOT NEW.prepared_by OR OLD.prepared_at IS NOT NEW.prepared_at)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_native_reconfirmations_generation_insert AFTER INSERT ON nc_native_reconfirmations
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_native_reconfirmations_generation_update AFTER UPDATE ON nc_native_reconfirmations
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_native_reconfirmations_generation_delete AFTER DELETE ON nc_native_reconfirmations
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_native_reconfirmations_keep BEFORE DELETE ON nc_native_reconfirmations
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_native_reconfirmation_authority_generation_insert AFTER INSERT ON nc_native_reconfirmation_authority
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_native_reconfirmation_authority_generation_update AFTER UPDATE ON nc_native_reconfirmation_authority
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_native_reconfirmation_authority_generation_delete AFTER DELETE ON nc_native_reconfirmation_authority
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_native_reconfirmation_authority_keep BEFORE DELETE ON nc_native_reconfirmation_authority
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
