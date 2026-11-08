-- One durable request per owner-confirmed binding, including unknown outcomes.
CREATE TABLE nc_transfer_instruction_preparations (
 id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 basis_json TEXT NOT NULL, basis_hash TEXT NOT NULL, prepared_by TEXT NOT NULL,
 session_id TEXT NOT NULL, factor_reference TEXT NOT NULL, prepared_at INTEGER NOT NULL
);
CREATE TABLE nc_transfer_instructions (
 id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES nc_customers(id),
 binding_id TEXT NOT NULL UNIQUE REFERENCES nc_stripe_customer_bindings(id), binding_revision TEXT NOT NULL,
 account_ref TEXT NOT NULL, stripe_customer_ref TEXT NOT NULL, status TEXT NOT NULL,
 claimed_at INTEGER NOT NULL, completed_at INTEGER, fields_json TEXT NOT NULL, source_hash TEXT,
 UNIQUE(account_ref,stripe_customer_ref)
);
ALTER TABLE nc_invoices ADD COLUMN transfer_instructions_json TEXT;
CREATE TRIGGER nc_transfer_instruction_snapshot_immutable BEFORE UPDATE OF transfer_instructions_json ON nc_invoices
WHEN OLD.status='issued' AND OLD.transfer_instructions_json IS NOT NEW.transfer_instructions_json
 AND NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_transfer_instructions_immutable BEFORE UPDATE ON nc_transfer_instructions
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND (OLD.id IS NOT NEW.id OR OLD.customer_id IS NOT NEW.customer_id OR OLD.binding_id IS NOT NEW.binding_id
 OR OLD.binding_revision IS NOT NEW.binding_revision OR OLD.account_ref IS NOT NEW.account_ref OR OLD.stripe_customer_ref IS NOT NEW.stripe_customer_ref
 OR OLD.claimed_at IS NOT NEW.claimed_at OR OLD.status<>'claimed' OR NEW.status NOT IN ('available','uncertain'))
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_transfer_instructions_keep BEFORE DELETE ON nc_transfer_instructions
WHEN NOT EXISTS(SELECT 1 FROM nc_privacy_context) AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
BEGIN SELECT RAISE(ABORT,'nectar_immutable'); END;
CREATE TRIGGER nc_transfer_instructions_generation_insert AFTER INSERT ON nc_transfer_instructions BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_transfer_instructions_generation_update AFTER UPDATE ON nc_transfer_instructions BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_transfer_instructions_generation_delete AFTER DELETE ON nc_transfer_instructions BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_transfer_instruction_preparations_generation_insert AFTER INSERT ON nc_transfer_instruction_preparations BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
CREATE TRIGGER nc_transfer_instruction_preparations_generation_delete AFTER DELETE ON nc_transfer_instruction_preparations BEGIN UPDATE nc_privacy_generation SET value=value+1 WHERE id=1; END;
