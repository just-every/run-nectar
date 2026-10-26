-- Historical retry facts carry no restored debit authority.
CREATE TABLE nc_retry_policies(scope TEXT PRIMARY KEY,max_attempts INTEGER NOT NULL,window_days INTEGER NOT NULL,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE nc_retry_series(collection_id TEXT PRIMARY KEY,invoice_id TEXT NOT NULL,customer_id TEXT NOT NULL,first_failed_at INTEGER NOT NULL,next_at INTEGER,deadline INTEGER NOT NULL,attempts INTEGER NOT NULL,decline_code TEXT NOT NULL,status TEXT NOT NULL,policy_json TEXT NOT NULL,revision TEXT NOT NULL);
CREATE TABLE nc_retry_attempts(collection_id TEXT NOT NULL,invoice_id TEXT NOT NULL,customer_id TEXT NOT NULL,attempt INTEGER NOT NULL,attempted_at INTEGER NOT NULL,outcome TEXT NOT NULL,decline_code TEXT,amount_cents INTEGER NOT NULL,payment_id TEXT,dunning_step TEXT,PRIMARY KEY(collection_id,attempt));
CREATE INDEX nc_retry_due ON nc_retry_series(status,next_at);
CREATE TRIGGER nc_retry_policies_generation_insert AFTER insert ON nc_retry_policies BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_retry_policies_generation_update AFTER update ON nc_retry_policies BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_retry_policies_generation_delete AFTER delete ON nc_retry_policies BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_retry_series_generation_insert AFTER insert ON nc_retry_series BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_retry_series_generation_update AFTER update ON nc_retry_series BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_retry_series_generation_delete AFTER delete ON nc_retry_series BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_retry_attempts_generation_insert AFTER insert ON nc_retry_attempts BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_retry_attempts_generation_update AFTER update ON nc_retry_attempts BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_retry_attempts_generation_delete AFTER delete ON nc_retry_attempts BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
