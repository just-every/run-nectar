-- Sandbox records have no live customer, subscription or financial references.
CREATE TABLE nc_sandbox_catalogs (
 id TEXT PRIMARY KEY, source_fingerprint TEXT NOT NULL UNIQUE,
 catalog_json TEXT NOT NULL CHECK(json_valid(catalog_json)),
 created_by TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE nc_sandbox_customers (
 id TEXT PRIMARY KEY, catalog_id TEXT NOT NULL REFERENCES nc_sandbox_catalogs(id),
 label TEXT NOT NULL, start_date TEXT NOT NULL, trial_end TEXT,
 items_json TEXT NOT NULL CHECK(json_valid(items_json)), clock_at INTEGER NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>=1), created_at INTEGER NOT NULL
);
CREATE TABLE nc_sandbox_clock_events (
 customer_id TEXT NOT NULL REFERENCES nc_sandbox_customers(id),
 revision INTEGER NOT NULL, previous_at INTEGER, clock_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL, PRIMARY KEY(customer_id,revision)
);
CREATE TABLE nc_sandbox_previews (
 customer_id TEXT NOT NULL REFERENCES nc_sandbox_customers(id),
 window_key TEXT NOT NULL, due_date TEXT NOT NULL,
 preview_json TEXT NOT NULL CHECK(json_valid(preview_json)),
 PRIMARY KEY(customer_id,window_key)
);
CREATE TRIGGER nc_sandbox_catalog_fixed BEFORE UPDATE ON nc_sandbox_catalogs
WHEN NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_sandbox_customer_basis BEFORE UPDATE ON nc_sandbox_customers
WHEN NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND (OLD.id IS NOT NEW.id OR OLD.catalog_id IS NOT NEW.catalog_id OR OLD.label IS NOT NEW.label
 OR OLD.start_date IS NOT NEW.start_date OR OLD.trial_end IS NOT NEW.trial_end
 OR OLD.items_json IS NOT NEW.items_json OR OLD.created_at IS NOT NEW.created_at
 OR NEW.clock_at<=OLD.clock_at OR NEW.revision<>OLD.revision+1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_sandbox_clock_fixed BEFORE UPDATE ON nc_sandbox_clock_events
WHEN NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_sandbox_preview_fixed BEFORE UPDATE ON nc_sandbox_previews
WHEN NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
