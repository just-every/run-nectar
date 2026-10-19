-- Collections custody never changes the accounting ledger.
CREATE TABLE nc_cadence_policy (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 require_human INTEGER NOT NULL CHECK(require_human IN (0,1)), rules_json TEXT NOT NULL,
 revision INTEGER NOT NULL, changed_by TEXT NOT NULL, changed_at INTEGER NOT NULL
);
CREATE TABLE nc_cadence_policy_requests (
 id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, base_revision INTEGER NOT NULL,
 prepared_by_id TEXT NOT NULL REFERENCES nc_members(id), prepared_by TEXT NOT NULL, prepared_at INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applied','rejected')),
 decided_by_id TEXT REFERENCES nc_members(id), decided_by TEXT, decided_at INTEGER, approval_mode TEXT
);
CREATE TABLE nc_cadence_enrollments (
 invoice_id TEXT PRIMARY KEY REFERENCES nc_invoices(id), segment TEXT NOT NULL, transfer_terms TEXT NOT NULL,
 recorded_by TEXT NOT NULL, recorded_at INTEGER NOT NULL
);
CREATE TABLE nc_cadence_promises (
 id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES nc_invoices(id), pay_date TEXT NOT NULL,
 note TEXT NOT NULL, recorded_by TEXT NOT NULL, recorded_at INTEGER NOT NULL
);
CREATE INDEX nc_cadence_promises_invoice ON nc_cadence_promises(invoice_id,recorded_at);
CREATE TABLE nc_cadence_disputes (
 id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES nc_invoices(id), line_id TEXT NOT NULL REFERENCES nc_invoice_lines(id),
 amount_cents INTEGER NOT NULL CHECK(amount_cents>0), reason TEXT NOT NULL,
 recorded_by TEXT NOT NULL, recorded_at INTEGER NOT NULL,
 resolved_by TEXT, resolved_at INTEGER, outcome TEXT
);
CREATE INDEX nc_cadence_disputes_invoice ON nc_cadence_disputes(invoice_id,resolved_at);
CREATE TABLE nc_cadence_deliveries (
 id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES nc_invoices(id), stage INTEGER NOT NULL CHECK(stage IN (-3,1,7,15)),
 status TEXT NOT NULL CHECK(status IN ('awaiting_approval','pending','sending','accepted','suppressed','rejected','rate_limited','uncertain','failed','superseded')),
 basis_json TEXT NOT NULL, basis_key TEXT NOT NULL, policy_revision INTEGER NOT NULL,
 recipient TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, collectible_cents INTEGER NOT NULL,
 approved_by TEXT, approved_at INTEGER, approval_mode TEXT,
 reserved_at INTEGER NOT NULL, claimed_at INTEGER, finished_at INTEGER, provider_ref TEXT,
 UNIQUE(invoice_id,stage)
);
CREATE TABLE nc_cadence_escalations (
 invoice_id TEXT PRIMARY KEY REFERENCES nc_invoices(id), task_id TEXT NOT NULL UNIQUE REFERENCES nc_tasks(id),
 assigned_member_id TEXT NOT NULL REFERENCES nc_members(id), created_at INTEGER NOT NULL
);
CREATE TRIGGER nc_cadence_enrollments_content BEFORE UPDATE ON nc_cadence_enrollments BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_cadence_enrollments_keep BEFORE DELETE ON nc_cadence_enrollments BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_cadence_promises_content BEFORE UPDATE ON nc_cadence_promises BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_cadence_promises_keep BEFORE DELETE ON nc_cadence_promises BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_cadence_disputes_content BEFORE UPDATE OF invoice_id,line_id,amount_cents,reason,recorded_by,recorded_at ON nc_cadence_disputes BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_cadence_disputes_resolved BEFORE UPDATE ON nc_cadence_disputes WHEN OLD.resolved_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_cadence_disputes_keep BEFORE DELETE ON nc_cadence_disputes BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_cadence_policy_requests_content BEFORE UPDATE OF payload_json,base_revision,prepared_by_id,prepared_by,prepared_at ON nc_cadence_policy_requests BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_cadence_policy_requests_decided BEFORE UPDATE ON nc_cadence_policy_requests WHEN OLD.status<>'pending' BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_cadence_policy_requests_keep BEFORE DELETE ON nc_cadence_policy_requests BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_cadence_delivery_content BEFORE UPDATE OF invoice_id,stage,basis_json,basis_key,policy_revision,recipient,subject,body,collectible_cents,approved_by,approved_at,approval_mode,reserved_at ON nc_cadence_deliveries WHEN OLD.claimed_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_cadence_delivery_terminal BEFORE UPDATE ON nc_cadence_deliveries WHEN OLD.status IN ('accepted','suppressed','rejected','rate_limited','uncertain','failed','superseded') BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_cadence_delivery_keep BEFORE DELETE ON nc_cadence_deliveries BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
