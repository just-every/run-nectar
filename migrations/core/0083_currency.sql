-- USD is the migration default for all existing immutable financial history.
ALTER TABLE nc_customers ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD' CHECK(currency IN ('USD','CAD','EUR','GBP'));
ALTER TABLE nc_prices ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD' CHECK(currency IN ('USD','CAD','EUR','GBP'));
ALTER TABLE nc_payments ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD' CHECK(currency IN ('USD','CAD','EUR','GBP'));
ALTER TABLE nc_credit_notes ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD' CHECK(currency IN ('USD','CAD','EUR','GBP'));
ALTER TABLE nc_charges ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD' CHECK(currency IN ('USD','CAD','EUR','GBP'));

CREATE TABLE nc_currency_rates (
 id TEXT PRIMARY KEY,
 currency TEXT NOT NULL CHECK(currency IN ('CAD','EUR','GBP')),
 rate_date TEXT NOT NULL CHECK(length(rate_date)=10 AND date(rate_date)=rate_date),
 usd_per_unit TEXT NOT NULL CHECK(typeof(usd_per_unit)='text' AND CAST(usd_per_unit AS REAL)>0),
 source TEXT NOT NULL CHECK(length(trim(source)) BETWEEN 1 AND 300),
 recorded_by TEXT NOT NULL, recorded_at INTEGER NOT NULL,
 UNIQUE(currency,rate_date)
);
CREATE TRIGGER nc_currency_rates_fixed BEFORE UPDATE ON nc_currency_rates
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_currency_rates_keep BEFORE DELETE ON nc_currency_rates
WHEN NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;

-- Retain the existing catalogue version sequence. Currency selects each book;
-- the underlying immutable version number remains unique across the product.
CREATE INDEX nc_prices_currency_book ON nc_prices(product_id,currency,version);
CREATE TRIGGER nc_prices_currency_fixed BEFORE UPDATE OF currency ON nc_prices
WHEN NEW.currency IS NOT OLD.currency
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_customers_currency_fixed BEFORE UPDATE OF currency ON nc_customers
WHEN NEW.currency IS NOT OLD.currency AND (
 EXISTS(SELECT 1 FROM nc_subscriptions WHERE customer_id=OLD.id) OR
 EXISTS(SELECT 1 FROM nc_invoices WHERE customer_id=OLD.id) OR
 EXISTS(SELECT 1 FROM nc_payments WHERE customer_id=OLD.id) OR
 EXISTS(SELECT 1 FROM nc_charges WHERE customer_id=OLD.id) OR
 EXISTS(SELECT 1 FROM nc_balance_requests WHERE customer_id=OLD.id) OR
 EXISTS(SELECT 1 FROM nc_balance_entries WHERE customer_id=OLD.id))
BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_currency_fixed'); END;

-- Enforce matching currencies even on less common allocation and import doors.
CREATE TRIGGER nc_items_currency_insert BEFORE INSERT ON nc_items
WHEN NOT EXISTS(SELECT 1 FROM nc_subscriptions s JOIN nc_customers c ON c.id=s.customer_id JOIN nc_prices p ON p.id=NEW.price_id WHERE s.id=NEW.subscription_id AND c.currency=p.currency)
BEGIN SELECT RAISE(ABORT,'nectar_guard_currency_mismatch'); END;
CREATE TRIGGER nc_items_currency_update BEFORE UPDATE OF price_id,subscription_id ON nc_items
WHEN NOT EXISTS(SELECT 1 FROM nc_subscriptions s JOIN nc_customers c ON c.id=s.customer_id JOIN nc_prices p ON p.id=NEW.price_id WHERE s.id=NEW.subscription_id AND c.currency=p.currency)
BEGIN SELECT RAISE(ABORT,'nectar_guard_currency_mismatch'); END;
CREATE TRIGGER nc_invoices_currency_insert BEFORE INSERT ON nc_invoices
WHEN NOT EXISTS(SELECT 1 FROM nc_customers c WHERE c.id=NEW.customer_id AND c.currency=NEW.currency)
BEGIN SELECT RAISE(ABORT,'nectar_guard_currency_mismatch'); END;
CREATE TRIGGER nc_invoices_currency_fixed BEFORE UPDATE OF currency ON nc_invoices
WHEN NEW.currency IS NOT OLD.currency
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_invoice_lines_currency_insert BEFORE INSERT ON nc_invoice_lines
WHEN NEW.price_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM nc_prices p JOIN nc_invoices i ON i.id=NEW.invoice_id WHERE p.id=NEW.price_id AND p.currency=i.currency)
BEGIN SELECT RAISE(ABORT,'nectar_guard_currency_mismatch'); END;
CREATE TRIGGER nc_payments_currency_insert BEFORE INSERT ON nc_payments
WHEN NOT EXISTS(SELECT 1 FROM nc_customers c WHERE c.id=NEW.customer_id AND c.currency=NEW.currency)
BEGIN SELECT RAISE(ABORT,'nectar_guard_currency_mismatch'); END;
CREATE TRIGGER nc_payments_currency_fixed BEFORE UPDATE OF currency ON nc_payments
WHEN NEW.currency IS NOT OLD.currency
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_credit_notes_currency_insert BEFORE INSERT ON nc_credit_notes
WHEN NOT EXISTS(SELECT 1 FROM nc_invoices i WHERE i.id=NEW.invoice_id AND i.customer_id=NEW.customer_id AND i.currency=NEW.currency)
BEGIN SELECT RAISE(ABORT,'nectar_guard_currency_mismatch'); END;
CREATE TRIGGER nc_credit_notes_currency_fixed BEFORE UPDATE OF currency ON nc_credit_notes
WHEN NEW.currency IS NOT OLD.currency
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_allocations_currency_insert BEFORE INSERT ON nc_allocations
WHEN NOT EXISTS(SELECT 1 FROM nc_payments p JOIN nc_invoices i ON i.id=NEW.invoice_id WHERE p.id=NEW.payment_id AND p.currency=i.currency)
BEGIN SELECT RAISE(ABORT,'nectar_guard_currency_mismatch'); END;
CREATE TRIGGER nc_allocations_currency_update BEFORE UPDATE OF invoice_id,payment_id ON nc_allocations
WHEN NOT EXISTS(SELECT 1 FROM nc_payments p JOIN nc_invoices i ON i.id=NEW.invoice_id WHERE p.id=NEW.payment_id AND p.currency=i.currency)
BEGIN SELECT RAISE(ABORT,'nectar_guard_currency_mismatch'); END;
CREATE TRIGGER nc_charges_currency_insert BEFORE INSERT ON nc_charges
WHEN NOT EXISTS(SELECT 1 FROM nc_customers c WHERE c.id=NEW.customer_id AND c.currency=NEW.currency)
 OR (NEW.price_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM nc_prices p WHERE p.id=NEW.price_id AND p.currency=NEW.currency))
