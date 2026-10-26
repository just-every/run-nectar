-- Policies are immutable. A restored sequence carries history, never authority.
CREATE TABLE nc_dunning_policies (
 id TEXT PRIMARY KEY,
 name TEXT NOT NULL,
 scope TEXT NOT NULL CHECK(scope IN ('default','plan','segment')),
 scope_ref TEXT NOT NULL,
 offsets_json TEXT NOT NULL,
 end_day INTEGER NOT NULL,
 end_action TEXT NOT NULL CHECK(end_action IN ('keep_active','mark_unpaid','restrict','cancel')),
 invoice_only INTEGER NOT NULL CHECK(invoice_only IN (0,1)),
 created_by TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE TABLE nc_dunning_series (
 id TEXT PRIMARY KEY,
 invoice_id TEXT NOT NULL UNIQUE REFERENCES nc_invoices(id),
 customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 policy_id TEXT NOT NULL REFERENCES nc_dunning_policies(id),
 first_failed_at INTEGER NOT NULL,
 first_failed_date TEXT NOT NULL,
 timezone TEXT NOT NULL,
 status TEXT NOT NULL,
 ended_at INTEGER,
 end_date TEXT,
 created_by TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE TABLE nc_dunning_authority (
 id TEXT PRIMARY KEY REFERENCES nc_dunning_series(id),
 customer_id TEXT NOT NULL REFERENCES nc_customers(id)
);
CREATE TABLE nc_dunning_deliveries (
 id TEXT PRIMARY KEY,
 series_id TEXT NOT NULL REFERENCES nc_dunning_series(id),
 invoice_id TEXT NOT NULL REFERENCES nc_invoices(id),
 customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 step INTEGER NOT NULL,
 due_date TEXT NOT NULL,
 recipient TEXT NOT NULL,
 language TEXT NOT NULL,
 amount_cents INTEGER NOT NULL,
 basis_hash TEXT NOT NULL,
 wording_version TEXT NOT NULL,
 prepared_by TEXT NOT NULL,
 prepared_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 status TEXT NOT NULL,
 claimed_at INTEGER,
 finished_at INTEGER,
 provider_ref TEXT,
 UNIQUE(series_id,step)
);
CREATE TABLE nc_dunning_mail_authority (
 id TEXT PRIMARY KEY REFERENCES nc_dunning_deliveries(id),
 customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 owner_session_id TEXT NOT NULL,
 portal_session_id TEXT NOT NULL,
 setup_id TEXT NOT NULL,
 source_json TEXT NOT NULL,
 subject TEXT NOT NULL,
 body TEXT NOT NULL,
 html TEXT NOT NULL,
 from_address TEXT NOT NULL,
 mail_provider TEXT NOT NULL
);
CREATE TABLE nc_dunning_recoveries (
 id TEXT PRIMARY KEY,
 customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 invoice_id TEXT NOT NULL REFERENCES nc_invoices(id),
 delivery_id TEXT NOT NULL REFERENCES nc_dunning_deliveries(id)
);
CREATE INDEX nc_dunning_deliveries_invoice ON nc_dunning_deliveries(invoice_id);
CREATE INDEX nc_dunning_series_customer ON nc_dunning_series(customer_id);
CREATE TRIGGER nc_dunning_policies_generation_insert AFTER INSERT ON nc_dunning_policies BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_dunning_policies_generation_update AFTER UPDATE ON nc_dunning_policies BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_dunning_policies_generation_delete AFTER DELETE ON nc_dunning_policies BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_dunning_series_generation_insert AFTER INSERT ON nc_dunning_series BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_dunning_series_generation_update AFTER UPDATE ON nc_dunning_series BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_dunning_series_generation_delete AFTER DELETE ON nc_dunning_series BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_dunning_authority_generation_insert AFTER INSERT ON nc_dunning_authority BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_dunning_authority_generation_update AFTER UPDATE ON nc_dunning_authority BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_dunning_authority_generation_delete AFTER DELETE ON nc_dunning_authority BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_dunning_deliveries_generation_insert AFTER INSERT ON nc_dunning_deliveries BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_dunning_deliveries_generation_update AFTER UPDATE ON nc_dunning_deliveries BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_dunning_deliveries_generation_delete AFTER DELETE ON nc_dunning_deliveries BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_dunning_mail_authority_generation_insert AFTER INSERT ON nc_dunning_mail_authority BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_dunning_mail_authority_generation_update AFTER UPDATE ON nc_dunning_mail_authority BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_dunning_mail_authority_generation_delete AFTER DELETE ON nc_dunning_mail_authority BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_dunning_recoveries_generation_insert AFTER INSERT ON nc_dunning_recoveries BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_dunning_recoveries_generation_update AFTER UPDATE ON nc_dunning_recoveries BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_dunning_recoveries_generation_delete AFTER DELETE ON nc_dunning_recoveries BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
