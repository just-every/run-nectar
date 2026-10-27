-- Owner-approved takeover and append-only settlement custody for original invoices.
CREATE TABLE nc_processor_cash_imported_takeovers(
 id TEXT PRIMARY KEY,customer_id TEXT NOT NULL REFERENCES nc_customers(id),invoice_id TEXT NOT NULL UNIQUE REFERENCES nc_incumbent_invoices(id),
 account_ref TEXT NOT NULL,stripe_customer_ref TEXT NOT NULL,invoice_ref TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('prepared','disabling','active')),
 basis_json TEXT NOT NULL CHECK(json_valid(basis_json)),basis_hash TEXT NOT NULL,amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
 prepared_by TEXT NOT NULL,prepared_at INTEGER NOT NULL,approved_by TEXT,approved_at INTEGER,disabled_at INTEGER,
 CHECK(status='prepared' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),CHECK(status<>'active' OR disabled_at IS NOT NULL));
CREATE TABLE nc_processor_cash_imported_applications(
 id TEXT PRIMARY KEY,customer_id TEXT NOT NULL REFERENCES nc_customers(id),invoice_id TEXT NOT NULL REFERENCES nc_incumbent_invoices(id),
 takeover_id TEXT NOT NULL REFERENCES nc_processor_cash_imported_takeovers(id),account_ref TEXT NOT NULL,stripe_customer_ref TEXT NOT NULL,
 transfer_ref TEXT NOT NULL,amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents>0),currency TEXT NOT NULL CHECK(currency='usd'),
 source_hash TEXT NOT NULL,claimed_at INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN('uncertain','collected')),payment_intent_ref TEXT,charge_ref TEXT,
 collected_on TEXT,history_payment_id TEXT,proof_json TEXT CHECK(proof_json IS NULL OR json_valid(proof_json)),reconciled_at INTEGER,
 UNIQUE(account_ref,payment_intent_ref),UNIQUE(account_ref,charge_ref),
 CHECK(status<>'collected' OR (payment_intent_ref IS NOT NULL AND charge_ref IS NOT NULL AND collected_on IS NOT NULL AND proof_json IS NOT NULL AND reconciled_at IS NOT NULL)));
CREATE UNIQUE INDEX nc_processor_cash_imported_transfer ON nc_processor_cash_imported_applications(account_ref,transfer_ref,invoice_id) WHERE transfer_ref<>'';
CREATE UNIQUE INDEX nc_processor_cash_imported_uncertain ON nc_processor_cash_imported_applications(account_ref,stripe_customer_ref) WHERE status='uncertain';
CREATE TRIGGER nc_processor_cash_imported_takeover_source BEFORE INSERT ON nc_processor_cash_imported_takeovers
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND (NEW.status<>'prepared' OR EXISTS(SELECT 1 FROM nc_imported_collections WHERE invoice_id=NEW.invoice_id)
 OR NOT EXISTS(SELECT 1 FROM nc_incumbent_invoices i JOIN nc_customers c ON c.id=i.customer_id JOIN nc_stripe_customer_bindings b ON b.customer_id=c.id
 WHERE i.id=NEW.invoice_id AND c.id=NEW.customer_id AND c.status='active' AND c.erased_at IS NULL AND i.provider='stripe' AND i.status='open'
 AND i.provider_ref=NEW.invoice_ref AND i.remaining_cents=NEW.amount_cents AND b.account_ref=NEW.account_ref AND b.stripe_customer_ref=NEW.stripe_customer_ref
 AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(i.id,c.id,b.id))))
BEGIN SELECT RAISE(ABORT,'nectar_guard_processor_cash_imported_source_changed'); END;
CREATE TRIGGER nc_imported_collection_no_cash_takeover BEFORE INSERT ON nc_imported_collections
WHEN EXISTS(SELECT 1 FROM nc_processor_cash_imported_takeovers WHERE invoice_id=NEW.invoice_id)
BEGIN SELECT RAISE(ABORT,'nectar_guard_processor_cash_imported_already_managed'); END;
CREATE TRIGGER nc_processor_cash_imported_claim BEFORE INSERT ON nc_processor_cash_imported_applications
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND (NEW.status<>'uncertain' OR NEW.payment_intent_ref IS NOT NULL OR NEW.charge_ref IS NOT NULL
 OR EXISTS(SELECT 1 FROM nc_processor_cash_applications WHERE account_ref=NEW.account_ref AND stripe_customer_ref=NEW.stripe_customer_ref AND status='uncertain')
 OR NOT EXISTS(SELECT 1 FROM nc_processor_cash_imported_takeovers t JOIN nc_incumbent_invoices i ON i.id=t.invoice_id JOIN nc_customers c ON c.id=i.customer_id
 WHERE t.id=NEW.takeover_id AND t.status='active' AND t.invoice_id=NEW.invoice_id AND t.account_ref=NEW.account_ref AND t.stripe_customer_ref=NEW.stripe_customer_ref
 AND t.customer_id=NEW.customer_id AND c.status='active' AND c.erased_at IS NULL AND lower(i.currency)=NEW.currency
 AND i.remaining_cents-COALESCE((SELECT SUM(a.amount_cents) FROM nc_processor_cash_imported_applications a WHERE a.invoice_id=i.id AND a.status='collected'),0)>=NEW.amount_cents
 AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(t.id,i.id,c.id))))
