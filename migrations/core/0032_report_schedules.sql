-- A member chooses their own monthly report. Delivery snapshots are immutable;
-- statuses retain the distinction between provider acceptance and delivery.
CREATE TABLE nc_report_schedules (
  member_id TEXT PRIMARY KEY REFERENCES nc_members(id),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  day INTEGER NOT NULL CHECK(day BETWEEN 1 AND 28),
  revision TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE nc_report_deliveries (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES nc_members(id),
  period TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('preparing','sending','accepted','suppressed','failed','rejected','uncertain')),
  reports_json TEXT,
  sources_json TEXT,
  csv TEXT,
  generated_at INTEGER NOT NULL,
  provider_ref TEXT,
  UNIQUE(member_id,period)
);
CREATE TRIGGER nc_report_snapshot_immutable BEFORE UPDATE OF reports_json,sources_json,csv,member_id,period,generated_at ON nc_report_deliveries
WHEN OLD.reports_json IS NOT NULL
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
