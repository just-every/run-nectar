-- Reviewed rollback custody is descriptive. It is never executable authority.
CREATE TABLE nc_move_rollback_plans (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES nc_customers(id),
  subscription_id TEXT NOT NULL REFERENCES nc_subscriptions(id),
  cutover_start TEXT NOT NULL,
  processor_ref TEXT NOT NULL,
  instructions TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  basis_hash TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  prepared_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  confirmed_by TEXT,
  confirmed_at INTEGER,
  acknowledged_discrepancies INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged_discrepancies IN (0,1)),
  UNIQUE(subscription_id,prepared_by,basis_hash,plan_hash)
);
CREATE TRIGGER nc_move_rollback_plans_generation_insert AFTER INSERT ON nc_move_rollback_plans BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_move_rollback_plans_generation_update AFTER UPDATE ON nc_move_rollback_plans BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_move_rollback_plans_generation_delete AFTER DELETE ON nc_move_rollback_plans BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_move_rollback_plans_owned_insert BEFORE INSERT ON nc_move_rollback_plans
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
  AND NOT EXISTS(SELECT 1 FROM nc_subscriptions s JOIN nc_customers c ON c.id=s.customer_id WHERE s.id=NEW.subscription_id AND c.id=NEW.customer_id AND c.erased_at IS NULL)
BEGIN SELECT RAISE(ABORT,'nectar_guard_customer_erased'); END;
CREATE TRIGGER nc_move_rollback_plans_content BEFORE UPDATE ON nc_move_rollback_plans
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
  AND (OLD.confirmed_at IS NOT NULL OR NEW.id IS NOT OLD.id OR NEW.customer_id IS NOT OLD.customer_id OR NEW.subscription_id IS NOT OLD.subscription_id
    OR NEW.cutover_start IS NOT OLD.cutover_start OR NEW.processor_ref IS NOT OLD.processor_ref OR NEW.instructions IS NOT OLD.instructions
    OR NEW.plan_hash IS NOT OLD.plan_hash OR NEW.basis_hash IS NOT OLD.basis_hash OR NEW.snapshot_json IS NOT OLD.snapshot_json OR NEW.prepared_by IS NOT OLD.prepared_by OR NEW.created_at IS NOT OLD.created_at)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_move_rollback_plans_keep BEFORE DELETE ON nc_move_rollback_plans
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