BEGIN SELECT RAISE(ABORT,'nectar_guard_currency_mismatch'); END;
CREATE TRIGGER nc_charges_currency_fixed BEFORE UPDATE OF currency ON nc_charges
WHEN NEW.currency IS NOT OLD.currency
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;

-- Replace only the native collector's legacy USD-only CHECK. All rows, claims,
-- state guards, indexes and privacy-generation hooks are preserved.
PRAGMA defer_foreign_keys=ON;
DROP TRIGGER nc_native_collection_claim_source;
CREATE TABLE nc_native_collections_next (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES nc_invoices(id),
  customer_id TEXT NOT NULL REFERENCES nc_customers(id),
  account_ref TEXT NOT NULL,
  stripe_customer_ref TEXT NOT NULL,
  payment_method_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','claimed','uncertain','declined','customer_action_required','collected')),
  basis_json TEXT NOT NULL CHECK(json_valid(basis_json)),
  basis_hash TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents BETWEEN 50 AND 99999999),
  currency TEXT NOT NULL CHECK(currency IN ('usd','cad','eur','gbp')),
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
  CHECK(status NOT IN ('declined','customer_action_required') OR (payment_intent_ref IS NOT NULL AND error_code IS NOT NULL AND proof_json IS NOT NULL)),
  CHECK(status<>'collected' OR (payment_intent_ref IS NOT NULL AND charge_ref IS NOT NULL AND proof_json IS NOT NULL AND payment_id IS NOT NULL AND allocation_id IS NOT NULL))
);
INSERT INTO nc_native_collections_next(id,invoice_id,customer_id,account_ref,stripe_customer_ref,payment_method_ref,status,basis_json,basis_hash,amount_cents,currency,prepared_by,prepared_at,claimed_by,claimed_at,reconciled_at,payment_intent_ref,charge_ref,proof_json,payment_id,allocation_id,error_code,revision) SELECT id,invoice_id,customer_id,account_ref,stripe_customer_ref,payment_method_ref,status,basis_json,basis_hash,amount_cents,currency,prepared_by,prepared_at,claimed_by,claimed_at,reconciled_at,payment_intent_ref,charge_ref,proof_json,payment_id,allocation_id,error_code,revision FROM nc_native_collections;
DROP TABLE nc_native_collections;
ALTER TABLE nc_native_collections_next RENAME TO nc_native_collections;
CREATE INDEX nc_native_collections_customer ON nc_native_collections(customer_id,prepared_at,id);
CREATE UNIQUE INDEX nc_native_collections_intent ON nc_native_collections(account_ref,payment_intent_ref) WHERE payment_intent_ref IS NOT NULL AND payment_intent_ref<>'';
CREATE UNIQUE INDEX nc_native_collections_charge ON nc_native_collections(account_ref,charge_ref) WHERE charge_ref IS NOT NULL AND charge_ref<>'';
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
 OR OLD.prepared_by IS NOT NEW.prepared_by OR OLD.prepared_at IS NOT NEW.prepared_at OR OLD.status IN ('collected','declined','customer_action_required')
 OR (OLD.payment_intent_ref IS NOT NULL AND OLD.payment_intent_ref IS NOT NEW.payment_intent_ref)
 OR (OLD.charge_ref IS NOT NULL AND OLD.charge_ref IS NOT NEW.charge_ref)
 OR NOT(OLD.status=NEW.status OR (OLD.status='pending' AND NEW.status='claimed') OR (OLD.status IN ('claimed','uncertain') AND NEW.status IN ('uncertain','declined','customer_action_required','collected')))
 OR (NEW.status<>'pending' AND NOT EXISTS(SELECT 1 FROM nc_native_collection_claims WHERE request_id=NEW.id AND invoice_id=NEW.invoice_id)))
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_native_collection_payment BEFORE UPDATE ON nc_native_collections
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND NEW.status='collected' AND NOT EXISTS(SELECT 1 FROM nc_payments p JOIN nc_allocations a ON a.payment_id=p.id
 WHERE p.id=NEW.payment_id AND a.id=NEW.allocation_id AND p.customer_id=NEW.customer_id AND a.invoice_id=NEW.invoice_id
 AND p.amount_cents=NEW.amount_cents AND a.amount_cents=NEW.amount_cents AND p.method='card_external')