BEGIN SELECT RAISE(ABORT,'nectar_guard_processor_cash_imported_source_changed'); END;
CREATE TRIGGER nc_processor_cash_native_no_imported_claim BEFORE INSERT ON nc_processor_cash_applications
WHEN EXISTS(SELECT 1 FROM nc_processor_cash_imported_applications WHERE account_ref=NEW.account_ref AND stripe_customer_ref=NEW.stripe_customer_ref AND status='uncertain')
BEGIN SELECT RAISE(ABORT,'nectar_guard_processor_cash_imported_already_claimed'); END;
CREATE TRIGGER nc_processor_cash_imported_takeover_basis BEFORE UPDATE ON nc_processor_cash_imported_takeovers
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND (OLD.id IS NOT NEW.id OR OLD.customer_id IS NOT NEW.customer_id OR OLD.invoice_id IS NOT NEW.invoice_id OR OLD.account_ref IS NOT NEW.account_ref
 OR OLD.stripe_customer_ref IS NOT NEW.stripe_customer_ref OR OLD.invoice_ref IS NOT NEW.invoice_ref OR OLD.basis_json IS NOT NEW.basis_json OR OLD.basis_hash IS NOT NEW.basis_hash
 OR OLD.amount_cents IS NOT NEW.amount_cents OR OLD.prepared_by IS NOT NEW.prepared_by OR OLD.prepared_at IS NOT NEW.prepared_at OR OLD.status='active'
 OR NOT ((OLD.status='prepared' AND NEW.status='disabling') OR (OLD.status='disabling' AND NEW.status='active')))
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_processor_cash_imported_application_basis BEFORE UPDATE ON nc_processor_cash_imported_applications
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND (OLD.id IS NOT NEW.id OR OLD.customer_id IS NOT NEW.customer_id OR OLD.invoice_id IS NOT NEW.invoice_id OR OLD.takeover_id IS NOT NEW.takeover_id
 OR OLD.account_ref IS NOT NEW.account_ref OR OLD.stripe_customer_ref IS NOT NEW.stripe_customer_ref OR OLD.transfer_ref IS NOT NEW.transfer_ref
 OR OLD.amount_cents IS NOT NEW.amount_cents OR OLD.currency IS NOT NEW.currency OR OLD.source_hash IS NOT NEW.source_hash OR OLD.claimed_at IS NOT NEW.claimed_at
 OR OLD.status='collected' OR (OLD.payment_intent_ref IS NOT NULL AND OLD.payment_intent_ref IS NOT NEW.payment_intent_ref)
 OR NOT EXISTS(SELECT 1 FROM nc_customers c WHERE c.id=NEW.customer_id AND c.status='active' AND c.erased_at IS NULL)
 OR EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN(NEW.id,NEW.customer_id,NEW.invoice_id)))
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_processor_cash_imported_takeover_keep BEFORE DELETE ON nc_processor_cash_imported_takeovers
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_processor_cash_imported_application_keep BEFORE DELETE ON nc_processor_cash_imported_applications
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_processor_cash_imported_takeover_generation_insert AFTER INSERT ON nc_processor_cash_imported_takeovers BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_processor_cash_imported_takeover_generation_update AFTER UPDATE ON nc_processor_cash_imported_takeovers BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_processor_cash_imported_takeover_generation_delete AFTER DELETE ON nc_processor_cash_imported_takeovers BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_processor_cash_imported_application_generation_insert AFTER INSERT ON nc_processor_cash_imported_applications BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_processor_cash_imported_application_generation_update AFTER UPDATE ON nc_processor_cash_imported_applications BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_processor_cash_imported_application_generation_delete AFTER DELETE ON nc_processor_cash_imported_applications BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
