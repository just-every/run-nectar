-- Ephemeral customer authority; excluded from installation archives.
CREATE TABLE nc_portal_signins (
 id TEXT PRIMARY KEY,
 purpose TEXT NOT NULL CHECK(purpose IN ('request','confirmation')),
 rate_key TEXT NOT NULL,
 rate_subject TEXT NOT NULL,
 issued_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 token_hash TEXT UNIQUE,
 customer_id TEXT,
 customer_revision TEXT,
 contact_id TEXT,
 email_hash TEXT,
 origin TEXT,
 policy_revision TEXT,
 ready_at INTEGER,
 consumed_at INTEGER,
 revoked_at INTEGER,
 CHECK(expires_at=issued_at+900000)
);
CREATE INDEX nc_portal_signin_window ON nc_portal_signins(purpose,issued_at);
CREATE INDEX nc_portal_signin_expiry ON nc_portal_signins(expires_at);
CREATE INDEX nc_portal_signin_rate ON nc_portal_signins(purpose,rate_key,issued_at);
CREATE INDEX nc_portal_signin_subject ON nc_portal_signins(purpose,rate_subject,issued_at);
CREATE INDEX nc_portal_signin_customer ON nc_portal_signins(customer_id);
ALTER TABLE nc_portal_sessions ADD COLUMN contact_id TEXT;
ALTER TABLE nc_portal_sessions ADD COLUMN email_hash TEXT;
