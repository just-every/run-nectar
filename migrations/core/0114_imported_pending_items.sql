-- The import adapter can undo only an untouched, unbilled imported charge.
-- All ordinary charges and every issued charge keep their immutable custody.
ALTER TABLE nc_charges ADD COLUMN origin TEXT NOT NULL DEFAULT 'native' CHECK(origin IN ('native','import'));
ALTER TABLE nc_charges ADD COLUMN import_revision TEXT;
DROP TRIGGER nc_charge_keep;
CREATE TRIGGER nc_charge_keep BEFORE DELETE ON nc_charges
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context)
  AND (OLD.origin <> 'import' OR OLD.invoice_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_charge_import_custody BEFORE UPDATE OF origin,import_revision ON nc_charges
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
