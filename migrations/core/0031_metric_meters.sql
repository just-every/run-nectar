ALTER TABLE nc_meters ADD COLUMN source_meter_id TEXT REFERENCES nc_meters(id);
ALTER TABLE nc_meters ADD COLUMN metric_plan_json TEXT;
ALTER TABLE nc_meters ADD COLUMN metric_key TEXT;
ALTER TABLE nc_meters ADD COLUMN metric_version INTEGER;
CREATE UNIQUE INDEX nc_metric_version ON nc_meters(metric_key,metric_version) WHERE metric_key IS NOT NULL;
ALTER TABLE nc_prices ADD COLUMN dimensions_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE nc_usage_events ADD COLUMN properties_json TEXT NOT NULL DEFAULT '{}';
CREATE TABLE nc_metric_requests (
 id TEXT PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL, unit_label TEXT NOT NULL,
 source_meter_id TEXT NOT NULL REFERENCES nc_meters(id), plan_json TEXT NOT NULL, sql_text TEXT NOT NULL,
 version INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('prepared','active')),
 prepared_by TEXT NOT NULL, prepared_at INTEGER NOT NULL, activated_by TEXT, activated_at INTEGER, meter_id TEXT
);
CREATE TABLE nc_metric_previews (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES nc_metric_requests(id), customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 period TEXT NOT NULL, source_fingerprint TEXT NOT NULL, result_json TEXT NOT NULL, prepared_by TEXT NOT NULL, prepared_at INTEGER NOT NULL
);
CREATE TRIGGER nc_metric_previews_no_update BEFORE UPDATE ON nc_metric_previews BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_metric_previews_no_delete BEFORE DELETE ON nc_metric_previews BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_metric_requests_no_delete BEFORE DELETE ON nc_metric_requests BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_metric_requests_no_rewrite BEFORE UPDATE ON nc_metric_requests WHEN OLD.status='active' OR NEW.id<>OLD.id OR NEW.code<>OLD.code OR NEW.name<>OLD.name OR NEW.unit_label<>OLD.unit_label OR NEW.source_meter_id<>OLD.source_meter_id OR NEW.plan_json<>OLD.plan_json OR NEW.sql_text<>OLD.sql_text OR NEW.version<>OLD.version OR NEW.prepared_by<>OLD.prepared_by OR NEW.prepared_at<>OLD.prepared_at BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;

CREATE TRIGGER nc_usage_properties_immutable BEFORE UPDATE ON nc_usage_events WHEN NEW.properties_json<>OLD.properties_json BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_price_dimensions_immutable BEFORE UPDATE ON nc_prices WHEN NEW.dimensions_json<>OLD.dimensions_json BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_metric_definition_immutable BEFORE UPDATE ON nc_meters WHEN NEW.source_meter_id IS NOT OLD.source_meter_id OR NEW.metric_plan_json IS NOT OLD.metric_plan_json OR NEW.metric_key IS NOT OLD.metric_key OR NEW.metric_version IS NOT OLD.metric_version BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
