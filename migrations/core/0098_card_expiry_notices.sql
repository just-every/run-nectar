-- Historical notice custody grants no send or debit authority after restore.
CREATE TABLE nc_card_expiry_notices (
 id TEXT PRIMARY KEY,
 customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 subscription_id TEXT NOT NULL REFERENCES nc_subscriptions(id),
 term_id TEXT NOT NULL REFERENCES nc_renewal_terms(id),
 cycle INTEGER NOT NULL,
 setup_id TEXT NOT NULL,
 binding_id TEXT NOT NULL REFERENCES nc_stripe_customer_bindings(id),
 account_ref TEXT NOT NULL,
 payment_method_ref TEXT NOT NULL,
 renewal_date TEXT NOT NULL,
 due_date TEXT NOT NULL,
 recipient TEXT NOT NULL,
 language TEXT NOT NULL,
 last4 TEXT,
 exp_month INTEGER,
 exp_year INTEGER,
 wording_version TEXT NOT NULL,
 basis_hash TEXT NOT NULL,
 prepared_by TEXT NOT NULL,
 prepared_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 status TEXT NOT NULL,
 claimed_at INTEGER,
 finished_at INTEGER,
 provider_ref TEXT,
 error_code TEXT,
 UNIQUE(term_id,cycle)
);
CREATE INDEX nc_card_expiry_notices_customer ON nc_card_expiry_notices(customer_id);
-- Installation-bound bearer capability and frozen outbound body. Exclude this
-- entire table from archives and delete it on customer erasure.
CREATE TABLE nc_card_expiry_notice_authority (
 id TEXT PRIMARY KEY REFERENCES nc_card_expiry_notices(id),
 customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 owner_session_id TEXT NOT NULL,
 portal_session_id TEXT NOT NULL,
 source_json TEXT NOT NULL,
 subject TEXT NOT NULL,
 body TEXT NOT NULL,
 html TEXT NOT NULL,
 from_address TEXT NOT NULL,
 mail_provider TEXT NOT NULL
);
CREATE TRIGGER nc_card_expiry_notices_generation_insert AFTER INSERT ON nc_card_expiry_notices BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_card_expiry_notices_generation_update AFTER UPDATE ON nc_card_expiry_notices BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_card_expiry_notices_generation_delete AFTER DELETE ON nc_card_expiry_notices BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_card_expiry_notice_authority_generation_insert AFTER INSERT ON nc_card_expiry_notice_authority BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_card_expiry_notice_authority_generation_update AFTER UPDATE ON nc_card_expiry_notice_authority BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_card_expiry_notice_authority_generation_delete AFTER DELETE ON nc_card_expiry_notice_authority BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
