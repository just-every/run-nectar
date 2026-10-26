-- Executable authority is installation-local and must be excluded from archives.
CREATE TABLE nc_portal_method_actions (
 id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 binding_id TEXT NOT NULL REFERENCES nc_stripe_customer_bindings(id), binding_revision TEXT NOT NULL,
 customer_revision TEXT NOT NULL, setup_id TEXT NOT NULL REFERENCES nc_hosted_setups(id),
 account_ref TEXT NOT NULL, customer_ref TEXT NOT NULL, method_ref TEXT NOT NULL,
 method_json TEXT NOT NULL CHECK(json_valid(method_json)), livemode INTEGER NOT NULL CHECK(livemode=0),
 operation TEXT NOT NULL CHECK(operation IN ('default','remove')),
 status TEXT NOT NULL CHECK(status IN ('prepared','uncertain','complete','superseded')),
 previous_default_ref TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
 owner_session_id TEXT NOT NULL, factor_ref TEXT NOT NULL, factor_verified_at INTEGER NOT NULL,
 customer_session_id TEXT, accepted_at INTEGER, completed_at INTEGER,
 CHECK(status NOT IN ('uncertain','complete') OR (customer_session_id IS NOT NULL AND accepted_at IS NOT NULL))
);
CREATE UNIQUE INDEX nc_portal_method_action_live ON nc_portal_method_actions(binding_id) WHERE status IN ('prepared','uncertain');
CREATE INDEX nc_portal_method_action_customer ON nc_portal_method_actions(customer_id,created_at);

-- Historical observations contain no executable owner or customer-session custody.
CREATE TABLE nc_portal_method_action_history (
 id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES nc_customers(id), setup_id TEXT NOT NULL,
 account_ref TEXT NOT NULL, customer_ref TEXT NOT NULL, method_ref TEXT NOT NULL,
 operation TEXT NOT NULL CHECK(operation IN ('default','remove')),
 status TEXT NOT NULL CHECK(status IN ('prepared','uncertain','complete','superseded')),
 previous_default_ref TEXT, created_at INTEGER NOT NULL, accepted_at INTEGER, completed_at INTEGER
);
CREATE INDEX nc_portal_method_action_history_customer ON nc_portal_method_action_history(customer_id,created_at);
CREATE TRIGGER nc_portal_method_actions_generation_insert AFTER INSERT ON nc_portal_method_actions BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_portal_method_actions_generation_update AFTER UPDATE ON nc_portal_method_actions BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_portal_method_actions_generation_delete AFTER DELETE ON nc_portal_method_actions BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_portal_method_action_history_generation_insert AFTER INSERT ON nc_portal_method_action_history BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_portal_method_action_history_generation_update AFTER UPDATE ON nc_portal_method_action_history BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_portal_method_action_history_generation_delete AFTER DELETE ON nc_portal_method_action_history BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;

-- Close the race between a detached-method claim and new collection authority.
CREATE TRIGGER nc_automatic_method_removal_insert BEFORE INSERT ON nc_automatic_collection_authorizations
WHEN EXISTS(SELECT 1 FROM nc_automatic_collections c JOIN nc_portal_method_action_history h
 ON h.account_ref=c.account_ref AND h.customer_ref=c.stripe_customer_ref AND h.method_ref=c.payment_method_ref
 WHERE c.id=NEW.id AND h.operation='remove' AND h.status IN ('uncertain','complete'))
BEGIN SELECT RAISE(ABORT,'nectar_guard_payment_method_removal_claimed'); END;
CREATE TRIGGER nc_automatic_method_removal_update BEFORE UPDATE OF status ON nc_automatic_collections
WHEN NEW.status IN ('pending_approval','active','claimed','uncertain','pending_settlement') AND EXISTS(
 SELECT 1 FROM nc_portal_method_action_history h WHERE h.account_ref=NEW.account_ref AND h.customer_ref=NEW.stripe_customer_ref
 AND h.method_ref=NEW.payment_method_ref AND h.operation='remove' AND h.status IN ('uncertain','complete'))
BEGIN SELECT RAISE(ABORT,'nectar_guard_payment_method_removal_claimed'); END;
CREATE TRIGGER nc_topup_method_removal_insert BEFORE INSERT ON nc_prepaid_topup_authorizations
WHEN NEW.status IN ('awaiting_customer','pending','active') AND EXISTS(SELECT 1 FROM nc_portal_method_action_history h WHERE h.account_ref=json_extract(NEW.quote_json,'$.accountRef')
 AND h.customer_ref=json_extract(NEW.quote_json,'$.customerRef') AND h.method_ref=json_extract(NEW.quote_json,'$.paymentMethodRef')
 AND h.operation='remove' AND h.status IN ('uncertain','complete'))
BEGIN SELECT RAISE(ABORT,'nectar_guard_payment_method_removal_claimed'); END;
CREATE TRIGGER nc_topup_method_removal_update BEFORE UPDATE OF status ON nc_prepaid_topup_authorizations
WHEN NEW.status IN ('awaiting_customer','pending','active') AND EXISTS(SELECT 1 FROM nc_portal_method_action_history h
 WHERE h.account_ref=json_extract(NEW.quote_json,'$.accountRef') AND h.customer_ref=json_extract(NEW.quote_json,'$.customerRef')
 AND h.method_ref=json_extract(NEW.quote_json,'$.paymentMethodRef') AND h.operation='remove' AND h.status IN ('uncertain','complete'))
BEGIN SELECT RAISE(ABORT,'nectar_guard_payment_method_removal_claimed'); END;
CREATE TRIGGER nc_native_method_removal_claim BEFORE INSERT ON nc_native_collection_claims
WHEN NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1) AND EXISTS(SELECT 1 FROM nc_native_collections n JOIN nc_portal_method_action_history h
 ON h.account_ref=n.account_ref AND h.customer_ref=n.stripe_customer_ref AND h.method_ref=n.payment_method_ref
 WHERE n.id=NEW.request_id AND h.operation='remove' AND h.status IN ('uncertain','complete'))
BEGIN SELECT RAISE(ABORT,'nectar_guard_payment_method_removal_claimed'); END;
CREATE TRIGGER nc_trial_method_removal_insert BEFORE INSERT ON nc_trial_collections
WHEN NEW.status IN ('pending_owner','pending_approval','active','claimed','uncertain') AND EXISTS(SELECT 1 FROM nc_portal_method_action_history h WHERE h.account_ref=json_extract(NEW.quote_json,'$.accountRef')
 AND h.customer_ref=json_extract(NEW.quote_json,'$.customerRef') AND h.method_ref=json_extract(NEW.quote_json,'$.paymentMethodRef')
 AND h.operation='remove' AND h.status IN ('uncertain','complete'))
BEGIN SELECT RAISE(ABORT,'nectar_guard_payment_method_removal_claimed'); END;
CREATE TRIGGER nc_trial_method_removal_update BEFORE UPDATE OF status ON nc_trial_collections
WHEN NEW.status IN ('pending_owner','pending_approval','active','claimed','uncertain') AND EXISTS(SELECT 1 FROM nc_portal_method_action_history h
 WHERE h.account_ref=json_extract(NEW.quote_json,'$.accountRef') AND h.customer_ref=json_extract(NEW.quote_json,'$.customerRef')
 AND h.method_ref=json_extract(NEW.quote_json,'$.paymentMethodRef') AND h.operation='remove' AND h.status IN ('uncertain','complete'))
BEGIN SELECT RAISE(ABORT,'nectar_guard_payment_method_removal_claimed'); END;
