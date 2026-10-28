-- Exact finite schedules retain consent evidence separately from local authority.
CREATE TABLE nc_collection_schedules (
 id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 subscription_id TEXT NOT NULL REFERENCES nc_subscriptions(id), status TEXT NOT NULL,
 scope_json TEXT NOT NULL CHECK(json_valid(scope_json)), prepared_by TEXT NOT NULL,
 prepared_at INTEGER NOT NULL, primary_request TEXT, accepted_at INTEGER,
 approved_by TEXT, approved_at INTEGER, policy_id TEXT NOT NULL REFERENCES nc_dunning_policies(id)
);
CREATE TABLE nc_collection_schedule_authority (
 id TEXT PRIMARY KEY REFERENCES nc_collection_schedules(id),
 customer_id TEXT NOT NULL REFERENCES nc_customers(id)
);
CREATE TRIGGER nc_collection_schedule_immutable BEFORE UPDATE ON nc_collection_schedules
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND (OLD.id IS NOT NEW.id OR OLD.customer_id IS NOT NEW.customer_id OR OLD.subscription_id IS NOT NEW.subscription_id
 OR OLD.scope_json IS NOT NEW.scope_json OR OLD.prepared_by IS NOT NEW.prepared_by OR OLD.prepared_at IS NOT NEW.prepared_at
 OR OLD.policy_id IS NOT NEW.policy_id OR (OLD.accepted_at IS NOT NULL AND OLD.accepted_at IS NOT NEW.accepted_at)
 OR (OLD.approved_at IS NOT NULL AND OLD.approved_at IS NOT NEW.approved_at))
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_collection_schedule_insert AFTER INSERT ON nc_collection_schedules BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_collection_schedule_update AFTER UPDATE ON nc_collection_schedules BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_collection_schedule_delete AFTER DELETE ON nc_collection_schedules BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_collection_schedule_authority_insert AFTER INSERT ON nc_collection_schedule_authority BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_collection_schedule_authority_delete AFTER DELETE ON nc_collection_schedule_authority BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
