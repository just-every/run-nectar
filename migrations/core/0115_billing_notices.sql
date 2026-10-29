-- Notice settings do not grant unattended send or payment authority.
CREATE TABLE nc_billing_notice_settings(kind TEXT PRIMARY KEY,sender TEXT NOT NULL DEFAULT 'off',revision INTEGER NOT NULL DEFAULT 0,templates_json TEXT NOT NULL DEFAULT '{}');
INSERT INTO nc_billing_notice_settings(kind) VALUES('trial_ending');
INSERT INTO nc_billing_notice_settings(kind) VALUES('upcoming_renewal');
INSERT INTO nc_billing_notice_settings(kind) VALUES('payment_receipt');
INSERT INTO nc_billing_notice_settings(kind) VALUES('payment_failed');
INSERT INTO nc_billing_notice_settings(kind) VALUES('payment_method_required');
INSERT INTO nc_billing_notice_settings(kind) VALUES('authentication_required');
CREATE TABLE nc_billing_notices(
 id TEXT PRIMARY KEY,kind TEXT NOT NULL,invoice_id TEXT NOT NULL REFERENCES nc_invoices(id),
 customer_id TEXT NOT NULL REFERENCES nc_customers(id),event_key TEXT NOT NULL,
 recipient TEXT NOT NULL,language TEXT NOT NULL,amount_cents INTEGER NOT NULL,
 basis_hash TEXT NOT NULL,status TEXT NOT NULL,prepared_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
 claimed_at INTEGER,finished_at INTEGER,provider_ref TEXT,UNIQUE(kind,event_key)
);
CREATE TABLE nc_billing_notice_authority(
 id TEXT PRIMARY KEY REFERENCES nc_billing_notices(id),customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 owner_session_id TEXT NOT NULL,basis_json TEXT NOT NULL,subject TEXT NOT NULL,body TEXT NOT NULL
);
CREATE TRIGGER nc_billing_notice_settings_generation_insert AFTER INSERT ON nc_billing_notice_settings BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_billing_notice_settings_generation_update AFTER UPDATE ON nc_billing_notice_settings BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_billing_notice_settings_generation_delete AFTER DELETE ON nc_billing_notice_settings BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_billing_notices_generation_insert AFTER INSERT ON nc_billing_notices BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_billing_notices_generation_update AFTER UPDATE ON nc_billing_notices BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_billing_notices_generation_delete AFTER DELETE ON nc_billing_notices BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_billing_notice_authority_generation_insert AFTER INSERT ON nc_billing_notice_authority BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_billing_notice_authority_generation_update AFTER UPDATE ON nc_billing_notice_authority BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_billing_notice_authority_generation_delete AFTER DELETE ON nc_billing_notice_authority BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
