CREATE TABLE nc_notification_preferences (
 member_id TEXT PRIMARY KEY REFERENCES nc_members(id),
 mentions INTEGER NOT NULL DEFAULT 1 CHECK(mentions IN (0,1)),
 payment_mismatch INTEGER NOT NULL DEFAULT 0 CHECK(payment_mismatch IN (0,1)),
 billrun_exceptions INTEGER NOT NULL DEFAULT 0 CHECK(billrun_exceptions IN (0,1)),
 proposals INTEGER NOT NULL DEFAULT 0 CHECK(proposals IN (0,1))
);
CREATE TABLE nc_notifications (
 event TEXT NOT NULL CHECK(event IN ('payment_mismatch','billrun_exceptions','proposals')),
 subject TEXT NOT NULL,
 href TEXT NOT NULL,
 member_id TEXT NOT NULL REFERENCES nc_members(id),
 email TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','sending','accepted','suppressed','failed','rejected','uncertain')),
 provider_ref TEXT,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(event,subject,member_id)
);
CREATE TRIGGER nc_notifications_content BEFORE UPDATE OF event,subject,href,member_id,email ON nc_notifications BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
CREATE TRIGGER nc_notifications_keep BEFORE DELETE ON nc_notifications BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
