CREATE TABLE nc_processor_cash_unmatched (
 id TEXT PRIMARY KEY, account_ref TEXT NOT NULL, transfer_ref TEXT NOT NULL,
 customer_id TEXT NOT NULL REFERENCES nc_customers(id), amount_cents INTEGER NOT NULL CHECK(amount_cents>=0),
 currency TEXT NOT NULL, occurred_at INTEGER NOT NULL, sender TEXT NOT NULL, reference TEXT NOT NULL,
 reason TEXT NOT NULL, observed_at INTEGER NOT NULL, UNIQUE(account_ref,transfer_ref)
);
CREATE TABLE nc_processor_cash_escalations (
 id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 transfer_id TEXT NOT NULL REFERENCES nc_processor_cash_unmatched(id), age_days INTEGER NOT NULL,
 assigned_member_id TEXT NOT NULL REFERENCES nc_members(id), task_id TEXT NOT NULL REFERENCES nc_tasks(id),
 created_at INTEGER NOT NULL, UNIQUE(transfer_id,age_days)
);
DROP INDEX nc_processor_cash_transfer;
CREATE UNIQUE INDEX nc_processor_cash_transfer_invoice ON nc_processor_cash_applications(account_ref,transfer_ref,invoice_id) WHERE transfer_ref<>'';
CREATE TRIGGER nc_processor_cash_unmatched_generation_insert AFTER INSERT ON nc_processor_cash_unmatched BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_processor_cash_unmatched_generation_update AFTER UPDATE ON nc_processor_cash_unmatched BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_processor_cash_unmatched_generation_delete AFTER DELETE ON nc_processor_cash_unmatched BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_processor_cash_escalations_generation_insert AFTER INSERT ON nc_processor_cash_escalations BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_processor_cash_escalations_generation_delete AFTER DELETE ON nc_processor_cash_escalations BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
