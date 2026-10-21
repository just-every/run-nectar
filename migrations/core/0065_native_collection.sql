-- Native invoice collection: one durable claim and one off-session attempt.
-- Secret keys are installation bindings and are never stored in these tables.
CREATE TABLE nc_stripe_customer_bindings (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES nc_customers(id),
  account_ref TEXT NOT NULL,
  stripe_customer_ref TEXT NOT NULL,
  revision TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(customer_id,account_ref),
  UNIQUE(account_ref,stripe_customer_ref)
);
CREATE TABLE nc_native_collections (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES nc_invoices(id),
  customer_id TEXT NOT NULL REFERENCES nc_customers(id),
  account_ref TEXT NOT NULL,
  stripe_customer_ref TEXT NOT NULL,
  payment_method_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','claimed','uncertain','collected')),
  basis_json TEXT NOT NULL CHECK(json_valid(basis_json)),
  basis_hash TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents BETWEEN 50 AND 99999999),
  currency TEXT NOT NULL CHECK(currency='usd'),
  prepared_by TEXT NOT NULL,
  prepared_at INTEGER NOT NULL,
  claimed_by TEXT,
  claimed_at INTEGER,
  reconciled_at INTEGER,
  payment_intent_ref TEXT,
  charge_ref TEXT,
  proof_json TEXT CHECK(proof_json IS NULL OR json_valid(proof_json)),
  payment_id TEXT REFERENCES nc_payments(id),
  allocation_id TEXT REFERENCES nc_allocations(id),
  error_code TEXT,
  revision TEXT NOT NULL,
  CHECK(status<>'collected' OR (payment_intent_ref IS NOT NULL AND charge_ref IS NOT NULL AND proof_json IS NOT NULL AND payment_id IS NOT NULL AND allocation_id IS NOT NULL))
);
CREATE INDEX nc_native_collections_customer ON nc_native_collections(customer_id,prepared_at,id);
CREATE UNIQUE INDEX nc_native_collections_intent ON nc_native_collections(account_ref,payment_intent_ref) WHERE payment_intent_ref IS NOT NULL AND payment_intent_ref<>'';
CREATE UNIQUE INDEX nc_native_collections_charge ON nc_native_collections(account_ref,charge_ref) WHERE charge_ref IS NOT NULL AND charge_ref<>'';
CREATE TABLE nc_native_collection_claims (
  invoice_id TEXT PRIMARY KEY REFERENCES nc_invoices(id),
  request_id TEXT NOT NULL UNIQUE REFERENCES nc_native_collections(id),
  customer_id TEXT NOT NULL REFERENCES nc_customers(id),
  account_ref TEXT NOT NULL,
  intent_key TEXT NOT NULL,
  claimed_by TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  UNIQUE(account_ref,intent_key)
);

CREATE TRIGGER nc_native_collection_source BEFORE INSERT ON nc_native_collections
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (NEW.status<>'pending' OR NOT EXISTS(SELECT 1 FROM nc_invoices i JOIN nc_customers c ON c.id=i.customer_id
 WHERE i.id=NEW.invoice_id AND i.customer_id=NEW.customer_id AND i.status='issued' AND c.status='active' AND c.erased_at IS NULL
 AND json_extract(NEW.basis_json,'$.sourceFingerprint')=i.source_fingerprint AND json_extract(NEW.basis_json,'$.customerRevision')=c.revision
 AND json_extract(NEW.basis_json,'$.amountCents')=NEW.amount_cents AND json_extract(NEW.basis_json,'$.accountRef')=NEW.account_ref))
BEGIN SELECT RAISE(ABORT,'nectar_guard_native_collection_source_changed'); END;
CREATE TRIGGER nc_native_collection_basis BEFORE UPDATE ON nc_native_collections
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (OLD.id IS NOT NEW.id OR OLD.invoice_id IS NOT NEW.invoice_id OR OLD.customer_id IS NOT NEW.customer_id
 OR OLD.account_ref IS NOT NEW.account_ref OR OLD.stripe_customer_ref IS NOT NEW.stripe_customer_ref OR OLD.payment_method_ref IS NOT NEW.payment_method_ref
 OR OLD.basis_json IS NOT NEW.basis_json OR OLD.basis_hash IS NOT NEW.basis_hash OR OLD.amount_cents IS NOT NEW.amount_cents OR OLD.currency IS NOT NEW.currency
 OR OLD.prepared_by IS NOT NEW.prepared_by OR OLD.prepared_at IS NOT NEW.prepared_at OR OLD.status='collected'
 OR (OLD.payment_intent_ref IS NOT NULL AND OLD.payment_intent_ref IS NOT NEW.payment_intent_ref)
 OR (OLD.charge_ref IS NOT NULL AND OLD.charge_ref IS NOT NEW.charge_ref)
 OR NOT(OLD.status=NEW.status OR (OLD.status='pending' AND NEW.status='claimed') OR (OLD.status IN ('claimed','uncertain') AND NEW.status IN ('uncertain','collected')))
 OR (NEW.status<>'pending' AND NOT EXISTS(SELECT 1 FROM nc_native_collection_claims WHERE request_id=NEW.id AND invoice_id=NEW.invoice_id)))
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_native_collection_claim_source BEFORE INSERT ON nc_native_collection_claims
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND NOT EXISTS(SELECT 1 FROM nc_native_collections r JOIN nc_invoices i ON i.id=r.invoice_id JOIN nc_customers c ON c.id=r.customer_id
 WHERE r.id=NEW.request_id AND r.invoice_id=NEW.invoice_id AND r.customer_id=NEW.customer_id AND r.account_ref=NEW.account_ref
 AND json_extract(r.basis_json,'$.key')=NEW.intent_key AND r.status='pending' AND i.status='issued' AND c.erased_at IS NULL AND c.status='active')
