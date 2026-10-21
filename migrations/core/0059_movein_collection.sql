-- MOVE-009 Stripe leg: one explicit owner-authorized attempt per original
-- invoice. The immutable source document is never made a native invoice.
CREATE TABLE nc_imported_collections (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES nc_customers(id),
  invoice_id TEXT NOT NULL UNIQUE REFERENCES nc_incumbent_invoices(id) ON DELETE CASCADE,
  account_ref TEXT NOT NULL,
  invoice_ref TEXT NOT NULL,
  number TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','claimed','uncertain','failed','collected')),
  basis_json TEXT NOT NULL CHECK(json_valid(basis_json)),
  basis_hash TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents>0),
  currency TEXT NOT NULL,
  collected_on TEXT,
  charge_ref TEXT,
  payment_ref TEXT,
  payment_intent_ref TEXT,
  custody TEXT,
  error_code TEXT,
  prepared_by TEXT NOT NULL,
  prepared_at INTEGER NOT NULL,
  approved_by TEXT,
  approved_at INTEGER,
  claimed_at INTEGER,
  disabled_at INTEGER,
  reconciled_at INTEGER,
  revision TEXT NOT NULL,
  CHECK(status<>'collected' OR (collected_on IS NOT NULL AND charge_ref IS NOT NULL AND payment_ref IS NOT NULL))
);
CREATE INDEX nc_imported_collections_customer ON nc_imported_collections(customer_id,prepared_at,id);
-- Privacy anonymization may blank provider references on several rows. Opaque
-- invoice_id remains unique, so an erased request cannot be prepared again.
CREATE UNIQUE INDEX nc_imported_collections_invoice ON nc_imported_collections(account_ref,invoice_ref) WHERE account_ref<>'' AND invoice_ref<>'';
CREATE UNIQUE INDEX nc_imported_collections_charge ON nc_imported_collections(charge_ref) WHERE charge_ref IS NOT NULL AND charge_ref<>'';

CREATE TRIGGER nc_imported_collection_source BEFORE INSERT ON nc_imported_collections
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
  AND (NEW.status<>'pending' OR NOT EXISTS(SELECT 1 FROM nc_incumbent_invoices i JOIN nc_customers c ON c.id=i.customer_id
    WHERE i.id=NEW.invoice_id AND i.customer_id=NEW.customer_id AND i.provider='stripe' AND i.document_kind='invoice' AND i.status='open'
      AND i.provider_ref=NEW.invoice_ref AND i.number=NEW.number AND i.currency=NEW.currency AND i.remaining_cents=NEW.amount_cents
      AND c.erased_at IS NULL AND c.status='active'))
BEGIN SELECT RAISE(ABORT,'nectar_guard_collection_source_changed'); END;

CREATE TRIGGER nc_imported_collection_basis BEFORE UPDATE ON nc_imported_collections
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
  AND (OLD.id IS NOT NEW.id OR OLD.customer_id IS NOT NEW.customer_id OR OLD.invoice_id IS NOT NEW.invoice_id
    OR OLD.account_ref IS NOT NEW.account_ref OR OLD.invoice_ref IS NOT NEW.invoice_ref OR OLD.number IS NOT NEW.number
    OR OLD.basis_json IS NOT NEW.basis_json OR OLD.basis_hash IS NOT NEW.basis_hash OR OLD.amount_cents IS NOT NEW.amount_cents
    OR OLD.currency IS NOT NEW.currency OR OLD.prepared_by IS NOT NEW.prepared_by OR OLD.prepared_at IS NOT NEW.prepared_at
    OR OLD.status='collected' OR OLD.status='failed'
    OR NOT(OLD.status=NEW.status OR (OLD.status='pending' AND NEW.status='claimed')
      OR (OLD.status IN ('claimed','uncertain') AND NEW.status IN ('uncertain','failed','collected'))))
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_imported_collection_keep BEFORE DELETE ON nc_imported_collections
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;

CREATE TRIGGER nc_privacy_owned_nc_imported_collections_insert BEFORE INSERT ON nc_imported_collections
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
  AND (EXISTS(SELECT 1 FROM nc_customers WHERE id=NEW.customer_id AND erased_at IS NOT NULL)
    OR EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN (NEW.id,NEW.invoice_id,NEW.customer_id)))
BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_imported_collections_update BEFORE UPDATE ON nc_imported_collections
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
  AND (EXISTS(SELECT 1 FROM nc_customers WHERE id IN (NEW.customer_id,OLD.customer_id) AND erased_at IS NOT NULL)
    OR EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN (NEW.id,NEW.invoice_id,NEW.customer_id,OLD.id,OLD.invoice_id,OLD.customer_id)))
BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_generation_nc_imported_collections_insert AFTER INSERT ON nc_imported_collections
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_imported_collections_update AFTER UPDATE ON nc_imported_collections
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_imported_collections_delete AFTER DELETE ON nc_imported_collections
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
