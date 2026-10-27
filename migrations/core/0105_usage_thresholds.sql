-- Durable once-per-window alert custody. Editing a definition never rearms it.
CREATE TABLE nc_usage_thresholds (
 id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES nc_customers(id), subscription_id TEXT NOT NULL REFERENCES nc_subscriptions(id),
 meter_id TEXT REFERENCES nc_meters(id), contract_id TEXT REFERENCES nc_contracts(id), kind TEXT NOT NULL CHECK(kind IN ('usage','spend','commitment')),
 threshold TEXT NOT NULL, name TEXT NOT NULL, recipient TEXT NOT NULL, contact_id TEXT REFERENCES nc_contacts(id), enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
 created_by TEXT NOT NULL, revision TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX nc_usage_threshold_customer ON nc_usage_thresholds(customer_id,enabled);
CREATE TABLE nc_usage_crossings (
 id TEXT PRIMARY KEY, threshold_id TEXT NOT NULL REFERENCES nc_usage_thresholds(id), customer_id TEXT NOT NULL REFERENCES nc_customers(id), subscription_id TEXT NOT NULL REFERENCES nc_subscriptions(id),
 period_start TEXT NOT NULL, period_end TEXT NOT NULL, value TEXT NOT NULL, threshold TEXT NOT NULL, name TEXT NOT NULL, recipient TEXT NOT NULL,
 contact_id TEXT NOT NULL REFERENCES nc_contacts(id), kind TEXT NOT NULL CHECK(kind IN ('usage','spend','commitment')),
 email_status TEXT NOT NULL DEFAULT 'pending' CHECK(email_status IN ('pending','sending','accepted','suppressed','failed','uncertain')), provider_ref TEXT, created_at INTEGER NOT NULL,
 invoice_id TEXT REFERENCES nc_invoices(id), UNIQUE(threshold_id,period_start)
);
CREATE TRIGGER nc_usage_crossing_content BEFORE UPDATE OF threshold_id,customer_id,subscription_id,period_start,period_end,value,threshold,name,recipient,contact_id,kind,created_at ON nc_usage_crossings
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_usage_crossing_keep BEFORE DELETE ON nc_usage_crossings
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_usage_thresholds_generation_insert AFTER INSERT ON nc_usage_thresholds BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_usage_thresholds_generation_update AFTER UPDATE ON nc_usage_thresholds BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_usage_thresholds_generation_delete AFTER DELETE ON nc_usage_thresholds BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_usage_crossings_generation_insert AFTER INSERT ON nc_usage_crossings BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_usage_crossings_generation_update AFTER UPDATE ON nc_usage_crossings BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_usage_crossings_generation_delete AFTER DELETE ON nc_usage_crossings BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_usage_threshold_restore AFTER INSERT ON nc_usage_thresholds WHEN EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN UPDATE nc_usage_thresholds SET enabled=0 WHERE id=NEW.id; END;
CREATE TRIGGER nc_usage_crossing_restore AFTER INSERT ON nc_usage_crossings WHEN EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) BEGIN UPDATE nc_usage_crossings SET email_status='suppressed' WHERE id=NEW.id; END;
