ALTER TABLE nc_amendments ADD COLUMN prepared_by_id TEXT;
CREATE TRIGGER nc_amendment_preparer BEFORE UPDATE OF prepared_by_id ON nc_amendments BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
ALTER TABLE nc_changes ADD COLUMN prepared_by_id TEXT;
CREATE TRIGGER nc_change_preparer BEFORE UPDATE OF prepared_by_id ON nc_changes BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
