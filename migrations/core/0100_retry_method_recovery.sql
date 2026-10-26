-- Frozen proposals and facts are historical evidence, never executable custody.
CREATE TABLE nc_retry_method_recoveries (
 id TEXT PRIMARY KEY, collection_id TEXT NOT NULL, invoice_id TEXT NOT NULL,
 customer_id TEXT NOT NULL REFERENCES nc_customers(id), original_basis_hash TEXT NOT NULL,
 original_revision TEXT NOT NULL, payment_intent_ref TEXT NOT NULL,
 previous_method_ref TEXT NOT NULL, quote_json TEXT NOT NULL CHECK(json_valid(quote_json)),
 quote_hash TEXT NOT NULL, prepared_by TEXT NOT NULL, prepared_at INTEGER NOT NULL,
 expected_attempt INTEGER NOT NULL, deadline INTEGER NOT NULL, decline_code TEXT NOT NULL
);
CREATE INDEX nc_retry_method_recovery_customer ON nc_retry_method_recoveries(customer_id,prepared_at);
CREATE TABLE nc_retry_method_recovery_events (
 id TEXT PRIMARY KEY, recovery_id TEXT NOT NULL REFERENCES nc_retry_method_recoveries(id),
 customer_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('accepted','approved','rejected','withdrawn','claimed')),
 actor TEXT NOT NULL, at INTEGER NOT NULL, detail_json TEXT NOT NULL CHECK(json_valid(detail_json)),
 UNIQUE(recovery_id,kind)
);
-- Exclude this entire table from every archive. Restored facts cannot charge.
CREATE TABLE nc_retry_method_recovery_authorizations (
 id TEXT PRIMARY KEY REFERENCES nc_retry_method_recoveries(id), collection_id TEXT NOT NULL,
 customer_id TEXT NOT NULL, quote_hash TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('awaiting_customer','pending_approval','active','rejected','withdrawn','consumed')),
 owner_session_id TEXT NOT NULL, owner_verified_at INTEGER NOT NULL,
 customer_session_id TEXT, customer_origin TEXT, accepted_at INTEGER,
 approved_by TEXT, approver_session_id TEXT, approver_verified_at INTEGER,
 approval_mode TEXT CHECK(approval_mode IN ('single-approver','two-person')),
 revision TEXT NOT NULL,
 CHECK(status NOT IN ('pending_approval','active','consumed') OR (customer_session_id IS NOT NULL AND accepted_at IS NOT NULL)),
 CHECK(status NOT IN ('active','consumed') OR (approved_by IS NOT NULL AND approver_session_id IS NOT NULL))
);
CREATE UNIQUE INDEX nc_retry_method_recovery_live ON nc_retry_method_recovery_authorizations(collection_id)
 WHERE status IN ('awaiting_customer','pending_approval','active');
CREATE TRIGGER nc_retry_method_recoveries_immutable BEFORE UPDATE ON nc_retry_method_recoveries BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_retry_method_recovery_events_immutable BEFORE UPDATE ON nc_retry_method_recovery_events BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_retry_method_recoveries_generation_insert AFTER INSERT ON nc_retry_method_recoveries BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_retry_method_recoveries_generation_delete AFTER DELETE ON nc_retry_method_recoveries BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_retry_method_recovery_events_generation_insert AFTER INSERT ON nc_retry_method_recovery_events BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_retry_method_recovery_events_generation_delete AFTER DELETE ON nc_retry_method_recovery_events BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_retry_method_recovery_authorizations_generation_insert AFTER INSERT ON nc_retry_method_recovery_authorizations BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_retry_method_recovery_authorizations_generation_update AFTER UPDATE ON nc_retry_method_recovery_authorizations BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_retry_method_recovery_authorizations_generation_delete AFTER DELETE ON nc_retry_method_recovery_authorizations BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;

-- A concurrent detach cannot pass a recovery claim on its replacement method.
CREATE TRIGGER nc_retry_recovery_removal_update BEFORE UPDATE OF status ON nc_portal_method_action_history
WHEN NEW.operation='remove' AND NEW.status='uncertain' AND EXISTS(
 SELECT 1 FROM nc_retry_method_recovery_authorizations z JOIN nc_retry_method_recoveries r ON r.id=z.id
 JOIN nc_automatic_collections a ON a.id=r.collection_id
 WHERE json_extract(r.quote_json,'$.accountRef')=NEW.account_ref
 AND json_extract(r.quote_json,'$.method.customerRef')=NEW.customer_ref
 AND json_extract(r.quote_json,'$.method.paymentMethodRef')=NEW.method_ref
 AND (z.status IN ('awaiting_customer','pending_approval','active') OR (z.status='consumed' AND a.status IN ('claimed','uncertain','pending_settlement'))))
BEGIN SELECT RAISE(ABORT,'nectar_guard_portal_method_collection_authority'); END;
CREATE TRIGGER nc_retry_recovery_removed_method BEFORE UPDATE OF status ON nc_retry_method_recovery_authorizations
WHEN NEW.status IN ('pending_approval','active','consumed') AND EXISTS(
 SELECT 1 FROM nc_retry_method_recoveries r JOIN nc_portal_method_action_history h
 ON h.account_ref=json_extract(r.quote_json,'$.accountRef') AND h.customer_ref=json_extract(r.quote_json,'$.method.customerRef')
 AND h.method_ref=json_extract(r.quote_json,'$.method.paymentMethodRef') WHERE r.id=NEW.id AND h.operation='remove' AND h.status IN ('uncertain','complete'))
BEGIN SELECT RAISE(ABORT,'nectar_guard_payment_method_removal_claimed'); END;
