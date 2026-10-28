-- Merchant-reviewed restrictions and non-executable customer requests.
CREATE TABLE nc_portal_change_policy (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), prices_json TEXT NOT NULL CHECK(json_valid(prices_json)),
 minimum_seats INTEGER NOT NULL CHECK(minimum_seats BETWEEN 1 AND 1000000),
 pause_allowed INTEGER NOT NULL CHECK(pause_allowed IN (0,1)), revision INTEGER NOT NULL
);
CREATE TABLE nc_portal_change_requests (
 id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE,
 customer_id TEXT NOT NULL REFERENCES nc_customers(id), subscription_id TEXT NOT NULL REFERENCES nc_subscriptions(id),
 item_id TEXT NOT NULL REFERENCES nc_items(id), target_price_id TEXT NOT NULL REFERENCES nc_prices(id),
 quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 1000000), target_label TEXT NOT NULL, unit_amount TEXT NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL CHECK(status='pending'),
 source_json TEXT NOT NULL CHECK(json_valid(source_json)), basis_hash TEXT NOT NULL, policy_revision INTEGER NOT NULL,
 requested_at INTEGER NOT NULL, requested_on TEXT NOT NULL, below_minimum INTEGER NOT NULL CHECK(below_minimum IN (0,1))
);
CREATE INDEX nc_portal_change_customer ON nc_portal_change_requests(customer_id,subscription_id);
CREATE TABLE nc_policy_changes_next (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('credit','certificate','tax','lifecycle','feature','usage','portal_change')),
 payload_json TEXT NOT NULL, base_revision INTEGER NOT NULL,
 prepared_by_id TEXT NOT NULL REFERENCES nc_members(id), prepared_by TEXT NOT NULL, prepared_at INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','applied','rejected')) DEFAULT 'pending',
 decided_by_id TEXT REFERENCES nc_members(id), decided_by TEXT, decided_at INTEGER,
 approval_mode TEXT CHECK(approval_mode IN ('two-person','single-approver'))
);
INSERT INTO nc_policy_changes_next SELECT * FROM nc_policy_changes;
DROP TABLE nc_policy_changes;
ALTER TABLE nc_policy_changes_next RENAME TO nc_policy_changes;
CREATE TRIGGER nc_policy_change_content BEFORE UPDATE OF kind,payload_json,base_revision,prepared_by_id,prepared_by,prepared_at ON nc_policy_changes BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
CREATE TRIGGER nc_policy_change_decided BEFORE UPDATE ON nc_policy_changes WHEN OLD.status<>'pending' BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
CREATE TRIGGER nc_policy_change_keep BEFORE DELETE ON nc_policy_changes BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;

CREATE TRIGGER nc_portal_change_content BEFORE UPDATE ON nc_portal_change_requests
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_portal_change_keep BEFORE DELETE ON nc_portal_change_requests
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_portal_change_erased BEFORE INSERT ON nc_portal_change_requests
WHEN EXISTS(SELECT 1 FROM nc_customers WHERE id=NEW.customer_id AND erased_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_portal_change_generation_insert AFTER INSERT ON nc_portal_change_requests BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_portal_change_generation_update AFTER UPDATE ON nc_portal_change_requests BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_portal_change_generation_delete AFTER DELETE ON nc_portal_change_requests BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;

DROP TRIGGER nc_policy_change_content;
CREATE TRIGGER nc_policy_change_content BEFORE UPDATE OF kind,payload_json,base_revision,prepared_by_id,prepared_by,prepared_at ON nc_policy_changes  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_policy_change_decided;
CREATE TRIGGER nc_policy_change_decided BEFORE UPDATE ON nc_policy_changes WHEN (OLD.status<>'pending') AND NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
DROP TRIGGER nc_policy_change_keep;
CREATE TRIGGER nc_policy_change_keep BEFORE DELETE ON nc_policy_changes  WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) BEGIN SELECT RAISE(ABORT, 'nectar_immutable'); END;
CREATE TRIGGER nc_privacy_generation_nc_policy_changes_insert AFTER INSERT ON nc_policy_changes
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_policy_changes_update AFTER UPDATE ON nc_policy_changes
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_privacy_generation_nc_policy_changes_delete AFTER DELETE ON nc_policy_changes
BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
