-- Certificate custody is append-only; claims identify states where exemption is requested.
CREATE TABLE nc_exemption_claims (
 customer_id TEXT NOT NULL REFERENCES nc_customers(id), state TEXT NOT NULL,
 created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(customer_id, state)
);
CREATE TABLE nc_certificates (
 id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES nc_customers(id), state TEXT NOT NULL,
 reference TEXT NOT NULL, valid_from TEXT NOT NULL, expires_on TEXT NOT NULL,
 filename TEXT NOT NULL, media_type TEXT NOT NULL, content_base64 TEXT NOT NULL, sha256 TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','validated','rejected')) DEFAULT 'pending',
 collected_by TEXT NOT NULL, collected_at INTEGER NOT NULL,
 reviewed_by TEXT, reviewed_at INTEGER, review_note TEXT
);
CREATE INDEX nc_certificates_customer_state ON nc_certificates(customer_id, state);
CREATE TRIGGER nc_certificates_content BEFORE UPDATE OF customer_id,state,reference,valid_from,expires_on,filename,media_type,content_base64,sha256,collected_by,collected_at ON nc_certificates BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
CREATE TRIGGER nc_certificates_review BEFORE UPDATE ON nc_certificates WHEN OLD.status != 'pending' BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
CREATE TRIGGER nc_certificates_keep BEFORE DELETE ON nc_certificates BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
CREATE TABLE nc_certificate_reminders (
 delivery_id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, state TEXT NOT NULL,
 certificate_id TEXT, kind TEXT NOT NULL, status TEXT NOT NULL, provider_ref TEXT,
 created_at INTEGER NOT NULL, sent_at INTEGER
);
CREATE TABLE nc_certificate_policy (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), enabled INTEGER NOT NULL DEFAULT 0,
 revision INTEGER NOT NULL, changed_by TEXT NOT NULL, changed_at INTEGER NOT NULL
);
