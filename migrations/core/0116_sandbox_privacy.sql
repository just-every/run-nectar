-- Incidental personal labels participate in native erasure. Clock, calendar
-- and money changes remain unavailable outside their ordinary sandbox doors.
DROP TRIGGER nc_sandbox_catalog_fixed;
DROP TRIGGER nc_sandbox_customer_basis;
DROP TRIGGER nc_sandbox_preview_fixed;
CREATE TRIGGER nc_sandbox_catalog_fixed BEFORE UPDATE ON nc_sandbox_catalogs
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_sandbox_customer_basis BEFORE UPDATE ON nc_sandbox_customers
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND (OLD.id IS NOT NEW.id OR OLD.catalog_id IS NOT NEW.catalog_id OR OLD.label IS NOT NEW.label
 OR OLD.start_date IS NOT NEW.start_date OR OLD.trial_end IS NOT NEW.trial_end
 OR OLD.items_json IS NOT NEW.items_json OR OLD.created_at IS NOT NEW.created_at
 OR NEW.clock_at<=OLD.clock_at OR NEW.revision<>OLD.revision+1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_sandbox_preview_fixed BEFORE UPDATE ON nc_sandbox_previews
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_sandbox_catalog_generation_insert AFTER INSERT ON nc_sandbox_catalogs BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_sandbox_catalog_generation_update AFTER UPDATE ON nc_sandbox_catalogs BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_sandbox_catalog_generation_delete AFTER DELETE ON nc_sandbox_catalogs BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_sandbox_customer_generation_insert AFTER INSERT ON nc_sandbox_customers BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_sandbox_customer_generation_update AFTER UPDATE ON nc_sandbox_customers BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_sandbox_customer_generation_delete AFTER DELETE ON nc_sandbox_customers BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_sandbox_preview_generation_insert AFTER INSERT ON nc_sandbox_previews BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_sandbox_preview_generation_update AFTER UPDATE ON nc_sandbox_previews BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_sandbox_preview_generation_delete AFTER DELETE ON nc_sandbox_previews BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
