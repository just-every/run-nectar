-- Owner consent and independent confirmation precede automatic invoice issue.
CREATE TABLE nc_invoice_automation (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 hour INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23), revision INTEGER NOT NULL,
 prepared_by TEXT NOT NULL, approved_by TEXT NOT NULL, request_id TEXT NOT NULL
);
CREATE TABLE nc_invoice_automation_requests (
 id TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), hour INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23),
 base_revision INTEGER NOT NULL, prepared_by TEXT NOT NULL, prepared_at INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applied','rejected')),
 approved_by TEXT, approval_mode TEXT CHECK(approval_mode IN ('two-person','single-approver'))
);
CREATE TRIGGER nc_invoice_automation_request_content BEFORE UPDATE OF enabled,hour,base_revision,prepared_by,prepared_at ON nc_invoice_automation_requests
 BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_invoice_automation_request_decided BEFORE UPDATE ON nc_invoice_automation_requests WHEN OLD.status<>'pending'
 BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_invoice_automation_request_keep BEFORE DELETE ON nc_invoice_automation_requests
 BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TABLE nc_invoice_automation_runs (
 id TEXT PRIMARY KEY, business_day TEXT NOT NULL UNIQUE, policy_revision INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('running','completed','failed')), result_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
);

CREATE TRIGGER nc_guard_invoice_automation BEFORE INSERT ON nc_guard WHEN NEW.ok IS NOT 1 AND NEW.code='invoice_automation_changed'
 BEGIN SELECT RAISE(ABORT,'nectar_guard_invoice_automation_changed'); END;
