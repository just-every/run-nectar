CREATE TABLE nc_renewal_terms (
 id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL REFERENCES nc_subscriptions(id),
 subscription_revision TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
 months INTEGER NOT NULL, auto_renew INTEGER NOT NULL, notice_days INTEGER NOT NULL,
 uplift_percent TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
 prepared_by_id TEXT NOT NULL, prepared_by TEXT NOT NULL, created_at INTEGER NOT NULL,
 decided_by TEXT, decided_at INTEGER, approval_mode TEXT,
 cycle INTEGER NOT NULL DEFAULT 0, revision TEXT NOT NULL, token_hash TEXT,
 cancelled_at INTEGER, quote TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX nc_one_active_term ON nc_renewal_terms(subscription_id) WHERE status='active';
CREATE TABLE nc_renewal_events (
 id TEXT PRIMARY KEY, term_id TEXT NOT NULL REFERENCES nc_renewal_terms(id),
 subscription_id TEXT NOT NULL REFERENCES nc_subscriptions(id), cycle INTEGER NOT NULL,
 effective_date TEXT NOT NULL, end_date TEXT NOT NULL, kind TEXT NOT NULL,
 uplift_percent TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(term_id,cycle)
);
CREATE TRIGGER nc_renewal_events_immutable BEFORE UPDATE ON nc_renewal_events BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_renewal_events_keep BEFORE DELETE ON nc_renewal_events BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TABLE nc_renewal_notices (
 id TEXT PRIMARY KEY, term_id TEXT NOT NULL REFERENCES nc_renewal_terms(id), cycle INTEGER NOT NULL,
 due_date TEXT NOT NULL, renewal_date TEXT NOT NULL, recipient TEXT NOT NULL, snapshot_json TEXT NOT NULL,
 status TEXT NOT NULL, provider_ref TEXT, created_at INTEGER NOT NULL, UNIQUE(term_id,cycle)
);