BEGIN SELECT RAISE(ABORT,'nectar_guard_native_collection_source_changed'); END;
CREATE TRIGGER nc_native_collection_payment BEFORE UPDATE ON nc_native_collections
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND NEW.status='collected' AND NOT EXISTS(SELECT 1 FROM nc_payments p JOIN nc_allocations a ON a.payment_id=p.id
 WHERE p.id=NEW.payment_id AND a.id=NEW.allocation_id AND p.customer_id=NEW.customer_id AND a.invoice_id=NEW.invoice_id
 AND p.amount_cents=NEW.amount_cents AND a.amount_cents=NEW.amount_cents AND p.method='card_external')
BEGIN SELECT RAISE(ABORT,'nectar_guard_native_collection_payment_mismatch'); END;
CREATE TRIGGER nc_stripe_customer_bindings_immutable BEFORE UPDATE ON nc_stripe_customer_bindings
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_native_collection_claims_immutable BEFORE UPDATE ON nc_native_collection_claims
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_stripe_customer_bindings_keep BEFORE DELETE ON nc_stripe_customer_bindings
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_stripe_customer_bindings_customer_insert BEFORE INSERT ON nc_stripe_customer_bindings
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (NOT EXISTS(SELECT 1 FROM nc_customers WHERE id=NEW.customer_id AND erased_at IS NULL AND status='active')
 OR EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN (NEW.customer_id)))
BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_stripe_customer_bindings_customer_update BEFORE UPDATE ON nc_stripe_customer_bindings
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (NOT EXISTS(SELECT 1 FROM nc_customers WHERE id=NEW.customer_id AND erased_at IS NULL AND status='active')
 OR EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN (NEW.customer_id)))
BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_stripe_customer_bindings_generation_insert AFTER INSERT ON nc_stripe_customer_bindings
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_stripe_customer_bindings_generation_update AFTER UPDATE ON nc_stripe_customer_bindings
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_stripe_customer_bindings_generation_delete AFTER DELETE ON nc_stripe_customer_bindings
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_native_collections_keep BEFORE DELETE ON nc_native_collections
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_native_collections_customer_insert BEFORE INSERT ON nc_native_collections
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (NOT EXISTS(SELECT 1 FROM nc_customers WHERE id=NEW.customer_id AND erased_at IS NULL AND status='active')
 OR EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN (NEW.customer_id,NEW.invoice_id)))
BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_native_collections_customer_update BEFORE UPDATE ON nc_native_collections
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (NOT EXISTS(SELECT 1 FROM nc_customers WHERE id=NEW.customer_id AND erased_at IS NULL AND status='active')
 OR EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN (NEW.customer_id,NEW.invoice_id)))
BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_native_collections_generation_insert AFTER INSERT ON nc_native_collections
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_native_collections_generation_update AFTER UPDATE ON nc_native_collections
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_native_collections_generation_delete AFTER DELETE ON nc_native_collections
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_native_collection_claims_keep BEFORE DELETE ON nc_native_collection_claims
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_native_collection_claims_customer_insert BEFORE INSERT ON nc_native_collection_claims
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (NOT EXISTS(SELECT 1 FROM nc_customers WHERE id=NEW.customer_id AND erased_at IS NULL AND status='active')
 OR EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN (NEW.customer_id,NEW.invoice_id)))
BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_native_collection_claims_customer_update BEFORE UPDATE ON nc_native_collection_claims
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (NOT EXISTS(SELECT 1 FROM nc_customers WHERE id=NEW.customer_id AND erased_at IS NULL AND status='active')
 OR EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN (NEW.customer_id,NEW.invoice_id)))
BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_native_collection_claims_generation_insert AFTER INSERT ON nc_native_collection_claims
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_native_collection_claims_generation_update AFTER UPDATE ON nc_native_collection_claims
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_native_collection_claims_generation_delete AFTER DELETE ON nc_native_collection_claims
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
