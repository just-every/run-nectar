CREATE TABLE nc_credit_policy (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), two_person_above_cents INTEGER,
 revision INTEGER NOT NULL, changed_by TEXT NOT NULL, changed_at INTEGER NOT NULL
);
CREATE TABLE nc_credit_requests (
 id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES nc_invoices(id),
 amount_cents INTEGER NOT NULL CHECK(amount_cents>0), reason TEXT NOT NULL,
 prepared_by TEXT NOT NULL, prepared_name TEXT NOT NULL, prepared_at INTEGER NOT NULL,
 basis TEXT NOT NULL, policy_revision INTEGER NOT NULL, balance_cents INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','issued')) DEFAULT 'pending',
 approved_by TEXT, approved_at INTEGER, credit_id TEXT REFERENCES nc_credit_notes(id)
);
CREATE TRIGGER nc_credit_request_content BEFORE UPDATE OF invoice_id,amount_cents,reason,prepared_by,prepared_name,prepared_at,basis,policy_revision,balance_cents ON nc_credit_requests BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
CREATE TRIGGER nc_credit_request_issued BEFORE UPDATE ON nc_credit_requests WHEN OLD.status='issued' BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
CREATE TRIGGER nc_credit_request_keep BEFORE DELETE ON nc_credit_requests BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
