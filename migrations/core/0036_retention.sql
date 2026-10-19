CREATE TABLE nc_retention_policies (
 id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, base_revision TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 prepared_by_id TEXT NOT NULL, prepared_by TEXT NOT NULL, prepared_at INTEGER NOT NULL,
 decided_by_id TEXT, decided_by TEXT, decided_at INTEGER,
 approval_mode TEXT CHECK(approval_mode IN ('two-person','single-approver'))
);
CREATE UNIQUE INDEX nc_retention_policy_successor ON nc_retention_policies(base_revision) WHERE status='approved';
CREATE TRIGGER nc_retention_policy_content BEFORE UPDATE OF id,payload_json,base_revision,prepared_by_id,prepared_by,prepared_at ON nc_retention_policies BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_retention_policy_decided BEFORE UPDATE ON nc_retention_policies WHEN OLD.status<>'pending' BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_retention_policy_keep BEFORE DELETE ON nc_retention_policies BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;

CREATE TABLE nc_retention_offers (
 id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL REFERENCES nc_subscriptions(id),
 kind TEXT NOT NULL CHECK(kind IN ('save','winback')),
 policy_id TEXT NOT NULL REFERENCES nc_retention_policies(id), source_revision TEXT NOT NULL,
 terms_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'offered' CHECK(status IN ('offered','accepted','declined','expired')),
 reason TEXT NOT NULL DEFAULT '', from_date TEXT NOT NULL, to_date TEXT NOT NULL,
 token_hash TEXT, created_at INTEGER NOT NULL, decided_at INTEGER,
 mail_status TEXT NOT NULL DEFAULT 'not_sent', provider_ref TEXT,
 UNIQUE(subscription_id,kind,source_revision)
);
CREATE UNIQUE INDEX nc_retention_offer_token ON nc_retention_offers(token_hash) WHERE token_hash IS NOT NULL;
CREATE UNIQUE INDEX nc_one_winback ON nc_retention_offers(subscription_id) WHERE kind='winback';
