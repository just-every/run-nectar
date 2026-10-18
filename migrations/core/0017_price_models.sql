-- Existing simple price inputs and their rating rule remain unchanged.
ALTER TABLE nc_prices ADD COLUMN pricing_model TEXT NOT NULL DEFAULT 'simple'
  CHECK (pricing_model IN ('simple', 'graduated', 'volume', 'package', 'stair_step'));
ALTER TABLE nc_prices ADD COLUMN tiers_json TEXT CHECK (tiers_json IS NULL OR json_valid(tiers_json));
ALTER TABLE nc_prices ADD COLUMN package_size TEXT;
CREATE TRIGGER nc_price_models_immutable BEFORE UPDATE OF pricing_model, tiers_json, package_size ON nc_prices
BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
CREATE TRIGGER nc_price_models_valid BEFORE INSERT ON nc_prices
WHEN (NEW.pricing_model = 'simple' AND (NEW.tiers_json IS NOT NULL OR NEW.package_size IS NOT NULL))
  OR (NEW.pricing_model <> 'simple' AND (NEW.kind = 'flat' OR NEW.tiers_json IS NULL))
  OR ((NEW.pricing_model = 'package') <> (NEW.package_size IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'nectar_invalid_price_model'); END;

-- Quantity models can bill a zero-seat band and high-volume seat counts.
-- The public handlers retain the original simple-seat range.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE nc_items_expanded (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES nc_subscriptions(id),
  price_id TEXT NOT NULL REFERENCES nc_prices(id),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 0 AND 1000000000),
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  change_id TEXT,
  origin TEXT NOT NULL DEFAULT 'native' CHECK (origin IN ('native', 'import')),
  provider_ref TEXT,
  created_at INTEGER NOT NULL,
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
INSERT INTO nc_items_expanded SELECT * FROM nc_items;
DROP TABLE nc_items;
ALTER TABLE nc_items_expanded RENAME TO nc_items;
CREATE INDEX nc_items_subscription ON nc_items (subscription_id);
PRAGMA defer_foreign_keys = OFF;
