-- Scheduled assurance ticks keep one record each, so a failure and its recovery stay visible.
CREATE TABLE nc_assurance_runs (
  id TEXT PRIMARY KEY,
  business_day TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed','interrupted')),
  owner_id TEXT,
  compared INTEGER,
  opened INTEGER,
  rechecked INTEGER,
  error_code TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE UNIQUE INDEX nc_assurance_runs_single ON nc_assurance_runs(status) WHERE status='running';
CREATE INDEX nc_assurance_runs_day ON nc_assurance_runs(business_day,started_at);
