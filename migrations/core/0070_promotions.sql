-- CAT-005: reusable coupons, promotion codes with redemption limits, expiry and
-- first-time-customer rules, and trial payment-method facts, extensions and outcomes.
-- A redemption materializes as approved, price-scoped contract amendments, so the
-- ordinary rating, revenue and erasure paths apply to it unchanged.
CREATE TABLE nc_coupons(
 id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE COLLATE NOCASE,kind TEXT NOT NULL CHECK(kind IN ('percent','amount')),value TEXT NOT NULL,
 duration TEXT NOT NULL CHECK(duration IN ('once','repeating','forever')),months INTEGER CHECK(months IS NULL OR months BETWEEN 1 AND 36),
 products_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(products_json)),status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
 created_by TEXT NOT NULL,created_at INTEGER NOT NULL,
 CHECK((duration='repeating')=(months IS NOT NULL)));
CREATE TABLE nc_promotion_codes(
 id TEXT PRIMARY KEY,code TEXT NOT NULL UNIQUE COLLATE NOCASE,coupon_id TEXT NOT NULL REFERENCES nc_coupons(id),
 max_redemptions INTEGER CHECK(max_redemptions IS NULL OR max_redemptions>0),expires_on TEXT,first_time_only INTEGER NOT NULL DEFAULT 0 CHECK(first_time_only IN (0,1)),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),created_by TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE nc_promotion_redemptions(
 id TEXT PRIMARY KEY,code_id TEXT NOT NULL REFERENCES nc_promotion_codes(id),coupon_id TEXT NOT NULL REFERENCES nc_coupons(id),
 customer_id TEXT NOT NULL REFERENCES nc_customers(id),subscription_id TEXT NOT NULL REFERENCES nc_subscriptions(id),
 redeemed_by TEXT NOT NULL,redeemed_at INTEGER NOT NULL,amendments_json TEXT NOT NULL CHECK(json_valid(amendments_json)),
 UNIQUE(code_id,subscription_id));
CREATE INDEX nc_promotion_redemptions_code ON nc_promotion_redemptions(code_id);
CREATE TABLE nc_trial_extensions(
 id TEXT PRIMARY KEY,subscription_id TEXT NOT NULL REFERENCES nc_subscriptions(id),customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 previous_end TEXT NOT NULL,new_end TEXT NOT NULL,days INTEGER NOT NULL CHECK(days BETWEEN 1 AND 90),extended_by TEXT NOT NULL,extended_at INTEGER NOT NULL);
ALTER TABLE nc_subscriptions ADD COLUMN trial_payment TEXT CHECK(trial_payment IS NULL OR trial_payment IN ('card','none'));
ALTER TABLE nc_subscriptions ADD COLUMN trial_outcome TEXT CHECK(trial_outcome IS NULL OR trial_outcome IN ('converted','ended_unpaid'));
ALTER TABLE nc_subscriptions ADD COLUMN trial_resolved_at INTEGER;
CREATE TRIGGER nc_coupons_content BEFORE UPDATE OF name,kind,value,duration,months,products_json ON nc_coupons BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_coupons_keep BEFORE DELETE ON nc_coupons BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_promotion_codes_content BEFORE UPDATE OF code,coupon_id,max_redemptions,expires_on,first_time_only ON nc_promotion_codes BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_promotion_codes_keep BEFORE DELETE ON nc_promotion_codes BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_promotion_redemptions_immutable BEFORE UPDATE ON nc_promotion_redemptions WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_promotion_redemptions_keep BEFORE DELETE ON nc_promotion_redemptions WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_trial_extensions_immutable BEFORE UPDATE ON nc_trial_extensions WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_trial_extensions_keep BEFORE DELETE ON nc_trial_extensions WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_coupons_generation_insert AFTER insert ON nc_coupons BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_coupons_generation_update AFTER update ON nc_coupons BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_coupons_generation_delete AFTER delete ON nc_coupons BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_promotion_codes_generation_insert AFTER insert ON nc_promotion_codes BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_promotion_codes_generation_update AFTER update ON nc_promotion_codes BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_promotion_codes_generation_delete AFTER delete ON nc_promotion_codes BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_promotion_redemptions_generation_insert AFTER insert ON nc_promotion_redemptions BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_promotion_redemptions_generation_update AFTER update ON nc_promotion_redemptions BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_promotion_redemptions_generation_delete AFTER delete ON nc_promotion_redemptions BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_trial_extensions_generation_insert AFTER insert ON nc_trial_extensions BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_trial_extensions_generation_update AFTER update ON nc_trial_extensions BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_trial_extensions_generation_delete AFTER delete ON nc_trial_extensions BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_promotion_redemptions_owned_insert BEFORE INSERT ON nc_promotion_redemptions WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND EXISTS(SELECT 1 FROM nc_customers WHERE id IN (NEW.customer_id) AND erased_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_trial_extensions_owned_insert BEFORE INSERT ON nc_trial_extensions WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND EXISTS(SELECT 1 FROM nc_customers WHERE id IN (NEW.customer_id) AND erased_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
