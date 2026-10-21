-- MOVE-011 / SET-001 foundation: legal identities and explicit routing choices.
-- Routing references record owner intent; they are not provider credentials or
-- proof that a charge/journal was routed to that account/company.
CREATE TABLE nc_billing_entities (
  id TEXT PRIMARY KEY,
  legal_name TEXT NOT NULL,
  address TEXT NOT NULL,
  ein TEXT NOT NULL,
  invoice_prefix TEXT NOT NULL,
  invoice_number_width INTEGER NOT NULL CHECK(invoice_number_width BETWEEN 1 AND 12),
  next_invoice_number INTEGER NOT NULL DEFAULT 1 CHECK(next_invoice_number>0),
  credit_prefix TEXT NOT NULL,
  credit_number_width INTEGER NOT NULL CHECK(credit_number_width BETWEEN 1 AND 12),
  next_credit_number INTEGER NOT NULL DEFAULT 1 CHECK(next_credit_number>0),
  payment_terms_days INTEGER NOT NULL CHECK(payment_terms_days BETWEEN 0 AND 120),
  processor_account_ref TEXT NOT NULL,
  ledger_company_ref TEXT NOT NULL,
  tax_registration TEXT NOT NULL,
  revision TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
ALTER TABLE nc_customers ADD COLUMN billing_entity_id TEXT REFERENCES nc_billing_entities(id);
ALTER TABLE nc_invoices ADD COLUMN billing_entity_id TEXT REFERENCES nc_billing_entities(id);
ALTER TABLE nc_invoices ADD COLUMN billing_route_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE nc_credit_notes ADD COLUMN billing_entity_id TEXT REFERENCES nc_billing_entities(id);
ALTER TABLE nc_credit_notes ADD COLUMN billing_route_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE nc_incumbent_invoices ADD COLUMN billing_entity_id TEXT REFERENCES nc_billing_entities(id);

CREATE TABLE nc_numbering_sources (
  id TEXT PRIMARY KEY,
  entity_id TEXT REFERENCES nc_billing_entities(id),
  customer_id TEXT REFERENCES nc_customers(id),
  source_invoice_id TEXT NOT NULL REFERENCES nc_incumbent_invoices(id),
  kind TEXT NOT NULL CHECK(kind IN ('invoice','credit-note')),
  provider TEXT NOT NULL CHECK(provider='stripe'),
  account_ref TEXT NOT NULL,
  numbering_mode TEXT NOT NULL CHECK(numbering_mode IN ('account','customer')),
  capture_kind TEXT NOT NULL CHECK(capture_kind IN ('owner-recorded-settings','live-customer-api')),
  prefix TEXT NOT NULL,
  width INTEGER NOT NULL CHECK(width BETWEEN 1 AND 12),
  next_number INTEGER NOT NULL CHECK(next_number>0),
  last_number TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  source_json TEXT NOT NULL CHECK(json_valid(source_json)),
  source_hash TEXT NOT NULL,
  captured_by TEXT NOT NULL,
  captured_at INTEGER NOT NULL
);
CREATE INDEX nc_numbering_sources_scope ON nc_numbering_sources(entity_id,customer_id,captured_at,id);

CREATE TABLE nc_entity_customer_numbers (
  customer_id TEXT NOT NULL REFERENCES nc_customers(id),
  entity_id TEXT NOT NULL REFERENCES nc_billing_entities(id),
  kind TEXT NOT NULL CHECK(kind IN ('invoice','credit-note')),
  prefix TEXT NOT NULL,
  width INTEGER NOT NULL CHECK(width BETWEEN 1 AND 12),
  next_number INTEGER NOT NULL CHECK(next_number>0),
  source_id TEXT REFERENCES nc_numbering_sources(id),
  revision TEXT NOT NULL,
  PRIMARY KEY(customer_id,kind)
);
CREATE TRIGGER nc_numbering_source_immutable BEFORE UPDATE ON nc_numbering_sources
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_numbering_source_keep BEFORE DELETE ON nc_numbering_sources
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_numbering_source_customer BEFORE INSERT ON nc_numbering_sources
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND EXISTS(SELECT 1 FROM nc_customers WHERE id=NEW.customer_id AND erased_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_entity_customer_number_scope BEFORE INSERT ON nc_entity_customer_numbers
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND NOT EXISTS(SELECT 1 FROM nc_customers WHERE id=NEW.customer_id AND billing_entity_id=NEW.entity_id AND erased_at IS NULL)
BEGIN SELECT RAISE(ABORT,'nectar_guard_source_changed'); END;
CREATE TRIGGER nc_entity_customer_number_scope_update BEFORE UPDATE ON nc_entity_customer_numbers
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND NOT EXISTS(SELECT 1 FROM nc_customers WHERE id=NEW.customer_id AND billing_entity_id=NEW.entity_id AND erased_at IS NULL)
BEGIN SELECT RAISE(ABORT,'nectar_guard_source_changed'); END;
CREATE TRIGGER nc_numbering_sources_generation_insert AFTER INSERT ON nc_numbering_sources
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_numbering_sources_generation_update AFTER UPDATE ON nc_numbering_sources
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_numbering_sources_generation_delete AFTER DELETE ON nc_numbering_sources
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_entity_customer_numbers_generation_insert AFTER INSERT ON nc_entity_customer_numbers
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_entity_customer_numbers_generation_update AFTER UPDATE ON nc_entity_customer_numbers
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_entity_customer_numbers_generation_delete AFTER DELETE ON nc_entity_customer_numbers
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
