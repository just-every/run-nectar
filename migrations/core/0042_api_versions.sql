-- DEV-002. Each credential is pinned to a dated API version (credentials issued
-- before versions existed keep the original shape), and JSON writes may carry an
-- Idempotency-Key whose first successful result is replayed for 24 hours.
ALTER TABLE nc_agent_keys ADD COLUMN api_version TEXT NOT NULL DEFAULT '2026-10-01';
CREATE TABLE nc_idempotency (
  actor_ref TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','done')),
  response_status INTEGER,
  response_json TEXT CHECK(response_json IS NULL OR json_valid(response_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(actor_ref, idempotency_key)
);
CREATE INDEX nc_idempotency_created ON nc_idempotency(created_at);
