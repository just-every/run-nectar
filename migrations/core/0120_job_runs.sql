-- Execution observations contain no product payload or executable authority.
CREATE TABLE nc_job_dispatches (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  cron TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed','interrupted')),
  started_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  finished_at INTEGER,
  error_code TEXT CHECK(error_code IN ('storage_failure','job_failure','job_reported_failure','execution_lease_expired'))
);
CREATE INDEX nc_job_dispatches_active ON nc_job_dispatches(status,heartbeat_at);
CREATE TABLE nc_job_executions (
  dispatch_id TEXT NOT NULL REFERENCES nc_job_dispatches(id),
  ordinal INTEGER NOT NULL,
  job TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('not_started','running','completed','failed','interrupted')),
  started_at INTEGER,
  finished_at INTEGER,
  error_code TEXT CHECK(error_code IN ('storage_failure','job_failure','job_reported_failure','execution_lease_expired')),
  PRIMARY KEY(dispatch_id,ordinal)
);
