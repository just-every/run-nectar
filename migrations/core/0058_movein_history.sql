-- MOVE-007: source custody is separate from native payment/billing execution.
ALTER TABLE nc_incumbent_invoices ADD COLUMN source_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE nc_incumbent_invoices ADD COLUMN issue_date TEXT;
ALTER TABLE nc_incumbent_invoices ADD COLUMN due_date TEXT;
ALTER TABLE nc_incumbent_invoices ADD COLUMN currency TEXT;

CREATE TABLE nc_incumbent_history (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES nc_customers(id),
  provider TEXT NOT NULL,
  provider_ref TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('payment','refund','dispute','subscription-event')),
  occurred_on TEXT NOT NULL,
  amount_cents INTEGER CHECK(amount_cents IS NULL OR (typeof(amount_cents)='integer' AND amount_cents>=0)),
  currency TEXT,
  status TEXT NOT NULL,
  invoice_ref TEXT,
  subscription_ref TEXT,
  payload_json TEXT NOT NULL,
  revision TEXT NOT NULL,
  UNIQUE(provider,kind,provider_ref)
);
CREATE INDEX nc_incumbent_history_customer ON nc_incumbent_history(customer_id,occurred_on,id);

CREATE TRIGGER nc_privacy_generation_nc_incumbent_history_insert AFTER INSERT ON nc_incumbent_history
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_incumbent_history_update AFTER UPDATE ON nc_incumbent_history
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_incumbent_history_delete AFTER DELETE ON nc_incumbent_history
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_owned_nc_incumbent_history_insert BEFORE INSERT ON nc_incumbent_history
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
  AND EXISTS(SELECT 1 FROM nc_customers WHERE id=NEW.customer_id AND erased_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_privacy_owned_nc_incumbent_history_update BEFORE UPDATE ON nc_incumbent_history
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
  AND EXISTS(SELECT 1 FROM nc_customers WHERE id IN (NEW.customer_id,OLD.customer_id) AND erased_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;

-- Only the owner-approved privacy batch saves this minimal numeric projection.
-- Its opaque service/credit identities never retain incumbent ids or raw text.
CREATE TABLE nc_incumbent_revenue (
  invoice_id TEXT PRIMARY KEY REFERENCES nc_incumbent_invoices(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES nc_customers(id) ON DELETE CASCADE,
  schedules_json TEXT NOT NULL CHECK(json_valid(schedules_json) AND json_type(schedules_json)='array'),
  credits_json TEXT NOT NULL CHECK(json_valid(credits_json) AND json_type(credits_json)='array'),
  source_fingerprint TEXT NOT NULL,
  policy_version TEXT NOT NULL
);
CREATE INDEX nc_incumbent_revenue_customer ON nc_incumbent_revenue(customer_id);
CREATE TRIGGER nc_incumbent_revenue_source BEFORE INSERT ON nc_incumbent_revenue
WHEN NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
  AND (NOT EXISTS(SELECT 1 FROM nc_privacy_context) OR NOT EXISTS(
    SELECT 1 FROM nc_incumbent_invoices i WHERE i.id=NEW.invoice_id AND i.customer_id=NEW.customer_id AND i.document_kind='invoice'))
BEGIN SELECT RAISE(ABORT,'nectar_guard_revenue_source_changed'); END;
CREATE TRIGGER nc_incumbent_revenue_immutable BEFORE UPDATE ON nc_incumbent_revenue
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_incumbent_revenue_keep BEFORE DELETE ON nc_incumbent_revenue
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_privacy_generation_nc_incumbent_revenue_insert AFTER INSERT ON nc_incumbent_revenue
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_incumbent_revenue_update AFTER UPDATE ON nc_incumbent_revenue
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_incumbent_revenue_delete AFTER DELETE ON nc_incumbent_revenue
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
