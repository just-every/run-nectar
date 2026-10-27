-- One application of an observed transfer to one own native invoice. The
-- uncertain row is committed before any Stripe write and never authorizes retry.
CREATE TABLE nc_processor_cash_applications (
 id TEXT PRIMARY KEY,
 customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 invoice_id TEXT NOT NULL REFERENCES nc_invoices(id),
 account_ref TEXT NOT NULL,
 stripe_customer_ref TEXT NOT NULL,
 transfer_ref TEXT NOT NULL,
 amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents BETWEEN 50 AND 99999999),
 currency TEXT NOT NULL CHECK(currency='usd'),
 source_hash TEXT NOT NULL,
 claimed_at INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN('uncertain','collected')),
 payment_intent_ref TEXT,
 charge_ref TEXT,
 payment_id TEXT UNIQUE REFERENCES nc_payments(id),
 allocation_id TEXT UNIQUE REFERENCES nc_allocations(id),
 reconciled_at INTEGER,
 proof_json TEXT CHECK(proof_json IS NULL OR json_valid(proof_json)),
 UNIQUE(account_ref,payment_intent_ref),
 UNIQUE(account_ref,charge_ref),
 CHECK(status<>'collected' OR (payment_intent_ref IS NOT NULL AND charge_ref IS NOT NULL AND payment_id IS NOT NULL AND allocation_id IS NOT NULL AND proof_json IS NOT NULL AND reconciled_at IS NOT NULL))
);
CREATE INDEX nc_processor_cash_customer ON nc_processor_cash_applications(customer_id,claimed_at,id);
-- The privacy scrub can clear a source reference on retained financial facts.
CREATE UNIQUE INDEX nc_processor_cash_transfer ON nc_processor_cash_applications(account_ref,transfer_ref) WHERE transfer_ref<>'';
-- Serialize unresolved pooled-balance writes, even across separate webhook events.
CREATE UNIQUE INDEX nc_processor_cash_unconfirmed ON nc_processor_cash_applications(account_ref,stripe_customer_ref) WHERE status='uncertain';
CREATE TRIGGER nc_processor_cash_source BEFORE INSERT ON nc_processor_cash_applications
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND (NEW.status<>'uncertain' OR NEW.payment_intent_ref IS NOT NULL OR NEW.payment_id IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM nc_stripe_customer_bindings b JOIN nc_customers c ON c.id=b.customer_id JOIN nc_invoices i ON i.customer_id=c.id
   WHERE b.customer_id=NEW.customer_id AND b.account_ref=NEW.account_ref AND b.stripe_customer_ref=NEW.stripe_customer_ref
   AND i.id=NEW.invoice_id AND i.status='issued' AND lower(i.currency)=NEW.currency AND c.status='active' AND c.erased_at IS NULL
   AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(b.id,c.id,i.id)))
 OR EXISTS(SELECT 1 FROM nc_native_collection_claims WHERE invoice_id=NEW.invoice_id)
 OR EXISTS(SELECT 1 FROM nc_automatic_collections WHERE invoice_id=NEW.invoice_id AND status NOT IN('revoked','invalidated'))
 OR EXISTS(SELECT 1 FROM nc_prepaid_topup_claims WHERE invoice_id=NEW.invoice_id)
 OR EXISTS(SELECT 1 FROM nc_payment_link_attempts WHERE invoice_id=NEW.invoice_id))
BEGIN SELECT RAISE(ABORT,'nectar_guard_processor_cash_invoice_managed'); END;
CREATE TRIGGER nc_processor_cash_update BEFORE UPDATE ON nc_processor_cash_applications
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND (OLD.id IS NOT NEW.id OR OLD.invoice_id IS NOT NEW.invoice_id OR OLD.customer_id IS NOT NEW.customer_id
 OR OLD.account_ref IS NOT NEW.account_ref OR OLD.stripe_customer_ref IS NOT NEW.stripe_customer_ref OR OLD.transfer_ref IS NOT NEW.transfer_ref
 OR OLD.amount_cents IS NOT NEW.amount_cents OR OLD.currency IS NOT NEW.currency OR OLD.source_hash IS NOT NEW.source_hash OR OLD.claimed_at IS NOT NEW.claimed_at
 OR OLD.status='collected' OR (OLD.payment_intent_ref IS NOT NULL AND OLD.payment_intent_ref IS NOT NEW.payment_intent_ref)
 OR NOT EXISTS(SELECT 1 FROM nc_customers c WHERE c.id=NEW.customer_id AND c.status='active' AND c.erased_at IS NULL)
 OR EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(NEW.id,NEW.customer_id,NEW.invoice_id))
 OR (NEW.status='collected' AND NOT EXISTS(SELECT 1 FROM nc_payments p JOIN nc_allocations a ON a.payment_id=p.id
   WHERE p.id=NEW.payment_id AND a.id=NEW.allocation_id AND a.invoice_id=NEW.invoice_id AND p.customer_id=NEW.customer_id
   AND p.amount_cents=NEW.amount_cents AND a.amount_cents=NEW.amount_cents AND lower(p.currency)=NEW.currency AND p.method='bank_transfer'
   AND p.reference='stripe:'||NEW.account_ref||':'||NEW.payment_intent_ref)))
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_processor_cash_keep BEFORE DELETE ON nc_processor_cash_applications
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_processor_cash_generation_insert AFTER INSERT ON nc_processor_cash_applications BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_processor_cash_generation_update AFTER UPDATE ON nc_processor_cash_applications BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_processor_cash_generation_delete AFTER DELETE ON nc_processor_cash_applications BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;

-- Other collectors cannot claim this invoice after a pooled-cash write began.
CREATE TRIGGER nc_native_no_processor_cash BEFORE INSERT ON nc_native_collection_claims
WHEN EXISTS(SELECT 1 FROM nc_processor_cash_applications WHERE invoice_id=NEW.invoice_id)
BEGIN SELECT RAISE(ABORT,'nectar_guard_processor_cash_invoice_managed'); END;
CREATE TRIGGER nc_automatic_no_processor_cash BEFORE INSERT ON nc_automatic_collections
WHEN EXISTS(SELECT 1 FROM nc_processor_cash_applications WHERE invoice_id=NEW.invoice_id)
BEGIN SELECT RAISE(ABORT,'nectar_guard_processor_cash_invoice_managed'); END;
CREATE TRIGGER nc_automatic_claim_no_processor_cash BEFORE UPDATE OF claimed_at ON nc_automatic_collections
WHEN NEW.claimed_at IS NOT NULL AND EXISTS(SELECT 1 FROM nc_processor_cash_applications WHERE invoice_id=NEW.invoice_id)
BEGIN SELECT RAISE(ABORT,'nectar_guard_processor_cash_invoice_managed'); END;
CREATE TRIGGER nc_topup_no_processor_cash BEFORE UPDATE OF invoice_id ON nc_prepaid_topup_claims
WHEN EXISTS(SELECT 1 FROM nc_processor_cash_applications WHERE invoice_id=NEW.invoice_id)
BEGIN SELECT RAISE(ABORT,'nectar_guard_processor_cash_invoice_managed'); END;
CREATE TRIGGER nc_payment_link_no_processor_cash BEFORE UPDATE OF invoice_id ON nc_payment_link_attempts
WHEN EXISTS(SELECT 1 FROM nc_processor_cash_applications WHERE invoice_id=NEW.invoice_id)
BEGIN SELECT RAISE(ABORT,'nectar_guard_processor_cash_invoice_managed'); END;
