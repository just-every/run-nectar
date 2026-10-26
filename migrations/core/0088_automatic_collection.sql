-- Exact customer consent and human approval for one invoice collection attempt.
CREATE TABLE nc_automatic_collections (
 id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES nc_invoices(id), customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 status TEXT NOT NULL CHECK(status IN ('awaiting_customer','pending_approval','active','claimed','uncertain','pending_settlement','collected','refused','returned','revoked','invalidated')),
 basis_json TEXT NOT NULL CHECK(json_valid(basis_json)), basis_hash TEXT NOT NULL,
 prepared_by TEXT NOT NULL, prepared_at INTEGER NOT NULL, customer_session_id TEXT, accepted_at INTEGER,
 approved_by TEXT, approved_at INTEGER, approval_mode TEXT, claimed_at INTEGER,
 account_ref TEXT NOT NULL, stripe_customer_ref TEXT NOT NULL, payment_method_ref TEXT NOT NULL,
 amount_cents INTEGER NOT NULL CHECK(amount_cents BETWEEN 50 AND 99999999), method_kind TEXT NOT NULL CHECK(method_kind IN ('card','us_bank_account')),
 payment_intent_ref TEXT, charge_ref TEXT, payment_id TEXT REFERENCES nc_payments(id), allocation_id TEXT REFERENCES nc_allocations(id),
 settled_at INTEGER, error_code TEXT, revision TEXT NOT NULL
);
CREATE UNIQUE INDEX nc_automatic_collection_live ON nc_automatic_collections(invoice_id) WHERE status NOT IN ('revoked','invalidated');
CREATE UNIQUE INDEX nc_automatic_collection_attempt ON nc_automatic_collections(invoice_id) WHERE claimed_at IS NOT NULL;
CREATE UNIQUE INDEX nc_automatic_collection_intent ON nc_automatic_collections(account_ref,payment_intent_ref) WHERE payment_intent_ref IS NOT NULL;
CREATE INDEX nc_automatic_collection_customer ON nc_automatic_collections(customer_id,prepared_at);
CREATE TABLE nc_automatic_collection_events (
 account_ref TEXT NOT NULL, event_ref TEXT NOT NULL, customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 collection_id TEXT NOT NULL REFERENCES nc_automatic_collections(id), received_at INTEGER NOT NULL, PRIMARY KEY(account_ref,event_ref)
);
CREATE TRIGGER nc_automatic_collection_no_native BEFORE UPDATE OF claimed_at ON nc_automatic_collections
WHEN NEW.claimed_at IS NOT NULL AND OLD.claimed_at IS NULL AND EXISTS(SELECT 1 FROM nc_native_collection_claims WHERE invoice_id=NEW.invoice_id)
BEGIN SELECT RAISE(ABORT,'nectar_guard_native_collection_already_claimed'); END;
CREATE TRIGGER nc_native_collection_no_automatic BEFORE INSERT ON nc_native_collection_claims
WHEN EXISTS(SELECT 1 FROM nc_automatic_collections WHERE invoice_id=NEW.invoice_id AND status NOT IN ('revoked','invalidated'))
BEGIN SELECT RAISE(ABORT,'nectar_guard_automatic_collection_managed'); END;
CREATE TRIGGER nc_automatic_collection_basis BEFORE UPDATE ON nc_automatic_collections
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND (OLD.basis_json IS NOT NEW.basis_json OR OLD.basis_hash IS NOT NEW.basis_hash OR OLD.invoice_id IS NOT NEW.invoice_id
 OR OLD.customer_id IS NOT NEW.customer_id OR OLD.prepared_by IS NOT NEW.prepared_by OR OLD.prepared_at IS NOT NEW.prepared_at
 OR OLD.account_ref IS NOT NEW.account_ref OR OLD.stripe_customer_ref IS NOT NEW.stripe_customer_ref OR OLD.payment_method_ref IS NOT NEW.payment_method_ref
 OR OLD.amount_cents IS NOT NEW.amount_cents OR OLD.method_kind IS NOT NEW.method_kind
 OR (OLD.claimed_at IS NOT NULL AND OLD.claimed_at IS NOT NEW.claimed_at)
 OR (OLD.payment_intent_ref IS NOT NULL AND OLD.payment_intent_ref IS NOT NEW.payment_intent_ref)
 OR (OLD.payment_id IS NOT NULL AND OLD.payment_id IS NOT NEW.payment_id))
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_automatic_collection_generation_insert AFTER INSERT ON nc_automatic_collections BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_automatic_collection_generation_update AFTER UPDATE ON nc_automatic_collections BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_automatic_collection_generation_delete AFTER DELETE ON nc_automatic_collections BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;

-- Installation-local authority is separate from retained attempt and cash facts.
CREATE TABLE nc_automatic_collection_authorizations (
 id TEXT PRIMARY KEY REFERENCES nc_automatic_collections(id) ON DELETE CASCADE,
 customer_id TEXT NOT NULL REFERENCES nc_customers(id), invoice_id TEXT NOT NULL REFERENCES nc_invoices(id),
 basis_hash TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL
);
