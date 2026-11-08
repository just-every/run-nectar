-- Explicitly tagged unattached test cards can exercise provider decline fixtures.
ALTER TABLE nc_sandbox_processor_authority ADD COLUMN standalone_card INTEGER NOT NULL DEFAULT 0 CHECK(standalone_card IN (0,1));
