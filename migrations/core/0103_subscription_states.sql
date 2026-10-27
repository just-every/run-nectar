-- Observations carry typed source facts, never collection authority.
CREATE TABLE nc_subscription_states (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 id TEXT NOT NULL UNIQUE,
 subscription_id TEXT NOT NULL REFERENCES nc_subscriptions(id),
 customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 previous_id TEXT,
 previous_state TEXT,
 state TEXT NOT NULL CHECK(state IN ('scheduled','trialing','active','past_due','unpaid','paused','canceled','ended')),
 cause_json TEXT NOT NULL,
 observed_at INTEGER NOT NULL
);
CREATE INDEX nc_subscription_states_subscription ON nc_subscription_states(subscription_id,seq);
CREATE TRIGGER nc_subscription_states_immutable BEFORE UPDATE ON nc_subscription_states
 WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_subscription_states_keep BEFORE DELETE ON nc_subscription_states
 WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_subscription_states_erased BEFORE INSERT ON nc_subscription_states
 WHEN EXISTS(SELECT 1 FROM nc_customers WHERE id=NEW.customer_id AND erased_at IS NOT NULL)
 BEGIN SELECT RAISE(ABORT,'nectar_customer_erased'); END;
CREATE TRIGGER nc_subscription_states_generation AFTER INSERT ON nc_subscription_states
 BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TABLE nc_subscription_state_cursor(singleton INTEGER PRIMARY KEY CHECK(singleton=1),subscription_id TEXT NOT NULL);
INSERT INTO nc_subscription_state_cursor VALUES(1,'');
