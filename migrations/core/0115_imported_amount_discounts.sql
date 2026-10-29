-- Preserve source custody and exact exclusive expiry on the native amount term.
-- Defaults keep earlier native redemptions and import snapshots unchanged.
ALTER TABLE nc_coupon_amount_terms ADD COLUMN origin TEXT NOT NULL DEFAULT 'native' CHECK(origin IN ('native','import'));
ALTER TABLE nc_coupon_amount_terms ADD COLUMN effective_to TEXT;
ALTER TABLE nc_coupon_amount_terms ADD COLUMN source_json TEXT NOT NULL DEFAULT '{}';
CREATE TRIGGER nc_coupon_amount_terms_immutable BEFORE UPDATE ON nc_coupon_amount_terms
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_coupon_amount_terms_owned BEFORE INSERT ON nc_coupon_amount_terms
WHEN EXISTS(SELECT 1 FROM nc_customers WHERE id=NEW.customer_id AND erased_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'nectar_erased'); END;
