-- Dated lifecycle changes are evidence; corrections append another transition.
CREATE TABLE nc_subscription_lifecycle (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 id TEXT NOT NULL UNIQUE,
 subscription_id TEXT NOT NULL REFERENCES nc_subscriptions(id),
 kind TEXT NOT NULL CHECK(kind IN ('pause','resume','cancel','reactivate')),
 effective_date TEXT NOT NULL,
 until_date TEXT,
 access TEXT NOT NULL CHECK(access IN ('retain','suspend')),
 related_id TEXT REFERENCES nc_subscription_lifecycle(id),
 reason TEXT NOT NULL,
 author_id TEXT NOT NULL REFERENCES nc_members(id),
 author TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX nc_lifecycle_close ON nc_subscription_lifecycle(related_id) WHERE related_id IS NOT NULL;
CREATE TRIGGER nc_lifecycle_immutable BEFORE UPDATE ON nc_subscription_lifecycle
BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
CREATE TRIGGER nc_lifecycle_keep BEFORE DELETE ON nc_subscription_lifecycle
BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
