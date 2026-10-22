-- CAT-001: immutable cadence facts extend earlier immutable price versions.
CREATE TABLE nc_price_intervals (
  price_id TEXT PRIMARY KEY REFERENCES nc_prices(id),
  interval_unit TEXT NOT NULL CHECK(interval_unit IN ('day','week','month')),
  interval_count INTEGER NOT NULL CHECK(typeof(interval_count)='integer' AND interval_count BETWEEN 1 AND 1200),
  billing_timing TEXT NOT NULL CHECK(billing_timing IN ('advance','arrears'))
);
CREATE TRIGGER nc_price_intervals_immutable BEFORE UPDATE ON nc_price_intervals
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_price_intervals_keep BEFORE DELETE ON nc_price_intervals
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_price_intervals_usage BEFORE INSERT ON nc_price_intervals
WHEN NEW.billing_timing='advance' AND EXISTS(SELECT 1 FROM nc_prices WHERE id=NEW.price_id AND kind='unit')
BEGIN SELECT RAISE(ABORT,'nectar_guard_metered_usage_requires_arrears'); END;

ALTER TABLE nc_subscriptions ADD COLUMN billing_anchor_date TEXT;
ALTER TABLE nc_subscriptions ADD COLUMN contract_term_months INTEGER CHECK(contract_term_months IS NULL OR contract_term_months BETWEEN 1 AND 119987);
ALTER TABLE nc_subscriptions ADD COLUMN contract_end_date TEXT;
ALTER TABLE nc_invoices ADD COLUMN billing_key TEXT NOT NULL DEFAULT 'legacy-monthly-arrears';
DROP INDEX nc_invoices_once;
CREATE UNIQUE INDEX nc_invoices_once ON nc_invoices(subscription_id,period_start,billing_key) WHERE status='issued' AND invoice_kind='recurring';

-- Financial ownership is claimed atomically with issue, once per item period.
CREATE TABLE nc_billing_components (
  subscription_id TEXT NOT NULL REFERENCES nc_subscriptions(id),
  component_key TEXT NOT NULL,
  invoice_id TEXT NOT NULL REFERENCES nc_invoices(id),
  item_id TEXT NOT NULL REFERENCES nc_items(id),
  service_start TEXT NOT NULL,
  service_end TEXT NOT NULL,
  nominal_start TEXT NOT NULL,
  nominal_end TEXT NOT NULL,
  PRIMARY KEY(subscription_id,component_key)
);
CREATE INDEX nc_billing_components_invoice ON nc_billing_components(invoice_id);
CREATE TRIGGER nc_billing_components_source BEFORE INSERT ON nc_billing_components
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND NOT EXISTS(SELECT 1 FROM nc_invoices i JOIN nc_items t ON t.id=NEW.item_id WHERE i.id=NEW.invoice_id AND i.status='issued' AND i.subscription_id=NEW.subscription_id AND t.subscription_id=NEW.subscription_id)
BEGIN SELECT RAISE(ABORT,'nectar_guard_billing_component_source'); END;
CREATE TRIGGER nc_billing_components_immutable BEFORE UPDATE ON nc_billing_components
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_billing_components_keep BEFORE DELETE ON nc_billing_components
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_price_intervals_generation_insert AFTER INSERT ON nc_price_intervals BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_price_intervals_generation_update AFTER UPDATE ON nc_price_intervals BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_price_intervals_generation_delete AFTER DELETE ON nc_price_intervals BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_billing_components_generation_insert AFTER INSERT ON nc_billing_components BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_billing_components_generation_update AFTER UPDATE ON nc_billing_components BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_billing_components_generation_delete AFTER DELETE ON nc_billing_components BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
