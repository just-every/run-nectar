-- Preserve the original amendment kind/price fence. A retention percentage
-- discount's selected immutable price is a separate, source-bound relation.
CREATE TABLE nc_amendment_scopes (
 amendment_id TEXT PRIMARY KEY REFERENCES nc_amendments(id) ON DELETE CASCADE,
 customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 subscription_id TEXT NOT NULL REFERENCES nc_subscriptions(id),
 price_id TEXT NOT NULL REFERENCES nc_prices(id)
);
CREATE INDEX nc_amendment_scopes_subscription ON nc_amendment_scopes(subscription_id);
CREATE TRIGGER nc_amendment_scopes_source BEFORE INSERT ON nc_amendment_scopes
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND NOT EXISTS(
 SELECT 1 FROM nc_amendments a JOIN nc_subscriptions s ON s.id=a.subscription_id JOIN nc_prices p ON p.id=NEW.price_id
 WHERE a.id=NEW.amendment_id AND a.kind='discount_percent' AND a.status='approved' AND a.price_id IS NULL
 AND s.id=NEW.subscription_id AND s.customer_id=NEW.customer_id AND p.kind IN ('flat','seat')
 AND EXISTS(SELECT 1 FROM nc_items i WHERE i.subscription_id=s.id AND i.price_id=p.id
 AND i.effective_from<COALESCE(a.effective_to,'9999-12-31') AND COALESCE(i.effective_to,'9999-12-31')>a.effective_from)
) BEGIN SELECT RAISE(ABORT,'nectar_guard_amendment_scope_source'); END;
CREATE TRIGGER nc_amendment_scopes_immutable BEFORE UPDATE ON nc_amendment_scopes
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_amendment_scopes_keep BEFORE DELETE ON nc_amendment_scopes
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_amendment_scopes_owned_insert BEFORE INSERT ON nc_amendment_scopes
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
AND EXISTS(SELECT 1 FROM nc_customers WHERE id=NEW.customer_id AND erased_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_amendment_scopes_owned_update BEFORE UPDATE ON nc_amendment_scopes
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
AND EXISTS(SELECT 1 FROM nc_customers WHERE id IN (NEW.customer_id,OLD.customer_id) AND erased_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_amendment_scopes_generation_insert AFTER INSERT ON nc_amendment_scopes
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_amendment_scopes_generation_update AFTER UPDATE ON nc_amendment_scopes
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_amendment_scopes_generation_delete AFTER DELETE ON nc_amendment_scopes
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
