-- Source discounts can cover one item even when several share a price.
ALTER TABLE nc_amendments ADD COLUMN item_id TEXT REFERENCES nc_items(id);
CREATE INDEX nc_amendments_item ON nc_amendments(item_id);
CREATE TRIGGER nc_amendments_item_insert BEFORE INSERT ON nc_amendments
WHEN NEW.item_id IS NOT NULL AND (NEW.kind <> 'discount_percent' OR NOT EXISTS(
 SELECT 1 FROM nc_items WHERE id=NEW.item_id AND subscription_id=NEW.subscription_id
)) BEGIN SELECT RAISE(ABORT,'nectar_guard_amendment_item'); END;
CREATE TRIGGER nc_amendments_item_update BEFORE UPDATE ON nc_amendments
WHEN NEW.item_id IS NOT NULL AND (NEW.kind <> 'discount_percent' OR NOT EXISTS(
 SELECT 1 FROM nc_items WHERE id=NEW.item_id AND subscription_id=NEW.subscription_id
)) BEGIN SELECT RAISE(ABORT,'nectar_guard_amendment_item'); END;