BEGIN SELECT RAISE(ABORT,'nectar_guard_native_collection_payment_mismatch'); END;
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
CREATE TRIGGER nc_native_collection_claim_source BEFORE INSERT ON nc_native_collection_claims
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND NOT EXISTS(SELECT 1 FROM nc_native_collections r JOIN nc_invoices i ON i.id=r.invoice_id JOIN nc_customers c ON c.id=r.customer_id
 WHERE r.id=NEW.request_id AND r.invoice_id=NEW.invoice_id AND r.customer_id=NEW.customer_id AND r.account_ref=NEW.account_ref
 AND json_extract(r.basis_json,'$.key')=NEW.intent_key AND r.status='pending' AND i.status='issued' AND c.erased_at IS NULL AND c.status='active')
BEGIN SELECT RAISE(ABORT,'nectar_guard_native_collection_source_changed'); END;
CREATE TRIGGER nc_native_collection_currency_insert BEFORE INSERT ON nc_native_collections
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND (NOT EXISTS(SELECT 1 FROM nc_invoices WHERE id=NEW.invoice_id AND lower(currency)=NEW.currency)
 OR json_extract(NEW.basis_json,'$.currency') IS NOT NEW.currency)
BEGIN SELECT RAISE(ABORT,'nectar_guard_currency_mismatch'); END;
CREATE TRIGGER nc_native_collection_currency_payment BEFORE UPDATE ON nc_native_collections
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND NEW.status='collected' AND NOT EXISTS(SELECT 1 FROM nc_payments WHERE id=NEW.payment_id AND lower(currency)=NEW.currency)
BEGIN SELECT RAISE(ABORT,'nectar_guard_currency_mismatch'); END;
INSERT INTO nc_guard(code,ok) SELECT 'currency_migration_foreign_keys',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check) THEN 1 ELSE 0 END;
DELETE FROM nc_guard;
PRAGMA defer_foreign_keys=OFF;

CREATE TRIGGER nc_balance_entries_usd_instrument BEFORE INSERT ON nc_balance_entries WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND EXISTS(SELECT 1 FROM nc_customers WHERE id=NEW.customer_id AND currency<>'USD') BEGIN SELECT RAISE(ABORT,'nectar_guard_currency_path_not_supported'); END;

CREATE TRIGGER nc_balance_requests_usd_instrument BEFORE INSERT ON nc_balance_requests WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND EXISTS(SELECT 1 FROM nc_customers WHERE id=NEW.customer_id AND currency<>'USD') BEGIN SELECT RAISE(ABORT,'nectar_guard_currency_path_not_supported'); END;

CREATE TRIGGER nc_write_offs_usd_instrument BEFORE INSERT ON nc_write_offs WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND EXISTS(SELECT 1 FROM nc_customers WHERE id=NEW.customer_id AND currency<>'USD') BEGIN SELECT RAISE(ABORT,'nectar_guard_currency_path_not_supported'); END;

CREATE TRIGGER nc_plan_changes_usd_instrument BEFORE INSERT ON nc_plan_changes WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND EXISTS(SELECT 1 FROM nc_customers WHERE id=NEW.customer_id AND currency<>'USD') BEGIN SELECT RAISE(ABORT,'nectar_guard_currency_path_not_supported'); END;

CREATE TRIGGER nc_usage_corrections_usd_instrument BEFORE INSERT ON nc_usage_corrections WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND EXISTS(SELECT 1 FROM nc_customers WHERE id=NEW.customer_id AND currency<>'USD') BEGIN SELECT RAISE(ABORT,'nectar_guard_currency_path_not_supported'); END;

CREATE TRIGGER nc_customer_hierarchies_usd_instrument BEFORE INSERT ON nc_customer_hierarchies WHEN EXISTS(SELECT 1 FROM nc_customers WHERE id IN (NEW.customer_id,NEW.parent_id) AND currency<>'USD') BEGIN SELECT RAISE(ABORT,'nectar_guard_currency_path_not_supported'); END;
