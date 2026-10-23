-- DEV-006: explicit app writes on a shadow subscription. Installation-bound
-- execution custody stays portable so an uncertain write still fences cutover
-- after restore. No background handler executes these requests.
CREATE TABLE nc_shadow_app_changes (
 id TEXT PRIMARY KEY,customer_id TEXT NOT NULL REFERENCES nc_customers(id),subscription_id TEXT NOT NULL REFERENCES nc_subscriptions(id),
 account_ref TEXT NOT NULL,provider_ref TEXT NOT NULL,customer_ref TEXT NOT NULL,item_id TEXT REFERENCES nc_items(id),provider_item_ref TEXT,
 quantity INTEGER,cancel_at_period_end INTEGER,customer_revision TEXT NOT NULL,subscription_revision TEXT NOT NULL,
 before_json TEXT NOT NULL,prepared_by TEXT NOT NULL,prepared_at INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','sending','uncertain','applied')),
 claimed_at INTEGER,applied_at INTEGER,result_json TEXT
);
CREATE TRIGGER nc_shadow_app_cutover_fence BEFORE UPDATE OF billing_mode ON nc_subscriptions
WHEN NEW.billing_mode='live' AND OLD.billing_mode='shadow'
 AND EXISTS(SELECT 1 FROM nc_shadow_app_changes WHERE subscription_id=OLD.id AND status IN ('sending','uncertain'))
BEGIN SELECT RAISE(ABORT,'nectar_guard_shadow_change_unconfirmed'); END;
