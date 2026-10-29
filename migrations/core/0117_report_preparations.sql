-- Local preparation custody ends at the once-only external mail claim.
CREATE TABLE nc_report_preparations (
  delivery_id TEXT PRIMARY KEY REFERENCES nc_report_deliveries(id),
  revision TEXT NOT NULL,
  schedule_revision TEXT NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  claimed_at INTEGER
);
