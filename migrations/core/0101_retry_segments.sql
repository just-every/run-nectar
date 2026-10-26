CREATE TABLE nc_retry_segments(customer_id TEXT PRIMARY KEY REFERENCES nc_customers(id),segment TEXT,revision TEXT NOT NULL,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE nc_retry_selection_generation(id INTEGER PRIMARY KEY CHECK(id=1),value INTEGER NOT NULL);
INSERT INTO nc_retry_selection_generation VALUES(1,0);
CREATE TRIGGER nc_retry_segments_generation_insert AFTER INSERT ON nc_retry_segments BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; UPDATE nc_retry_selection_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_retry_segments_generation_update AFTER UPDATE ON nc_retry_segments BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; UPDATE nc_retry_selection_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_retry_segments_generation_delete AFTER DELETE ON nc_retry_segments BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; UPDATE nc_retry_selection_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_retry_policies_selection_insert AFTER INSERT ON nc_retry_policies BEGIN UPDATE nc_retry_selection_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_retry_policies_selection_update AFTER UPDATE ON nc_retry_policies BEGIN UPDATE nc_retry_selection_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_retry_policies_selection_delete AFTER DELETE ON nc_retry_policies BEGIN UPDATE nc_retry_selection_generation SET value=value+1 WHERE id=1; END;
